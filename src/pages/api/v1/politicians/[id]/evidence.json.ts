import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../../lib/api';
import { getLatestScoreRun, getCategoryBySlug } from '../../../../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ locals, params, url }) => {
  // Access runtime environment bindings
  const env = locals.runtime?.env;
  if (!env) {
    console.error('Runtime environment not available');
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }

  const db = env.DB;
  const { id } = params;
  const categorySlug = url.searchParams.get('category');
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);

  if (!id) {
    return jsonResponse({ error: 'Politician ID required' }, { status: 400 });
  }

  try {
    const latestRun = await getLatestScoreRun(db);
    if (!latestRun) {
      return jsonResponse({
        politicianId: id,
        categoryId: categorySlug,
        items: [],
      });
    }

    let sql = `
      SELECT 
        se.division_id,
        se.vote,
        se.effect,
        se.rationale_snapshot,
        d.title,
        d.date,
        d.source_url,
        c.slug as category_slug
      FROM score_explanations se
      JOIN divisions d ON se.division_id = d.id
      JOIN categories c ON se.category_id = c.id
      WHERE se.score_run_id = ? AND se.politician_id = ?
    `;

    const bindings: any[] = [latestRun, id];

    if (categorySlug) {
      const category = await getCategoryBySlug(db, categorySlug);
      if (!category) {
        return jsonResponse({ error: 'Category not found' }, { status: 404 });
      }
      sql += ' AND se.category_id = ?';
      bindings.push(category.id);
    }

    sql += ' ORDER BY d.date DESC LIMIT ?';
    bindings.push(limit);

    const stmt = db.prepare(sql);
    const bound = bindings.reduce((statement, b) => statement.bind(b), stmt);
    const result = await bound.all();

    const items = (result.results as any[]).map((row) => ({
      title: `Division: ${row.title}`,
      date: row.date,
      vote: row.vote.toUpperCase(),
      effect: row.effect,
      rationale: row.rationale_snapshot,
      url: row.source_url,
    }));

    return jsonResponse({
      politicianId: id,
      categoryId: categorySlug,
      items,
    });
  } catch (e) {
    console.error('Error in /api/v1/politicians/[id]/evidence.json:', e);
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }
};
