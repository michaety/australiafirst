// Scoring algorithm implementation

export interface CategoryScore {
  category_id: string;
  score_0_100: number;
  score_signed: number;
  coverage: number;
  last_division_date: string | null;
}

export interface OverallScore {
  overall_0_100: number;
  coverage: number;
}

export interface ScoreExplanation {
  politician_id: string;
  category_id: string;
  division_id: string;
  vote: string;
  effect: number;
  rationale_snapshot: string;
}

export interface DivisionMapping {
  division_id: string;
  category_id: string;
  direction: 'pro' | 'anti';
  strength: number;
  rationale: string;
}

export interface Vote {
  division_id: string;
  vote: string; // 'aye' | 'no' | 'abstain' | 'absent'
}

export function calculateVoteImpact(
  vote: string,
  direction: 'pro' | 'anti',
  strength: number
): number {
  let baseImpact = 0;

  // Convert vote to base impact
  if (vote === 'aye') {
    baseImpact = 1;
  } else if (vote === 'no') {
    baseImpact = -1;
  } else {
    // abstain or absent = 0
    baseImpact = 0;
  }

  // Invert if direction is anti
  if (direction === 'anti') {
    baseImpact = -baseImpact;
  }

  return baseImpact * strength;
}

export function calculateCategoryScore(
  votes: Vote[],
  mappings: DivisionMapping[]
): CategoryScore | null {
  const mappingMap = new Map(mappings.map(m => [m.division_id, m]));
  
  let rawScore = 0;
  let maxPossible = 0;
  let votedCount = 0;
  let lastDate: string | null = null;

  for (const vote of votes) {
    const mapping = mappingMap.get(vote.division_id);
    if (!mapping) continue;

    maxPossible += mapping.strength;

    if (vote.vote === 'aye' || vote.vote === 'no') {
      votedCount++;
      const impact = calculateVoteImpact(vote.vote, mapping.direction, mapping.strength);
      rawScore += impact;
    }
  }

  if (maxPossible === 0) {
    return null;
  }

  const score_signed = (100 * rawScore) / maxPossible;
  const score_0_100 = (score_signed + 100) / 2;
  const coverage = mappings.length > 0 ? votedCount / mappings.length : 0;

  return {
    category_id: mappings[0]?.category_id ?? '',
    score_0_100,
    score_signed,
    coverage,
    last_division_date: lastDate,
  };
}

export function calculateOverallScore(
  categoryScores: Array<CategoryScore & { weight: number }>
): OverallScore {
  let weightedSum = 0;
  let totalWeight = 0;
  let coverageSum = 0;

  for (const cat of categoryScores) {
    const adjustedWeight = cat.weight * cat.coverage;
    weightedSum += cat.score_0_100 * adjustedWeight;
    totalWeight += adjustedWeight;
    coverageSum += cat.coverage;
  }

  const overall_0_100 = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const coverage = categoryScores.length > 0 ? coverageSum / categoryScores.length : 0;

  return {
    overall_0_100,
    coverage,
  };
}

export function generateExplanations(
  politician_id: string,
  votes: Vote[],
  mappings: DivisionMapping[]
): ScoreExplanation[] {
  const explanations: ScoreExplanation[] = [];
  const mappingMap = new Map(mappings.map(m => [m.division_id, m]));

  for (const vote of votes) {
    const mapping = mappingMap.get(vote.division_id);
    if (!mapping) continue;

    const effect = calculateVoteImpact(vote.vote, mapping.direction, mapping.strength);

    explanations.push({
      politician_id,
      category_id: mapping.category_id,
      division_id: vote.division_id,
      vote: vote.vote,
      effect,
      rationale_snapshot: mapping.rationale,
    });
  }

  return explanations;
}
