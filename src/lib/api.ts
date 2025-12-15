// API utilities for JSON responses and KV caching

export function jsonResponse(data: unknown, options: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      ...options.headers,
    },
    ...options,
  });
}

export function jsonError(message: string, status = 500) {
  return jsonResponse({ error: message }, { status });
}

// KV cache helpers
export async function getCached<T>(
  kv: KVNamespace,
  key: string,
  ttl = 300
): Promise<T | null> {
  try {
    const cached = await kv.get(key, 'json');
    return cached as T | null;
  } catch (e) {
    console.error('KV get error:', e);
    return null;
  }
}

export async function setCached<T>(
  kv: KVNamespace,
  key: string,
  value: T,
  ttl = 300
): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(value), {
      expirationTtl: ttl,
    });
  } catch (e) {
    console.error('KV put error:', e);
  }
}

export async function withCache<T>(
  kv: KVNamespace,
  key: string,
  fetcher: () => Promise<T>,
  ttl = 300
): Promise<T> {
  const cached = await getCached<T>(kv, key, ttl);
  if (cached !== null) {
    return cached;
  }

  const fresh = await fetcher();
  await setCached(kv, key, fresh, ttl);
  return fresh;
}
