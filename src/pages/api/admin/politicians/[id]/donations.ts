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
      donor_name: string;
      amount_cents?: number;
      year?: number;
      source?: string;
      source_url?: string;
      notes?: string;
    };
    const { donor_name, amount_cents, year, source = 'AEC', source_url, notes } = body;
    if (!donor_name) return jsonError('donor_name required', 400);

    const donationId = `donation_${crypto.randomUUID()}`;
    await DB.prepare(`
      INSERT INTO donations (id, politician_id, donor_name, amount_cents, year, source, source_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(donationId, id, donor_name, amount_cents ?? null, year ?? null, source, source_url ?? null, notes ?? null).run();

    return jsonResponse({ success: true, id: donationId }, { status: 201 });
  } catch (err) {
    return jsonError(`Failed to create donation: ${err instanceof Error ? err.message : String(err)}`);
  }
};
