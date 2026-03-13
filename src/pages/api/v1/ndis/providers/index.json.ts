import type { APIRoute } from 'astro';
import { jsonResponse, jsonError } from '../../../../../lib/api';

export const prerender = false;

const PAGE_SIZE = 50;

export const GET: APIRoute = async ({ url, locals }) => {
  const { DB } = locals.runtime.env;

  try {
    const risk  = url.searchParams.get('risk') || '';
    const state = url.searchParams.get('state') || '';
    const q     = url.searchParams.get('q') || '';
    const page  = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const offset = (page - 1) * PAGE_SIZE;

    const conditions: string[] = [];
    const bindings: (string | number)[] = [];

    if (risk) {
      conditions.push('p.risk_label = ?');
      bindings.push(risk);
    }
    if (state) {
      conditions.push('p.state = ?');
      bindings.push(state);
    }
    if (q) {
      conditions.push('(p.legal_name LIKE ? OR p.trading_name LIKE ? OR p.abn LIKE ?)');
      const like = `%${q}%`;
      bindings.push(like, like, like);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT
        p.id, p.abn, p.legal_name, p.trading_name, p.suburb, p.state,
        p.reg_status, p.abn_status, p.entity_type,
        p.risk_score, p.risk_label, p.action_count,
        p.abn_reg_date, p.updated_at,
        (SELECT action_type FROM ndis_compliance_actions WHERE provider_id = p.id ORDER BY start_date DESC LIMIT 1) as latest_action_type
      FROM ndis_providers p
      ${where}
      ORDER BY p.risk_score DESC, p.action_count DESC
      LIMIT ? OFFSET ?
    `;

    const result = await DB.prepare(query)
      .bind(...bindings, PAGE_SIZE, offset)
      .all();

    // Count for pagination
    const countResult = await DB.prepare(
      `SELECT COUNT(*) as total FROM ndis_providers p ${where}`
    ).bind(...bindings).first<{ total: number }>();

    return jsonResponse({
      page,
      pageSize: PAGE_SIZE,
      total: countResult?.total ?? 0,
      providers: result.results,
    }, { ttl: 120 });
  } catch (err) {
    console.error('[NDIS API] providers list error:', err);
    return jsonError(`Failed to fetch providers: ${err instanceof Error ? err.message : String(err)}`);
  }
};
