// Database helper utilities

export async function getLatestScoreRun(db: D1Database): Promise<number | null> {
  const result = await db
    .prepare('SELECT id FROM score_runs ORDER BY ran_at DESC LIMIT 1')
    .first<{ id: number }>();
  return result?.id ?? null;
}

export async function getPoliticianById(db: D1Database, id: string) {
  return await db
    .prepare('SELECT * FROM politicians WHERE id = ?')
    .bind(id)
    .first();
}

export async function getCategories(db: D1Database) {
  const result = await db
    .prepare('SELECT * FROM categories ORDER BY name')
    .all();
  return result.results;
}

export async function getCategoryBySlug(db: D1Database, slug: string) {
  return await db
    .prepare('SELECT * FROM categories WHERE slug = ?')
    .bind(slug)
    .first();
}

export interface PoliticianFilters {
  jurisdiction?: string;
  chamber?: string;
  party?: string;
  search?: string;
}

export async function getPoliticians(
  db: D1Database,
  filters: PoliticianFilters = {}
) {
  let sql = 'SELECT p.*, pt.name as party_name FROM politicians p LEFT JOIN parties pt ON p.party_id = pt.id WHERE 1=1';
  const bindings: string[] = [];

  if (filters.jurisdiction) {
    sql += ' AND p.jurisdiction = ?';
    bindings.push(filters.jurisdiction);
  }

  if (filters.chamber) {
    sql += ' AND p.chamber = ?';
    bindings.push(filters.chamber);
  }

  if (filters.party) {
    sql += ' AND pt.abbreviation = ?';
    bindings.push(filters.party);
  }

  if (filters.search) {
    sql += ' AND p.name LIKE ?';
    bindings.push(`%${filters.search}%`);
  }

  sql += ' ORDER BY p.name';

  const stmt = db.prepare(sql);
  const bound = bindings.reduce((statement, b) => statement.bind(b), stmt);
  const result = await bound.all();
  return result.results;
}
