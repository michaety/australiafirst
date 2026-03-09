import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireAdminAuth } from '../../../../../lib/api';

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
  const { DB } = locals.runtime.env;
  const authError = requireAdminAuth(request, locals.runtime.env);
  if (authError) return authError;

  const { id } = params;
  if (!id) return jsonError('Missing politician ID', 400);

  try {
    const body = await request.json() as {
      entity_name: string;
      entity_country?: string;
      relationship_type?: string;
      risk_rating?: 'low' | 'medium' | 'high' | 'critical';
      description?: string;
      date_start?: string;
      date_end?: string;
      source_url?: string;
    };
    const { entity_name, entity_country, relationship_type, risk_rating = 'low', description, date_start, date_end, source_url } = body;
    if (!entity_name) return jsonError('entity_name required', 400);

    const tieId = `tie_${crypto.randomUUID()}`;
    await DB.prepare(`
      INSERT INTO foreign_ties (id, politician_id, entity_name, entity_country, relationship_type, risk_rating, description, date_start, date_end, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(tieId, id, entity_name, entity_country ?? null, relationship_type ?? null, risk_rating, description ?? null, date_start ?? null, date_end ?? null, source_url ?? null).run();

    return jsonResponse({ success: true, id: tieId }, { status: 201 });
  } catch (err) {
    return jsonError(`Failed to create foreign tie: ${err instanceof Error ? err.message : String(err)}`);
  }
};
