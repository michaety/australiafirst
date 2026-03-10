import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

interface OADebateItem {
  gid?: string;
  epobject_id?: string;
  hdate?: string;
  body?: string;
  parent?: {
    body?: string;
    epobject_id?: string;
  };
  listurl?: string;
}

interface OADivision {
  division_id?: string;
  date?: string;
  title?: string;
  motion?: string;
  source_url?: string;
  aye_votes?: Array<{ member_id?: string; vote?: string }>;
  no_votes?: Array<{ member_id?: string; vote?: string }>;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  const { DB } = locals.runtime.env;
  const apiKey = locals.runtime.env.OPENAUSTRALIA_API_KEY;

  if (!apiKey) {
    return jsonError('OPENAUSTRALIA_API_KEY not set', 500);
  }

  try {
    let divisionsProcessed = 0;
    let votesProcessed = 0;
    let actionsCreated = 0;
    let queuedForMapping = 0;

    // Fetch divisions for both House of Reps and Senate
    for (const house of ['representatives', 'senate']) {
      const type = house === 'senate' ? 'senate' : 'commons';
      const url = `https://www.openaustralia.org.au/api/getDivisions?key=${apiKey}&type=${type}&num=100&output=js`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
      });

      if (!res.ok) {
        console.error(`OpenAustralia getDivisions failed for ${house}: ${res.status}`);
        continue;
      }

      const data = await res.json() as OADivision[];
      if (!Array.isArray(data)) continue;

      for (const div of data) {
        if (!div.division_id) continue;

        const divisionId = `oa_div_${div.division_id}`;
        const externalId = String(div.division_id);
        const date = div.date || '';
        const title = div.title || 'Untitled Division';
        const motion = div.motion || '';
        const sourceUrl = div.source_url || `https://www.openaustralia.org.au/divisions/?d=${externalId}`;

        // Upsert division
        await DB.prepare(`
          INSERT INTO divisions (id, external_id, chamber, date, title, motion, source_url)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            motion = excluded.motion,
            source_url = excluded.source_url,
            updated_at = datetime('now')
        `).bind(divisionId, externalId, house, date, title, motion, sourceUrl).run();

        divisionsProcessed++;

        // Add to mapping queue if new
        await DB.prepare(`
          INSERT OR IGNORE INTO mapping_queue (division_id, status)
          VALUES (?, 'new')
        `).bind(divisionId).run();

        // Check if it was actually inserted (new)
        const queueRow = await DB.prepare(
          `SELECT status FROM mapping_queue WHERE division_id = ? AND status = 'new'`
        ).bind(divisionId).first();
        if (queueRow) queuedForMapping++;

        // Process AYE votes
        const ayeVotes = div.aye_votes || [];
        for (const v of ayeVotes) {
          if (!v.member_id) continue;
          const politicianId = `oa_${v.member_id}`;

          await DB.prepare(`
            INSERT INTO votes (division_id, politician_id, vote, source_url)
            VALUES (?, ?, 'aye', ?)
            ON CONFLICT(division_id, politician_id) DO UPDATE SET
              vote = excluded.vote
          `).bind(divisionId, politicianId, sourceUrl).run();

          votesProcessed++;

          // Create action entry for this vote
          const actionId = `vote_${politicianId}_${divisionId}`;
          await DB.prepare(`
            INSERT INTO actions (id, politician_id, title, description, date, category, source_url)
            VALUES (?, ?, ?, ?, ?, 'voting-record', ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              description = excluded.description
          `).bind(actionId, politicianId, `Voted AYE: ${title}`, motion || title, date, sourceUrl).run();

          actionsCreated++;
        }

        // Process NO votes
        const noVotes = div.no_votes || [];
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
          `).bind(actionId, politicianId, `Voted NO: ${title}`, motion || title, date, sourceUrl).run();

          actionsCreated++;
        }
      }
    }

    return jsonResponse({
      success: true,
      processed: divisionsProcessed,
      votes: votesProcessed,
      actions: actionsCreated,
      queued: queuedForMapping,
    });
  } catch (err) {
    console.error('Divisions ETL error:', err);
    return jsonError(`Divisions ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
