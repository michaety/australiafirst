import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/api';

// Seed default categories
const DEFAULT_CATEGORIES = [
  {
    id: 'economic-resilience',
    slug: 'economic-resilience',
    name: 'Economic Resilience',
    description: 'Policies supporting sustainable economic growth and financial stability',
    default_weight: 1.0,
  },
  {
    id: 'integrity-transparency',
    slug: 'integrity-transparency',
    name: 'Integrity & Transparency',
    description: 'Policies promoting accountability and ethical governance',
    default_weight: 1.2,
  },
  {
    id: 'environmental-stewardship',
    slug: 'environmental-stewardship',
    name: 'Environmental Stewardship',
    description: 'Policies supporting environmental protection and climate action',
    default_weight: 1.0,
  },
  {
    id: 'social-equity',
    slug: 'social-equity',
    name: 'Social Equity',
    description: 'Policies promoting fairness and equal opportunities',
    default_weight: 1.0,
  },
  {
    id: 'national-security',
    slug: 'national-security',
    name: 'National Security',
    description: 'Policies supporting national defense and security',
    default_weight: 0.9,
  },
];

export const POST: APIRoute = async ({ locals }) => {
  const db = locals.runtime.env.DB;

  try {
    for (const category of DEFAULT_CATEGORIES) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO categories (id, slug, name, description, default_weight) 
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          category.id,
          category.slug,
          category.name,
          category.description,
          category.default_weight
        )
        .run();
    }

    return jsonResponse({
      success: true,
      message: 'Categories seeded successfully',
      count: DEFAULT_CATEGORIES.length,
    });
  } catch (e) {
    console.error('Error seeding categories:', e);
    return jsonResponse({ error: 'Internal server error' }, { status: 500 });
  }
};
