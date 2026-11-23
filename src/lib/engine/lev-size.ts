/** Exact-match capital % by the coin's used leverage. Anything else uses the default. */

export type LevSizeTier = {
  leverage: number;
  capitalPct: number;
};

/** Where capital % is measured from. Live always caps at free cash. */
export type CapitalBase = "total" | "free";

export const DEFAULT_CAPITAL_PCT = 3;
export const DEFAULT_CAPITAL_BASE: CapitalBase = "total";

export const DEFAULT_LEV_SIZE_TIERS: LevSizeTier[] = [
  { leverage: 5, capitalPct: 15 },
  { leverage: 10, capitalPct: 12 },
  { leverage: 25, capitalPct: 6 },
];

export function parseCapitalBase(raw: unknown): CapitalBase {
  return String(raw ?? "").trim().toLowerCase() === "free" ? "free" : "total";
}

export function clampCapitalPct(n: number, fallback = DEFAULT_CAPITAL_PCT) {
  const v = Number(n);
  if (!Number.isFinite(v)) return Math.min(100, Math.max(1, fallback));
  return Math.min(100, Math.max(1, v));
}

export function parseLevSizeTiers(raw: unknown): LevSizeTier[] {
  let arr: unknown = raw;
  if (raw == null) return DEFAULT_LEV_SIZE_TIERS.map((t) => ({ ...t }));
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return DEFAULT_LEV_SIZE_TIERS.map((t) => ({ ...t }));
    try {
      arr = JSON.parse(s);
    } catch {
      return DEFAULT_LEV_SIZE_TIERS.map((t) => ({ ...t }));
    }
  }
  if (!Array.isArray(arr)) return DEFAULT_LEV_SIZE_TIERS.map((t) => ({ ...t }));
  const out: LevSizeTier[] = [];
  const seen = new Set<number>();
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { leverage?: unknown; capitalPct?: unknown };
    const leverage = Math.round(Number(rec.leverage));
    const capitalPct = clampCapitalPct(Number(rec.capitalPct), NaN);
    if (!Number.isFinite(leverage) || leverage < 1 || leverage > 200) continue;
    if (!Number.isFinite(capitalPct)) continue;
    if (seen.has(leverage)) continue;
    seen.add(leverage);
    out.push({ leverage, capitalPct });
  }
  out.sort((a, b) => a.leverage - b.leverage);
  return out;
}

export function stringifyLevSizeTiers(tiers: LevSizeTier[]) {
  return JSON.stringify(parseLevSizeTiers(tiers));
}

/** Margin % of equity for this fill. Match the coin's venue max leverage, else the default. */
export function capitalPctForLeverage(
  usedLeverage: number,
  defaultPct: number,
  tiers: readonly LevSizeTier[],
) {
  const lev = Math.round(Number(usedLeverage));
  const hit = tiers.find((t) => t.leverage === lev);
  return clampCapitalPct(hit ? hit.capitalPct : defaultPct);
}

/** Notional as % of equity = margin% × leverage. */
export function notionalPctOfEquity(marginPct: number, leverage: number) {
  return clampCapitalPct(marginPct) * Math.max(1, Number(leverage) || 1);
}
