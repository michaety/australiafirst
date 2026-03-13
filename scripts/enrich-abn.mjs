#!/usr/bin/env node
/**
 * enrich-abn.mjs
 * Fetches missing ABN data from the Australian Business Register (ABR)
 * and updates the ndis_providers table in D1.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=your_token node scripts/enrich-abn.mjs
 *
 * Get your Cloudflare API token at: https://dash.cloudflare.com/profile/api-tokens
 * Needs "D1:Edit" permission on the australiafirst database.
 */

const CF_ACCOUNT_ID  = '99219c560167b5a8192acb36f0fe2b76';
const CF_DATABASE_ID = 'f9e743c7-e125-4d30-a75c-60d4c5fe52eb';
const ABR_GUID       = '425a7c39-0aba-45fb-b15c-15e1beb657f6';
const ABR_BASE       = 'https://abr.business.gov.au/json/AbnDetails.aspx';

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!CF_TOKEN) {
  console.error('Error: CLOUDFLARE_API_TOKEN env var is required');
  process.exit(1);
}

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_DATABASE_ID}/query`;

async function d1(sql, params = []) {
  const res = await fetch(D1_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  return json.result[0];
}

async function lookupAbn(abn) {
  const url = `${ABR_BASE}?abn=${abn}&guid=${ABR_GUID}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`ABR HTTP ${res.status}`);
  const text = await res.text();
  // ABR sometimes wraps in a callback — strip it if present
  const stripped = text.trim().replace(/^[^(]*\(/, '').replace(/\);?\s*$/, '');
  return JSON.parse(stripped);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Fetch all providers missing abn_status
  const result = await d1(
    `SELECT id, abn, legal_name FROM ndis_providers WHERE abn_status IS NULL AND abn IS NOT NULL ORDER BY id`
  );
  const providers = result.results;
  console.log(`Found ${providers.length} providers missing ABN data\n`);

  let ok = 0, notFound = 0, errors = 0;
  const BATCH = 5;
  const DELAY = 250; // ms between batches (~20 req/s, well within ABR limits)

  for (let i = 0; i < providers.length; i += BATCH) {
    const batch = providers.slice(i, i + BATCH);

    await Promise.all(batch.map(async (p) => {
      try {
        const abr = await lookupAbn(p.abn);

        if (abr.Message && abr.Message.toLowerCase().includes('not found')) {
          notFound++;
          console.log(`  NOT FOUND  ${p.abn}  ${p.legal_name}`);
          // Mark as looked-up so we don't retry it forever
          await d1(
            `UPDATE ndis_providers SET abn_status = 'Not found', updated_at = datetime('now') WHERE id = ?`,
            [p.id]
          );
          return;
        }

        const abnStatus   = abr.AbnStatus         || null;
        const entityType  = abr.EntityTypeName     || null;
        const abnRegDate  = abr.AbnStatusEffectiveFrom
          ? abr.AbnStatusEffectiveFrom.split('T')[0]
          : null;
        const gstRegDate  = abr.Gst && abr.Gst !== ''
          ? abr.Gst.split('T')[0]
          : null;

        await d1(
          `UPDATE ndis_providers
           SET abn_status = ?, entity_type = ?, abn_reg_date = ?, gst_reg_date = ?, updated_at = datetime('now')
           WHERE id = ?`,
          [abnStatus, entityType, abnRegDate, gstRegDate, p.id]
        );

        ok++;
        const line = `  OK  ${p.abn}  ${abnStatus}  ${entityType}  reg:${abnRegDate}  gst:${gstRegDate ?? 'none'}`;
        console.log(line);
      } catch (err) {
        errors++;
        console.error(`  ERR  ${p.abn}  ${p.legal_name}  —  ${err.message}`);
      }
    }));

    const done = Math.min(i + BATCH, providers.length);
    process.stdout.write(`\r[${done}/${providers.length}] ok:${ok} not_found:${notFound} errors:${errors}`);

    if (i + BATCH < providers.length) await sleep(DELAY);
  }

  console.log(`\n\nDone. ok:${ok}  not_found:${notFound}  errors:${errors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
