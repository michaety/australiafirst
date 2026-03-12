import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  const host = context.request.headers.get("host") || "";

  // Never touch non-NDIS requests
  if (!host.startsWith("ndis.")) return next();

  const url = new URL(context.request.url);

  // Rewrite /foo -> /ndis/foo so Astro routes to src/pages/ndis/
  // Never rewrite /api/ paths — they are served directly from src/pages/api/
  if (!url.pathname.startsWith("/ndis") && !url.pathname.startsWith("/api/")) {
    url.pathname = "/ndis" + url.pathname;
    return context.rewrite(url.toString());
  }

  return next();
});
