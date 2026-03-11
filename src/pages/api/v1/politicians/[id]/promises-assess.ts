import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, getCached, setCached } from '../../../../../lib/api';

export const prerender = false;

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const CACHE_TTL = 60 * 60 * 24; // 24 hours — assessments change rarely
const VALID_STATUSES = new Set(['KEPT', 'BROKEN', 'PARTIAL', 'PENDING']);

export const POST: APIRoute = async ({ params, locals }) => {
  const { DB, KV, AI } = locals.runtime.env as Env & { AI: any };
  const { id } = params;

  if (!id) return jsonError('Missing politician ID', 400);

  try {
    const { results: promises } = await DB.prepare(
      `SELECT id, title, description, status FROM promises WHERE politician_id = ? ORDER BY id`,
    ).bind(id).all<{ id: string; title: string; description: string | null; status: string }>();

    if (promises.length === 0) return jsonResponse({ assessed: 0, results: [] });

    const results: { id: string; title: string; oldStatus: string; newStatus: string }[] = [];

    for (const promise of promises) {
      const cacheKey = `v1:promise-assess:${promise.id}`;
      let newStatus: string | null = await getCached<string>(KV, cacheKey);

      if (!newStatus) {
        const prompt = `This Australian politician made this promise: "${promise.title}". The current status note says: "${promise.description ?? 'No description provided'}". Based on this, classify as: KEPT (promise delivered), BROKEN (clearly not delivered), PARTIAL (partly done), or PENDING (too early to tell or unclear). Return only one word.`;

        const result = await AI.run(AI_MODEL, {
          messages: [
            { role: 'system', content: 'You assess Australian political promises. Respond with exactly one word: KEPT, BROKEN, PARTIAL, or PENDING.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 10,
        });

        const word = (result?.response ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
        newStatus = VALID_STATUSES.has(word) ? word : 'PENDING';
        await setCached(KV, cacheKey, newStatus, CACHE_TTL);
      }

      if (newStatus !== promise.status.toUpperCase()) {
        await DB.prepare(
          `UPDATE promises SET status = ? WHERE id = ?`,
        ).bind(newStatus.toLowerCase(), promise.id).run();
      }

      results.push({ id: promise.id, title: promise.title, oldStatus: promise.status, newStatus });
    }

    return jsonResponse({ assessed: results.length, results });
  } catch (err) {
    console.error(`POST /api/v1/politicians/${id}/promises-assess error:`, err);
    return jsonError('Failed to assess promises');
  }
};
