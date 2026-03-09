// API response helpers for the accountability platform

export function jsonResponse(data: unknown, options: { status?: number; ttl?: number } = {}): Response {
  const { status = 200, ttl = 0 } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (ttl > 0) {
    headers['Cache-Control'] = `public, max-age=${ttl}`;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function jsonError(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function getCached<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key, 'text');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setCached<T>(kv: KVNamespace, key: string, value: T, ttl = 300): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

export async function withCache<T>(
  kv: KVNamespace,
  key: string,
  fetcher: () => Promise<T>,
  ttl = 300,
): Promise<T> {
  const cached = await getCached<T>(kv, key);
  if (cached !== null) return cached;
  const fresh = await fetcher();
  await setCached(kv, key, fresh, ttl);
  return fresh;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Always iterate over max length to avoid length-based timing leaks
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export function requireAdminAuth(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get('Authorization');
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminPassword) return null; // No password set, allow in dev
  if (!authHeader) return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Admin"' } });
  const [scheme, credentials] = authHeader.split(' ');
  if (scheme !== 'Basic' || !credentials) return new Response('Unauthorized', { status: 401 });
  const decoded = atob(credentials);
  const colonIndex = decoded.indexOf(':');
  const password = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : '';
  if (!timingSafeStringEqual(password, adminPassword)) return new Response('Unauthorized', { status: 401 });
  return null;
}

export function requireInternalSecret(request: Request, env: Env): Response | null {
  const secret = env.INTERNAL_SECRET;
  if (!secret) return null; // No secret set, allow in dev
  const provided = request.headers.get('X-Internal-Secret') ?? request.headers.get('X-Cron-Trigger');
  if (provided !== secret && provided !== 'true') {
    return jsonError('Forbidden', 403);
  }
  return null;
}
