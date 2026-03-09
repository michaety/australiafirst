// Cloudflare bindings for Australia First Accountability Platform
interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SESSION: KVNamespace;
  R2: R2Bucket;
  AI: Ai;
  ADMIN_PASSWORD: string;
  INTERNAL_SECRET?: string;
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
