import type { APIRoute } from 'astro';
import { jsonResponse, jsonError, requireInternalSecret } from '../../../../lib/api';

export const prerender = false;

const BATCH_SIZE = 50;

const ACTION_WEIGHTS: Record<string, number> = {
  banning_order:           70,
  revocation:              80,
  suspension:              50,
  enforceable_undertaking: 30,
  compliance_notice:       15,
  refusal_to_re_register:  40,
};

function riskLabel(score: number): string {
  if (score >= 70) return 'critical';
  if (score >= 40) return 'high';
  if (score >= 15) return 'medium';
  return 'low';
}

function abnAgeMultiplier(abnRegDate: string | null, actionStartDate: string | null): number {
  if (!abnRegDate || !actionStartDate) return 1.0;
  try {
    const months = (new Date(actionStartDate).getTime() - new Date(abnRegDate).getTime()) / (1000 * 60 * 60 * 24 * 30);
    return months < 12 ? 1.3 : 1.0;
  } catch { return 1.0; }
}

type ActionRow = {
  provider_id: string;
  action_type: string;
  status: string;
  is_permanent: number;
  subject_type: string;
  start_date: string | null;
};

type ProviderRow = {
  id: string;
  abn_reg_date: string | null;
};

export async function runNdisScorerETL(env: Env) {
  const { DB } = env;

  // Single query: all providers with their actions via JOIN
  const [provResult, actResult] = await DB.batch([
    DB.prepare('SELECT id, abn_reg_date FROM ndis_providers'),
    DB.prepare(`
      SELECT provider_id, action_type, status, is_permanent, subject_type, start_date
      FROM ndis_compliance_actions
      WHERE provider_id IS NOT NULL
    `),
  ]);

  const providers = provResult.results as ProviderRow[];
  const allActions = actResult.results as ActionRow[];

  // Group actions by provider_id
  const actionsByProvider = new Map<string, ActionRow[]>();
  for (const a of allActions) {
    if (!actionsByProvider.has(a.provider_id)) actionsByProvider.set(a.provider_id, []);
    actionsByProvider.get(a.provider_id)!.push(a);
  }

  // Compute scores for each provider
  const updateStmts: D1PreparedStatement[] = [];

  for (const provider of providers) {
    const actions = actionsByProvider.get(provider.id) || [];
    let score = 0;

    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      let base = ACTION_WEIGHTS[a.action_type] ?? 10;

      if (a.is_permanent) {
        base = 100;
      } else {
        if (a.status !== 'in_force') base *= 0.4;
        if (a.subject_type === 'individual') base *= 0.7;
        base *= abnAgeMultiplier(provider.abn_reg_date, a.start_date);
        if (i >= 1) base *= 1.2;
      }

      score += base;
    }

    score = Math.min(100, Math.round(score));
    const label = actions.length === 0 ? 'low' : riskLabel(score);

    updateStmts.push(
      DB.prepare(`
        UPDATE ndis_providers
        SET risk_score = ?, risk_label = ?, action_count = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(score, label, actions.length, provider.id)
    );
  }

  // Batch updates
  for (let i = 0; i < updateStmts.length; i += BATCH_SIZE) {
    await DB.batch(updateStmts.slice(i, i + BATCH_SIZE));
  }

  return { success: true, providers_scored: providers.length };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const authError = requireInternalSecret(request, locals.runtime.env);
  if (authError) return authError;

  try {
    const result = await runNdisScorerETL(locals.runtime.env);
    return jsonResponse(result);
  } catch (err) {
    console.error('[NDIS Scorer ETL] Error:', err);
    return jsonError(`NDIS Scorer ETL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
