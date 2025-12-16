/**
 * Custom Cloudflare Worker entrypoint with scheduled event support
 * This wraps the Astro-generated worker and adds cron trigger handling
 */

// This will be the Astro-generated worker
import astroWorker from './_worker.js/index.js';

/**
 * Scheduled event handler for Cloudflare Cron Triggers
 * Routes cron jobs to appropriate ETL and scoring endpoints
 * 
 * Cron schedules (defined in wrangler.json):
 * - 0 2 * * *       - Daily at 2:00 AM: Roster ETL
 * - 30 2 * * *      - Daily at 2:30 AM: Divisions ETL  
 * - 0 4 * * *       - Daily at 4:00 AM: Scoring Job
 * - 0 3 * * SUN     - Weekly on Sunday at 3:00 AM: TVFY Policies ETL
 */
async function handleScheduled(event, env, ctx) {
  const { cron } = event;
  
  console.log(`[CRON] Triggered: ${cron}`);

  try {
    // Route based on cron schedule
    let endpoint = null;
    let description = '';

    // Daily at 2:00 AM - Roster ETL
    if (cron === '0 2 * * *') {
      endpoint = '/api/internal/etl/roster';
      description = 'Roster ETL';
    }
    // Daily at 2:30 AM - Divisions ETL
    else if (cron === '30 2 * * *') {
      endpoint = '/api/internal/etl/divisions';
      description = 'Divisions ETL';
    }
    // Daily at 4:00 AM - Scoring job
    else if (cron === '0 4 * * *') {
      endpoint = '/api/internal/scorer/run';
      description = 'Scoring Job';
    }
    // Weekly on Sunday at 3:00 AM - TVFY policies
    else if (cron === '0 3 * * SUN') {
      endpoint = '/api/internal/etl/tvfy-policies';
      description = 'TVFY Policies ETL';
    }

    if (endpoint) {
      console.log(`[CRON] Running ${description}: ${endpoint}`);
      
      // Create a request to the internal endpoint
      // Use a dummy hostname - the worker will route based on pathname
      const request = new Request(`https://dummy.internal${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cron-Trigger': 'true',
        },
      });

      // Call the Astro worker's fetch handler
      const response = await astroWorker.fetch(request, env, ctx);
      
      // Response body can only be consumed once, so choose one method
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
    // Don't throw - we don't want cron failures to prevent future runs
  }
}

// Export the worker with both fetch and scheduled handlers
export default {
  async fetch(request, env, ctx) {
    return astroWorker.fetch(request, env, ctx);
  },
  
  async scheduled(event, env, ctx) {
    await handleScheduled(event, env, ctx);
  },
};
