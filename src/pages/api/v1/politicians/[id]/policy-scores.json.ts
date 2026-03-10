import type { APIRoute } from 'astro';
import { jsonResponse, jsonError } from '../../../../../lib/api';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const { DB } = locals.runtime.env;
  const { id } = params;

  if (!id) return jsonError('Missing politician ID', 400);

  try {
    const { results } = await DB.prepare(
      `SELECT policy_id, policy_name, policy_description, agreement_pct, votes_count
       FROM politician_policy_scores
       WHERE politician_id = ?
       ORDER BY ABS(agreement_pct - 50) ASC`,
    )
      .bind(id)
      .all();

    return jsonResponse({ policyScores: results }, { ttl: 300 });
  } catch (err) {
    console.error(`GET /api/v1/politicians/${id}/policy-scores.json error:`, err);
    return jsonError('Failed to fetch policy scores');
  }
};
