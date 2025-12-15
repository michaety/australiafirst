import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../lib/api';

export const GET: APIRoute = async ({ locals, url }) => {
  const db = locals.runtime.env.DB;
  const mapped = url.searchParams.get('mapped');
  const since = url.searchParams.get('since');
  const chamber = url.searchParams.get('chamber');

  try {
    let sql = `
      SELECT 
        d.*,
        CASE WHEN dm.id IS NOT NULL THEN 1 ELSE 0 END as is_mapped
      FROM divisions d
      LEFT JOIN division_mappings dm ON d.id = dm.division_id
      WHERE 1=1
    `;

    const bindings: any[] = [];

    if (mapped === 'true') {
      sql += ' AND dm.id IS NOT NULL';
    } else if (mapped === 'false') {
      sql += ' AND dm.id IS NULL';
    }

    if (since) {
      sql += ' AND d.date >= ?';
      bindings.push(since);
    }

    if (chamber) {
      sql += ' AND d.chamber = ?';
      bindings.push(chamber);
    }

    sql += ' ORDER BY d.date DESC LIMIT 100';

    const stmt = db.prepare(sql);
    const bound = bindings.reduce((s, b) => s.bind(b), stmt);
    const result = await bound.all();

    return jsonResponse({
      divisions: result.results,
    });
  } catch (e) {
    console.error('Error in /api/v1/divisions.json:', e);
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }
};
