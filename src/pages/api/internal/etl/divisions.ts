import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

// TheyVoteForYou API — the proper source for Australian parliamentary divisions
const TVFY_BASE = 'https://theyvoteforyou.org.au/api/v1';
const MAX_PAGES_PER_RUN = 2; // pages per house per run
const DIVISIONS_PER_PAGE = 50; // list endpoint is cheap — no detail fetches needed
const MAX_DETAIL_FETCHES = 3; // detail fetches per run (votes) to stay within limits
const KV_KEY_PREFIX = 'etl:divisions:page';

interface TVFYDivisionSummary {
  id: number;
  house: string;
  name: string;
  date: string;
  number: number;
  clock_time: string | null;
  aye_votes: number;
  no_votes: number;
  possible_turnout: number;
  rebellions: number;
  edited: boolean;
}

interface TVFYVote {
  member: {
    id: number;
    first_name: string;
    last_name: string;
    party: string;
    electorate: string;
  };
  vote: string; // 'aye' | 'no' | 'absent' | 'abstention' | 'aye3' | 'no3' (tellers)
}

interface TVFYDivisionDetail {
  id: number;
  house: string;
  name: string;
  date: string;
  number: number;
  clock_time: string | null;
  source_url: string;
  debate_url: string;
  source_gid: string;
  rebellions: number;
  votes: TVFYVote[];
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function runDivisionsETL(env: Env) {
  const { DB, KV } = env;
  const apiKey = env.THEYVOTEFORYOU_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: 'THEYVOTEFORYOU_API_KEY not set. Register at https://theyvoteforyou.org.au/users/sign_up then run: npx wrangler secret put THEYVOTEFORYOU_API_KEY',
      divisions: 0, votes: 0, pagesProcessed: 0,
    };
  }

  // Deduplicate any existing action rows with the same (politician_id, title, date)
  await DB.prepare(`
    DELETE FROM actions WHERE id NOT IN (
      SELECT MIN(id) FROM actions GROUP BY politician_id, title, date
    )
  `).run();

  const errors: string[] = [];
  let divisionsProcessed = 0;
  let votesProcessed = 0;
  let actionsCreated = 0;
  let pagesProcessed = 0;
  let detailsFetched = 0;

  // Build name → politician_id lookup
  const politicians = await DB.prepare(
    `SELECT id, name FROM politicians`
  ).all<{ id: string; name: string }>();

  const nameIndex = new Map<string, string>();
  for (const p of politicians.results) {
    const parts = p.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      const first = parts[0].toLowerCase();
      const last = parts[parts.length - 1].toLowerCase();
      nameIndex.set(`${first} ${last}`, p.id);
      nameIndex.set(`${last} ${first}`, p.id);
      nameIndex.set(last, nameIndex.get(last) || p.id);
    }
  }

  function findPoliticianId(firstName: string, lastName: string): string | null {
    return nameIndex.get(`${firstName.toLowerCase()} ${lastName.toLowerCase()}`)
      || nameIndex.get(lastName.toLowerCase()) || null;
  }

  // PHASE 1: Ingest division summaries (fast — no detail calls)
  for (const house of ['representatives', 'senate'] as const) {
    const kvKey = `${KV_KEY_PREFIX}:${house}`;
    const lastPageStr = await KV.get(kvKey);
    let startPage = lastPageStr ? parseInt(lastPageStr, 10) + 1 : 1;

    for (let page = startPage; page < startPage + MAX_PAGES_PER_RUN; page++) {
      const listUrl = `${TVFY_BASE}/divisions.json?key=${encodeURIComponent(apiKey)}&house=${house}&sort=date&per_page=${DIVISIONS_PER_PAGE}&page=${page}`;
      const listRes = await fetch(listUrl, {
        headers: { 'User-Agent': 'OnTheRecord/1.0 accountability-platform' },
      });

      if (!listRes.ok) {
        if (listRes.status === 404) {
          await KV.put(kvKey, '0');
          break;
        }
        if (listRes.status === 401) {
          return {
            success: false,
            error: 'THEYVOTEFORYOU_API_KEY is invalid. Register at https://theyvoteforyou.org.au/users/sign_up then run: npx wrangler secret put THEYVOTEFORYOU_API_KEY',
            divisions: divisionsProcessed, votes: votesProcessed, pagesProcessed,
          };
        }
        const body = await listRes.text().catch(() => '');
        errors.push(`TVFY list failed for ${house} page ${page}: ${listRes.status} ${body.slice(0, 200)}`);
        break;
      }

      const summaries = await listRes.json() as TVFYDivisionSummary[];
      if (!Array.isArray(summaries) || summaries.length === 0) {
        await KV.put(kvKey, '0');
        break;
      }

      // Batch insert all summaries
      const stmts: D1PreparedStatement[] = [];
      for (const s of summaries) {
        const divisionId = `tvfy_${s.id}`;
        const title = stripHtml(s.name).slice(0, 200) || 'Parliamentary Division';
        const sourceUrl = `https://theyvoteforyou.org.au/divisions/${s.id}`;

        stmts.push(DB.prepare(`
          INSERT INTO divisions (id, external_id, chamber, date, title, motion, source_url)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            motion = excluded.motion,
            source_url = excluded.source_url,
            updated_at = datetime('now')
        `).bind(divisionId, String(s.id), house, s.date, title, title, sourceUrl));

        stmts.push(DB.prepare(`
          INSERT OR IGNORE INTO mapping_queue (division_id, status)
          VALUES (?, 'pending_votes')
        `).bind(divisionId));
      }
      await DB.batch(stmts);
      divisionsProcessed += summaries.length;

      await KV.put(kvKey, String(page));
      pagesProcessed++;
    }
  }

  // PHASE 2: Fetch vote details for divisions that need them (limited per run)
  const pending = await DB.prepare(
    `SELECT d.id, d.external_id, d.chamber, d.date, d.title, d.source_url
     FROM divisions d
     JOIN mapping_queue mq ON mq.division_id = d.id
     WHERE mq.status = 'pending_votes'
     LIMIT ?`
  ).bind(MAX_DETAIL_FETCHES).all<{
    id: string; external_id: string; chamber: string;
    date: string; title: string; source_url: string;
  }>();

  for (const div of pending.results) {
    const detailUrl = `${TVFY_BASE}/divisions/${div.external_id}.json?key=${encodeURIComponent(apiKey)}`;
    const detailRes = await fetch(detailUrl, {
      headers: { 'User-Agent': 'OnTheRecord/1.0 accountability-platform' },
    });

    if (!detailRes.ok) {
      errors.push(`Detail fetch failed for ${div.id}: ${detailRes.status}`);
      continue;
    }

    const detail = await detailRes.json() as TVFYDivisionDetail;
    const stmts: D1PreparedStatement[] = [];

    for (const v of detail.votes || []) {
      if (!v.member) continue;
      const politicianId = findPoliticianId(v.member.first_name, v.member.last_name);
      if (!politicianId) continue;

      let voteValue: string;
      if (v.vote === 'aye' || v.vote === 'aye3') voteValue = 'aye';
      else if (v.vote === 'no' || v.vote === 'no3') voteValue = 'no';
      else if (v.vote === 'abstention') voteValue = 'abstain';
      else voteValue = 'absent';

      stmts.push(DB.prepare(`
        INSERT INTO votes (division_id, politician_id, vote, source_url)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(division_id, politician_id) DO UPDATE SET vote = excluded.vote
      `).bind(div.id, politicianId, voteValue, div.source_url));

      const actionId = `vote_${politicianId}_${div.id}`;
      stmts.push(DB.prepare(`
        INSERT INTO actions (id, politician_id, title, description, date, category, source_url)
        VALUES (?, ?, ?, ?, ?, 'voting-record', ?)
        ON CONFLICT DO NOTHING
      `).bind(actionId, politicianId, `Voted ${voteValue.toUpperCase()}: ${div.title}`, div.title, div.date, div.source_url));

      votesProcessed++;
      actionsCreated++;
    }

    // Mark as processed
    stmts.push(DB.prepare(
      `UPDATE mapping_queue SET status = 'done' WHERE division_id = ?`
    ).bind(div.id));

    await DB.batch(stmts);
    detailsFetched++;
  }

  return {
    success: true,
    pagesProcessed,
    divisions: divisionsProcessed,
    detailsFetched,
    votes: votesProcessed,
    actions: actionsCreated,
    errors: errors.length > 0 ? errors : undefined,
    note: 'Call repeatedly to process more pages and vote details.',
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  try {
    const result = await runDivisionsETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('Divisions ETL error:', err);
    return jsonError(`Divisions ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
