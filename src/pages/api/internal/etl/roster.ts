import type { APIRoute } from 'astro';
import { jsonResponse, jsonError } from '../../../../lib/api';

export const prerender = false;

export async function runRosterETL(env: Env) {
  const { DB } = env;
  const apiKey = env.OPENAUSTRALIA_API_KEY;

  if (!apiKey) {
    throw new Error('OPENAUSTRALIA_API_KEY not set');
  }

  const [repsRes, sensRes] = await Promise.all([
    fetch(`https://www.openaustralia.org.au/api/getRepresentatives?key=${apiKey}&output=js`),
    fetch(`https://www.openaustralia.org.au/api/getSenators?key=${apiKey}&output=js`),
  ]);

  if (!repsRes.ok || !sensRes.ok) {
    throw new Error(`OpenAustralia API error: ${repsRes.status} / ${sensRes.status}`);
  }

  const repsData = await repsRes.json() as { member?: unknown[] } | unknown[];
  const sensData = await sensRes.json() as { member?: unknown[] } | unknown[];

  const reps = (Array.isArray(repsData) ? repsData : (repsData as { member?: unknown[] }).member) ?? [];
  const sens = (Array.isArray(sensData) ? sensData : (sensData as { member?: unknown[] }).member) ?? [];

  const members = [...reps, ...sens] as Array<{
    member_id?: string;
    full_name?: string;
    first_name?: string;
    last_name?: string;
    party?: string;
    constituency?: string;
    house?: string;
    image?: string;
  }>;

  let processedCount = 0;

  for (const member of members) {
    if (!member.member_id) continue;

    const id = `oa_${member.member_id}`;
    const name = member.full_name ?? [member.first_name, member.last_name].filter(Boolean).join(' ');
    const chamber = member.house === 'senate' ? 'senate' : 'representatives';
    const partyName = member.party ?? null;
    const electorate = member.constituency ?? null;
    const imageUrl = member.image ?? null;

    let partyId: string | null = null;
    if (partyName) {
      partyId = `party_${partyName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;
      await DB.prepare(`
        INSERT INTO parties (id, name) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name
      `).bind(partyId, partyName).run();
    }

    await DB.prepare(`
      INSERT INTO politicians (id, name, chamber, party_id, electorate, jurisdiction, image_url)
      VALUES (?, ?, ?, ?, ?, 'commonwealth', ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        chamber = excluded.chamber,
        party_id = excluded.party_id,
        electorate = excluded.electorate,
        image_url = excluded.image_url
    `).bind(id, name, chamber, partyId, electorate, imageUrl).run();

    const photoId = `photo_${id}`;
    await DB.prepare(`
      INSERT OR IGNORE INTO politician_photos (id, politician_id, source_url, status)
      VALUES (?, ?, ?, 'pending')
    `).bind(photoId, id, imageUrl).run();

    processedCount++;
  }

  return { success: true, message: 'Roster synced', processedCount };
}

export const POST: APIRoute = async ({ locals }) => {
  try {
    const result = await runRosterETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('Roster ETL error:', err);
    return jsonError(`Roster ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};