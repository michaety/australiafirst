import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

const FITS_SEARCH_URL = 'https://www.transparency.ag.gov.au/search';

const FIVE_EYES = new Set(['australia', 'united states', 'united kingdom', 'canada', 'new zealand',
  'usa', 'us', 'uk', 'nz', 'au', 'gb']);
const CRITICAL_COUNTRIES = new Set(['china', 'russia', 'iran', 'north korea', 'dprk',
  'peoples republic of china', 'prc', 'russian federation']);

function assessRisk(country: string | null): 'low' | 'medium' | 'high' | 'critical' {
  if (!country) return 'medium';
  const c = country.toLowerCase().trim();
  if (c === 'australia') return 'low';
  if (CRITICAL_COUNTRIES.has(c)) return 'critical';
  if (FIVE_EYES.has(c)) return 'medium';
  return 'high';
}

function mapRelationshipType(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('donat') || lower.includes('fund') || lower.includes('financ')) return 'donation';
  if (lower.includes('director') || lower.includes('board') || lower.includes('officer')) return 'directorship';
  if (lower.includes('travel') || lower.includes('trip') || lower.includes('visit')) return 'travel';
  if (lower.includes('lobby') || lower.includes('represent') || lower.includes('advocacy')) return 'lobbying';
  if (lower.includes('member') || lower.includes('associat') || lower.includes('affiliat')) return 'membership';
  return 'lobbying'; // default
}

function hashForeignTie(parts: string[]): string {
  let hash = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return 'fits_' + Math.abs(hash).toString(36);
}

function extractTextContent(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runForeignTiesETL(env: Env) {
  const { DB } = env;

  const politicians = await DB.prepare(
    `SELECT id, name FROM politicians`
  ).all<{ id: string; name: string }>();

  let totalProcessed = 0;
  let totalMatched = 0;
  let totalUnmatched = 0;
  let totalTies = 0;

  for (const politician of politicians.results) {
    totalProcessed++;

    if (totalProcessed > 1) await sleep(1000);

    const searchName = encodeURIComponent(politician.name);
    const searchUrl = `${FITS_SEARCH_URL}?name=${searchName}`;

    let html: string;
    try {
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'AustraliaFirst/1.0 accountability-platform',
          'Accept': 'text/html',
        },
      });

      if (!res.ok) {
        console.error(`FITS search failed for ${politician.name}: ${res.status}`);
        totalUnmatched++;
        continue;
      }

      html = await res.text();
    } catch (err) {
      console.error(`FITS fetch error for ${politician.name}:`, err);
      totalUnmatched++;
      continue;
    }

    const tableRowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows: string[] = [];
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = tableRowPattern.exec(html)) !== null) {
      rows.push(rowMatch[1]);
    }

    const cardPattern = /<div[^>]*class="[^"]*(?:result|registrant|entry)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let cardMatch: RegExpExecArray | null;
    while ((cardMatch = cardPattern.exec(html)) !== null) {
      rows.push(cardMatch[1]);
    }

    const noResults = html.toLowerCase().includes('no results') ||
                      html.toLowerCase().includes('no matching') ||
                      html.toLowerCase().includes('0 results');

    if (rows.length <= 1 && noResults) {
      totalUnmatched++;
      continue;
    }

    let foundEntries = false;

    for (const row of rows) {
      const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellPattern.exec(row)) !== null) {
        cells.push(extractTextContent(cellMatch[1]));
      }

      if (cells.length < 2) continue;
      if (cells[0].toLowerCase().includes('name') && cells[1].toLowerCase().includes('country')) continue;

      const entityName = cells[0] || '';
      const entityCountry = cells.length > 1 ? cells[1] : null;
      const activityType = cells.length > 2 ? cells[2] : '';
      const dateStr = cells.length > 3 ? cells[3] : null;

      if (!entityName || entityName.length < 2) continue;

      foundEntries = true;
      const riskRating = assessRisk(entityCountry);
      const relationshipType = mapRelationshipType(activityType);
      const id = hashForeignTie([politician.id, entityName, entityCountry || '', relationshipType]);

      await DB.prepare(`
        INSERT INTO foreign_ties (id, politician_id, entity_name, entity_country, relationship_type, risk_rating, description, date_start, source_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          entity_country = excluded.entity_country,
          relationship_type = excluded.relationship_type,
          risk_rating = excluded.risk_rating,
          description = excluded.description
      `).bind(
        id, politician.id, entityName, entityCountry, relationshipType,
        riskRating, activityType || null, dateStr || null, searchUrl,
      ).run();

      totalTies++;
    }

    if (!foundEntries && !noResults) {
      const linkPattern = /<a[^>]*href="[^"]*registrant[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch: RegExpExecArray | null;
      while ((linkMatch = linkPattern.exec(html)) !== null) {
        const entityName = extractTextContent(linkMatch[1]);
        if (!entityName || entityName.length < 2) continue;

        foundEntries = true;
        const id = hashForeignTie([politician.id, entityName, '', 'lobbying']);

        await DB.prepare(`
          INSERT INTO foreign_ties (id, politician_id, entity_name, entity_country, relationship_type, risk_rating, description, source_url)
          VALUES (?, ?, ?, NULL, 'lobbying', 'medium', NULL, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_url = excluded.source_url
        `).bind(id, politician.id, entityName, searchUrl).run();

        totalTies++;
      }
    }

    if (foundEntries) {
      totalMatched++;
    } else {
      totalUnmatched++;
    }
  }

  return {
    success: true,
    processed: totalProcessed,
    matched: totalMatched,
    unmatched: totalUnmatched,
    ties: totalTies,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  try {
    const result = await runForeignTiesETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('Foreign ties ETL error:', err);
    return jsonError(`Foreign ties ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
