// Cloudflare bindings for Policy Alignment Index
interface Env {
  // D1 Database binding
  DB: D1Database;
  // KV namespace binding
  KV: KVNamespace;
  // R2 bucket binding
  R2: R2Bucket;
  // Secrets (do not commit)
  OPENAUSTRALIA_API_KEY: string;
  THEYVOTEFORYOU_API_KEY?: string;
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
