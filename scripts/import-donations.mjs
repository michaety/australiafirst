import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CSV parser (handles quoted fields, CRLF/LF) ────────────────────────────
function parseCSV(text) {
  const rows = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let val = '';
        i++; // skip opening quote
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
          else if (line[i] === '"') { i++; break; }
          else { val += line[i++]; }
        }
        fields.push(val);
        if (line[i] === ',') i++;
      } else {
        const end = line.indexOf(',', i);
        if (end === -1) { fields.push(line.slice(i)); break; }
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
    rows.push(fields);
  }
  return rows;
}

// ── Name normalisation ─────────────────────────────────────────────────────
const PREFIX_RE = /^(?:Hon|Dr|Mr|Ms|Mrs|Prof|Senator)\s+/gi;
const SUFFIX_RE = /[\s,]+(?:MP|OAM|AM|AO|QC|SC)\b/gi;

function normaliseName(name) {
  let n = name.trim();
  // strip all leading prefixes (may be multiple, e.g. "Hon Dr")
  let prev;
  do { prev = n; n = n.replace(PREFIX_RE, '').trim(); PREFIX_RE.lastIndex = 0; } while (n !== prev);
  // strip all trailing suffixes (may be multiple, e.g. "OAM MP")
  do { prev = n; n = n.replace(SUFFIX_RE, '').trim(); SUFFIX_RE.lastIndex = 0; } while (n !== prev);
  return n.toLowerCase();
}

// ── Hex-8 from donor name ──────────────────────────────────────────────────
function hex8(str) {
  return createHash('md5').update(str.toLowerCase().trim()).digest('hex').slice(0, 8);
}

// ── Financial year end integer ─────────────────────────────────────────────
// "2024-25" → 2025,  "2023-24" → 2024
function fyEnd(fy) {
  const m = fy.match(/(\d{4})-(\d{2,4})$/);
  if (!m) throw new Error(`Unexpected financial year format: ${fy}`);
  const base = parseInt(m[1], 10);
  return base + 1; // "2024-25" end year is 2025
}

// ── SQL escape ────────────────────────────────────────────────────────────
function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

// ── Run wrangler D1 command ────────────────────────────────────────────────
function d1(sql) {
  const cmd = `npx wrangler d1 execute australiafirst --remote --json --command ${JSON.stringify(sql)}`;
  const raw = execSync(cmd, { cwd: join(__dirname, '..'), encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(raw);
}

// ══ MAIN ══════════════════════════════════════════════════════════════════

// 1. Load and filter CSV
const csvPath = join(__dirname, '../aec_data/Detailed Receipts.csv');
const rows = parseCSV(readFileSync(csvPath, 'utf-8'));

const ALLOWED_TYPES = new Set(['Member of HOR Return', 'Member of Senate Return']);

// header row: Financial Year, Return Type, Recipient Name, Received From, Receipt Type, Value
const dataRows = rows.slice(1).filter(r => ALLOWED_TYPES.has(r[1]));
console.log(`Total MoP rows in CSV: ${dataRows.length}`);

// 2. Fetch all politicians from D1
console.log('Fetching politicians from D1…');
const polResult = d1('SELECT id, name FROM politicians');
const politicians = polResult[0]?.results ?? [];
console.log(`Politicians in DB: ${politicians.length}`);

// Build normalised lookup map  name→{id, name}
const polMap = new Map();
for (const p of politicians) {
  const key = normaliseName(p.name);
  if (key) polMap.set(key, p);
}

// 3. Match each row to a politician
const matched = [];
const unmatched = new Set();

for (const row of dataRows) {
  const [financialYear, , recipientName, receivedFrom, receiptType, valueStr] = row;
  const normRecipient = normaliseName(recipientName);
  const pol = polMap.get(normRecipient);

  if (!pol) {
    unmatched.add(recipientName);
    continue;
  }

  const year = fyEnd(financialYear);
  const amountCents = Math.round(parseFloat(valueStr) * 100);
  const donorName = receivedFrom.trim();
  const id = `aec_${year}_${pol.id}_${hex8(donorName)}`;

  matched.push({ id, politician_id: pol.id, donor_name: donorName, amount_cents: amountCents, year, receipt_type: receiptType });
}

console.log(`Matched: ${matched.length}  |  Unmatched politicians: ${unmatched.size}`);
if (unmatched.size > 0) {
  console.log('Unmatched names:');
  for (const n of [...unmatched].sort()) console.log(`  - ${n}`);
}

if (matched.length === 0) {
  console.log('Nothing to insert.');
  process.exit(0);
}

// 4. Deduplicate by id (keep last occurrence, consistent with INSERT OR IGNORE keeping first)
const deduped = [...new Map(matched.map(r => [r.id, r])).values()];
console.log(`After dedup: ${deduped.length} rows to insert`);

// 5. Bulk insert in batches of 50
const BATCH = 50;
let inserted = 0;

for (let i = 0; i < deduped.length; i += BATCH) {
  const batch = deduped.slice(i, i + BATCH);
  const values = batch.map(r =>
    `(${esc(r.id)},${esc(r.politician_id)},${esc(r.donor_name)},${r.amount_cents},${r.year},'AEC','https://transparency.aec.gov.au/MemberOfParliament',${esc(r.receipt_type)})`
  ).join(',');
  const sql = `INSERT OR IGNORE INTO donations (id,politician_id,donor_name,amount_cents,year,source,source_url,notes) VALUES ${values}`;
  const res = d1(sql);
  const changes = res[0]?.meta?.changes ?? 0;
  inserted += changes;
  process.stdout.write(`  Batch ${Math.floor(i / BATCH) + 1}: ${changes} inserted (${inserted} total so far)\n`);
}

console.log(`\nDone. ${inserted} new rows inserted into donations.`);
