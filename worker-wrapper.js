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

    // Daily at 2:00 AM - Roster ETL
    if (cron === '0 2 * * *') {
      endpoint = '/api/internal/etl/roster';
      description = 'Roster ETL';
    }
    // Daily at 3:00 AM - Photo fetch
    else if (cron === '0 3 * * *') {
      endpoint = '/api/internal/photos/fetch';
      description = 'Photo Fetch';
    }
    // Daily at 4:00 AM - Reserved for future use
    else if (cron === '0 4 * * *') {
      console.log('[CRON] 4AM slot reserved for future use');
      return;
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
