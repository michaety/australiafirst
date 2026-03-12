import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

const ABR_BASE = 'https://abn.business.gov.au/json/AbnDetails.aspx';
const NDIS_PROVIDER_SEARCH = 'https://www.ndiscommission.gov.au/provider-registration/find-registered-provider';

// Strip JSONP wrapper: cb({...}) -> {...}
function parseAbrJsonp(text: string): Record<string, unknown> | null {
  try {
    const json = text.replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, '');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Normalise ABN to 11 digits (strip spaces/punctuation)
function normaliseAbn(raw: string): string {
  return raw.replace(/\D/g, '').padStart(11, '0').slice(-11);
}

// Fetch ABR data for a given ABN
async function fetchAbrData(abn: string): Promise<Record<string, unknown> | null> {
  const url = `${ABR_BASE}?abn=${abn}&callback=cb`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'OnTheRecord/1.0 public-interest-research' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return parseAbrJsonp(text);
  } catch {
    return null;
  }
}

// Attempt to find an ABN by searching the NDIS provider register
async function findAbnByName(legalName: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ providername: legalName });
    const url = `${NDIS_PROVIDER_SEARCH}?${params}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'OnTheRecord/1.0 public-interest-research' },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Look for ABN pattern in the page: 11 consecutive digits or formatted XX XXX XXX XXX
    const abnPattern = /ABN[:\s]*(\d[\d\s]{9,12}\d)/i;
    const match = html.match(abnPattern);
    if (match) return normaliseAbn(match[1]);

    // Also try data attribute or hidden field
    const dataAbn = html.match(/data-abn="(\d+)"/i);
    if (dataAbn) return normaliseAbn(dataAbn[1]);

    return null;
  } catch {
    return null;
  }
}

// Parse ISO date from ABR response
function abrDate(val: unknown): string | null {
  if (!val || typeof val !== 'string') return null;
  // ABR returns dates like "2010-01-01T00:00:00"
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10);
  return null;
}

export async function runNdisAbrETL(env: Env) {
  const { DB } = env;

  let enriched = 0;
  let abnFound = 0;
  let skipped = 0;

  // Find providers that need ABR enrichment
  const providers = await DB.prepare(`
    SELECT id, legal_name, abn, abn_status, state
    FROM ndis_providers
    WHERE abn IS NULL OR abn_status IS NULL
    LIMIT 100
  `).all();

  for (const provider of providers.results as Array<{id: string; legal_name: string; abn: string | null; abn_status: string | null; state: string | null}>) {
    let abn = provider.abn ? normaliseAbn(provider.abn) : null;

    // Step 1: Try to find ABN if not already known
    if (!abn) {
      abn = await findAbnByName(provider.legal_name);
      if (abn) abnFound++;
    }

    if (!abn) {
      skipped++;
      continue;
    }

    // Step 2: Fetch ABR data
    const abr = await fetchAbrData(abn);
    if (!abr) {
      skipped++;
      continue;
    }

    // Extract fields from ABR response
    const entityType   = (abr.entityTypeName as string) || (abr.EntityTypeName as string) || null;
    const abnStatus    = (abr.entityStatusCode as string) === 'ACT' ? 'Active' : 'Cancelled';
    const abnRegDate   = abrDate(abr.abn1RegisteredDate ?? abr.AbnRegisterDate);
    const gstRegDate   = abrDate(abr.goodsAndServicesTaxDate ?? abr.GstRegisterDate);

    // Extract state from mainBusinessPhysicalAddress
    const addrBlock = (abr.mainBusinessPhysicalAddress ?? abr.MainBusinessPhysicalAddress) as Record<string, string> | undefined;
    const state     = addrBlock?.stateCode ?? addrBlock?.StateCode ?? provider.state ?? null;

    // Extract trading name(s) from businessNames
    const bNames = (abr.businessNames ?? abr.BusinessNames) as Array<{name?: string; Name?: string}> | undefined;
    const tradingName = bNames && bNames.length > 0 ? (bNames[0].name ?? bNames[0].Name ?? null) : null;

    // Determine reg_status from NDIS context (ABN status drives it)
    const regStatus = abnStatus === 'Active' ? 'registered' : 'revoked';

    await DB.prepare(`
      UPDATE ndis_providers SET
        abn          = ?,
        abn_status   = ?,
        entity_type  = ?,
        abn_reg_date = ?,
        gst_reg_date = ?,
        state        = COALESCE(state, ?),
        trading_name = COALESCE(trading_name, ?),
        reg_status   = COALESCE(reg_status, ?),
        updated_at   = datetime('now')
      WHERE id = ?
    `).bind(
      abn,
      abnStatus,
      entityType,
      abnRegDate,
      gstRegDate,
      state,
      tradingName,
      regStatus,
      provider.id,
    ).run();

    enriched++;
  }

  return {
    success: true,
    providers_enriched: enriched,
    abns_found: abnFound,
    skipped,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authError = requireInternalSecret(request, locals.runtime.env);
  if (authError) return authError;

  try {
    const result = await runNdisAbrETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('[NDIS ABR ETL] Error:', err);
    return jsonError(`NDIS ABR ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
