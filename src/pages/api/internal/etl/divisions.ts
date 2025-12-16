import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/api';
import { OpenAustraliaClient } from '../../../../lib/upstream/openaus';
import { storeRawDocument } from '../../../../lib/audit';
import { randomUUID } from 'crypto';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
  const db = locals.runtime.env.DB;
  const r2 = locals.runtime.env.R2;
  const apiKey = locals.runtime.env.OPENAUSTRALIA_API_KEY;

  try {
    const client = new OpenAustraliaClient({ apiKey });

    // Get last ingested division date
    const lastDivision = await db
      .prepare('SELECT MAX(date) as last_date FROM divisions')
      .first<{ last_date: string }>();

    const sinceDate = lastDivision?.last_date || '2020-01-01';

    // Fetch divisions for both chambers
    const [houseDivisions, senateDivisions] = await Promise.all([
      client.getDivisions({ type: 'house', date: sinceDate }),
      client.getDivisions({ type: 'senate', date: sinceDate }),
    ]);

    // Store raw data
    await storeRawDocument(db, r2, 'openaustralia-divisions-house', houseDivisions);
    await storeRawDocument(db, r2, 'openaustralia-divisions-senate', senateDivisions);

    let processedDivisions = 0;
    let processedVotes = 0;

    // Process divisions
    const allDivisions = [
      ...((houseDivisions as any)?.divisions || []),
      ...((senateDivisions as any)?.divisions || []),
    ];

    for (const division of allDivisions) {
      const divisionId = randomUUID();

      // Insert division
      await db
        .prepare(
          `INSERT OR REPLACE INTO divisions 
           (id, external_id, chamber, date, title, motion, source_url) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          divisionId,
          division.division_id,
          division.house === 'Commons' ? 'house' : 'senate',
          division.date,
          division.division_title || 'Unknown',
          division.motion || null,
          division.source_url || null
        )
        .run();

      processedDivisions++;

      // Add to mapping queue if not already mapped
      await db
        .prepare(
          `INSERT OR IGNORE INTO mapping_queue (division_id, status) 
           VALUES (?, 'new')`
        )
        .bind(divisionId)
        .run();

      // Fetch detailed vote data for this division
      try {
        const divisionDetail = await client.getDivision({ id: division.division_id });
        await storeRawDocument(
          db,
          r2,
          `openaustralia-division-detail-${division.division_id}`,
          divisionDetail
        );

        // Process votes
        const votes = (divisionDetail as any)?.votes || [];
        for (const vote of votes) {
          // Find politician by external_id
          const politician = await db
            .prepare(
              `SELECT id FROM politicians WHERE external_ids LIKE ?`
            )
            .bind(`%"openaustralia":"${vote.person_id}"%`)
            .first<{ id: string }>();

          if (politician) {
            await db
              .prepare(
                `INSERT OR REPLACE INTO votes 
                 (division_id, politician_id, vote, source_url) 
                 VALUES (?, ?, ?, ?)`
              )
              .bind(
                divisionId,
                politician.id,
                vote.vote.toLowerCase(),
                vote.source_url || null
              )
              .run();

            processedVotes++;
          }
        }
      } catch (e) {
        console.error(`Failed to fetch division detail for ${division.division_id}:`, e);
      }
    }

    return jsonResponse({
      success: true,
      message: 'Divisions and votes synced successfully',
      processedDivisions,
      processedVotes,
    });
  } catch (e) {
    console.error('Error in divisions ETL:', e);
    return jsonResponse(
      { error: 'Internal server error', details: String(e) },
      { status: 500 }
    );
  }
};
