import type { APIRoute } from 'astro';
import { jsonResponse, withCache } from '../../../lib/api';
import { getCategories } from '../../../lib/db';

export const GET: APIRoute = async ({ locals }) => {
  const db = locals.runtime.env.DB;
  const kv = locals.runtime.env.KV;

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
