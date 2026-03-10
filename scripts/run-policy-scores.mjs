/**
 * Standalone script to run the policy-scores ETL directly via wrangler D1.
 *
 * Usage:
 *   THEYVOTEFORYOU_API_KEY=your_key node scripts/run-policy-scores.mjs
 *
 * Or set the key in .dev.vars:
 *   THEYVOTEFORYOU_API_KEY=your_key
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load API key ───────────────────────────────────────────────────────────
function loadApiKey() {
  // 1. From environment
  if (process.env.THEYVOTEFORYOU_API_KEY) return process.env.THEYVOTEFORYOU_API_KEY;

  // 2. From .dev.vars
  const devVarsPath = join(ROOT, '.dev.vars');
  if (existsSync(devVarsPath)) {
    const content = readFileSync(devVarsPath, 'utf-8');
    const match = content.match(/^THEYVOTEFORYOU_API_KEY\s*=\s*(.+)$/m);
    if (match) return match[1].trim();
  }

  // 3. From wrangler secrets (not easily readable — user must pass via env)
  return null;
}

// ── D1 helpers ─────────────────────────────────────────────────────────────
function d1Query(sql) {
  const cmd = `npx wrangler d1 execute australiafirst --remote --json --command ${JSON.stringify(sql)}`;
  const raw = execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(raw);
}

function d1Execute(sql) {
  const cmd = `npx wrangler d1 execute australiafirst --remote --json --command ${JSON.stringify(sql)}`;
  const raw = execSync(cmd, { cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(raw);
}

// ── SQL escape ─────────────────────────────────────────────────────────────
function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

// ── Name normalisation ─────────────────────────────────────────────────────
const PREFIX_RE = /^(?:Hon|Dr|Mr|Ms|Mrs|Prof|Senator)\s+/gi;
const SUFFIX_RE = /[\s,]+(?:MP|OAM|AM|AO|QC|SC)\b/gi;

function normaliseName(name) {
  let n = name.trim();
  let prev;
  do { prev = n; n = n.replace(PREFIX_RE, '').trim(); PREFIX_RE.lastIndex = 0; } while (n !== prev);
  do { prev = n; n = n.replace(SUFFIX_RE, '').trim(); SUFFIX_RE.lastIndex = 0; } while (n !== prev);
  return n.toLowerCase();
}

// ══ MAIN ══════════════════════════════════════════════════════════════════

const apiKey = loadApiKey();
if (!apiKey) {
  console.error('ERROR: THEYVOTEFORYOU_API_KEY not found.');
  console.error('Set it via:');
  console.error('  THEYVOTEFORYOU_API_KEY=your_key node scripts/run-policy-scores.mjs');
  console.error('  -- or --');
  console.error('  Add THEYVOTEFORYOU_API_KEY=your_key to .dev.vars');
  process.exit(1);
}

const TVFY_BASE = 'https://theyvoteforyou.org.au/api/v1';
const BATCH = 50;

// 1. Fetch politicians from D1
console.log('Fetching politicians from D1...');
const polResult = d1Query('SELECT id, name FROM politicians');
const politicians = polResult[0]?.results ?? [];
console.log(`Politicians in DB: ${politicians.length}`);

const polMap = new Map();
const lastNameMap = new Map();
for (const p of politicians) {
  const key = normaliseName(p.name);
  if (key) polMap.set(key, p.id);
  const parts = key.split(' ');
  const ln = parts[parts.length - 1];
  if (ln && !lastNameMap.has(ln)) {
    lastNameMap.set(ln, p.id);
  } else if (ln) {
    lastNameMap.set(ln, '__ambiguous__');
  }
}

// 2. Fetch people list from TVFY
console.log('Fetching people from TVFY...');
const peopleRes = await fetch(`${TVFY_BASE}/people.json?key=${encodeURIComponent(apiKey)}`, {
  headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
});

if (!peopleRes.ok) {
  console.error(`TVFY people list failed: ${peopleRes.status}`);
  if (peopleRes.status === 401) console.error('API key is invalid.');
  process.exit(1);
}

const people = await peopleRes.json();
console.log(`TVFY people: ${people.length}`);

// 3. For each person, fetch details and collect policy scores
let totalInserted = 0;
let matched = 0;
let unmatched = 0;
const allRows = [];

for (const person of people) {
  // Names are nested: person.latest_member.name.first / .last
  const member = person.latest_member;
  if (!member) { unmatched++; continue; }

  const firstName = member.name?.first ?? '';
  const lastName = member.name?.last ?? '';
  if (!firstName && !lastName) { unmatched++; continue; }

  const fullName = `${firstName} ${lastName}`.trim();
  const normKey = normaliseName(fullName);
  let politicianId = polMap.get(normKey);

  // Last-name-only fallback
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
  process.stdout.write(`  Fetching policies for ${fullName} (tvfy:${person.id})...`);

  let detail;
  try {
    const detailRes = await fetch(`${TVFY_BASE}/people/${person.id}.json?key=${encodeURIComponent(apiKey)}`, {
      headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
    });
    if (!detailRes.ok) {
      console.log(` FAILED (${detailRes.status})`);
      continue;
    }
    detail = await detailRes.json();
  } catch (e) {
    console.log(` ERROR: ${e.message}`);
    continue;
  }

  const comparisons = detail.policy_comparisons ?? [];
  console.log(` ${comparisons.length} policies`);

  for (const comp of comparisons) {
    const { agree, disagree, absent, abstain } = comp.agreement;
    const total = agree + disagree + absent + abstain;
    const agreePlusDisagree = agree + disagree;
    const agreementPct = agreePlusDisagree > 0 ? (agree / agreePlusDisagree) * 100 : null;
    const id = `tvfy_${politicianId}_${comp.policy.id}`;

    allRows.push({
      id,
      politician_id: politicianId,
      policy_id: comp.policy.id,
      policy_name: comp.policy.name,
      policy_description: comp.policy.description ?? null,
      agreement_pct: agreementPct,
      votes_count: total,
    });
  }
}

console.log(`\nMatched: ${matched}  |  Unmatched: ${unmatched}  |  Total policy score rows: ${allRows.length}`);

if (allRows.length === 0) {
  console.log('Nothing to insert.');
  process.exit(0);
}

// 4. Insert in batches of 50 using wrangler D1 CLI
console.log(`Inserting in batches of ${BATCH}...`);

for (let i = 0; i < allRows.length; i += BATCH) {
  const batch = allRows.slice(i, i + BATCH);
  const values = batch.map(r =>
    `(${esc(r.id)},${esc(r.politician_id)},${r.policy_id},${esc(r.policy_name)},${esc(r.policy_description)},${r.agreement_pct === null ? 'NULL' : r.agreement_pct},${r.votes_count},'TVFY')`
  ).join(',\n  ');

  const sql = `INSERT INTO politician_policy_scores (id,politician_id,policy_id,policy_name,policy_description,agreement_pct,votes_count,source) VALUES\n  ${values}\nON CONFLICT(politician_id,policy_id) DO UPDATE SET\n  policy_name=excluded.policy_name,\n  policy_description=excluded.policy_description,\n  agreement_pct=excluded.agreement_pct,\n  votes_count=excluded.votes_count`;

  try {
    const res = d1Execute(sql);
    const changes = res[0]?.meta?.changes ?? 0;
    totalInserted += changes;
    const batchNum = Math.floor(i / BATCH) + 1;
    const totalBatches = Math.ceil(allRows.length / BATCH);
    process.stdout.write(`  Batch ${batchNum}/${totalBatches}: ${changes} upserted (${totalInserted} total so far)\n`);
  } catch (e) {
    console.error(`  Batch ${Math.floor(i / BATCH) + 1} failed:`, e.message?.slice(0, 200));
  }
}

console.log(`\nDone. ${totalInserted} rows inserted/updated in politician_policy_scores.`);
