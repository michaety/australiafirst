/**
 * Custom Cloudflare Worker entrypoint with scheduled event support
 * This wraps the Astro-generated worker and adds cron trigger handling
 */

import astroWorker from './_worker.js/index.js';

const SCHEDULED_INTERNAL_HOST = 'scheduled.internal';

const CRON_MAP = {
  '0 2 * * *':   { endpoint: '/api/internal/etl/roster',         description: 'Roster ETL' },
  '30 2 * * *':  { endpoint: '/api/internal/etl/divisions',       description: 'Divisions ETL' },
  '0 3 * * *':   { endpoint: '/api/internal/etl/donations',       description: 'Donations ETL' },
  '30 3 * * *':  { endpoint: '/api/internal/etl/foreign-ties',    description: 'Foreign Ties ETL' },
  '0 4 * * *':   { endpoint: '/api/internal/etl/photos',          description: 'Photos ETL' },
  '0 5 * * *':   { endpoint: '/api/internal/etl/ndis-compliance', description: 'NDIS Compliance ETL' },
  '30 5 * * *':  { endpoint: '/api/internal/etl/ndis-abr',        description: 'NDIS ABR Enrichment' },
  '0 6 * * *':   { endpoint: '/api/internal/etl/ndis-scorer',     description: 'NDIS Scorer' },
  '30 6 * * *':  { endpoint: '/api/internal/etl/scorer',          description: 'Politician Scorer' },
};

async function recordETLRun(kv, name, status, result) {
  if (!kv) return;
  try {
    await kv.put(
      `etl:last-run:${name}`,
      JSON.stringify({ ts: new Date().toISOString(), status, result }),
      { expirationTtl: 8 * 86400 }, // expire after 8 days
    );
  } catch (e) {
    console.error(`[CRON] Failed to record ETL run for ${name}:`, e);
  }
}

async function handleScheduled(event, env, ctx) {
  const { cron } = event;
  console.log(`[CRON] Triggered: ${cron}`);

  const job = CRON_MAP[cron];
  if (!job) {
    console.log(`[CRON] No handler configured for schedule: ${cron}`);
    return;
  }

  console.log(`[CRON] Running ${job.description}: ${job.endpoint}`);
  try {
    const request = new Request(`https://${SCHEDULED_INTERNAL_HOST}${job.endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cron-Trigger': 'true' },
    });
    const response = await astroWorker.fetch(request, env, ctx);
    if (response.headers.get('content-type')?.includes('application/json')) {
      const result = await response.json();
      console.log(`[CRON] ${job.description} completed:`, result);
      await recordETLRun(env.KV, job.description, result?.success === false ? 'error' : 'ok', result);
    } else {
      const text = await response.text();
      console.log(`[CRON] ${job.description} completed:`, text);
      await recordETLRun(env.KV, job.description, response.ok ? 'ok' : 'error', { text });
    }
  } catch (error) {
    console.error(`[CRON] Error running ${job.description}:`, error);
    await recordETLRun(env.KV, job.description, 'error', { error: error.message });
  }
}

export default {
  async fetch(request, env, ctx) {
    return astroWorker.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    await handleScheduled(event, env, ctx);
  },
};
