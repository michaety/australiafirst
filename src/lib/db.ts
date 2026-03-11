// Database helpers for accountability platform
export interface Politician {
  id: string;
  name: string;
  chamber: string;
  party_id: string | null;
  party_name: string | null;
  party_abbreviation: string | null;
  electorate: string | null;
  jurisdiction: string;
  photo_url: string | null;
  mugshot_r2_key: string | null;
  bio: string | null;
  website: string | null;
  social_media: string | null;
  risk_score: number;
  risk_label: string;
}

export interface Action {
  id: string;
  politician_id: string;
  title: string;
  description: string;
  date: string | null;
  category: string | null;
  source_url: string | null;
  evidence_url: string | null;
  created_at: string;
}

export interface Donation {
  id: string;
  politician_id: string | null;
  party_id: string | null;
  donor_name: string;
  amount_cents: number | null;
  year: number | null;
  source: string;
  source_url: string | null;
  notes: string | null;
  created_at: string;
}

export interface Promise_ {
  id: string;
  politician_id: string;
  title: string;
  description: string | null;
  made_date: string | null;
  deadline_date: string | null;
  status: 'kept' | 'broken' | 'partial' | 'pending';
  evidence_url: string | null;
  source_url: string | null;
  notes: string | null;
  created_at: string;
}

export interface ForeignTie {
  id: string;
  politician_id: string;
  entity_name: string;
  entity_country: string | null;
  relationship_type: string | null;
  risk_rating: 'low' | 'medium' | 'high' | 'critical';
  description: string | null;
  date_start: string | null;
  date_end: string | null;
  source_url: string | null;
  created_at: string;
}

export async function getPoliticians(
  db: D1Database,
  filters: { chamber?: string; party?: string; search?: string; sort?: string } = {},
): Promise<Politician[]> {
  const sort = filters.sort ?? 'name';

  let selectExtra = '';
  let joinExtra = '';
  let orderBy = 'p.name ASC';

  if (sort === 'donors') {
    joinExtra = `LEFT JOIN (SELECT politician_id, COUNT(*) AS donor_count FROM donations GROUP BY politician_id) _d ON _d.politician_id = p.id`;
    selectExtra = ', COALESCE(_d.donor_count, 0) AS _sort_val';
    orderBy = '_sort_val DESC, p.name ASC';
  } else if (sort === 'actions') {
    joinExtra = `LEFT JOIN (SELECT politician_id, COUNT(*) AS action_count FROM actions GROUP BY politician_id) _a ON _a.politician_id = p.id`;
    selectExtra = ', COALESCE(_a.action_count, 0) AS _sort_val';
    orderBy = '_sort_val DESC, p.name ASC';
  } else if (sort === 'controversial') {
    joinExtra = `LEFT JOIN (SELECT politician_id, AVG(agreement_pct) AS avg_agreement FROM politician_policy_scores GROUP BY politician_id) _ps ON _ps.politician_id = p.id`;
    selectExtra = ', _ps.avg_agreement AS _avg_agreement';
    orderBy = 'CASE WHEN _ps.avg_agreement IS NULL THEN 1 ELSE 0 END ASC, ABS(_ps.avg_agreement - 50) ASC, p.name ASC';
  } else if (sort === 'risk') {
    orderBy = 'p.risk_score DESC, p.name ASC';
  }

  let query = `
    SELECT p.id, p.name, p.chamber, p.party_id, p.electorate, p.jurisdiction,
           p.photo_url, p.mugshot_r2_key, p.bio, p.website, p.social_media,
           p.risk_score, p.risk_label,
           pt.name AS party_name, pt.abbreviation AS party_abbreviation${selectExtra}
    FROM politicians p
    LEFT JOIN parties pt ON pt.id = p.party_id
    ${joinExtra}
    WHERE 1=1
  `;
  const params: unknown[] = [];
  if (filters.chamber) {
    query += ` AND p.chamber = ?`;
    params.push(filters.chamber);
  }
  if (filters.party) {
    query += ` AND (pt.abbreviation = ? OR pt.name = ?)`;
    params.push(filters.party, filters.party);
  }
  if (filters.search) {
    query += ` AND (p.name LIKE ? OR p.electorate LIKE ?)`;
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  query += ` ORDER BY ${orderBy}`;
  const result = await db.prepare(query).bind(...params).all<Politician>();
  return result.results ?? [];
}

export async function getPoliticianById(db: D1Database, id: string): Promise<Politician | null> {
  const result = await db.prepare(`
    SELECT p.id, p.name, p.chamber, p.party_id, p.electorate, p.jurisdiction,
           p.photo_url, p.mugshot_r2_key, p.bio, p.website, p.social_media,
           pt.name AS party_name, pt.abbreviation AS party_abbreviation
    FROM politicians p
    LEFT JOIN parties pt ON pt.id = p.party_id
    WHERE p.id = ?
  `).bind(id).first<Politician>();
  return result ?? null;
}

export async function getActions(db: D1Database, politicianId: string): Promise<Action[]> {
  const result = await db.prepare(
    `SELECT * FROM actions WHERE politician_id = ? ORDER BY date DESC, created_at DESC`,
  ).bind(politicianId).all<Action>();
  return result.results ?? [];
}

export async function getDonations(db: D1Database, politicianId: string): Promise<Donation[]> {
  const result = await db.prepare(
    `SELECT * FROM donations WHERE politician_id = ? ORDER BY year DESC, amount_cents DESC`,
  ).bind(politicianId).all<Donation>();
  return result.results ?? [];
}

export async function getPartyDonations(db: D1Database, partyId: string): Promise<Donation[]> {
  const result = await db.prepare(
    `SELECT * FROM donations WHERE party_id = ? AND politician_id IS NULL ORDER BY amount_cents DESC LIMIT 50`,
  ).bind(partyId).all<Donation>();
  return result.results ?? [];
}

export async function getPromises(db: D1Database, politicianId: string): Promise<Promise_[]> {
  const result = await db.prepare(
    `SELECT * FROM promises WHERE politician_id = ? ORDER BY made_date DESC`,
  ).bind(politicianId).all<Promise_>();
  return result.results ?? [];
}

export async function getForeignTies(db: D1Database, politicianId: string): Promise<ForeignTie[]> {
  const result = await db.prepare(
    `SELECT * FROM foreign_ties WHERE politician_id = ? ORDER BY risk_rating DESC, created_at DESC`,
  ).bind(politicianId).all<ForeignTie>();
  return result.results ?? [];
}

export async function getPoliticianProfile(db: D1Database, id: string) {
  const politician = await getPoliticianById(db, id);
  if (!politician) return null;
  const [actions, donations, promises, foreignTies] = await Promise.all([
    getActions(db, id),
    getDonations(db, id),
    getPromises(db, id),
    getForeignTies(db, id),
  ]);
  // For party-affiliated MPs with no individual donations, fetch party-level donations
  let partyDonations: Donation[] = [];
  if (politician.party_id && politician.party_id !== 'party_independent' && donations.length === 0) {
    partyDonations = await getPartyDonations(db, politician.party_id);
  }
  return { politician, actions, donations, promises, foreignTies, partyDonations };
}
