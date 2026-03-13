import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../lib/api';

export const prerender = false;

const ETL_JOBS = [
  'Roster ETL',
  'Divisions ETL',
  'Donations ETL',
  'Foreign Ties ETL',
  'Photos ETL',
  'NDIS Compliance ETL',
  'NDIS ABR Enrichment',
  'NDIS Scorer',
  'Politician Scorer',
];

export const GET: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  const { KV, DB } = locals.runtime.env;

  try {
    // Fetch last-run records from KV for all jobs
    const jobStatuses = await Promise.all(
      ETL_JOBS.map(async (name) => {
        const raw = await KV.get(`etl:last-run:${name}`);
        if (!raw) return { name, status: 'never', ts: null, result: null };
        try {
          const { ts, status, result } = JSON.parse(raw);
          return { name, status, ts, result };
        } catch {
          return { name, status: 'unknown', ts: null, result: null };
        }
      }),
    );

    // Quick DB row counts for sanity check
    const [politicians, actions, donations, foreignTies, policyScores, promises, ndisProviders] =
      await Promise.all([
        DB.prepare('SELECT COUNT(*) AS n FROM politicians').first<{ n: number }>(),
        DB.prepare('SELECT COUNT(*) AS n FROM actions').first<{ n: number }>(),
        DB.prepare('SELECT COUNT(*) AS n FROM donations').first<{ n: number }>(),
        DB.prepare('SELECT COUNT(*) AS n FROM foreign_ties').first<{ n: number }>(),
        DB.prepare('SELECT COUNT(*) AS n FROM politician_policy_scores').first<{ n: number }>(),
        DB.prepare('SELECT COUNT(*) AS n FROM promises').first<{ n: number }>(),
        DB.prepare('SELECT COUNT(*) AS n FROM ndis_providers').first<{ n: number }>(),
      ]);

    const hasErrors = jobStatuses.some((j) => j.status === 'error');
    const hasNever = jobStatuses.some((j) => j.status === 'never');

    return jsonResponse({
      ok: !hasErrors,
      warning: hasNever ? 'Some jobs have never run' : undefined,
      jobs: jobStatuses,
      counts: {
        politicians: politicians?.n ?? 0,
        actions: actions?.n ?? 0,
        donations: donations?.n ?? 0,
        foreignTies: foreignTies?.n ?? 0,
        policyScores: policyScores?.n ?? 0,
        promises: promises?.n ?? 0,
        ndisProviders: ndisProviders?.n ?? 0,
      },
    });
  } catch (err) {
    console.error('[health] error:', err);
    return jsonError(`Health check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
