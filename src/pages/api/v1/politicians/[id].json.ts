import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, withCache } from '../../../../lib/api';
import { getPoliticianProfile } from '../../../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  const { DB, KV } = locals.runtime.env;
  const { id } = params;

  if (!id) return jsonError('Missing politician ID', 400);

  try {
    const cacheKey = `v1:politician:${id}`;
    const data = await withCache(KV, cacheKey, async () => {
      const profile = await getPoliticianProfile(DB, id);
      if (!profile) return null;
      const { politician, actions, donations, promises, foreignTies } = profile;
      return {
        updatedAt: new Date().toISOString(),
        politician: {
          id: politician.id,
          name: politician.name,
          chamber: politician.chamber,
          party: politician.party_abbreviation ?? politician.party_name ?? null,
          partyName: politician.party_name ?? null,
          electorate: politician.electorate,
          jurisdiction: politician.jurisdiction,
          photoUrl: politician.photo_url,
          hasMugshot: !!politician.mugshot_r2_key,
          bio: politician.bio,
          website: politician.website,
        },
        actions: actions.map((a) => ({
          id: a.id,
          title: a.title,
          description: a.description,
          date: a.date,
          category: a.category,
          sourceUrl: a.source_url,
          evidenceUrl: a.evidence_url,
        })),
        donations: donations.map((d) => ({
          id: d.id,
          donorName: d.donor_name,
          amountCents: d.amount_cents,
          year: d.year,
          source: d.source,
          sourceUrl: d.source_url,
          notes: d.notes,
        })),
        promises: promises.map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          madeDate: p.made_date,
          deadlineDate: p.deadline_date,
          status: p.status,
          evidenceUrl: p.evidence_url,
          sourceUrl: p.source_url,
          notes: p.notes,
        })),
        foreignTies: foreignTies.map((f) => ({
          id: f.id,
          entityName: f.entity_name,
          entityCountry: f.entity_country,
          relationshipType: f.relationship_type,
          riskRating: f.risk_rating,
          description: f.description,
          dateStart: f.date_start,
          dateEnd: f.date_end,
          sourceUrl: f.source_url,
        })),
      };
    }, 60);

    if (!data) return jsonError('Politician not found', 404);
    return jsonResponse(data, { ttl: 60 });
  } catch (err) {
    console.error(`GET /api/v1/politicians/${id}.json error:`, err);
    return jsonError('Failed to fetch politician profile');
  }
};
