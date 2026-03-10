import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

const JOBS = [
  { name: 'roster', path: '/api/internal/etl/roster' },
  { name: 'photos', path: '/api/internal/etl/photos' },
  { name: 'divisions', path: '/api/internal/etl/divisions' },
  { name: 'donations', path: '/api/internal/etl/donations' },
  { name: 'foreign-ties', path: '/api/internal/etl/foreign-ties' },
];

export const POST: APIRoute = async ({ request, locals, url }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  const origin = url.origin;
  const secret = request.headers.get('X-Internal-Secret') || request.headers.get('X-Cron-Trigger') || '';

  const results: Record<string, unknown> = {};

  for (const job of JOBS) {
    const jobUrl = `${origin}${job.path}`;
    try {
      const res = await fetch(jobUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': secret,
          'X-Cron-Trigger': request.headers.get('X-Cron-Trigger') || '',
        },
      });

      if (res.headers.get('content-type')?.includes('application/json')) {
        results[job.name] = await res.json();
      } else {
        results[job.name] = { status: res.status, body: await res.text() };
      }
    } catch (err) {
      results[job.name] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return jsonResponse({ success: true, results });
};
