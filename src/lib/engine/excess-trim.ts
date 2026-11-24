import { clampMaxPositions } from "./fill-gates.ts";
import { netClosePnl, PAPER_TAKER_BPS } from "./paper.ts";
import type { Side } from "./types.ts";

export type TrimmablePosition = {
  id: number;
  symbol: string;
  side: string;
  entry: number | string;
  qty: number | string;
  risk_usd: number | string;
  fees_usd?: number | string | null;
  notional_usd?: number | string | null;
  opened_at: string;
};

export type ExcessCandidate<T extends TrimmablePosition> = {
  position: T;
  markPrice: number;
  estimatedPnlUsd: number;
};

/**
 * Selects excess open positions beyond `maxPositions` to close with minimal loss.
 * Sorts by highest unrealized net PnL USD descending (profits first, then smallest loss),
 * tie-breaking by smaller notional and newer opened_at.
 */
export function selectExcessToClose<T extends TrimmablePosition>(
  positions: T[],
  maxPositions: unknown,
  markPrices: Record<string, number>,
): ExcessCandidate<T>[] {
  const cap = clampMaxPositions(maxPositions);
  const excessCount = positions.length - cap;
  if (excessCount <= 0) return [];

  const scored: ExcessCandidate<T>[] = positions.map((p) => {
    const entry = Number(p.entry) || 0;
    const rawMark = markPrices[p.symbol];
    const markPrice = Number.isFinite(rawMark) && rawMark > 0 ? rawMark : entry;
    const side: Side = p.side === "short" ? "short" : "long";
    const settled = netClosePnl({
      side,
      entry,
      exit: markPrice,
      qty: Number(p.qty) || 0,
      riskUsd: Number(p.risk_usd) || 0,
      openFee: Number(p.fees_usd) || 0,
      closeFeeBps: PAPER_TAKER_BPS,
    });
    return {
      position: p,
      markPrice,
      estimatedPnlUsd: settled.pnl,
    };
  });

  scored.sort((a, b) => {
    const pnlDiff = b.estimatedPnlUsd - a.estimatedPnlUsd;
    if (Math.abs(pnlDiff) > 1e-6) return pnlDiff;
    const notA = Number(a.position.notional_usd) || 0;
    const notB = Number(b.position.notional_usd) || 0;
    if (Math.abs(notA - notB) > 1e-6) return notA - notB;
    return new Date(b.position.opened_at).getTime() - new Date(a.position.opened_at).getTime();
  });

  return scored.slice(0, excessCount);
}
