import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

// AEC donation disclosures are published annually as ZIP/CSV at:
// https://transparency.aec.gov.au/AnnualDonor
// Automated ingest is not yet implemented — data must be imported manually.

export async function runDonationsETL(_env: Env) {
  return {
    success: true,
    skipped: true,
    note: 'AEC donation data requires manual CSV import from https://transparency.aec.gov.au/AnnualDonor — automated ETL not yet implemented.',
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authErr = requireInternalSecret(request, locals.runtime.env);
  if (authErr) return authErr;

  try {
    const result = await runDonationsETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('Donations ETL error:', err);
    return jsonError(`Donations ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
