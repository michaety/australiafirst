import type { APIRoute } from 'astro';
import { jsonResponse, jsonError } from '../../../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const { DB } = locals.runtime.env;
  const { id } = params;

  if (!id) return jsonError('Missing provider id', 400);

  try {
    const provider = await DB.prepare(
      'SELECT * FROM ndis_providers WHERE id = ?'
    ).bind(id).first();

    if (!provider) return jsonError('Provider not found', 404);

    const actions = await DB.prepare(
      'SELECT * FROM ndis_compliance_actions WHERE provider_id = ? ORDER BY start_date DESC'
    ).bind(id).all();

    return jsonResponse({ provider, actions: actions.results }, { ttl: 120 });
  } catch (err) {
    console.error('[NDIS API] provider profile error:', err);
    return jsonError(`Failed to fetch provider: ${err instanceof Error ? err.message : String(err)}`);
  }
};
