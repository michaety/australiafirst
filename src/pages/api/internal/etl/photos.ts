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
        headers: { 'User-Agent': 'OnTheRecord/1.0 accountability-platform' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buffer = await res.arrayBuffer();
      const r2Key = `photos/${politicianId}/original.jpg`;

      let processedBuffer: ArrayBuffer = buffer;
      try {
        const uint8 = new Uint8Array(buffer);
        const aiResult = await AI.run('@cf/bytedance/stable-diffusion-xl-lightning' as any, {
          prompt: 'police mugshot photo, harsh overhead fluorescent lighting, high contrast, desaturated washed out colors, gritty, front facing portrait, plain grey background, booking photo style',
          image: [...uint8],
          strength: 0.35,
          guidance: 7.5,
        }) as ReadableStream | Uint8Array | ArrayBuffer;
        if (aiResult instanceof Uint8Array) {
          processedBuffer = aiResult.buffer;
        } else if (aiResult instanceof ArrayBuffer) {
          processedBuffer = aiResult;
        } else if (aiResult instanceof ReadableStream) {
          const reader = aiResult.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          const total = chunks.reduce((s, c) => s + c.length, 0);
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          processedBuffer = merged.buffer;
        }
      } catch (aiErr) {
        console.error('AI mugshot processing failed, using original:', aiErr);
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
