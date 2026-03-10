/**
 * scripts/extract-promises.mjs
 *
 * For each politician (5 per run), fetches their recent Hansard speeches via
 * the OpenAustralia API, strips HTML, sends the text to Cloudflare Workers AI
 * (llama-3.1-8b-instruct) to extract specific measurable promises, and inserts
 * results into the D1 `promises` table.
 *
 * Progress is tracked in KV under the key "extract-promises:offset" so runs
 * resume where they left off.
 *
 * Usage:
 *   CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx node scripts/extract-promises.mjs
 *
 * Optional env vars:
 *   BATCH_SIZE=5        Number of politicians per run (default: 5)
 *   RESET_OFFSET=1      Reset KV progress to 0 before running
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const OA_API_KEY   = 'Bp5GG2FZowR6E9aDopCGUGoz';
const DB_NAME      = 'australiafirst';
const KV_KEY       = 'extract-promises:offset';
const BATCH_SIZE   = parseInt(process.env.BATCH_SIZE ?? '5', 10);
const AI_MODEL     = '@cf/meta/llama-3.1-8b-instruct';

// OA senator member_ids are 6-digit numbers (100xxx range)
function inferOaType(oaId) {
  return parseInt(oaId, 10) >= 100000 ? 'senate' : 'representatives';
}

// Scrape the OA MP/Senator profile page to extract recent speech gids.
// Falls back when the person-based API search index has no results.
async function getProfileGids(oaId, type) {
  const profileUrl = type === 'senate'
    ? `https://www.openaustralia.org.au/senator/?m=${oaId}`
    : `https://www.openaustralia.org.au/mp/?m=${oaId}`;
  try {
    const res = await fetch(profileUrl, {
      headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const gids = [];
    const re = /\/(?:debates|senate)\/\?id=([\d\-]+\.[\d]+\.[\d]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) gids.push(m[1]);
    return [...new Set(gids)];          // deduplicate, preserve order
  } catch {
    return [];
  }
}

// Fetch individual speeches from a section gid; filters to the target speaker.
async function fetchSpeechesByGid(oaId, type, sectionGid) {
  const url = `https://www.openaustralia.org.au/api/getDebates?key=${OA_API_KEY}&type=${type}&gid=${sectionGid}&output=js`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
    });
    if (!res.ok) return [];
    const items = await res.json();
    if (!Array.isArray(items)) return [];
    return items.filter(
      item => item.speaker?.member_id === String(oaId) && item.body
    );
  } catch {
    return [];
  }
}

// ── Credentials ─────────────────────────────────────────────────────────────
function loadEnv() {
  const vars = {};
  const devVarsPath = join(ROOT, '.dev.vars');
  if (existsSync(devVarsPath)) {
    for (const line of readFileSync(devVarsPath, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
      if (m) vars[m[1]] = m[2].trim();
    }
  }
  return {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? vars.CLOUDFLARE_ACCOUNT_ID,
    apiToken:  process.env.CLOUDFLARE_API_TOKEN  ?? vars.CLOUDFLARE_API_TOKEN,
  };
}

// Wrangler env: strip CLOUDFLARE_API_TOKEN so wrangler uses its own login session
// (the token passed via env is scoped to AI only and lacks D1/KV permissions)
const wranglerEnv = { ...process.env };
delete wranglerEnv.CLOUDFLARE_API_TOKEN;

// ── wrangler helper (avoids shell variable expansion of $ in SQL/values) ─────
function wrangler(args) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    cwd: ROOT, encoding: 'utf-8', env: wranglerEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return result.stdout;
}

// ── D1 helpers ───────────────────────────────────────────────────────────────
function d1(sql) {
  const raw = wrangler(['d1', 'execute', DB_NAME, '--remote', '--json', '--command', sql]);
  return JSON.parse(raw);
}

// ── KV helpers ───────────────────────────────────────────────────────────────
function kvGet(key) {
  try {
    return wrangler(['kv', 'key', 'get', key, '--binding=KV', '--preview', 'false', '--remote']).trim();
  } catch {
    return null;
  }
}

function kvPut(key, value) {
  wrangler(['kv', 'key', 'put', key, String(value), '--binding=KV', '--preview', 'false', '--remote']);
}

// ── SQL escape ───────────────────────────────────────────────────────────────
function esc(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

// ── HTML → plain text ────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Deterministic ID ─────────────────────────────────────────────────────────
function hashId(parts) {
  let h = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return 'promise_' + Math.abs(h).toString(36);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Extract JSON array from AI response ──────────────────────────────────────
function extractJsonArray(text) {
  // Handle markdown code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : text.trim();

  const start = candidate.indexOf('[');
  const end   = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Cloudflare Workers AI ────────────────────────────────────────────────────
async function callAI(accountId, apiToken, politicianName, speechText) {
  const systemPrompt =
    'You extract structured data from Australian parliamentary speeches and return only valid JSON arrays. Never include explanatory text outside the JSON.';

  const userPrompt = `Analyze these Hansard speeches by ${politicianName} and extract specific, measurable promises or commitments.

A qualifying promise must:
- Be a commitment to take a future action or achieve a measurable outcome
- Be something ${politicianName} personally committed to (not describing existing policy)
- Be concrete enough that it can later be verified as kept or broken

Speeches:
---
${speechText.slice(0, 6000)}
---

Return ONLY a JSON array. If no promises found, return [].
Each element must have exactly these fields:
  "title"       – concise title, max 80 chars
  "description" – full context of the commitment, 1–2 sentences
  "made_date"   – date of the speech in YYYY-MM-DD format, or null if unknown
  "status"      – always the string "pending"

JSON array only, no other text:`;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${AI_MODEL}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        max_tokens: 1024,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CF AI ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return extractJsonArray(data?.result?.response ?? '');
}

// ══ MAIN ════════════════════════════════════════════════════════════════════

const { accountId, apiToken } = loadEnv();

if (!accountId || !apiToken) {
  console.error('ERROR: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.');
  console.error('  CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=xxx node scripts/extract-promises.mjs');
  process.exit(1);
}

// Optionally reset progress
if (process.env.RESET_OFFSET === '1') {
  console.log('Resetting KV progress to 0...');
  kvPut(KV_KEY, 0);
}

// 1. Fetch politicians — OpenAustralia ID is encoded in the `id` column as "oa_{person_id}"
console.log('Fetching politicians from D1...');
const polResult = d1('SELECT id, name FROM politicians ORDER BY name ASC');
const allPoliticians = (polResult[0]?.results ?? [])
  .map(p => {
    // Try external_ids JSON first, fall back to "oa_NNN" id prefix
    let oaId = null;
    if (p.external_ids) {
      try { oaId = JSON.parse(p.external_ids).openaustralia ?? null; } catch {}
    }
    if (!oaId && p.id?.startsWith('oa_')) {
      oaId = p.id.slice(3); // strip "oa_" prefix
    }
    return { ...p, oaId };
  })
  .filter(p => p.oaId);
console.log(`  ${allPoliticians.length} politicians with OpenAustralia IDs`);

// 2. Load offset from KV
const savedOffset = parseInt(kvGet(KV_KEY) ?? '0', 10) || 0;
const batch = allPoliticians.slice(savedOffset, savedOffset + BATCH_SIZE);

if (batch.length === 0) {
  console.log(`All ${allPoliticians.length} politicians processed. Run with RESET_OFFSET=1 to restart.`);
  process.exit(0);
}

console.log(`\nProcessing politicians ${savedOffset + 1}–${savedOffset + batch.length} of ${allPoliticians.length}\n`);

let totalInserted = 0;

for (const pol of batch) {
  const oaId = pol.oaId;

  console.log(`── ${pol.name} (OA: ${oaId})`);

  // 3. Fetch recent Hansard speeches from OpenAustralia
  const oaType = inferOaType(oaId);
  let speeches = [];

  // 3a. Try the person-based search API first (fast path, works if OA index is populated)
  try {
    const url = `https://www.openaustralia.org.au/api/getDebates?key=${OA_API_KEY}&type=${oaType}&person=${oaId}&num=10&output=js`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const rows = data;
        speeches = rows
          .map(r => ({
            text:      stripHtml(r.body ?? r.speech ?? ''),
            date:      r.hdate ?? r.date ?? null,
            sourceUrl: r.gid ? `https://www.openaustralia.org.au/debates/?id=${r.gid}` : null,
          }))
          .filter(s => s.text.length > 50);
      }
    }
  } catch { /* fall through to profile-page method */ }

  // 3b. Fallback: scrape MP/Senator profile page for speech gids, then fetch each
  if (speeches.length === 0) {
    console.log(`  Person search empty – scraping profile page...`);
    const gids = await getProfileGids(oaId, oaType);
    console.log(`  Profile gids found: ${gids.length}`);

    for (const gid of gids.slice(0, 10)) {
      const items = await fetchSpeechesByGid(oaId, oaType, gid);
      for (const item of items) {
        const text = stripHtml(item.body ?? '');
        if (text.length > 50) {
          speeches.push({
            text,
            date:      item.hdate ?? null,
            sourceUrl: `https://www.openaustralia.org.au/debates/?id=${gid}`,
          });
        }
      }
      await sleep(300);
      if (speeches.length >= 10) break;
    }
  }

  if (speeches.length === 0) {
    console.log(`  No usable speeches`);
    await sleep(500);
    continue;
  }

  console.log(`  ${speeches.length} speech segment(s) retrieved`);

  // 4. Combine speech text for AI
  const combinedText = speeches
    .map(s => `[${s.date ?? 'date unknown'}]\n${s.text}`)
    .join('\n\n');

  // 5. Call CF AI
  let promises;
  try {
    promises = await callAI(accountId, apiToken, pol.name, combinedText);
    console.log(`  AI found ${promises.length} promise(s)`);
  } catch (e) {
    console.log(`  ✗ AI error: ${e.message}`);
    await sleep(2000);
    continue;
  }

  // 6. Insert valid promises into D1
  const valid = promises.filter(p => p?.title && typeof p.title === 'string' && p.title.trim().length > 3);

  for (const promise of valid) {
    const id        = hashId([pol.id, promise.title.trim()]);
    const title     = promise.title.trim().slice(0, 200);
    const desc      = promise.description?.trim() ?? null;
    const madeDate  = /^\d{4}-\d{2}-\d{2}$/.test(promise.made_date ?? '')
      ? promise.made_date
      : (speeches[0]?.date ?? null);
    const sourceUrl = speeches[0]?.sourceUrl ?? null;

    const sql = `
      INSERT INTO promises (id, politician_id, title, description, made_date, status, source_url)
      VALUES (${esc(id)}, ${esc(pol.id)}, ${esc(title)}, ${esc(desc)}, ${esc(madeDate)}, 'pending', ${esc(sourceUrl)})
      ON CONFLICT(id) DO UPDATE SET
        title       = excluded.title,
        description = excluded.description,
        made_date   = excluded.made_date,
        source_url  = excluded.source_url
    `.trim().replace(/\s+/g, ' ');

    try {
      d1(sql);
      console.log(`    + "${title.slice(0, 70)}"`);
      totalInserted++;
    } catch (e) {
      console.error(`    ✗ Insert failed: ${e.message?.slice(0, 120)}`);
    }
  }

  await sleep(1000);
}

// 7. Save new offset to KV
const newOffset = savedOffset + batch.length;
kvPut(KV_KEY, newOffset);

console.log(`\n${'─'.repeat(60)}`);
console.log(`Batch complete.`);
console.log(`  Promises inserted/updated : ${totalInserted}`);
console.log(`  KV offset saved           : ${newOffset} / ${allPoliticians.length}`);
if (newOffset < allPoliticians.length) {
  console.log(`  Run again to process the next ${BATCH_SIZE}.`);
} else {
  console.log(`  All politicians processed. Run with RESET_OFFSET=1 to restart.`);
}
