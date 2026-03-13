import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireAdminAuth } from '../../../../../lib/api';

export const prerender = false;

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const { DB, KV } = locals.runtime.env;
  const authError = requireAdminAuth(request, locals.runtime.env);
  if (authError) return authError;

  const { id } = params;
  if (!id) return jsonError('Missing politician ID', 400);

  try {
    const body = await request.json() as {
      promise_id: string;
      status?: 'kept' | 'broken' | 'partial' | 'pending';
      description?: string;
      evidence_url?: string;
      notes?: string;
    };
    const { promise_id, status, description, evidence_url, notes } = body;
    if (!promise_id) return jsonError('promise_id required', 400);

    const sets: string[] = [];
    const binds: unknown[] = [];
    if (status !== undefined) { sets.push('status = ?'); binds.push(status); }
    if (description !== undefined) { sets.push('description = ?'); binds.push(description); }
    if (evidence_url !== undefined) { sets.push('evidence_url = ?'); binds.push(evidence_url); }
    if (notes !== undefined) { sets.push('notes = ?'); binds.push(notes); }
    if (sets.length === 0) return jsonError('No fields to update', 400);

    binds.push(promise_id, id);
    await DB.prepare(
      `UPDATE promises SET ${sets.join(', ')} WHERE id = ? AND politician_id = ?`,
    ).bind(...binds).run();

    await KV.delete(`v1:politician:${id}`);

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonError(`Failed to update promise: ${err instanceof Error ? err.message : String(err)}`);
  }
};

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
