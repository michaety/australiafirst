import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const BATCH_SIZE = 10;

interface PromiseRow {
  id: string;
  title: string;
  description: string | null;
  status: string | null;
}

async function assessPromise(
  env: Env,
  promise: PromiseRow,
): Promise<{ status: string; notes: string }> {
  const prompt = `You are assessing whether an Australian politician has kept a political promise.

Promise title: ${promise.title}
Promise description: ${promise.description || '(no description provided)'}

Based on general knowledge of Australian politics, assess whether this promise has been:
- kept: The promise was fulfilled
- broken: The promise was explicitly abandoned or violated
- partial: Some progress was made but not fully delivered
- pending: Not enough information to assess, or it is still in progress

Return ONLY a JSON object with two fields:
  status: one of "kept" | "broken" | "partial" | "pending"
  notes: a single sentence explaining the assessment

No other text outside the JSON object.`;

  try {
    const result = await (env.AI as any).run(AI_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'You assess Australian political promises. Return only valid JSON with "status" and "notes" fields.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 256,
    });

    const raw: string = result?.response ?? '';
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1].trim() : raw.trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1) return { status: 'pending', notes: 'Assessment failed: no JSON returned' };

    const parsed = JSON.parse(candidate.slice(start, end + 1));
    const validStatuses = new Set(['kept', 'broken', 'partial', 'pending']);
    const status = validStatuses.has(parsed.status) ? parsed.status : 'pending';
    const notes = typeof parsed.notes === 'string' ? parsed.notes.slice(0, 500) : '';
    return { status, notes };
  } catch {
    return { status: 'pending', notes: 'Assessment failed: unexpected error' };
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  const env = locals.runtime.env;
  const db = env.DB;

  try {
    const { results: pending } = await db.prepare(
      `SELECT id, title, description, status FROM promises WHERE status = 'pending' OR status IS NULL`,
    ).all<PromiseRow>();

    let assessed = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        batch.map(async (promise) => {
          try {
            const result = await assessPromise(env, promise);
            return { promise, result, ok: true as const };
          } catch (err) {
            console.error(`Failed to assess promise ${promise.id}:`, err);
            return { promise, ok: false as const };
          }
        }),
      );

      const stmts = [];
      for (const r of results) {
        if (r.ok) {
          stmts.push(
            db.prepare(`UPDATE promises SET status = ?, notes = ? WHERE id = ?`)
              .bind(r.result.status, r.result.notes, r.promise.id),
          );
          assessed++;
        } else {
          errors++;
        }
      }

      if (stmts.length > 0) {
        await db.batch(stmts);
      }
    }

    return jsonResponse({ assessed, skipped, errors });
  } catch (err) {
    console.error('Promises assess ETL error:', err);
    return jsonError(`Promises assess ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
