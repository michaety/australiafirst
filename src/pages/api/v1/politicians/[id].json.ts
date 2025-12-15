import type { APIRoute } from 'astro';
import { jsonResponse, withCache } from '../../../../lib/api';
import { getPoliticianById, getLatestScoreRun } from '../../../../lib/db';

export const GET: APIRoute = async ({ locals, params }) => {
  const db = locals.runtime.env.DB;
  const kv = locals.runtime.env.KV;
  const { id } = params;

  if (!id) {
    return jsonResponse({ error: 'Politician ID required' }, { status: 400 });
  }

  const cacheKey = `api:politician:${id}`;

  try {
    const data = await withCache(
      kv,
      cacheKey,
      async () => {
        const politician = await getPoliticianById(db, id);
        if (!politician) {
          return null;
        }

        const latestRun = await getLatestScoreRun(db);

        if (!latestRun) {
          return {
            frameworkVersion: 'v0.1.0',
            lastUpdated: new Date().toISOString().split('T')[0],
            politician: {
              id: politician.id,
              name: politician.name,
              party: null,
              seat: politician.electorate,
              chamber: politician.chamber,
              jurisdiction: politician.jurisdiction,
              avatar: politician.image_url,
              overall: null,
              categoryScores: {},
            },
          };
        }

        // Get party info
        const party = politician.party_id
          ? await db
              .prepare('SELECT name FROM parties WHERE id = ?')
              .bind(politician.party_id)
              .first<{ name: string }>()
          : null;

        // Get overall score
        const overallScore = await db
          .prepare(
            'SELECT overall_0_100, coverage FROM politician_overall_scores WHERE score_run_id = ? AND politician_id = ?'
          )
          .bind(latestRun, id)
          .first<{ overall_0_100: number; coverage: number }>();

        // Get category scores
        const categoryScores = await db
          .prepare(
            `SELECT pcs.*, c.slug 
             FROM politician_category_scores pcs
             JOIN categories c ON pcs.category_id = c.id
             WHERE pcs.score_run_id = ? AND pcs.politician_id = ?`
          )
          .bind(latestRun, id)
          .all();

        const categoryScoresMap: Record<string, any> = {};
        for (const cs of categoryScores.results as any[]) {
          categoryScoresMap[cs.slug] = {
            score_0_100: Math.round(cs.score_0_100),
            score_signed: Math.round(cs.score_signed),
            coverage: Math.round(cs.coverage * 100),
          };
        }

        return {
          frameworkVersion: 'v0.1.0',
          lastUpdated: new Date().toISOString().split('T')[0],
          politician: {
            id: politician.id,
            name: politician.name,
            party: party?.name ?? null,
            seat: politician.electorate,
            chamber: politician.chamber,
            jurisdiction: politician.jurisdiction,
            avatar: politician.image_url,
            overall: overallScore
              ? {
                  score_0_100: Math.round(overallScore.overall_0_100),
                  coverage: Math.round(overallScore.coverage * 100),
                }
              : null,
            categoryScores: categoryScoresMap,
          },
        };
      },
      60
    );

    if (!data) {
      return jsonResponse({ error: 'Politician not found' }, { status: 404 });
    }

    return jsonResponse(data);
  } catch (e) {
    console.error('Error in /api/v1/politicians/[id].json:', e);
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }
};
