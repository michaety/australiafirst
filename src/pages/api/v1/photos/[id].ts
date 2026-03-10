import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const { DB, R2 } = locals.runtime.env;
  const id = params.id;

  const row = await DB.prepare(`
    SELECT r2_key FROM politician_photos WHERE politician_id = ? AND status = 'fetched'
  `).bind(`oa_${id}`).first() as { r2_key: string } | null;

  if (!row?.r2_key) {
    return new Response('Not found', { status: 404 });
  }

  const object = await R2.get(row.r2_key);
  if (!object) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    }
  });
};
