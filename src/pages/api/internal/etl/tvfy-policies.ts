import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/api';
import { TVFYClient } from '../../../../lib/upstream/tvfy';
import { storeRawDocument } from '../../../../lib/audit';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
  // Access runtime environment bindings
  const env = locals.runtime?.env;
  if (!env) {
    console.error('Runtime environment not available');
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }

  const db = env.DB;
  const r2 = env.R2;
  const apiKey = env.THEYVOTEFORYOU_API_KEY;

  try {
    const client = new TVFYClient({ apiKey });

    // Fetch policies from TVFY
    const policiesData = await client.getPolicies();

    // Store raw data in R2 for audit
    await storeRawDocument(db, r2, 'tvfy-policies', policiesData);

    // Count policies if it's an array
    const count = Array.isArray(policiesData) ? policiesData.length : 0;

    // Mark as successfully parsed
    // Note: We don't import these into division_mappings automatically
    // They're stored for human review only

    return jsonResponse({
      success: true,
      message: 'TVFY policies fetched and stored for review',
      count,
    });
  } catch (e) {
    console.error('Error in TVFY policies ETL:', e);
    return jsonResponse(
      { error: 'Internal server error', details: String(e) },
      { status: 500 }
    );
  }
};
