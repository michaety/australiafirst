/**
 * Custom Cloudflare Worker entrypoint with scheduled event support
 * This wraps the Astro-generated worker and adds cron trigger handling
 */

import astroWorker from './_worker.js/index.js';

const SCHEDULED_INTERNAL_HOST = 'scheduled.internal';

async function handleScheduled(event, env, ctx) {
  const { cron } = event;
  console.log(`[CRON] Triggered: ${cron}`);

  try {
    let endpoint = null;
    let description = '';

    // Daily at 2:00 AM - Roster sync
    if (cron === '0 2 * * *') {
      endpoint = '/api/internal/etl/roster';
      description = 'Roster ETL';
    }
    // Daily at 2:30 AM - Divisions + actions
    else if (cron === '30 2 * * *') {
      endpoint = '/api/internal/etl/divisions';
      description = 'Divisions ETL';
    }
    // Daily at 3:00 AM - Donations
    else if (cron === '0 3 * * *') {
      endpoint = '/api/internal/etl/donations';
      description = 'Donations ETL';
    }
    // Daily at 3:30 AM - Foreign ties
    else if (cron === '30 3 * * *') {
      endpoint = '/api/internal/etl/foreign-ties';
      description = 'Foreign Ties ETL';
    }
    // Daily at 4:00 AM - Photos fetch
    else if (cron === '0 4 * * *') {
      endpoint = '/api/internal/etl/photos';
      description = 'Photos ETL';
    }
    // Daily at 5:00 AM - NDIS compliance scrape
    else if (cron === '0 5 * * *') {
      endpoint = '/api/internal/etl/ndis-compliance';
      description = 'NDIS Compliance ETL';
    }
    // Daily at 5:30 AM - NDIS ABR enrichment
    else if (cron === '30 5 * * *') {
      endpoint = '/api/internal/etl/ndis-abr';
      description = 'NDIS ABR Enrichment';
    }
    // Daily at 6:00 AM - NDIS scorer
    else if (cron === '0 6 * * *') {
      endpoint = '/api/internal/etl/ndis-scorer';
      description = 'NDIS Scorer';
    }

    if (endpoint) {
      console.log(`[CRON] Running ${description}: ${endpoint}`);
      const request = new Request(`https://${SCHEDULED_INTERNAL_HOST}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cron-Trigger': 'true',
        },
      });
      const response = await astroWorker.fetch(request, env, ctx);
      if (response.headers.get('content-type')?.includes('application/json')) {
        const result = await response.json();
        console.log(`[CRON] ${description} completed:`, result);
      } else {
        const text = await response.text();
        console.log(`[CRON] ${description} completed:`, text);
      }
    } else {
      console.log(`[CRON] No handler configured for schedule: ${cron}`);
    }
  } catch (error) {
    console.error(`[CRON] Error processing scheduled event:`, error);
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
