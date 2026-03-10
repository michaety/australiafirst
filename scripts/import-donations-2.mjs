/**
 * import-donations-2.mjs
 *
 * Reads donation data from three AEC CSV files in aec_data/ and inserts any
 * missing records into the D1 `donations` table.
 *
 * Files processed:
 *   1. aec_data/Detailed Receipts.csv
 *      Columns: Financial Year | Return Type | Recipient Name | Received From | Receipt Type | Value
 *      Filter:  Return Type IN ('Member of HOR Return', 'Member of Senate Return')
 *
 *   2. aec_data/MemberOfParliamentReturns.csv
 *      Columns: Financial Year | Return Type | Name | Total Donations Received | Number of Donors
 *      Provides aggregate totals per MP/Senator per year.
 *      We only insert rows where Total Donations Received > 0 AND no individual
 *      detail records already exist (or can be inserted) for that politician+year
 *      from File 1. donor_name is set to '[AEC aggregate total]'.
 *
 *   3. aec_data/Donor Donations Received.csv
 *      Columns: Financial Year | Name | Donation Received From | Date | Value
 *      `Name` is the recipient entity (usually an organisation, rarely a politician).
 *      We attempt to match `Name` against the politicians table; where matched we
 *      treat each row as a politician←donor donation record.
 *
 * ID format: aec_{year}_{politicianId}_{hex8(md5(donorName.toLowerCase().trim()))}
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── CSV parser (handles quoted fields with embedded commas/newlines, CRLF/LF) ─
function parseCSV(text) {
  const rows = [];
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let i = 0;
  while (i < src.length) {
    // skip blank lines
    while (i < src.length && src[i] === '\n') i++;
    if (i >= src.length) break;

    const fields = [];
    while (i < src.length && src[i] !== '\n') {
      if (src[i] === '"') {
        // quoted field
        i++; // skip opening quote
        let val = '';
        while (i < src.length) {
          if (src[i] === '"' && src[i + 1] === '"') { val += '"'; i += 2; }
          else if (src[i] === '"') { i++; break; }
          else { val += src[i++]; }
        }
        fields.push(val);
        // skip comma separator
        if (i < src.length && src[i] === ',') i++;
      } else {
        // unquoted field
        let start = i;
        while (i < src.length && src[i] !== ',' && src[i] !== '\n') i++;
        fields.push(src.slice(start, i));
        if (i < src.length && src[i] === ',') i++;
      }
    }
    if (i < src.length && src[i] === '\n') i++;
    if (fields.length > 0) rows.push(fields);
  }
  return rows;
}

// ── Name normalisation ─────────────────────────────────────────────────────
// Strip leading prefixes and trailing suffixes to get a bare name for matching.
const PREFIX_RE = /^(?:Hon(?:ourable)?|Dr|Mr|Ms|Mrs|Miss|Prof|Senator(?:\s+the\s+Hon)?|the\s+Hon)\s+/gi;
const SUFFIX_RE = /[\s,]+(?:MP|OAM|AM|AO|QC|SC|MHA)\b/gi;

function normaliseName(name) {
  let n = name.trim();
  let prev;
  // strip all leading prefixes iteratively
  do { prev = n; n = n.replace(PREFIX_RE, '').trim(); PREFIX_RE.lastIndex = 0; } while (n !== prev);
  // strip all trailing suffixes iteratively
  do { prev = n; n = n.replace(SUFFIX_RE, '').trim(); SUFFIX_RE.lastIndex = 0; } while (n !== prev);
  return n.toLowerCase();
}

// ── Hex-8 from donor name ──────────────────────────────────────────────────
function hex8(str) {
  return createHash('md5').update(str.toLowerCase().trim()).digest('hex').slice(0, 8);
}

// ── Financial year end integer ─────────────────────────────────────────────
// "2024-25" → 2025,  "2020-21" → 2021
function fyEnd(fy) {
  const m = fy.trim().match(/(\d{4})-(\d{2,4})$/);
  if (!m) throw new Error(`Unexpected financial year format: "${fy}"`);
  return parseInt(m[1], 10) + 1;
}

// ── SQL escape ─────────────────────────────────────────────────────────────
function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

// ── Run wrangler D1 command ────────────────────────────────────────────────
function d1(sql) {
  const cmd = `npx wrangler d1 execute australiafirst --remote --json --command ${JSON.stringify(sql)}`;
  const raw = execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(raw);
}

// ── Batch insert helper ────────────────────────────────────────────────────
const BATCH = 50;

function batchInsert(rows, label) {
  if (rows.length === 0) {
    console.log(`  [${label}] Nothing to insert.`);
    return 0;
  }
  let totalInserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = batch.map(r =>
      `(${esc(r.id)},${esc(r.politician_id)},${esc(r.donor_name)},${r.amount_cents},${r.year},'AEC','https://transparency.aec.gov.au/MemberOfParliament',${esc(r.notes)})`
    ).join(',');
    const sql = `INSERT OR IGNORE INTO donations (id,politician_id,donor_name,amount_cents,year,source,source_url,notes) VALUES ${values}`;
    const res = d1(sql);
    const changes = res[0]?.meta?.changes ?? 0;
    totalInserted += changes;
    process.stdout.write(`  [${label}] Batch ${Math.floor(i / BATCH) + 1}: ${changes} inserted (${totalInserted} total so far)\n`);
  }
  return totalInserted;
}

// ══ MAIN ══════════════════════════════════════════════════════════════════

// 1. Fetch all politicians from D1 and build a normalised name→politician map
console.log('Fetching politicians from D1…');
const polResult = d1('SELECT id, name FROM politicians');
const politicians = polResult[0]?.results ?? [];
console.log(`Politicians in DB: ${politicians.length}`);

const polMap = new Map(); // normalisedName → {id, name}
for (const p of politicians) {
  const key = normaliseName(p.name);
  if (key) polMap.set(key, p);
}

// 2. Fetch existing AEC donation IDs to avoid duplicate work
console.log('Fetching existing AEC donation IDs from D1…');
const existingResult = d1('SELECT id FROM donations WHERE source=\'AEC\'');
const existingIds = new Set((existingResult[0]?.results ?? []).map(r => r.id));
console.log(`Existing AEC donations: ${existingIds.size}\n`);

// ── File 1: Detailed Receipts.csv ─────────────────────────────────────────
// Columns: Financial Year[0], Return Type[1], Recipient Name[2], Received From[3], Receipt Type[4], Value[5]
console.log('=== File 1: Detailed Receipts.csv ===');
const ALLOWED_TYPES = new Set(['Member of HOR Return', 'Member of Senate Return']);

const detailedPath = join(ROOT, 'aec_data/Detailed Receipts.csv');
const detailedRows = parseCSV(readFileSync(detailedPath, 'utf-8'));
const detailedData = detailedRows.slice(1).filter(r => ALLOWED_TYPES.has(r[1]));
console.log(`Total MoP rows in CSV (after type filter): ${detailedData.length}`);

const file1Matched = [];
const file1Unmatched = new Set();

for (const row of detailedData) {
  const [financialYear, , recipientName, receivedFrom, receiptType, valueStr] = row;
  const normRecipient = normaliseName(recipientName);
  const pol = polMap.get(normRecipient);

  if (!pol) {
    file1Unmatched.add(recipientName);
    continue;
  }

  const year = fyEnd(financialYear);
  const donorName = receivedFrom.trim();
  const amountCents = Math.round(parseFloat(valueStr || '0') * 100);
  const id = `aec_${year}_${pol.id}_${hex8(donorName)}`;

  if (existingIds.has(id)) continue; // already in DB (INSERT OR IGNORE handles it too, but saves bandwidth)

  file1Matched.push({ id, politician_id: pol.id, donor_name: donorName, amount_cents: amountCents, year, notes: receiptType });
}

console.log(`Matched: ${file1Matched.length}  |  Unmatched politician names: ${file1Unmatched.size}`);
if (file1Unmatched.size > 0) {
  console.log('Unmatched names from File 1:');
  for (const n of [...file1Unmatched].sort()) console.log(`  - ${n}`);
}

// Deduplicate by ID (same politician + donor + year combination)
const file1Deduped = [...new Map(file1Matched.map(r => [r.id, r])).values()];
console.log(`After dedup: ${file1Deduped.length} rows to insert`);
const file1Inserted = batchInsert(file1Deduped, 'DetailedReceipts');
console.log(`File 1 done: ${file1Inserted} new rows inserted.\n`);

// Track which politician+year combos we now have individual detail rows for
const detailCoveredKeys = new Set(
  detailedData
    .map(row => {
      const pol = polMap.get(normaliseName(row[2]));
      if (!pol) return null;
      return `${pol.id}_${fyEnd(row[0])}`;
    })
    .filter(Boolean)
);

// ── File 2: MemberOfParliamentReturns.csv ─────────────────────────────────
// Columns: Financial Year[0], Return Type[1], Name[2], Total Donations Received[3], Number of Donors[4]
// Strategy: For MP/year combos NOT covered by individual rows in File 1 (i.e. where
//   File 1 had no matching entries), insert a single aggregate record.
//   Donor name = '[AEC aggregate total]'
//   This avoids double-counting for MPs who ARE covered by File 1.
console.log('=== File 2: MemberOfParliamentReturns.csv ===');
const mpPath = join(ROOT, 'aec_data/MemberOfParliamentReturns.csv');
const mpRows = parseCSV(readFileSync(mpPath, 'utf-8'));
const mpData = mpRows.slice(1); // drop header
console.log(`Total rows in CSV: ${mpData.length}`);

const file2Matched = [];
const file2Unmatched = new Set();

for (const row of mpData) {
  const [financialYear, returnType, polName, totalStr] = row;
  const total = parseFloat(totalStr || '0');
  if (total <= 0) continue; // skip zero-donation rows

  const normName = normaliseName(polName);
  const pol = polMap.get(normName);
  if (!pol) {
    file2Unmatched.add(polName);
    continue;
  }

  const year = fyEnd(financialYear);
  const coveredKey = `${pol.id}_${year}`;

  // Skip if we have (or will have) individual-level rows from File 1 for this combo
  if (detailCoveredKeys.has(coveredKey)) continue;

  const donorName = '[AEC aggregate total]';
  const amountCents = Math.round(total * 100);
  const id = `aec_${year}_${pol.id}_${hex8(donorName)}`;

  if (existingIds.has(id)) continue;

  file2Matched.push({ id, politician_id: pol.id, donor_name: donorName, amount_cents: amountCents, year, notes: returnType });
}

console.log(`Matched: ${file2Matched.length}  |  Unmatched politician names: ${file2Unmatched.size}`);
if (file2Unmatched.size > 0) {
  console.log('Unmatched names from File 2:');
  for (const n of [...file2Unmatched].sort()) console.log(`  - ${n}`);
}

const file2Deduped = [...new Map(file2Matched.map(r => [r.id, r])).values()];
console.log(`After dedup: ${file2Deduped.length} rows to insert`);
const file2Inserted = batchInsert(file2Deduped, 'MPReturns');
console.log(`File 2 done: ${file2Inserted} new rows inserted.\n`);

// ── File 3: Donor Donations Received.csv ──────────────────────────────────
// Columns: Financial Year[0], Name[1], Donation Received From[2], Date[3], Value[4]
// `Name` = recipient entity. We try to match it against politicians.
// For most rows `Name` is an organisation (Climate 200, etc.) and won't match —
// those are logged as unmatched. Any politician name found is treated as a
// direct politician←donor record.
console.log('=== File 3: Donor Donations Received.csv ===');
const donorPath = join(ROOT, 'aec_data/Donor Donations Received.csv');
const donorRows = parseCSV(readFileSync(donorPath, 'utf-8'));
const donorData = donorRows.slice(1);
console.log(`Total rows in CSV: ${donorData.length}`);

const file3Matched = [];
const file3Unmatched = new Set();

for (const row of donorData) {
  const [financialYear, recipientName, donorNameRaw, , valueStr] = row;
  const normName = normaliseName(recipientName);
  const pol = polMap.get(normName);

  if (!pol) {
    file3Unmatched.add(recipientName.trim());
    continue;
  }

  const year = fyEnd(financialYear);
  const donorName = donorNameRaw.trim();
  const amountCents = Math.round(parseFloat(valueStr || '0') * 100);
  const id = `aec_${year}_${pol.id}_${hex8(donorName)}`;

  if (existingIds.has(id)) continue;

  file3Matched.push({ id, politician_id: pol.id, donor_name: donorName, amount_cents: amountCents, year, notes: 'Donor Donations Received' });
}

console.log(`Matched: ${file3Matched.length}  |  Unmatched entities (non-politicians): ${file3Unmatched.size}`);
if (file3Matched.length > 0) {
  console.log('Matched politician names from File 3:');
  const seenPols = new Set(file3Matched.map(r => r.politician_id));
  for (const id of seenPols) {
    const pol = politicians.find(p => p.id === id);
    console.log(`  - ${pol?.name} (${id})`);
  }
}

const file3Deduped = [...new Map(file3Matched.map(r => [r.id, r])).values()];
console.log(`After dedup: ${file3Deduped.length} rows to insert`);
const file3Inserted = batchInsert(file3Deduped, 'DonorDonationsReceived');
console.log(`File 3 done: ${file3Inserted} new rows inserted.\n`);

// ── Summary ───────────────────────────────────────────────────────────────
const grandTotal = file1Inserted + file2Inserted + file3Inserted;
console.log('════════════════════════════════════════');
console.log(`Grand total new donations inserted: ${grandTotal}`);
console.log(`  File 1 (Detailed Receipts):        ${file1Inserted}`);
console.log(`  File 2 (MP Returns aggregate):     ${file2Inserted}`);
console.log(`  File 3 (Donor Donations Received): ${file3Inserted}`);
console.log('════════════════════════════════════════');
