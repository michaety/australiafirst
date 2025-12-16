import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/api';
import { TVFYClient } from '../../../../lib/upstream/tvfy';
import { storeRawDocument } from '../../../../lib/audit';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
  const db = locals.runtime.env.DB;
  const r2 = locals.runtime.env.R2;
  const apiKey = locals.runtime.env.THEYVOTEFORYOU_API_KEY;

  try {
    const client = new TVFYClient({ apiKey });

    // Fetch policies from TVFY
    const policiesData = await client.getPolicies();

    // Store raw data in R2 for audit
    await storeRawDocument(db, r2, 'tvfy-policies', policiesData);

    // Mark as successfully parsed
    // Note: We don't import these into division_mappings automatically
    // They're stored for human review only

    return jsonResponse({
      success: true,
      message: 'TVFY policies fetched and stored for review',
      count: Array.isArray(policiesData) ? policiesData.length : 0,
    });
  } catch (e) {
    console.error('Error in TVFY policies ETL:', e);
    return jsonResponse(
      { error: 'Internal server error', details: String(e) },
      { status: 500 }
    );
  }
};
