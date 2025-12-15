// R2 audit trail helper - stores raw upstream payloads

import crypto from 'crypto';

export async function storeRawDocument(
  db: D1Database,
  r2: R2Bucket,
  sourceName: string,
  data: unknown
): Promise<{ r2Key: string; sha256: string }> {
  const json = JSON.stringify(data);
  const sha256 = crypto.createHash('sha256').update(json).digest('hex');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const r2Key = `raw/${sourceName}/${timestamp}-${sha256.slice(0, 8)}.json`;

  // Store in R2
  await r2.put(r2Key, json, {
    httpMetadata: {
      contentType: 'application/json',
    },
    customMetadata: {
      source: sourceName,
      sha256,
      timestamp,
    },
  });

  // Record in database
  await db
    .prepare(
      'INSERT INTO raw_documents (source_name, r2_key, sha256, parse_status) VALUES (?, ?, ?, ?)'
    )
    .bind(sourceName, r2Key, sha256, 'pending')
    .run();

  return { r2Key, sha256 };
}

export async function markDocumentParsed(
  db: D1Database,
  r2Key: string,
  status: 'success' | 'error',
  error?: string
) {
  await db
    .prepare(
      'UPDATE raw_documents SET parse_status = ?, error = ? WHERE r2_key = ?'
    )
    .bind(status, error ?? null, r2Key)
    .run();
}
