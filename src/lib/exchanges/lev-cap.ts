/** Never request more than this, even if a venue advertises 250x+. */
export const LEV_CAP = 200;

export function capLeverage(n: number, fallback = 25) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 1) return Math.min(LEV_CAP, Math.max(1, fallback));
  return Math.min(LEV_CAP, Math.max(1, v));
}

export function clampMinLeverage(raw: unknown): number {
  const v = Math.round(Number(raw));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(LEV_CAP, Math.max(1, v));
}

export function normalizeLeverageRange(
  minRaw: unknown,
  maxRaw: unknown,
): { min: number; max: number } {
  const max = capLeverage(Number(maxRaw), LEV_CAP);
  const min = Math.min(max, clampMinLeverage(minRaw));
  return { min, max };
}

export function isCoinWithinLeverageRange(coinMaxLev: number, minLev: number): boolean {
  const min = clampMinLeverage(minLev);
  if (min <= 1) return true;
  const coinMax = Math.round(Number(coinMaxLev) || 0);
  return coinMax >= min;
}

/**
 * If `count` open trades already have leverage > `cap`, new fills use `cap`
 * as the user ceiling (still never above `userCap`). Count 0 disables.
 */
export function stackedUserLevCap(
  userCap: number,
  openLevs: readonly number[],
  count: number,
  cap: number,
) {
  const user = capLeverage(userCap, 200);
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n <= 0) return user;
  const stacked = Math.min(user, capLeverage(cap, 75));
  let high = 0;
  for (const lev of openLevs) {
    if (Number(lev) > stacked) {
      high += 1;
      if (high >= n) return stacked;
    }
  }
  return user;
}
