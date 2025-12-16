import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../lib/api';
import { getLatestScoreRun } from '../../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  // Access runtime environment bindings
  const env = locals.runtime?.env;
  if (!env) {
    console.error('Runtime environment not available');
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }

  const db = env.DB;

  try {
    const latestRun = await getLatestScoreRun(db);
    const runInfo = latestRun
      ? await db
          .prepare('SELECT ran_at FROM score_runs WHERE id = ?')
          .bind(latestRun)
          .first<{ ran_at: string }>()
      : null;

    const lastIngest = await db
      .prepare('SELECT MAX(created_at) as last_at FROM raw_documents')
      .first<{ last_at: string }>();

    return jsonResponse({
      frameworkVersion: 'v0.1.0',
      lastScoreRunAt: runInfo?.ran_at ?? null,
      dataLastIngestedAt: lastIngest?.last_at ?? null,
    });
  } catch (e) {
    console.error('Error in /api/v1/meta.json:', e);
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }
};
