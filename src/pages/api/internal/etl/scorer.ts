import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

export async function runScorerETL(env: Env) {
  const db = env.DB;

  // Count foreign_ties grouped by risk_rating for each politician
  const { results: rows } = await db.prepare(`
    SELECT p.id,
      SUM(CASE WHEN ft.risk_rating = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN ft.risk_rating = 'high'     THEN 1 ELSE 0 END) AS high,
      SUM(CASE WHEN ft.risk_rating = 'medium'   THEN 1 ELSE 0 END) AS medium,
      SUM(CASE WHEN ft.risk_rating = 'low'      THEN 1 ELSE 0 END) AS low
    FROM politicians p
    LEFT JOIN foreign_ties ft ON ft.politician_id = p.id
    GROUP BY p.id
  `).all<{ id: string; critical: number; high: number; medium: number; low: number }>();

  let updated = 0;
  let criticalCount = 0, highCount = 0, mediumCount = 0, lowCount = 0;

  const stmts = rows.map((r) => {
    const score = Math.min(100, r.critical * 40 + r.high * 20 + r.medium * 10 + r.low * 5);
    let label: string;
    if (score >= 60) { label = 'critical'; criticalCount++; }
    else if (score >= 30) { label = 'high'; highCount++; }
    else if (score >= 10) { label = 'medium'; mediumCount++; }
    else { label = 'low'; lowCount++; }
    updated++;
    return db.prepare(
      `UPDATE politicians SET risk_score = ?, risk_label = ? WHERE id = ?`,
    ).bind(score, label, r.id);
  });

  // Batch in groups of 50 (D1 batch limit)
  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50));
  }

  return {
    success: true,
    updated,
    critical: criticalCount,
    high: highCount,
    medium: mediumCount,
    low: lowCount,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  try {
    const result = await runScorerETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('Scorer ETL error:', err);
    return jsonError(`Scorer ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
