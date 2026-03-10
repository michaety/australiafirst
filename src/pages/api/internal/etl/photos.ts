import type { APIRoute } from 'astro';
import { jsonResponse, jsonError } from '../../../../lib/api';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
  const { DB, R2 } = locals.runtime.env;

  try {
    const pending = await DB.prepare(`
      SELECT pp.id, pp.politician_id, pp.source_url
      FROM politician_photos pp
      WHERE pp.status = 'pending'
      LIMIT 50
    `).all();

    let fetched = 0;
    let errors = 0;

    for (const row of pending.results as Array<{ id: string; politician_id: string; source_url: string | null }>) {
      const politicianId = row.politician_id;
      const photoUrl = row.source_url;

      if (!photoUrl) continue;

      try {
        const res = await fetch(photoUrl, {
          headers: { 'User-Agent': 'Australia First/1.0 accountability-platform' }
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const buffer = await res.arrayBuffer();
        const r2Key = `photos/${politicianId}/original.jpg`;

        await R2.put(r2Key, buffer, {
          httpMetadata: { contentType: 'image/jpeg' }
        });

        await DB.prepare(`
          UPDATE politician_photos
          SET status = 'fetched', r2_key = ?, source_url = ?, fetched_at = datetime('now')
          WHERE id = ?
        `).bind(r2Key, photoUrl, row.id).run();

        await DB.prepare(`
          UPDATE politicians SET photo_url = ? WHERE id = ?
        `).bind(`/api/v1/photos/${politicianId}`, politicianId).run();

        fetched++;
      } catch (err) {
        await DB.prepare(`
          UPDATE politician_photos SET status = 'error', error = ? WHERE id = ?
        `).bind(String(err), row.id).run();
        errors++;
      }
    }

    return jsonResponse({ success: true, processed: pending.results.length, fetched, errors });
  } catch (err) {
    return jsonError(`Photos ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
