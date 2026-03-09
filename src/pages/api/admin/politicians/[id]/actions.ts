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
      title: string;
      description: string;
      date?: string;
      category?: string;
      source_url?: string;
      evidence_url?: string;
    };
    const { title, description, date, category, source_url, evidence_url } = body;
    if (!title || !description) return jsonError('title and description required', 400);

    const actionId = `action_${crypto.randomUUID()}`;
    await DB.prepare(`
      INSERT INTO actions (id, politician_id, title, description, date, category, source_url, evidence_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(actionId, id, title, description, date ?? null, category ?? null, source_url ?? null, evidence_url ?? null).run();

    return jsonResponse({ success: true, id: actionId }, { status: 201 });
  } catch (err) {
    return jsonError(`Failed to create action: ${err instanceof Error ? err.message : String(err)}`);
  }
};
