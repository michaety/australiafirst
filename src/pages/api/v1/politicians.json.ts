import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, withCache } from '../../../lib/api';
import { getPoliticians } from '../../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const { DB, KV } = locals.runtime.env;
  const url = new URL(request.url);
  const chamber = url.searchParams.get('chamber') ?? undefined;
  const party = url.searchParams.get('party') ?? undefined;
  const search = url.searchParams.get('q') ?? undefined;
  const sort = url.searchParams.get('sort') ?? undefined;

  try {
    const cacheKey = `v1:politicians:${chamber ?? ''}:${party ?? ''}:${search ?? ''}:${sort ?? ''}`;
    const data = await withCache(KV, cacheKey, async () => {
      const politicians = await getPoliticians(DB, { chamber, party, search, sort });
      return {
        updatedAt: new Date().toISOString(),
        count: politicians.length,
        politicians: politicians.map((p) => ({
          id: p.id,
          name: p.name,
          chamber: p.chamber,
          party: p.party_abbreviation ?? p.party_name ?? null,
          partyName: p.party_name ?? null,
          electorate: p.electorate,
          jurisdiction: p.jurisdiction,
          photoUrl: p.photo_url,
          hasMugshot: !!p.mugshot_r2_key,
          riskScore: p.risk_score ?? 0,
          riskLabel: p.risk_label ?? 'low',
        })),
      };
    }, 120);

    return jsonResponse(data, { ttl: 120 });
  } catch (err) {
    console.error('GET /api/v1/politicians.json error:', err);
    return jsonError('Failed to fetch politicians');
  }
};
