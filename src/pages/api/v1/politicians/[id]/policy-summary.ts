import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, getCached, setCached } from '../../../../../lib/api';

export const prerender = false;

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const CACHE_TTL = 60 * 60 * 24; // 24 hours

export const GET: APIRoute = async ({ params, locals }) => {
  const { DB, KV, AI } = locals.runtime.env as Env & { AI: any };
  const { id } = params;

  if (!id) return jsonError('Missing politician ID', 400);

  const cacheKey = `v1:policy-summary:${id}`;
  const cached = await getCached<{ summary: string | null }>(KV, cacheKey);
  if (cached) return jsonResponse(cached, { ttl: CACHE_TTL });

  try {
    const [polRow, scoresRow] = await Promise.all([
      DB.prepare(`SELECT name, party_name FROM politicians WHERE id = ?`)
        .bind(id)
        .first<{ name: string; party_name: string | null }>(),
      DB.prepare(
        `SELECT policy_name, agreement_pct
         FROM politician_policy_scores
         WHERE politician_id = ? AND agreement_pct IS NOT NULL
         ORDER BY ABS(agreement_pct - 50) DESC
         LIMIT 5`,
      )
        .bind(id)
        .all<{ policy_name: string; agreement_pct: number }>(),
    ]);

    if (!polRow) return jsonError('Politician not found', 404);

    const scores = scoresRow.results;
    if (scores.length === 0) {
      const data = { summary: null };
      await setCached(KV, cacheKey, data, CACHE_TTL);
      return jsonResponse(data);
    }

    const stanceLabel = (pct: number) => {
      if (pct >= 80) return 'strongly supports';
      if (pct >= 60) return 'mostly supports';
      if (pct >= 40) return 'has a mixed record on';
      if (pct >= 20) return 'mostly opposes';
      return 'strongly opposes';
    };

    const policyLines = scores
      .map((s) => `- ${s.policy_name}: ${stanceLabel(Math.round(s.agreement_pct))} (${Math.round(s.agreement_pct)}% agreement)`)
      .join('\n');

    const name = polRow.name;
    const party = polRow.party_name ?? 'an Australian political party';

    const prompt = `In 2-3 plain English sentences, summarise how ${name} (${party}) votes on major issues. Focus on what's surprising or notable. Avoid jargon. Write for a general Australian audience.

Their most notable voting positions:
${policyLines}`;

    const result = await AI.run(AI_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You write plain English summaries of Australian politicians voting records for a general audience. Keep it factual, concise, and avoid political jargon. 2-3 sentences maximum. Do not start with their name.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 200,
    });

    const summary = (result?.response ?? '').trim() || null;
    const data = { summary };
    await setCached(KV, cacheKey, data, CACHE_TTL);
    return jsonResponse(data, { ttl: CACHE_TTL });
  } catch (err) {
    console.error(`GET /api/v1/politicians/${id}/policy-summary error:`, err);
    return jsonError('Failed to generate policy summary');
  }
};
