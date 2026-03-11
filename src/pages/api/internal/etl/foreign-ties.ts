import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

// ── Data sources ──────────────────────────────────────────────────────────────
// Senate: structured JSON API (discovered from the React SPA env.js)
const PBS_API   = 'https://pbs-apim-aqcdgxhvaug7f8em.z01.azurefd.net/api';
// House: individual PDF links scraped from the register page
const APH_BASE  = 'https://www.aph.gov.au';
const REG_PAGE  = `${APH_BASE}/Senators_and_Members/Members/Register`;

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

// ── Risk helpers ──────────────────────────────────────────────────────────────
const FIVE_EYES = new Set([
  'australia', 'united states', 'united kingdom', 'canada', 'new zealand',
  'usa', 'us', 'uk', 'nz', 'au', 'gb',
]);
const CRITICAL = new Set([
  'china', 'russia', 'iran', 'north korea', 'dprk',
  'peoples republic of china', 'prc', 'russian federation',
  'belarus', 'venezuela', 'cuba', 'myanmar',
]);

function assessRisk(country: string | null | undefined): 'low' | 'medium' | 'high' | 'critical' {
  if (!country) return 'medium';
  const c = country.toLowerCase().trim();
  if (c === 'australia') return 'low';
  if (CRITICAL.has(c)) return 'critical';
  if (FIVE_EYES.has(c)) return 'medium';
  return 'high';
}

function hashTie(parts: string[]): string {
  let h = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return 'aph_' + Math.abs(h).toString(36);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function stripHtml(s: string) { return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

// ── Name helpers ──────────────────────────────────────────────────────────────
// Extracts the last word as surname from "Firstname Surname" format
function surname(fullName: string): string {
  return fullName.trim().split(/\s+/).at(-1) ?? fullName.trim();
}

// Returns an array of lookup keys to try for a given surname.
// Handles apostrophes (O'Neil→oneil), hyphens (Watson-Brown→watson-brown, brown)
function surnameLookupKeys(fullName: string): string[] {
  const sur = surname(fullName).toLowerCase();
  const keys = [sur];
  // Strip apostrophes: O'Neil → oneil, O'Brien → obrien
  const noApostrophe = sur.replace(/'/g, '');
  if (noApostrophe !== sur) keys.push(noApostrophe);
  // For hyphenated names, also try just the last part: Watson-Brown → brown
  if (sur.includes('-')) {
    const lastPart = sur.split('-').at(-1);
    if (lastPart) keys.push(lastPart);
    // Also try without hyphen: watson-brown → watsonbrown
    keys.push(sur.replace(/-/g, ''));
  }
  return keys;
}

// Senate API returns "Surname, Firstname" – normalise to "Firstname Surname"
function normaliseApiName(apiName: string): string {
  const [sur, ...given] = apiName.split(',');
  return `${given.join(',').trim()} ${sur.trim()}`.trim();
}

// ── Lightweight JS PDF text extractor ────────────────────────────────────────
// Works for text-embedded (non-scanned) PDFs.
function extractPdfText(buf: ArrayBuffer): string {
  const raw = new TextDecoder('latin1').decode(buf);
  const parts: string[] = [];

  // Extract text from BT...ET blocks (PDF content streams)
  const btEt = /BT([\s\S]*?)ET/g;
  let m: RegExpExecArray | null;
  while ((m = btEt.exec(raw)) !== null) {
    const block = m[1];
    // Tj / ' / " operators contain parenthesised strings
    const tjPat = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")/g;
    let t: RegExpExecArray | null;
    while ((t = tjPat.exec(block)) !== null) {
      parts.push(
        t[1]
          .replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\\/g, '\\')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')'),
      );
    }
    // TJ arrays contain alternating strings and kerning numbers
    const tjArr = /\[([^\]]+)\]\s*TJ/g;
    let a: RegExpExecArray | null;
    while ((a = tjArr.exec(block)) !== null) {
      const pieces = a[1].match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g) ?? [];
      for (const p of pieces) parts.push(p.slice(1, -1));
    }
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ── Workers AI: extract foreign ties from free text ───────────────────────────
interface AiForeignTie {
  entity_name: string;
  entity_country: string | null;
  relationship_type: 'directorship' | 'travel' | 'donation' | 'membership' | 'investment' | 'lobbying';
  description: string;
}

async function aiExtractForeignTies(
  env: Env, politicianName: string, text: string,
): Promise<AiForeignTie[]> {
  const prompt = `Analyze this Australian politician's register of interests for ${politicianName} and extract ONLY foreign ties.

A "foreign tie" is:
- Directorship or role in a foreign (non-Australian) company or entity
- Travel or hospitality funded by a foreign government, state entity, or foreign-based organisation
- Gifts from foreign entities or foreign nationals
- Investments in companies listed on foreign (non-ASX) stock exchanges
- Memberships in foreign organisations
- Income from foreign sources

Register text:
---
${text.slice(0, 5000)}
---

Return ONLY a JSON array of objects with these fields:
  entity_name: string (name of the foreign entity or country)
  entity_country: string or null (country of the entity, null if unknown)
  relationship_type: one of "directorship" | "travel" | "donation" | "membership" | "investment" | "lobbying"
  description: string (1 sentence describing the tie)

Return [] if no foreign ties are found. No other text outside the JSON array.`;

  try {
    const result = await (env.AI as any).run(AI_MODEL, {
      messages: [
        { role: 'system', content: 'You extract structured data from Australian parliamentary interest registers. Return only valid JSON arrays. Never use placeholder names like "Company X", "Country Y", or single letters. If you are uncertain, omit the entry entirely. Only include entries with specific, real entity names.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
    });

    const raw: string = result?.response ?? '';
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1].trim() : raw.trim();
    const start = candidate.indexOf('[');
    const end   = candidate.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    const KNOWN_SHORT = new Set(['US','UK','NZ','AU','EU','DE','FR','JP','CN','IN','SG','HK','CA','IT','ES','BR','KR','TW','AE','CH','SE','NO','DK','NL','BE','AT','PL','IE','MY','TH','ID','PH']);
    return parsed.filter((tie: AiForeignTie) => {
      if (!tie.entity_name || tie.entity_name.length < 3) return false;
      // Drop anything explicitly Australian
      if ((tie.entity_country ?? '').toLowerCase().trim() === 'australia') return false;
      if (/^(Company|Entity|Organisation|Organization|Association|Group|Institute)\s+[A-Z]$/i.test(tie.entity_name)) return false;
      if (/^(Country|Nation|State|Region)\s+[A-Z]$/i.test(tie.entity_country ?? '')) return false;
      if ((tie.entity_country ?? '').length <= 2 && !KNOWN_SHORT.has((tie.entity_country ?? '').toUpperCase())) return false;
      return true;
    });
  } catch {
    return [];
  }
}

// ── Senate ETL via PBS JSON API ───────────────────────────────────────────────
interface SenateStatement {
  cdapId: string; name: string; senatorParty: string; state: string;
  id: string; lodgmentDate: string;
}
interface SenateStatementDetail {
  senatorInterestStatement: { senatorName: string; lodgementDate: string };
  registeredDirectorshipsOfCompanies: { interests: Array<{ nameOfCompany?: string; companyName?: string; countryOfIncorporation?: string }> };
  sponsoredTravelOrHospitality: { interests: Array<{ detailOfTravelHospitality?: string }> };
  gifts: { interests: Array<{ detailOfGifts?: string }> };
  otherInterest: { interests: Array<{ nameOfInterest?: string; details?: string }> };
  investments: { interests: Array<{ nameOfInvestment?: string; countryOfInvestment?: string; details?: string }> };
  shareHoldings: { interests: Array<{ nameOfCompany?: string; countryOfCompany?: string }> };
}

async function processSenator(
  env: Env, db: D1Database, politician: { id: string; name: string }, cdapId: string,
): Promise<number> {
  const res = await fetch(`${PBS_API}/getSenatorStatement?cdapid=${cdapId}`, {
    headers: { 'User-Agent': 'OnTheRecord/1.0' },
  });
  if (!res.ok) return 0;

  const data = await res.json() as SenateStatementDetail;
  const sourceUrl = `${PBS_API}/getSenatorStatement?cdapid=${cdapId}`;
  let count = 0;

  // Build a text blob from all free-text fields for AI analysis
  const textParts: string[] = [];

  // Directorships — parse directly if country field present; else collect for AI
  for (const item of data.registeredDirectorshipsOfCompanies?.interests ?? []) {
    const name = item.nameOfCompany ?? item.companyName ?? '';
    if (!name) continue;
    const country = (item.countryOfIncorporation ?? null) as string | null;
    // Only flag non-Australian directorships outright; let AI handle ambiguous ones
    if (country && country.toLowerCase() !== 'australia') {
      const id = hashTie([politician.id, name, country, 'directorship']);
      await db.prepare(`
        INSERT INTO foreign_ties (id, politician_id, entity_name, entity_country, relationship_type, risk_rating, description, source_url)
        VALUES (?, ?, ?, ?, 'directorship', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET entity_country=excluded.entity_country, risk_rating=excluded.risk_rating
      `).bind(id, politician.id, name, country, assessRisk(country), `Directorship: ${name} (${country})`, sourceUrl).run();
      count++;
    } else {
      textParts.push(`Directorship: ${name}${country ? ` (${country})` : ''}`);
    }
  }

  // Sponsored travel — always send to AI (free text, high value signal)
  for (const item of data.sponsoredTravelOrHospitality?.interests ?? []) {
    const detail = item.detailOfTravelHospitality ?? '';
    if (detail) textParts.push(`Sponsored travel: ${detail}`);
  }

  // Gifts
  for (const item of data.gifts?.interests ?? []) {
    const detail = item.detailOfGifts ?? '';
    if (detail) textParts.push(`Gift: ${detail}`);
  }

  // Share holdings
  for (const item of data.shareHoldings?.interests ?? []) {
    const name = item.nameOfCompany ?? '';
    const country = item.countryOfCompany ?? null;
    if (name && country && country.toLowerCase() !== 'australia') {
      textParts.push(`Share holding: ${name} (${country})`);
    }
  }

  // Investments
  for (const item of data.investments?.interests ?? []) {
    const name = item.nameOfInvestment ?? item.details ?? '';
    const country = item.countryOfInvestment ?? null;
    if (name) textParts.push(`Investment: ${name}${country ? ` (${country})` : ''}`);
  }

  // Other interests
  for (const item of data.otherInterest?.interests ?? []) {
    const detail = item.nameOfInterest ?? item.details ?? '';
    if (detail) textParts.push(`Other interest: ${detail}`);
  }

  if (textParts.length > 0) {
    const ties = await aiExtractForeignTies(env, politician.name, textParts.join('\n'));
    for (const tie of ties) {
      if (!tie.entity_name || tie.entity_name.length < 2) continue;
      const id = hashTie([politician.id, tie.entity_name, tie.entity_country ?? '', tie.relationship_type]);
      await db.prepare(`
        INSERT INTO foreign_ties (id, politician_id, entity_name, entity_country, relationship_type, risk_rating, description, source_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          entity_country    = excluded.entity_country,
          relationship_type = excluded.relationship_type,
          risk_rating       = excluded.risk_rating,
          description       = excluded.description
      `).bind(
        id, politician.id, tie.entity_name, tie.entity_country ?? null,
        tie.relationship_type, assessRisk(tie.entity_country),
        tie.description ?? null, sourceUrl,
      ).run();
      count++;
    }
  }

  return count;
}

// ── House ETL via APH PDF register ───────────────────────────────────────────
// Build surname → PDF URL map from the register page.
// Returns [map, debugInfo] so the caller can log diagnostics.
async function fetchMemberPdfMap(): Promise<{ map: Map<string, string>; total: number; samples: string[] }> {
  const res = await fetch(REG_PAGE, { headers: { 'User-Agent': 'OnTheRecord/1.0 accountability-platform', 'Accept': 'text/html' } });
  if (!res.ok) {
    console.error(`fetchMemberPdfMap: HTTP ${res.status} from ${REG_PAGE}`);
    return { map: new Map(), total: 0, samples: [] };
  }
  const html = await res.text();

  const map = new Map<string, string>();
  // Match both single- and double-quoted hrefs, full https URL or absolute path
  // e.g. href="/-/media/.../48p/AB/Albanese_48P.pdf"
  //   or href='https://www.aph.gov.au/-/media/.../48p/AB/Albanese_48P.pdf'
  const re = /href=["']([^"']*\/48p\/[A-Z]{2}\/([A-Za-z][A-Za-z0-9\-]*)_48P\.pdf)["']/gi;
  let m: RegExpExecArray | null;
  const samples: string[] = [];

  while ((m = re.exec(html)) !== null) {
    let path = m[1];
    const rawSurname = m[2]; // e.g. "Albanese", "ChesterD"

    // Ensure absolute URL
    if (path.startsWith('/')) path = `${APH_BASE}${path}`;

    // Normalise: strip trailing single uppercase letter used for disambiguation (e.g. "ChesterD" → "Chester")
    const cleanSurname = rawSurname.replace(/[A-Z]$/, '');

    map.set(rawSurname.toLowerCase(), path);        // raw key  e.g. "chesterd"
    map.set(cleanSurname.toLowerCase(), path);      // clean key e.g. "chester"

    if (samples.length < 5) samples.push(`${rawSurname} → ${path}`);
  }

  return { map, total: map.size, samples };
}

async function processMember(
  env: Env, db: D1Database,
  politician: { id: string; name: string }, pdfUrl: string,
): Promise<number> {
  const res = await fetch(pdfUrl, { headers: { 'User-Agent': 'OnTheRecord/1.0' } });
  if (!res.ok) return 0;

  const buf = await res.arrayBuffer();
  const text = extractPdfText(buf);
  console.log(`  ${politician.name}: PDF fetch status=${res.status} text_length=${text.length}`);
  if (text.length < 50) {
    // PDF likely scanned — skip (would need OCR)
    console.log(`  ${politician.name}: scanned PDF (text<50), skipping`);
    return 0;
  }

  const ties = await aiExtractForeignTies(env, politician.name, text);
  let count = 0;

  for (const tie of ties) {
    if (!tie.entity_name || tie.entity_name.length < 2) continue;
    const id = hashTie([politician.id, tie.entity_name, tie.entity_country ?? '', tie.relationship_type]);
    await db.prepare(`
      INSERT INTO foreign_ties (id, politician_id, entity_name, entity_country, relationship_type, risk_rating, description, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity_country    = excluded.entity_country,
        relationship_type = excluded.relationship_type,
        risk_rating       = excluded.risk_rating,
        description       = excluded.description
    `).bind(
      id, politician.id, tie.entity_name, tie.entity_country ?? null,
      tie.relationship_type, assessRisk(tie.entity_country),
      tie.description ?? null, pdfUrl,
    ).run();
    count++;
  }

  return count;
}

// ══ MAIN ETL ═════════════════════════════════════════════════════════════════
export async function runForeignTiesETL(env: Env, offset = 0, limit = 20, debugName?: string) {
  const db = env.DB;

  let politicians: { id: string; name: string; chamber: string }[];
  if (debugName) {
    const { results } = await db.prepare(
      "SELECT id, name, chamber FROM politicians WHERE name LIKE ? ORDER BY name",
    ).bind(`%${debugName}%`).all<{ id: string; name: string; chamber: string }>();
    politicians = results;
  } else {
    const { results } = await db.prepare(
      "SELECT id, name, chamber FROM politicians ORDER BY name LIMIT ? OFFSET ?",
    ).bind(limit, offset).all<{ id: string; name: string; chamber: string }>();
    politicians = results;
  }

  // ── 1. Build Senate name→cdapId map ──────────────────────────────────────
  const senateRes = await fetch(`${PBS_API}/queryStatements?pageSize=200&pageNumber=1`, {
    headers: { 'User-Agent': 'OnTheRecord/1.0 accountability-platform' },
  });
  const senateData = senateRes.ok
    ? (await senateRes.json() as { statementOfRegisterableInterests: SenateStatement[] })
    : { statementOfRegisterableInterests: [] };

  // Index by normalised surname (lowercase) → cdapId
  // Senate API name format: "Surname, Firstname" → normalise to "Firstname Surname"
  const senateBySurname = new Map<string, string>();
  for (const s of senateData.statementOfRegisterableInterests) {
    const normName = normaliseApiName(s.name);   // "Waters, Larissa" → "Larissa Waters"
    const sur = surname(normName).toLowerCase(); // "waters"
    senateBySurname.set(sur, s.cdapId);
    // Also store by full normalised name (lowercase) for direct lookup
    senateBySurname.set(normName.toLowerCase(), s.cdapId);
  }

  console.log(`Senate index: ${senateData.statementOfRegisterableInterests.length} senators, ${senateBySurname.size} index entries`);
  // Debug: first 5 senate surnames in the map
  const senateSample = [...senateBySurname.entries()].slice(0, 5).map(([k, v]) => `${k}→${v}`);
  console.log(`Senate sample: ${senateSample.join(', ')}`);

  // ── 2. Build House surname→PDF URL map ────────────────────────────────────
  const { map: memberPdfMap, total: pdfTotal, samples: pdfSamples } = await fetchMemberPdfMap();
  console.log(`PDF map: ${pdfTotal} entries from ${REG_PAGE}`);
  console.log(`PDF samples: ${pdfSamples.join(' | ')}`);

  // ── 3. Process each politician ─────────────────────────────────────────────
  // Route by OA member ID: senators have 6-digit IDs in the 100xxx range
  let totalSenate = 0, totalHouse = 0, totalTies = 0, skipped = 0;

  // Debug: log first 5 politician surnames and what they'd look up
  const polSample = politicians.slice(0, 5).map(p => {
    const keys = surnameLookupKeys(p.name);
    const isSenate = (p.chamber || '').toLowerCase() === 'senate';
    const hit = isSenate
      ? (keys.some(k => senateBySurname.has(k)) ? 'senate✓' : 'senate✗')
      : (keys.some(k => memberPdfMap.has(k)) ? 'pdf✓' : 'pdf✗');
    return `${p.name}[${p.chamber}](${keys.join('|')})[${hit}]`;
  });
  console.log(`Politician sample: ${polSample.join(', ')}`);

  for (const pol of politicians) {
    const keys = surnameLookupKeys(pol.name);
    // Route by chamber column (reliable) rather than ID heuristic
    const isSenate = (pol.chamber || '').toLowerCase() === 'senate';

    if (isSenate) {
      const cdapId = keys.reduce<string | undefined>((found, k) => found ?? senateBySurname.get(k), undefined)
        ?? senateBySurname.get(pol.name.toLowerCase());
      if (cdapId) {
        try {
          const n = await processSenator(env, db, pol, cdapId);
          totalTies += n;
          totalSenate++;
          console.log(`Senate ${pol.name}: ${n} ties`);
        } catch (err) {
          console.error(`Senate ${pol.name}:`, err);
        }
        await sleep(500);
      } else {
        skipped++;
        console.log(`Senate ${pol.name} (${keys.join(',')}): no PBS API match`);
      }
    } else {
      const pdfUrl = keys.reduce<string | undefined>((found, k) => found ?? memberPdfMap.get(k), undefined);
      if (pdfUrl) {
        try {
          const n = await processMember(env, db, pol, pdfUrl);
          totalTies += n;
          totalHouse++;
          console.log(`House ${pol.name}: ${n} ties`);
        } catch (err) {
          console.error(`House ${pol.name}:`, err);
        }
        await sleep(800);
      } else {
        skipped++;
        console.log(`House ${pol.name} (${keys.join(',')}): no PDF match`);
      }
    }
  }

  return {
    success: true,
    senate: totalSenate,
    house: totalHouse,
    skipped,
    totalForeignTies: totalTies,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  try {
    const body = await request.json().catch(() => ({}));
    const offset = Number((body as any).offset ?? 0);
    const limit  = Number((body as any).limit  ?? 20);
    const debugName = (body as any).debugName as string | undefined;
    const result = await runForeignTiesETL(locals.runtime.env, offset, limit, debugName);
    return jsonResponse(result);
  } catch (err) {
    console.error('Foreign ties ETL error:', err);
    return jsonError(`Foreign ties ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
