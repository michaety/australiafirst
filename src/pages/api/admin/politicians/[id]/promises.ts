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
      description?: string;
      made_date?: string;
      deadline_date?: string;
      status?: 'kept' | 'broken' | 'partial' | 'pending';
      evidence_url?: string;
      source_url?: string;
      notes?: string;
    };
    const { title, description, made_date, deadline_date, status = 'pending', evidence_url, source_url, notes } = body;
    if (!title) return jsonError('title required', 400);

    const promiseId = `promise_${crypto.randomUUID()}`;
    await DB.prepare(`
      INSERT INTO promises (id, politician_id, title, description, made_date, deadline_date, status, evidence_url, source_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(promiseId, id, title, description ?? null, made_date ?? null, deadline_date ?? null, status, evidence_url ?? null, source_url ?? null, notes ?? null).run();

    return jsonResponse({ success: true, id: promiseId }, { status: 201 });
  } catch (err) {
    return jsonError(`Failed to create promise: ${err instanceof Error ? err.message : String(err)}`);
  }
};
