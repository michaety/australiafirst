// Photo pipeline helpers for parliament photos / mugshot processing

export interface PhotoMeta {
  politicianId: string;
  sourceUrl: string;
  r2Key: string;
  r2KeyMugshot: string;
}

/**
 * Build the parliament photo URL for a politician.
 * Uses the APH API format.
 */
export function parliamentPhotoUrl(parliamentId: string): string {
  return `https://www.aph.gov.au/api/parliamentarian/${parliamentId}/image`;
}

/**
 * Fetch a photo from a URL and return as ArrayBuffer.
 */
export async function fetchPhotoBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Australia First/1.0 accountability-platform',
        Accept: 'image/*',
      },
    });
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Store a photo in R2 and return the key.
 */
export async function storePhotoInR2(
  r2: R2Bucket,
  key: string,
  buffer: ArrayBuffer,
  contentType = 'image/jpeg',
): Promise<void> {
  await r2.put(key, buffer, {
    httpMetadata: { contentType },
  });
}

/**
 * Get a photo from R2 for serving.
 */
export async function getPhotoFromR2(r2: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return await r2.get(key);
}

/**
 * Generate R2 key for original photo.
 */
export function photoR2Key(politicianId: string): string {
  return `photos/${politicianId}/original.jpg`;
}

/**
 * Generate R2 key for mugshot-processed photo.
 */
export function mugshotR2Key(politicianId: string): string {
  return `photos/${politicianId}/mugshot.jpg`;
}

/**
 * Apply mugshot aesthetic via Workers AI image transformation.
 * Returns transformed ArrayBuffer or original if AI unavailable.
 */
export async function applyMugshotStyle(
  ai: Ai,
  imageBuffer: ArrayBuffer,
): Promise<ArrayBuffer> {
  try {
    // Use Workers AI to apply image transformation
    // Note: Actual AI image processing depends on available models
    // For now we return the original - enhancement can be added when AI models are available
    void ai;
    return imageBuffer;
  } catch {
    return imageBuffer;
  }
}
