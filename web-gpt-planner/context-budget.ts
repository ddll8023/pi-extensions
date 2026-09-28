export const DEFAULT_TASK_TEXT_BUDGET = 12_000;

export interface BudgetCheck {
  allowed: boolean;
  estimatedTokens: number;
  usedTokens: number;
  limitTokens: number;
  remainingTokens: number;
}

export type TextTokenEstimator = (text: string) => number;

/** Check a cumulative task budget using the supplied host estimator. */
export function checkTaskBudget(
  usedTokens: number,
  payload: string,
  estimateText: TextTokenEstimator,
  limitTokens = DEFAULT_TASK_TEXT_BUDGET,
): BudgetCheck {
  const estimatedTokens = estimateText(payload);
  const safeUsed = Number.isFinite(usedTokens) && usedTokens >= 0 ? usedTokens : 0;
  const safeLimit = Number.isFinite(limitTokens) && limitTokens > 0 ? limitTokens : DEFAULT_TASK_TEXT_BUDGET;
  const total = safeUsed + estimatedTokens;
  return {
    allowed: total <= safeLimit,
    estimatedTokens,
    usedTokens: safeUsed,
    limitTokens: safeLimit,
    remainingTokens: Math.max(0, safeLimit - safeUsed),
  };
}
