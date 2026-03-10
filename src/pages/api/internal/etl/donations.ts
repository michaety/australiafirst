import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

// TheyVoteForYou API for policy voting data
// AEC donation data is in ZIP format and requires manual import
const TVFY_BASE = 'https://theyvoteforyou.org.au/api/v1';
const TVFY_SOURCE = 'https://theyvoteforyou.org.au';

interface TVFYPerson {
  id: number;
  latest_member: {
    id: number;
    name: {
      first: string;
      last: string;
    };
    electorate: string;
    house: string;
    party: string;
  };
}

interface TVFYPolicy {
  id: number;
  name: string;
  description: string;
  provisional: boolean;
}

interface TVFYPersonPolicy {
  policy: TVFYPolicy;
  agreement: string; // percentage like "85%"
  voted: boolean;
}

function hashId(parts: string[]): string {
  let hash = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return 'tvfy_' + Math.abs(hash).toString(36);
}

export async function runDonationsETL(env: Env) {
  const { DB } = env;
  const apiKey = env.THEYVOTEFORYOU_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: 'THEYVOTEFORYOU_API_KEY not set. Register at https://theyvoteforyou.org.au/users/sign_up then run: npx wrangler secret put THEYVOTEFORYOU_API_KEY',
      processed: 0, matched: 0, unmatched: 0,
    };
  }

  // Fetch people from TheyVoteForYou
  const peopleRes = await fetch(
    `${TVFY_BASE}/people.json?key=${encodeURIComponent(apiKey)}&per_page=200`,
    { headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' } },
  );

  if (!peopleRes.ok) {
    if (peopleRes.status === 401) {
      return {
        success: false,
        error: 'THEYVOTEFORYOU_API_KEY is invalid. Register at https://theyvoteforyou.org.au/users/sign_up then run: npx wrangler secret put THEYVOTEFORYOU_API_KEY',
        processed: 0, matched: 0, unmatched: 0,
      };
    }
    throw new Error(`TVFY people fetch failed: ${peopleRes.status}`);
  }

  const people = await peopleRes.json() as TVFYPerson[];
  if (!Array.isArray(people)) {
    throw new Error('TVFY returned unexpected people format');
  }

  // Build politician lookup by last name
  const politicians = await DB.prepare(
    `SELECT id, name FROM politicians`
  ).all<{ id: string; name: string }>();

  const nameIndex = new Map<string, string[]>();
  for (const p of politicians.results) {
    const parts = p.name.trim().split(/\s+/);
    const lastName = parts[parts.length - 1].toLowerCase();
    const existing = nameIndex.get(lastName) || [];
    existing.push(p.id);
    nameIndex.set(lastName, existing);
  }

  let totalProcessed = 0;
  let totalMatched = 0;
  let totalUnmatched = 0;

  for (const person of people) {
    if (!person.latest_member?.name?.last) continue;
    totalProcessed++;

    const lastName = person.latest_member.name.last.toLowerCase();
    const matches = nameIndex.get(lastName);

    if (!matches || matches.length === 0) {
      totalUnmatched++;
      continue;
    }

    totalMatched++;

    // Insert a placeholder noting AEC data requires manual import
    // and recording the TVFY person ID for future policy lookups
    for (const politicianId of matches) {
      const id = hashId(['tvfy_link', politicianId, String(person.id)]);
      const sourceUrl = `${TVFY_SOURCE}/people/${person.id}`;
      await DB.prepare(`
        INSERT INTO donations (id, politician_id, donor_name, amount_cents, year, source, source_url, notes)
        VALUES (?, ?, ?, NULL, NULL, 'TVFY', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_url = excluded.source_url,
          notes = excluded.notes
      `).bind(
        id, politicianId,
        `TheyVoteForYou Profile (${person.latest_member.name.first} ${person.latest_member.name.last})`,
        sourceUrl,
        'AEC donation data requires manual CSV import (ZIP format). TVFY person_id=' + person.id,
      ).run();
    }
  }

  return {
    success: true,
    processed: totalProcessed,
    matched: totalMatched,
    unmatched: totalUnmatched,
    note: 'AEC donation data is in ZIP format and requires manual import. TVFY person links stored for policy lookups.',
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  try {
    const result = await runDonationsETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('Donations ETL error:', err);
    return jsonError(`Donations ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
