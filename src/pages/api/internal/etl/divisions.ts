import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

const OA_BASE = 'https://www.openaustralia.org.au/api';
const START_DATE = '2023-01-01';
const END_DATE = '2024-06-30';
const MAX_DATES_PER_RUN = 10;
const KV_KEY_PREFIX = 'etl:divisions:last_date';

interface OADebateEntry {
  gid?: string;
  epobject_id?: string;
  hdate?: string;
  htype?: string;
  body?: string;
  listurl?: string;
}

interface OADivisionDetail {
  gid?: string;
  hdate?: string;
  body?: string;
  listurl?: string;
  yes_votes?: Array<{ member_id?: string }>;
  no_votes?: Array<{ member_id?: string }>;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Generate weekly date strings from start to end */
function generateWeeklyDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + 'T00:00:00Z');
  const endDate = new Date(end + 'T00:00:00Z');
  while (cur <= endDate) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return dates;
}

export async function runDivisionsETL(env: Env) {
  const { DB, KV } = env;
  const apiKey = env.OPENAUSTRALIA_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAUSTRALIA_API_KEY not set');
  }

  const allDates = generateWeeklyDates(START_DATE, END_DATE);

  let divisionsProcessed = 0;
  let votesProcessed = 0;
  let actionsCreated = 0;
  let queuedForMapping = 0;
  let datesProcessed = 0;

  for (const house of ['representatives', 'senate'] as const) {
    const type = house === 'senate' ? 'senate' : 'representatives';
    const kvKey = `${KV_KEY_PREFIX}:${house}`;

    // Resume from last processed date
    const lastDate = await KV.get(kvKey);
    let startIdx = 0;
    if (lastDate) {
      const idx = allDates.findIndex(d => d > lastDate);
      if (idx >= 0) startIdx = idx;
      else continue; // all dates already processed for this house
    }

    const batch = allDates.slice(startIdx, startIdx + MAX_DATES_PER_RUN);
    if (batch.length === 0) continue;

    for (const date of batch) {
      // Fetch debates for this date
      const listUrl = `${OA_BASE}/getDebates?key=${apiKey}&type=${type}&date=${date}&num=100&output=js`;
      const listRes = await fetch(listUrl, {
        headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
      });

      if (!listRes.ok) {
        console.error(`getDebates failed for ${house} ${date}: ${listRes.status}`);
        // Save progress and move on
        await KV.put(kvKey, date);
        datesProcessed++;
        continue;
      }

      const entries = await listRes.json() as OADebateEntry[];
      if (!Array.isArray(entries)) {
        await KV.put(kvKey, date);
        datesProcessed++;
        continue;
      }

      // htype "12" = division records
      const divisionEntries = entries.filter(e => e.htype === '12' && e.gid);

      for (const entry of divisionEntries) {
        const gid = entry.gid!;
        const divisionId = `oa_div_${gid.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const divDate = entry.hdate || date;
        const motionHtml = entry.body || '';
        const title = stripHtml(motionHtml).slice(0, 200) || 'Parliamentary Division';
        const motion = stripHtml(motionHtml);
        const sourceUrl = entry.listurl || `https://www.openaustralia.org.au/debates/?id=${gid}`;

        // Upsert division record
        await DB.prepare(`
          INSERT INTO divisions (id, external_id, chamber, date, title, motion, source_url)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            motion = excluded.motion,
            source_url = excluded.source_url,
            updated_at = datetime('now')
        `).bind(divisionId, gid, house, divDate, title, motion, sourceUrl).run();

        divisionsProcessed++;

        await DB.prepare(`
          INSERT OR IGNORE INTO mapping_queue (division_id, status)
          VALUES (?, 'new')
        `).bind(divisionId).run();

        const queueRow = await DB.prepare(
          `SELECT status FROM mapping_queue WHERE division_id = ? AND status = 'new'`
        ).bind(divisionId).first();
        if (queueRow) queuedForMapping++;

        // Fetch individual debate to get vote lists
        const detailUrl = `${OA_BASE}/getDebates?key=${apiKey}&gid=${encodeURIComponent(gid)}&output=js`;
        const detailRes = await fetch(detailUrl, {
          headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
        });

        if (!detailRes.ok) {
          console.error(`getDebates detail failed for gid=${gid}: ${detailRes.status}`);
          continue;
        }

        const detailData = await detailRes.json() as OADivisionDetail[];
        if (!Array.isArray(detailData) || detailData.length === 0) continue;

        // Find the entry with vote data (may be the first or one matching the gid)
        const voteEntry = detailData.find(d => d.yes_votes || d.no_votes) || detailData[0];

        // Process YES votes
        const yesVotes = voteEntry.yes_votes || [];
        for (const v of yesVotes) {
          if (!v.member_id) continue;
          const politicianId = `oa_${v.member_id}`;

          await DB.prepare(`
            INSERT INTO votes (division_id, politician_id, vote, source_url)
            VALUES (?, ?, 'aye', ?)
            ON CONFLICT(division_id, politician_id) DO UPDATE SET
              vote = excluded.vote
          `).bind(divisionId, politicianId, sourceUrl).run();

          votesProcessed++;

          const actionId = `vote_${politicianId}_${divisionId}`;
          await DB.prepare(`
            INSERT INTO actions (id, politician_id, title, description, date, category, source_url)
            VALUES (?, ?, ?, ?, ?, 'voting-record', ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              description = excluded.description
          `).bind(actionId, politicianId, `Voted AYE: ${title}`, motion || title, divDate, sourceUrl).run();

          actionsCreated++;
        }

        // Process NO votes
        const noVotes = voteEntry.no_votes || [];
        for (const v of noVotes) {
          if (!v.member_id) continue;
          const politicianId = `oa_${v.member_id}`;

          await DB.prepare(`
            INSERT INTO votes (division_id, politician_id, vote, source_url)
            VALUES (?, ?, 'no', ?)
            ON CONFLICT(division_id, politician_id) DO UPDATE SET
              vote = excluded.vote
          `).bind(divisionId, politicianId, sourceUrl).run();

          votesProcessed++;

          const actionId = `vote_${politicianId}_${divisionId}`;
          await DB.prepare(`
            INSERT INTO actions (id, politician_id, title, description, date, category, source_url)
            VALUES (?, ?, ?, ?, ?, 'voting-record', ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              description = excluded.description
          `).bind(actionId, politicianId, `Voted NO: ${title}`, motion || title, divDate, sourceUrl).run();

          actionsCreated++;
        }
      }

      // Save progress after each date
      await KV.put(kvKey, date);
      datesProcessed++;
    }
  }

  return {
    success: true,
    datesProcessed,
    divisions: divisionsProcessed,
    votes: votesProcessed,
    actions: actionsCreated,
    queued: queuedForMapping,
    note: datesProcessed < allDates.length * 2
      ? 'Partial run — call again to continue processing more dates.'
      : 'All dates processed.',
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
