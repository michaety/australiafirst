import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, getCached, setCached } from '../../../../../lib/api';

export const prerender = false;

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const CACHE_TTL = 60 * 60 * 6; // 6 hours

export const GET: APIRoute = async ({ params, locals }) => {
  const { DB, KV, AI } = locals.runtime.env as Env & { AI: any };
  const { id } = params;

  if (!id) return jsonError('Missing politician ID', 400);

  const cacheKey = `v1:actions-summary:${id}`;
  const cached = await getCached(KV, cacheKey);
  if (cached) return jsonResponse(cached, { ttl: CACHE_TTL });

  try {
    const [polRow, actionsRow] = await Promise.all([
      DB.prepare(`SELECT name FROM politicians WHERE id = ?`).bind(id).first<{ name: string }>(),
      DB.prepare(
        `SELECT title, date, category FROM actions
         WHERE politician_id = ?
         ORDER BY date DESC
         LIMIT 100`,
      ).bind(id).all<{ title: string; date: string; category: string }>(),
    ]);

    if (!polRow) return jsonError('Politician not found', 404);

    const actions = actionsRow.results;
    if (actions.length === 0) return jsonResponse({ summary: [] });

    // Group by category for the prompt
    const grouped: Record<string, string[]> = {};
    for (const a of actions) {
      const cat = a.category ?? 'other';
      (grouped[cat] ??= []).push(a.title);
    }

    const groupedText = Object.entries(grouped)
      .map(([cat, titles]) => `${cat}:\n${titles.slice(0, 20).map(t => `- ${t}`).join('\n')}`)
      .join('\n\n');

    const itemsPrompt = `These are parliamentary votes by ${polRow.name}. Rewrite each as a plain 1-sentence summary a non-political Australian would understand. Remove procedural votes like 'Consideration of Legislation' that have no real meaning. Return only votes that actually reveal something about their political positions. Return the top 10 most significant as a JSON array of objects with fields: { "title": string, "plain": string, "category": string, "date": string }.

Votes grouped by category:
${groupedText}

All votes with dates (most recent first):
${actions.slice(0, 50).map(a => `- [${a.date}] ${a.title}`).join('\n')}

Return ONLY a valid JSON array. No other text.`;

    const blurbPrompt = `In 2 sentences, what is ${polRow.name} most known for politically? What are the most notable things they've done or voted for? Write for a general Australian audience, no jargon.

Their documented actions:
${actions.slice(0, 20).map(a => `- [${a.category ?? 'other'}] ${a.title}`).join('\n')}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let itemsResult: any, blurbResult: any;
    try {
      [itemsResult, blurbResult] = await Promise.all([
        AI.run(AI_MODEL, {
          messages: [
            { role: 'system', content: 'You summarise Australian parliamentary votes in plain English for a general audience. Return only valid JSON arrays.' },
            { role: 'user', content: itemsPrompt },
          ],
          max_tokens: 1500,
        }, { signal: controller.signal }),
        AI.run(AI_MODEL, {
          messages: [
            { role: 'system', content: 'You write 2-sentence plain English summaries of Australian politicians for a general audience. Be factual and concise.' },
            { role: 'user', content: blurbPrompt },
          ],
          max_tokens: 150,
        }, { signal: controller.signal }),
      ]);
    } catch {
      clearTimeout(timeout);
      const data = { summary: [], blurb: 'Summary temporarily unavailable.' };
      return jsonResponse(data);
    }
    clearTimeout(timeout);

    const raw: string = itemsResult?.response ?? '';
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1].trim() : raw.trim();
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');

    let summary: unknown[] = [];
    if (start !== -1 && end !== -1) {
      try {
        summary = JSON.parse(candidate.slice(start, end + 1));
      } catch {
        summary = [];
      }
    }

    const blurb = (blurbResult?.response ?? '').trim() || null;

    const data = { summary, blurb };
    await setCached(KV, cacheKey, data, CACHE_TTL);
    return jsonResponse(data, { ttl: CACHE_TTL });
  } catch (err) {
    console.error(`GET /api/v1/politicians/${id}/actions-summary error:`, err);
    return jsonError('Failed to generate actions summary');
  }
};
