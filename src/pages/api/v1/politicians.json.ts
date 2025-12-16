import type { APIRoute } from 'astro';
import { jsonResponse, withCache } from '../../../lib/api';
import { getPoliticians, getLatestScoreRun } from '../../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  // Access runtime environment bindings
  const env = locals.runtime?.env;
  if (!env) {
    console.error('Runtime environment not available');
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }

  const db = env.DB;
  const kv = env.KV;

  const jurisdiction = url.searchParams.get('jurisdiction') || 'commonwealth';
  const chamber = url.searchParams.get('chamber') || undefined;
  const party = url.searchParams.get('party') || undefined;
  const search = url.searchParams.get('q') || undefined;

  const cacheKey = `api:politicians:${jurisdiction}:${chamber}:${party}:${search}`;

  try {
    const data = await withCache(
      kv,
      cacheKey,
      async () => {
        const politicians = await getPoliticians(db, {
          jurisdiction,
          chamber,
          party,
          search,
        });

        const latestRun = await getLatestScoreRun(db);

        // Fetch overall scores for each politician
        const enriched = await Promise.all(
          politicians.map(async (p: any) => {
            if (!latestRun) {
              return {
                id: p.id,
                name: p.name,
                party: p.party_name,
                seat: p.electorate,
                chamber: p.chamber,
                jurisdiction: p.jurisdiction,
                avatar: p.image_url,
                overall: null,
              };
            }

            const score = await db
              .prepare(
                'SELECT overall_0_100, coverage FROM politician_overall_scores WHERE score_run_id = ? AND politician_id = ?'
              )
              .bind(latestRun, p.id)
              .first<{ overall_0_100: number; coverage: number }>();

            return {
              id: p.id,
              name: p.name,
              party: p.party_name,
              seat: p.electorate,
              chamber: p.chamber,
              jurisdiction: p.jurisdiction,
              avatar: p.image_url,
              overall: score
                ? {
                    score_0_100: Math.round(score.overall_0_100),
                    coverage: Math.round(score.coverage * 100),
                  }
                : null,
            };
          })
        );

        return {
          frameworkVersion: 'v0.1.0',
          lastUpdated: new Date().toISOString().split('T')[0],
          politicians: enriched,
        };
      },
      60
    );

    return jsonResponse(data);
  } catch (e) {
    console.error('Error in /api/v1/politicians.json:', e);
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }
};
