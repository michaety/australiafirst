import type { APIRoute } from 'astro';
import { jsonResponse, jsonError } from '../../../../lib/api';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
  const { DB } = locals.runtime.env;

  try {
    const response = await fetch(
      'https://www.aph.gov.au/api/Member/allmembers?format=json',
      {
        headers: {
          'User-Agent': 'Australia First/1.0 accountability-platform',
          Accept: 'application/json',
        },
      },
    );

    if (!response.ok) {
      return jsonError(`Parliament API returned ${response.status}`, 502);
    }

    const raw = await response.json() as {
      Response?: {
        Representatives?: unknown[];
        Senators?: unknown[];
      };
    };

    const members = [
      ...(raw?.Response?.Representatives ?? []),
      ...(raw?.Response?.Senators ?? []),
    ] as Array<{
      Id?: string;
      Name?: { First?: string; Last?: string };
      Party?: { Name?: string; Abbreviation?: string };
      Electorate?: string;
      Chamber?: string;
      Title?: string;
    }>;

    let processedCount = 0;

    for (const member of members) {
      if (!member.Id) continue;

      const id = `aph_${member.Id}`;
      const name = [member.Name?.First, member.Name?.Last].filter(Boolean).join(' ');
      const chamber = member.Title === 'Senator' ? 'senate' : 'representatives';
      const partyName = member.Party?.Name ?? null;
      const partyAbbr = member.Party?.Abbreviation ?? null;
      const electorate = member.Electorate ?? null;

      let partyId: string | null = null;
      if (partyName) {
        partyId = `party_${(partyAbbr ?? partyName).toLowerCase().replace(/\s+/g, '_')}`;
        await DB.prepare(`
          INSERT INTO parties (id, name, abbreviation) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, abbreviation = excluded.abbreviation
        `).bind(partyId, partyName, partyAbbr).run();
      }

      await DB.prepare(`
        INSERT INTO politicians (id, name, chamber, party_id, electorate, jurisdiction)
        VALUES (?, ?, ?, ?, ?, 'federal')
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          chamber = excluded.chamber,
          party_id = excluded.party_id,
          electorate = excluded.electorate
      `).bind(id, name, chamber, partyId, electorate).run();

      const photoId = `photo_${id}`;
      await DB.prepare(`
        INSERT OR IGNORE INTO politician_photos (id, politician_id, status)
        VALUES (?, ?, 'pending')
      `).bind(photoId, id).run();

      processedCount++;
    }

    return jsonResponse({ success: true, message: 'Roster synced', processedCount });
  } catch (err) {
    console.error('Roster ETL error:', err);
    return jsonError(`Roster ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
