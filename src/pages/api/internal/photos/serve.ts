import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const { R2 } = locals.runtime.env;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing key', { status: 400 });

  if (!key.startsWith('photos/')) {
    return new Response('Forbidden', { status: 403 });
  }

  const object = await R2.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(object.body as ReadableStream, { headers });
};
