import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

const AEC_BASE = 'https://transparency.aec.gov.au/Download/DownloadCsvFile';
const PERIOD_IDS = [41, 40, 39]; // 2023-24, 2022-23, 2021-22
const SOURCE_URL = 'https://transparency.aec.gov.au';

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let inQuotes = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(current.trim());
      current = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(current.trim());
      current = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      current += ch;
    }
  }
  if (current || row.length > 0) {
    row.push(current.trim());
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function hashId(parts: string[]): string {
  let hash = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return 'aec_' + Math.abs(hash).toString(36);
}

function extractLastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

function yearFromFinancial(fy: string): number | null {
  // e.g. "2023-24" → 2024, "2022-23" → 2023
  const match = fy.match(/(\d{4})-(\d{2})/);
  if (match) return parseInt(match[1]) + 1;
  const plain = fy.match(/(\d{4})/);
  if (plain) return parseInt(plain[1]);
  return null;
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  const { DB } = locals.runtime.env;

  try {
    // Build a lookup: last_name → politician_id[]
    const politicians = await DB.prepare(
      `SELECT id, name FROM politicians`
    ).all<{ id: string; name: string }>();

    const nameIndex = new Map<string, string[]>();
    for (const p of politicians.results) {
      const lastName = extractLastName(p.name);
      const existing = nameIndex.get(lastName) || [];
      existing.push(p.id);
      nameIndex.set(lastName, existing);
    }

    let totalProcessed = 0;
    let totalMatched = 0;
    let totalUnmatched = 0;

    for (const periodId of PERIOD_IDS) {
      const url = `${AEC_BASE}?periodId=${periodId}&donationType=Receipts`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'AustraliaFirst/1.0 accountability-platform' },
      });

      if (!res.ok) {
        console.error(`AEC fetch failed for period ${periodId}: ${res.status}`);
        continue;
      }

      const text = await res.text();
      const rows = parseCSV(text);
      if (rows.length < 2) continue;

      // Find column indices from header
      const header = rows[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
      const donorIdx = header.findIndex(h => h.includes('donorname') || h.includes('donor'));
      const recipientIdx = header.findIndex(h => h.includes('recipientname') || h.includes('recipient'));
      const typeIdx = header.findIndex(h => h.includes('recipienttype') || h.includes('type'));
      const amountIdx = header.findIndex(h => h.includes('amount') || h.includes('value'));
      const yearIdx = header.findIndex(h => h.includes('financialyear') || h.includes('year'));

      if (donorIdx < 0 || recipientIdx < 0 || amountIdx < 0) {
        console.error(`CSV header mismatch for period ${periodId}:`, rows[0]);
        continue;
      }

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length <= Math.max(donorIdx, recipientIdx, amountIdx)) continue;

        const recipientType = typeIdx >= 0 ? row[typeIdx] : '';
        // Filter: only candidates and political parties
        if (recipientType && !recipientType.toLowerCase().includes('candidate') && !recipientType.toLowerCase().includes('party')) {
          continue;
        }

        const donorName = row[donorIdx];
        const recipientName = row[recipientIdx];
        const amountStr = row[amountIdx].replace(/[$,\s"]/g, '');
        const amount = parseFloat(amountStr);
        if (!donorName || !recipientName || isNaN(amount)) continue;

        const amountCents = Math.round(amount * 100);
        const financialYear = yearIdx >= 0 ? row[yearIdx] : '';
        const year = yearFromFinancial(financialYear);

        totalProcessed++;

        // Match recipient against politician last names
        const recipientLast = extractLastName(recipientName);
        const matches = nameIndex.get(recipientLast);

        if (!matches || matches.length === 0) {
          totalUnmatched++;
          continue;
        }

        totalMatched++;

        // Insert for all matching politicians (usually 1)
        for (const politicianId of matches) {
          const id = hashId([donorName, politicianId, String(amountCents), String(year ?? '')]);
          await DB.prepare(`
            INSERT INTO donations (id, politician_id, donor_name, amount_cents, year, source, source_url)
            VALUES (?, ?, ?, ?, ?, 'AEC', ?)
            ON CONFLICT(id) DO UPDATE SET
              amount_cents = excluded.amount_cents,
              donor_name = excluded.donor_name
          `).bind(id, politicianId, donorName, amountCents, year, SOURCE_URL).run();
        }
      }
    }

    return jsonResponse({
      success: true,
      processed: totalProcessed,
      matched: totalMatched,
      unmatched: totalUnmatched,
    });
  } catch (err) {
    console.error('Donations ETL error:', err);
    return jsonError(`Donations ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
