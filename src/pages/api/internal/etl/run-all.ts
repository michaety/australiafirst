import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';
import { runRosterETL } from './roster';
import { runPhotosETL } from './photos';
import { runDivisionsETL } from './divisions';
import { runDonationsETL } from './donations';
import { runForeignTiesETL } from './foreign-ties';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  const env = locals.runtime.env;
  const results: Record<string, unknown> = {};

  const jobs = [
    { name: 'roster', fn: () => runRosterETL(env) },
    { name: 'photos', fn: () => runPhotosETL(env) },
    { name: 'divisions', fn: () => runDivisionsETL(env) },
    { name: 'donations', fn: () => runDonationsETL(env) },
    { name: 'foreignTies', fn: () => runForeignTiesETL(env) },
  ];

  for (const job of jobs) {
    try {
      results[job.name] = await job.fn();
    } catch (err) {
      results[job.name] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return jsonResponse({ success: true, results });
};
