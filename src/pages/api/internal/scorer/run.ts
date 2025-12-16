import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/api';
import {
  calculateCategoryScore,
  calculateOverallScore,
  generateExplanations,
  type DivisionMapping,
  type Vote,
} from '../../../../lib/scoring';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
  const db = locals.runtime.env.DB;

  try {
    // Create a new score run
    const scoreRunResult = await db
      .prepare(
        `INSERT INTO score_runs (framework_version, notes) 
         VALUES (?, ?)`
      )
      .bind('v0.1.0', 'Automated nightly run')
      .run();

    const scoreRunId = scoreRunResult.meta.last_row_id;

    // Get all categories
    const categoriesResult = await db
      .prepare('SELECT * FROM categories')
      .all();
    const categories = categoriesResult.results as any[];

    // Get all politicians
    const politiciansResult = await db
      .prepare('SELECT id FROM politicians')
      .all();
    const politicians = politiciansResult.results as any[];

    let processedCount = 0;

    // Process each politician
    for (const politician of politicians) {
      const categoryScores: Array<any> = [];

      // Process each category
      for (const category of categories) {
        // Get mappings for this category
        const mappingsResult = await db
          .prepare(
            `SELECT dm.*, d.date 
             FROM division_mappings dm
             JOIN divisions d ON dm.division_id = d.id
             WHERE dm.category_id = ?`
          )
          .bind(category.id)
          .all();

        const mappings = mappingsResult.results as unknown as DivisionMapping[];

        if (mappings.length === 0) continue;

        // Get politician's votes for mapped divisions
        const divisionIds = mappings.map((m) => m.division_id);
        const placeholders = divisionIds.map(() => '?').join(',');

        const votesResult = await db
          .prepare(
            `SELECT division_id, vote 
             FROM votes 
             WHERE politician_id = ? AND division_id IN (${placeholders})`
          )
          .bind(politician.id, ...divisionIds)
          .all();

        const votes = votesResult.results as unknown as Vote[];

        // Calculate score
        const score = calculateCategoryScore(votes, mappings);

        if (score) {
          // Store category score
          await db
            .prepare(
              `INSERT INTO politician_category_scores 
               (score_run_id, politician_id, category_id, score_0_100, score_signed, coverage, last_division_date) 
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              scoreRunId,
              politician.id,
              category.id,
              score.score_0_100,
              score.score_signed,
              score.coverage,
              score.last_division_date
            )
            .run();

          categoryScores.push({
            ...score,
            weight: category.default_weight,
          });

          // Generate and store explanations
          const explanations = generateExplanations(
            politician.id,
            votes,
            mappings
          );

          for (const explanation of explanations) {
            await db
              .prepare(
                `INSERT INTO score_explanations 
                 (score_run_id, politician_id, category_id, division_id, vote, effect, rationale_snapshot) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(
                scoreRunId,
                explanation.politician_id,
                explanation.category_id,
                explanation.division_id,
                explanation.vote,
                explanation.effect,
                explanation.rationale_snapshot
              )
              .run();
          }
        }
      }

      // Calculate overall score
      if (categoryScores.length > 0) {
        const overallScore = calculateOverallScore(categoryScores);

        await db
          .prepare(
            `INSERT INTO politician_overall_scores 
             (score_run_id, politician_id, overall_0_100, coverage) 
             VALUES (?, ?, ?, ?)`
          )
          .bind(
            scoreRunId,
            politician.id,
            overallScore.overall_0_100,
            overallScore.coverage
          )
          .run();
      }

      processedCount++;
    }

    return jsonResponse({
      success: true,
      message: 'Scoring completed successfully',
      scoreRunId,
      processedCount,
    });
  } catch (e) {
    console.error('Error in scoring job:', e);
    return jsonResponse(
      { error: 'Internal server error', details: String(e) },
      { status: 500 }
    );
  }
};
