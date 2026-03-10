import type { APIRoute } from 'astro';
import { jsonResponse, jsonError } from '../../../../lib/api';

export const prerender = false;

export async function runPhotosETL(env: Env) {
  const { DB, R2, AI } = env;

  const pending = await DB.prepare(`
    SELECT pp.id, pp.politician_id, p.image_url
    FROM politician_photos pp
    JOIN politicians p ON p.id = pp.politician_id
    WHERE pp.status = 'pending' AND p.image_url IS NOT NULL
    LIMIT 50
  `).all();

  let fetched = 0;
  let errors = 0;

  for (const row of pending.results as Array<{ id: string; politician_id: string; image_url: string }>) {
    const politicianId = row.politician_id;
    const photoUrl = `https://www.openaustralia.org.au${row.image_url}`;

    try {
      const res = await fetch(photoUrl, {
        headers: { 'User-Agent': 'Australia First/1.0 accountability-platform' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buffer = await res.arrayBuffer();
      const r2Key = `photos/${politicianId}/original.jpg`;

      let processedBuffer: ArrayBuffer = buffer;
      try {
        const uint8 = new Uint8Array(buffer);
        const result = await AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', {
          prompt: 'police mugshot photo, harsh fluorescent lighting, high contrast, desaturated, gritty, front facing, plain grey background',
          image: Array.from(uint8),
          strength: 0.4,
          num_inference_steps: 8,
        });
        processedBuffer = result instanceof Uint8Array ? result.buffer : buffer;
      } catch {
        // AI processing failed, use original
      }

      await R2.put(r2Key, processedBuffer, {
        httpMetadata: { contentType: 'image/jpeg' }
      });

      await DB.prepare(`
        UPDATE politician_photos
        SET status = 'fetched', r2_key = ?, r2_key_mugshot = ?, source_url = ?, fetched_at = datetime('now')
        WHERE id = ?
      `).bind(r2Key, r2Key, photoUrl, row.id).run();

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

  return { success: true, processed: pending.results.length, fetched, errors };
}

export const POST: APIRoute = async ({ locals }) => {
  try {
    const result = await runPhotosETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    return jsonError(`Photos ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
