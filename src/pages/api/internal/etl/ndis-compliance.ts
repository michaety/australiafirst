import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

const CSV_URL = 'https://www.ndiscommission.gov.au/about-us/compliance-and-enforcement/compliance-actions/search/export';
const BATCH_SIZE = 50; // D1 batch limit (safe value)

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const row: string[] = [];
    while (i < len) {
      let field = '';
      if (text[i] === '"') {
        i++; // skip opening quote
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; }
            else { i++; break; }
          } else {
            field += text[i++];
          }
        }
      } else {
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i++];
        }
      }
      row.push(field.trim());
      if (i >= len || text[i] === '\n' || text[i] === '\r') {
        while (i < len && (text[i] === '\n' || text[i] === '\r')) i++;
        break;
      }
      i++; // skip comma
    }
    if (row.length > 1 || row[0]) rows.push(row);
  }

  return rows;
}

function normaliseActionType(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes('banning'))    return 'banning_order';
  if (r.includes('revoc'))      return 'revocation';
  if (r.includes('suspend'))    return 'suspension';
  if (r.includes('undertaking')) return 'enforceable_undertaking';
  if (r.includes('compliance')) return 'compliance_notice';
  if (r.includes('refusal'))    return 'refusal_to_re_register';
  return r.replace(/^er\s*-\s*/i, '').replace(/\s+/g, '_');
}

function deriveStatus(endDateStr: string | null): 'in_force' | 'expired' {
  if (!endDateStr) return 'in_force';
  const end = new Date(endDateStr);
  return isNaN(end.getTime()) ? 'in_force' : end < new Date() ? 'expired' : 'in_force';
}

function deriveIsPermanent(actionType: string, endDateStr: string | null, description: string): boolean {
  if (endDateStr) return false;
  if (description.toLowerCase().includes('permanent')) return true;
  if (actionType === 'banning_order' || actionType === 'revocation') return true;
  return false;
}

function classifySubject(name: string): 'provider' | 'individual' {
  return /\b(pty\s*ltd|ltd|inc|llc|limited|company|co\.|services|care|health|support|group|solutions|australia|trust|foundation|association|community|disability|ndis|provider|consortium|network|centre|center|trading|pty)\b/i.test(name)
    ? 'provider'
    : 'individual';
}

function hashAction(parts: string[]): string {
  let h = 0;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return 'ndis_act_' + Math.abs(h).toString(36);
}

function providerId(abn: string | null, name: string): string {
  if (abn) return `ndis_abn_${abn}`;
  return 'ndis_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 50);
}

function unescapeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// Run DB.batch() in chunks
async function batchRun(DB: D1Database, stmts: D1PreparedStatement[]) {
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await DB.batch(stmts.slice(i, i + BATCH_SIZE));
  }
}

export async function runNdisComplianceETL(env: Env) {
  const { DB, KV } = env;

  const res = await fetch(CSV_URL, {
    headers: { 'User-Agent': 'OnTheRecord/1.0 public-interest-research' },
  });
  if (!res.ok) throw new Error(`CSV fetch failed: HTTP ${res.status}`);

  const csvText = await res.text();
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('CSV appears empty or malformed');

  const [header, ...dataRows] = rows;
  const col = (name: string) => header.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));

  const iType        = col('type');
  const iDateFrom    = col('date effective');
  const iDateTo      = col('no longer');
  const iName        = col('name');
  const iAbn         = col('abn');
  const iCity        = col('city');
  const iState       = col('state');
  const iDescription = col('relevant information');

  // ── First pass: collect unique providers ────────────────────────────────────
  const providerMap = new Map<string, { id: string; abn: string | null; name: string; city: string | null; state: string | null }>();

  for (const row of dataRows) {
    if (row.length < 4) continue;
    const name        = unescapeHtml(row[iName] || '').trim();
    const rawType     = row[iType] || '';
    const abnRaw      = (row[iAbn] || '').replace(/\D/g, '');
    const abn         = abnRaw.length >= 9 ? abnRaw.padStart(11, '0') : null;
    const actionType  = normaliseActionType(rawType);
    if (!name || !rawType) continue;
    if (classifySubject(name) !== 'provider') continue;
    const pId = providerId(abn, name);
    if (!providerMap.has(pId)) {
      providerMap.set(pId, { id: pId, abn, name, city: row[iCity] || null, state: row[iState] || null });
    }
  }

  // ── Batch upsert providers ──────────────────────────────────────────────────
  const providerStmts = Array.from(providerMap.values()).map(p =>
    DB.prepare(`
      INSERT INTO ndis_providers (id, abn, legal_name, suburb, state, reg_status)
      VALUES (?, ?, ?, ?, ?, 'unknown')
      ON CONFLICT(id) DO UPDATE SET
        abn        = COALESCE(ndis_providers.abn, excluded.abn),
        legal_name = excluded.legal_name,
        suburb     = COALESCE(ndis_providers.suburb, excluded.suburb),
        state      = COALESCE(ndis_providers.state, excluded.state)
    `).bind(p.id, p.abn, p.name, p.city, p.state)
  );

  await batchRun(DB, providerStmts);
  const providersCreated = providerMap.size;

  // ── Second pass: batch upsert actions ───────────────────────────────────────
  const actionStmts: D1PreparedStatement[] = [];

  for (const row of dataRows) {
    if (row.length < 4) continue;
    const rawType    = row[iType] || '';
    const startDate  = (row[iDateFrom] || '').slice(0, 10) || null;
    const endDateRaw = (row[iDateTo]   || '').slice(0, 10) || null;
    const name       = unescapeHtml(row[iName] || '').trim();
    const abnRaw     = (row[iAbn] || '').replace(/\D/g, '');
    const abn        = abnRaw.length >= 9 ? abnRaw.padStart(11, '0') : null;
    const state      = row[iState] || null;
    const description = unescapeHtml(row[iDescription] || '').trim();
    if (!name || !rawType) continue;

    const actionType  = normaliseActionType(rawType);
    const status      = deriveStatus(endDateRaw);
    const isPermanent = deriveIsPermanent(actionType, endDateRaw, description);
    const subjectType = classifySubject(name);
    const provId      = subjectType === 'provider' ? providerId(abn, name) : null;
    const actionId    = hashAction([name, actionType, startDate || '']);

    actionStmts.push(
      DB.prepare(`
        INSERT INTO ndis_compliance_actions
          (id, provider_id, subject_name, subject_type, action_type, status,
           start_date, end_date, is_permanent, description, state, source_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status      = excluded.status,
          end_date    = excluded.end_date,
          description = excluded.description,
          provider_id = COALESCE(ndis_compliance_actions.provider_id, excluded.provider_id),
          scraped_at  = datetime('now')
      `).bind(
        actionId, provId, name, subjectType, actionType, status,
        startDate, endDateRaw, isPermanent ? 1 : 0,
        description || null, state,
        'https://www.ndiscommission.gov.au/about-us/compliance-and-enforcement/compliance-actions/search',
      )
    );
  }

  await batchRun(DB, actionStmts);

  await KV.put('ndis:compliance:last_run', new Date().toISOString());

  return {
    success: true,
    actions_upserted: actionStmts.length,
    providers_created: providersCreated,
    rows_in_csv: dataRows.length,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authError = requireInternalSecret(request, locals.runtime.env);
  if (authError) return authError;

  try {
    const result = await runNdisComplianceETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('[NDIS Compliance ETL] Error:', err);
    return jsonError(`NDIS Compliance ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
