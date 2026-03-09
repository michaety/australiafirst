import type { APIRoute } from 'astro';
import { jsonResponse, jsonError } from '../../../../lib/api';
import { fetchPhotoBuffer, storePhotoInR2, photoR2Key, mugshotR2Key, applyMugshotStyle } from '../../../../lib/photos';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const { DB, R2, AI } = locals.runtime.env;

  try {
    const body = await request.json() as { politician_id?: string; limit?: number };
    const { politician_id, limit = 10 } = body;

    let query = `
      SELECT pp.id, pp.politician_id, p.name
      FROM politician_photos pp
      JOIN politicians p ON p.id = pp.politician_id
      WHERE pp.status = 'pending'
    `;
    const params: unknown[] = [];
    if (politician_id) {
      query += ` AND pp.politician_id = ?`;
      params.push(politician_id);
    }
    query += ` LIMIT ?`;
    params.push(limit);

    const pending = await DB.prepare(query).bind(...params).all<{
      id: string;
      politician_id: string;
      name: string;
    }>().catch((err) => {
      console.error('Photo fetch: DB query failed:', err);
      throw err;
    });

    let fetched = 0;
    let failed = 0;

    for (const record of pending.results ?? []) {
      const aphId = record.politician_id.replace('aph_', '');
      const sourceUrl = `https://www.aph.gov.au/api/parliamentarian/${aphId}/image`;

      const buffer = await fetchPhotoBuffer(sourceUrl);
      if (!buffer) {
        await DB.prepare(
          `UPDATE politician_photos SET status = 'error', error = 'fetch_failed' WHERE id = ?`,
        ).bind(record.id).run();
        failed++;
        continue;
      }

      const r2Key = photoR2Key(record.politician_id);
      const r2KeyMugshot = mugshotR2Key(record.politician_id);

      await storePhotoInR2(R2, r2Key, buffer);

      const mugshot = await applyMugshotStyle(AI, buffer);
      await storePhotoInR2(R2, r2KeyMugshot, mugshot);

      await DB.prepare(`
        UPDATE politician_photos
        SET status = 'processed', source_url = ?, r2_key = ?, r2_key_mugshot = ?,
            fetched_at = datetime('now'), processed_at = datetime('now')
        WHERE id = ?
      `).bind(sourceUrl, r2Key, r2KeyMugshot, record.id).run();

      await DB.prepare(`
        UPDATE politicians SET photo_url = ?, mugshot_r2_key = ? WHERE id = ?
      `).bind(sourceUrl, r2KeyMugshot, record.politician_id).run();

      fetched++;
    }

    return jsonResponse({ success: true, fetched, failed });
  } catch (err) {
    console.error('Photo fetch ETL error:', err);
    return jsonError(`Photo fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
