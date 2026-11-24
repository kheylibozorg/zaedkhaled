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

/**
 * If `count` open trades already sit inside `[minLev .. userCap]` (when
 * `minLev > 1`) or exceed `cap` (when `minLev <= 1`), subsequent fills cap at
 * `cap` (never raising `userCap`). Coins below `minLev` still enter normally.
 */
export function stackedUserLevCap(
  userCap: number,
  openLevs: readonly number[],
  count: number,
  cap: number,
  minLev = 1,
) {
  const user = capLeverage(userCap, 200);
  const min = Math.min(user, clampMinLeverage(minLev));
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n <= 0) return user;
  const stacked = Math.min(user, capLeverage(cap, 75));
  let high = 0;
  for (const lev of openLevs) {
    const l = Number(lev);
    const matches = min > 1 ? l >= min && l <= user : l > stacked;
    if (matches) {
      high += 1;
      if (high >= n) return stacked;
    }
  }
  return user;
}
