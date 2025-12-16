import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/api';
import { OpenAustraliaClient } from '../../../../lib/upstream/openaus';
import { storeRawDocument } from '../../../../lib/audit';
import { randomUUID } from 'crypto';

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
  const apiKey = env.OPENAUSTRALIA_API_KEY;

  try {
    const client = new OpenAustraliaClient({ apiKey });

    // Fetch MPs and Senators
    const [mpsData, senatorsData] = await Promise.all([
      client.getMPs(),
      client.getSenators(),
    ]);

    // Store raw data
    await storeRawDocument(db, r2, 'openaustralia-mps', mpsData);
    await storeRawDocument(db, r2, 'openaustralia-senators', senatorsData);

    // Process and upsert politicians
    let processedCount = 0;
    const politicians = [...(mpsData as any[]), ...(senatorsData as any[])];

    for (const mp of politicians) {
      const politicianId = randomUUID();
      const externalIds = JSON.stringify({
        openaustralia: mp.person_id,
      });

      // Upsert party
      if (mp.party) {
        await db
          .prepare(
            `INSERT OR IGNORE INTO parties (id, name, abbreviation) 
             VALUES (?, ?, ?)`
          )
          .bind(mp.party.toLowerCase().replace(/\s+/g, '-'), mp.party, mp.party)
          .run();
      }

      // Upsert politician
      await db
        .prepare(
          `INSERT OR REPLACE INTO politicians 
           (id, external_ids, name, chamber, party_id, electorate, dates) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          politicianId,
          externalIds,
          mp.full_name,
          mp.house === 'Representatives' ? 'house' : 'senate',
          mp.party ? mp.party.toLowerCase().replace(/\s+/g, '-') : null,
          mp.constituency || mp.division,
          JSON.stringify({
            entered: mp.entered_house || mp.entered_senate,
            left: mp.left_house || mp.left_senate,
          })
        )
        .run();

      processedCount++;
    }

    return jsonResponse({
      success: true,
      message: 'Roster sync completed',
      processedCount,
    });
  } catch (e) {
    console.error('Error in roster ETL:', e);
    return jsonResponse(
      { error: 'Internal server error', details: String(e) },
      { status: 500 }
    );
  }
};
