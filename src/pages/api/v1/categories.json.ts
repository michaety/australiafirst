import type { APIRoute } from 'astro';
import { jsonResponse, withCache } from '../../../lib/api';
import { getCategories } from '../../../lib/db';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  // Access runtime environment bindings
  const env = locals.runtime?.env;
  if (!env) {
    console.error('Runtime environment not available');
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }

  const db = env.DB;
  const kv = env.KV;

  try {
    const categories = await withCache(
      kv,
      'api:categories',
      async () => {
        const cats = await getCategories(db);
        return cats.map((cat: any) => ({
          id: cat.id,
          slug: cat.slug,
          name: cat.name,
          description: cat.description,
          default_weight: cat.default_weight,
        }));
      },
      300
    );

    return jsonResponse({
      frameworkVersion: 'v0.1.0',
      categories,
    });
  } catch (e) {
    console.error('Error in /api/v1/categories.json:', e);
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }
};
