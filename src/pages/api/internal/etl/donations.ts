import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

// AEC donation data from R2-hosted CSVs (sourced from transparency.aec.gov.au)
// Two sources:
//   aec/donations-made.csv — "Donations Made" (donor → recipient, includes individual MPs)
//   aec/detailed-receipts.csv — "Detailed Receipts" (16MB, includes MP/Senator return rows)

const SOURCE_URL = 'https://transparency.aec.gov.au/AnnualDonor';
const PARTY_SOURCE_URL = 'https://transparency.aec.gov.au/AnnualPoliticalParty';

// ── AEC party name → DB party_id mapping ─────────────────────────────────────
// Maps AEC disclosure names (including state branches) to our parties table IDs.
const PARTY_NAME_MAP: Record<string, string> = {
  'australian labor party': 'party_australian_labor_party',
  'liberal party of australia': 'party_liberal_party',
  'national party of australia': 'party_national_party',
  'liberal national party of queensland': 'party_liberal_national_party',
  'australian greens': 'party_australian_greens',
  "pauline hanson's one nation": 'party_pauline_hansons_one_nation_party',
  'united australia party': 'party_united_australia_party',
  "katter's australian party": 'party_katters_australian_party',
  'jacqui lambie network': 'party_jacqui_lambie_network',
  'centre alliance': 'party_centre_alliance',
  'country liberal party': 'party_country_liberal_party',
  "australia's voice": 'party_australias_voice',
};

/** Resolve an AEC party name (e.g. "Australian Labor Party (N.S.W. Branch)") to DB party_id */
function resolvePartyId(aecName: string): string | null {
  const lower = aecName.toLowerCase().trim();
  // Direct match
  if (PARTY_NAME_MAP[lower]) return PARTY_NAME_MAP[lower];
  // Strip state branch suffixes and try again
  const stripped = lower
    .replace(/\s*\(.*branch\)$/i, '')
    .replace(/\s*\(.*division\).*$/i, '')
    .replace(/\s*-\s*(nsw|vic|qld|sa|wa|tas|nt|act|n\.s\.w\.|victoria|queensland|south australia|western australia|tasmania|northern territory).*$/i, '')
    .replace(/\s*(nsw|qld|sa|wa|nt|act|victoria)\s*(division|branch)?$/i, '')
    .replace(/\s*inc\.?$/i, '')
    .replace(/\s*\(kap\)$/i, '')
    .replace(/\s*\(nt\)$/i, '')
    .trim();
  if (PARTY_NAME_MAP[stripped]) return PARTY_NAME_MAP[stripped];
  // Try prefix matching for known parties
  for (const [key, id] of Object.entries(PARTY_NAME_MAP)) {
    if (stripped.startsWith(key) || key.startsWith(stripped)) return id;
  }
  // Greens variants: "The Greens NSW", "Queensland Greens", "The ACT Greens", "The Australian Greens - Victoria"
  if (/\bgreens?\b/i.test(lower)) return 'party_australian_greens';
  // One Nation variants: "One Nation Queensland Division", "One Nation SA", etc.
  if (/\bone nation\b/i.test(lower)) return 'party_pauline_hansons_one_nation_party';
  // Palmer / Pauline's UAP → United Australia Party
  if (/\bpalmer united\b|\bpauline.*united australia\b/i.test(lower)) return 'party_united_australia_party';
  return null;
}

// ── CSV parsing ──────────────────────────────────────────────────────────────
function parseCSVRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { fields.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  fields.push(current.trim());
  return fields;
}

// ── Name helpers ─────────────────────────────────────────────────────────────
// AEC names: "Hon Dr Andrew Charlton MP", "Ms Zali Steggall OAM MP", "Senator Andrew Bragg"
const HONORIFICS = /^(Hon\.?\s+|Dr\.?\s+|Ms\.?\s+|Mr\.?\s+|Mrs\.?\s+|Senator\s+)+/i;
const SUFFIXES = /\s+(MP|OAM|AO|AC|AM|QC|SC|KC)$/gi;

function cleanRecipientName(raw: string): string {
  return raw.replace(HONORIFICS, '').replace(SUFFIXES, '').trim();
}

function surname(name: string): string {
  return name.trim().split(/\s+/).at(-1) ?? name.trim();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/** When multiple politicians share a surname, try to disambiguate by first name */
function bestMatch(
  matches: { id: string; name: string }[],
  cleanedRecipient: string,
): { id: string; name: string }[] {
  if (matches.length <= 1) return matches;
  const csvFirst = firstName(cleanedRecipient);
  if (!csvFirst) return matches;
  const firstNameMatch = matches.filter(
    (p) => firstName(p.name) === csvFirst,
  );
  return firstNameMatch.length > 0 ? firstNameMatch : matches;
}

function hashDonation(parts: string[]): string {
  let h = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return 'aec_' + Math.abs(h).toString(36);
}

function parseFinancialYear(fy: string): number | null {
  // "2024-25" → 2024, "2023-24" → 2023, "2021-22" → 2021
  const m = fy.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Main ETL ─────────────────────────────────────────────────────────────────
export async function runDonationsETL(env: Env, filterYear?: string) {
  const { DB, R2 } = env;

  // Build politician lookup by surname
  const { results: politicians } = await DB.prepare(
    'SELECT id, name FROM politicians',
  ).all<{ id: string; name: string }>();

  const bySurname = new Map<string, { id: string; name: string }[]>();
  for (const p of politicians) {
    const sur = surname(p.name).toLowerCase();
    const arr = bySurname.get(sur) ?? [];
    arr.push(p);
    bySurname.set(sur, arr);
    // Also index without apostrophe
    const noApostrophe = sur.replace(/'/g, '');
    if (noApostrophe !== sur) {
      const arr2 = bySurname.get(noApostrophe) ?? [];
      arr2.push(p);
      bySurname.set(noApostrophe, arr2);
    }
  }

  let inserted = 0;
  let skipped = 0;
  const yearsProcessed = new Set<string>();

  // Process Donations Made CSV (has individual MP/Senator recipients)
  const donationsMadeObj = await R2.get('aec/donations-made.csv');
  if (donationsMadeObj) {
    const csv = await donationsMadeObj.text();
    const lines = csv.split('\n');
    // Header: "Financial Year","Donor Name","Donation Made To","Date","Value"
    const stmts: D1PreparedStatement[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = parseCSVRow(line);
      if (fields.length < 5) continue;

      const [fy, donorName, recipientRaw, _date, valueStr] = fields;
      if (filterYear && fy !== filterYear) continue;

      // Only process rows where recipient looks like an individual (has MP/Senator)
      if (!/\bMP\b|\bSenator\b/i.test(recipientRaw)) continue;

      const cleaned = cleanRecipientName(recipientRaw);
      const sur = surname(cleaned).toLowerCase();
      const surnameMatches = bySurname.get(sur);
      if (!surnameMatches || surnameMatches.length === 0) { skipped++; continue; }
      const matches = bestMatch(surnameMatches, cleaned);

      yearsProcessed.add(fy);
      const amountCents = Math.round(parseFloat(valueStr) * 100) || 0;
      const year = parseFinancialYear(fy);

      for (const pol of matches) {
        const id = hashDonation([pol.id, donorName, fy, valueStr, _date]);
        stmts.push(DB.prepare(`
          INSERT INTO donations (id, politician_id, donor_name, amount_cents, year, source, source_url, notes)
          VALUES (?, ?, ?, ?, ?, 'AEC', ?, ?)
          ON CONFLICT(id) DO NOTHING
        `).bind(id, pol.id, donorName, amountCents, year, SOURCE_URL, `FY ${fy} — Donations Made`));
        inserted++;
      }
    }

    // Batch write in groups of 50
    for (let i = 0; i < stmts.length; i += 50) {
      await DB.batch(stmts.slice(i, i + 50));
    }
  }

  // Process Detailed Receipts CSV (MP/Senator returns only)
  const receiptsObj = await R2.get('aec/detailed-receipts.csv');
  if (receiptsObj) {
    const csv = await receiptsObj.text();
    const lines = csv.split('\n');
    // Header: "Financial Year","Return Type","Recipient Name","Received From","Receipt Type","Value"
    const stmts: D1PreparedStatement[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = parseCSVRow(line);
      if (fields.length < 6) continue;

      const [fy, returnType, recipientRaw, receivedFrom, _receiptType, valueStr] = fields;
      if (filterYear && fy !== filterYear) continue;

      // Only process MP/Senator returns
      if (!/Member of HOR Return|Senator Return/i.test(returnType)) continue;

      const cleaned = cleanRecipientName(recipientRaw);
      const sur = surname(cleaned).toLowerCase();
      const surnameMatches = bySurname.get(sur);
      if (!surnameMatches || surnameMatches.length === 0) { skipped++; continue; }
      const matches = bestMatch(surnameMatches, cleaned);

      yearsProcessed.add(fy);
      const amountCents = Math.round(parseFloat(valueStr) * 100) || 0;
      const year = parseFinancialYear(fy);

      for (const pol of matches) {
        const id = hashDonation([pol.id, receivedFrom, fy, valueStr, 'receipt']);
        stmts.push(DB.prepare(`
          INSERT INTO donations (id, politician_id, donor_name, amount_cents, year, source, source_url, notes)
          VALUES (?, ?, ?, ?, ?, 'AEC', ?, ?)
          ON CONFLICT(id) DO NOTHING
        `).bind(id, pol.id, receivedFrom, amountCents, year, SOURCE_URL, `FY ${fy} — ${returnType}`));
        inserted++;
      }
    }

    for (let i = 0; i < stmts.length; i += 50) {
      await DB.batch(stmts.slice(i, i + 50));
    }
  }

  // ── Phase 3: Party donations from "Political Party Return" rows ──────────
  // These are already in the same Detailed Receipts CSV; we just need the
  // "Political Party Return" rows that we previously skipped.
  let partyInserted = 0;
  let partySkipped = 0;
  const unmatchedParties = new Set<string>();

  const receiptsObj2 = await R2.get('aec/detailed-receipts.csv');
  if (receiptsObj2) {
    const csv = await receiptsObj2.text();
    const lines = csv.split('\n');
    const stmts: D1PreparedStatement[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = parseCSVRow(line);
      if (fields.length < 6) continue;

      const [fy, returnType, recipientRaw, receivedFrom, _receiptType, valueStr] = fields;
      if (filterYear && fy !== filterYear) continue;

      // Only process party returns
      if (!/Political Party Return/i.test(returnType)) continue;

      const partyId = resolvePartyId(recipientRaw);
      if (!partyId) { unmatchedParties.add(recipientRaw); partySkipped++; continue; }

      yearsProcessed.add(fy);
      const amountCents = Math.round(parseFloat(valueStr) * 100) || 0;
      const year = parseFinancialYear(fy);
      const id = hashDonation(['party', partyId, receivedFrom, fy, valueStr]);

      stmts.push(DB.prepare(`
        INSERT INTO donations (id, politician_id, party_id, donor_name, amount_cents, year, source, source_url, notes)
        VALUES (?, NULL, ?, ?, ?, ?, 'AEC', ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).bind(id, partyId, receivedFrom, amountCents, year, PARTY_SOURCE_URL, `FY ${fy} — ${returnType} — ${recipientRaw}`));
      partyInserted++;
    }

    for (let i = 0; i < stmts.length; i += 50) {
      await DB.batch(stmts.slice(i, i + 50));
    }
  }

  return {
    success: true,
    individual: { inserted, skipped },
    party: { inserted: partyInserted, skipped: partySkipped, unmatched_parties: [...unmatchedParties].sort() },
    years_processed: [...yearsProcessed].sort(),
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  try {
    const body = await request.json().catch(() => ({}));
    const year = (body as any).year as string | undefined;
    const result = await runDonationsETL(locals.runtime.env, year);
    return jsonResponse(result);
  } catch (err) {
    console.error('Donations ETL error:', err);
    return jsonError(`Donations ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
