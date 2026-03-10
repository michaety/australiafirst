import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

const TVFY_BASE = 'https://theyvoteforyou.org.au/api/v1';

// The /people.json list response — each item has an id and a nested latest_member
interface TVFYPersonSummary {
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
  } | null;
}

interface TVFYPolicyComparison {
  policy: {
    id: number;
    name: string;
    description: string;
    provisional?: boolean;
  };
  // agreement is a percentage string like "100", "67.3", or null/empty if no votes
  agreement: string | null;
  voted?: boolean;
}

// The /people/{id}.json detail response
interface TVFYPersonDetail {
  id: number;
  latest_member: {
    name: {
      first: string;
      last: string;
    };
  } | null;
  policy_comparisons: TVFYPolicyComparison[];
}

const PREFIX_RE = /^(?:Hon|Dr|Mr|Ms|Mrs|Prof|Senator)\s+/gi;
const SUFFIX_RE = /[\s,]+(?:MP|OAM|AM|AO|QC|SC)\b/gi;

function normaliseName(name: string): string {
  let n = name.trim();
  let prev: string;
  do { prev = n; n = n.replace(PREFIX_RE, '').trim(); PREFIX_RE.lastIndex = 0; } while (n !== prev);
  do { prev = n; n = n.replace(SUFFIX_RE, '').trim(); SUFFIX_RE.lastIndex = 0; } while (n !== prev);
  return n.toLowerCase();
}

export async function runPolicyScoresETL(env: Env) {
  const { DB } = env;
  const apiKey = env.THEYVOTEFORYOU_API_KEY;

  if (!apiKey) {
    return {
      success: false,
      error: 'THEYVOTEFORYOU_API_KEY not set. Register at https://theyvoteforyou.org.au/users/sign_up then run: npx wrangler secret put THEYVOTEFORYOU_API_KEY',
      inserted: 0,
    };
  }

  // Build normalised name → politician_id lookup from DB
  const politiciansResult = await DB.prepare(
    `SELECT id, name FROM politicians`
  ).all<{ id: string; name: string }>();

  const polMap = new Map<string, string>();
  // Last-name-only fallback map (for cases where first name differs slightly)
  const lastNameMap = new Map<string, string>();
  for (const p of politiciansResult.results) {
    const key = normaliseName(p.name);
    if (key) polMap.set(key, p.id);
    const parts = key.split(' ');
    const lastName = parts[parts.length - 1];
    if (lastName && !lastNameMap.has(lastName)) {
      lastNameMap.set(lastName, p.id);
    } else if (lastName) {
      lastNameMap.set(lastName, '__ambiguous__');
    }
  }

  console.log(`[policy-scores] Politicians in DB: ${politiciansResult.results.length}`);

  // Fetch people list from TVFY
  const peopleUrl = `${TVFY_BASE}/people.json?key=${encodeURIComponent(apiKey)}`;
  const peopleRes = await fetch(peopleUrl, {
    headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
  });

  if (!peopleRes.ok) {
    if (peopleRes.status === 401) {
      return {
        success: false,
        error: 'THEYVOTEFORYOU_API_KEY is invalid.',
        inserted: 0,
      };
    }
    return {
      success: false,
      error: `TVFY people list failed: ${peopleRes.status}`,
      inserted: 0,
    };
  }

  const people = await peopleRes.json() as TVFYPersonSummary[];
  console.log(`[policy-scores] TVFY people fetched: ${people.length}`);

  const errors: string[] = [];
  let inserted = 0;
  let matched = 0;
  let unmatched = 0;

  for (const person of people) {
    // Names are nested under latest_member.name.first / .last
    const member = person.latest_member;
    if (!member) { unmatched++; continue; }

    const firstName = member.name?.first ?? '';
    const lastName = member.name?.last ?? '';
    if (!firstName && !lastName) { unmatched++; continue; }

    const fullName = `${firstName} ${lastName}`.trim();
    const normKey = normaliseName(fullName);

    // Try full name match first, then last-name-only fallback
    let politicianId = polMap.get(normKey);
    if (!politicianId) {
      const parts = normKey.split(' ');
      const last = parts[parts.length - 1];
      const fallback = lastNameMap.get(last);
      if (fallback && fallback !== '__ambiguous__') politicianId = fallback;
    }

    if (!politicianId) {
      unmatched++;
      continue;
    }

    matched++;

    // Fetch person detail to get policy_comparisons
    const detailUrl = `${TVFY_BASE}/people/${person.id}.json?key=${encodeURIComponent(apiKey)}`;
    let detail: TVFYPersonDetail;
    try {
      const detailRes = await fetch(detailUrl, {
        headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
      });
      if (!detailRes.ok) {
        errors.push(`Detail fetch failed for ${fullName} (${person.id}): ${detailRes.status}`);
        continue;
      }
      detail = await detailRes.json() as TVFYPersonDetail;
    } catch (e) {
      errors.push(`Detail fetch error for ${fullName}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const comparisons = detail.policy_comparisons ?? [];
    if (comparisons.length === 0) continue;

    console.log(`[policy-scores] ${fullName} → politician ${politicianId}, ${comparisons.length} policies`);

    // Insert in batches of 50
    const BATCH = 50;
    for (let i = 0; i < comparisons.length; i += BATCH) {
      const batch = comparisons.slice(i, i + BATCH);
      const stmts: D1PreparedStatement[] = [];

      for (const comp of batch) {
        // agreement is a pre-computed percentage string (e.g. "100", "67.3") or null
        const agreementPct = comp.agreement != null && comp.agreement !== ''
          ? parseFloat(comp.agreement)
          : null;
        const id = `tvfy_${politicianId}_${comp.policy.id}`;

        stmts.push(DB.prepare(`
          INSERT INTO politician_policy_scores
            (id, politician_id, policy_id, policy_name, policy_description, agreement_pct, votes_count, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'TVFY')
          ON CONFLICT(politician_id, policy_id) DO UPDATE SET
            policy_name = excluded.policy_name,
            policy_description = excluded.policy_description,
            agreement_pct = excluded.agreement_pct,
            votes_count = excluded.votes_count
        `).bind(
          id,
          politicianId,
          comp.policy.id,
          comp.policy.name,
          comp.policy.description ?? null,
          agreementPct,
          null,
        ));
      }

      try {
        const results = await DB.batch(stmts);
        const changes = results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
        inserted += changes;
      } catch (e) {
        errors.push(`Batch insert error for ${fullName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  console.log(`[policy-scores] Done. Inserted/updated: ${inserted}, matched: ${matched}, unmatched: ${unmatched}`);

  return {
    success: true,
    people: people.length,
    matched,
    unmatched,
    inserted,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  try {
    const result = await runPolicyScoresETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('Policy scores ETL error:', err);
    return jsonError(`Policy scores ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
