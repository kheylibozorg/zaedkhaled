export type AsterLevTier = {
  maxOpenPosLeverage?: number | string;
  initialLeverage?: number | string;
};

export type AsterBracketRow = {
  symbol?: string;
  riskBrackets?: AsterLevTier[];
  brackets?: AsterLevTier[];
};

/** Highest maxOpenPosLeverage / initialLeverage on a symbol's Aster brackets. */
export function maxLeverageFromAsterTiers(tiers: AsterLevTier[] | undefined): number {
  if (!tiers?.length) return 0;
  return Math.max(0, ...tiers.map((b) => Number(b.maxOpenPosLeverage ?? b.initialLeverage ?? 0)));
}

/** Public web payload, signed v3 array, or signed v3 single-symbol object. */
export function asterBracketRows(raw: unknown): AsterBracketRow[] {
  if (Array.isArray(raw)) return raw as AsterBracketRow[];
  if (!raw || typeof raw !== "object") return [];
  const o = raw as {
    symbol?: string;
    brackets?: AsterLevTier[];
    riskBrackets?: AsterLevTier[];
    data?: { brackets?: AsterBracketRow[] };
  };
  if (Array.isArray(o.data?.brackets)) return o.data.brackets;
  if (o.symbol && (o.brackets || o.riskBrackets)) return [o];
  return [];
}
