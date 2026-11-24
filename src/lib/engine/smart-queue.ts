import { clampHtfMaxPositions, clampMaxPositions, isHtfTf } from "./fill-gates.ts";
import type { IndicatorName, Side, Timeframe } from "./types.ts";

export const HTF_HOT_ZONE_ATR = 1.25;
export const MAX_WATCH_QUEUE_SIZE = 40;
export const SWAP_IMPROVEMENT_ATR = 0.5;

export function clampMaxLimitQueue(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 = auto
  return Math.min(40, Math.max(1, n));
}

export function resolveEffectiveQueueCap(opts: {
  safeLimitMode: boolean;
  maxPositions: unknown;
  openCount: number;
  maxLimitQueue: unknown;
}): number {
  const maxPos = clampMaxPositions(opts.maxPositions);
  if (opts.safeLimitMode) {
    return Math.max(0, maxPos - Math.max(0, Math.round(opts.openCount)));
  }
  const custom = clampMaxLimitQueue(opts.maxLimitQueue);
  if (custom > 0) return custom;
  return Math.max(8, maxPos * 2);
}

/**
 * Resolves max bars a queued order may sit on the venue.
 * Explicit user custom > 0 is respected verbatim; in auto (0), 1h/4h active limits
 * are capped tighter so slow higher-timeframe setups don't hog exchange slots.
 */
export function resolveSmartLimitTtlBars(
  tf: Timeframe,
  limitTtlBars: unknown,
  indicatorFtcWait: unknown,
): number {
  const custom = Math.round(Number(limitTtlBars));
  if (Number.isFinite(custom) && custom > 0) {
    return Math.min(48, Math.max(1, custom));
  }
  const wait = Math.round(Number(indicatorFtcWait));
  const base = Number.isFinite(wait) && wait > 0 ? Math.min(48, Math.max(1, wait)) : 8;
  if (tf === "4h") return Math.min(base, 3);
  if (tf === "1h") return Math.min(base, 5);
  return base;
}

export function approachDistanceAtr(opts: {
  entry: number;
  currentPrice: number;
  atr: number;
}): number {
  if (!Number.isFinite(opts.entry) || !(opts.entry > 0) || !Number.isFinite(opts.currentPrice) || !(opts.currentPrice > 0)) {
    return 999;
  }
  const dist = Math.abs(opts.entry - opts.currentPrice);
  const atr = Number.isFinite(opts.atr) && opts.atr > 0 ? opts.atr : opts.entry * 0.01;
  if (!(atr > 0)) return 999;
  return Number((dist / atr).toFixed(4));
}

/**
 * Decides whether a valid setup must wait in the bot's internal watch queue instead of
 * submitting immediately to the exchange.
 * - Confirmed Armed setups are always eligible for the active venue queue (unless slots are full).
 * - 1h / 4h Pre-Arm setups beyond HTF_HOT_ZONE_ATR stay in bot watch until price approaches entry.
 */
export function shouldStageInWatchQueue(opts: {
  timeframe: Timeframe;
  phase?: "armed" | "pre-arm";
  distanceAtr: number;
}): boolean {
  if (opts.phase !== "pre-arm") return false;
  if (isHtfTf(opts.timeframe) && opts.distanceAtr > HTF_HOT_ZONE_ATR) {
    return true;
  }
  return false;
}

export type ScoredQueueCandidate = {
  symbol: string;
  coin: string;
  timeframe: Timeframe;
  indicator: IndicatorName;
  side: Side;
  phase: "armed" | "pre-arm";
  distanceAtr: number;
  rr: number;
};

const TF_SPEED_RANK: Record<Timeframe, number> = {
  "5m": 0,
  "15m": 1,
  "1h": 2,
  "4h": 3,
};

/**
 * Compares two candidates for queue priority (negative = a has higher priority / fills faster).
 * 1. Confirmed Armed beats Pre-Arm unless Pre-Arm is >1.5 ATR closer to entry.
 * 2. Smaller approach distance in ATR (closer to fill).
 * 3. Faster timeframe (5m < 15m < 1h < 4h).
 * 4. Higher planned R:R.
 */
export function compareQueuePriority(a: ScoredQueueCandidate, b: ScoredQueueCandidate): number {
  if (a.phase !== b.phase) {
    const aArmed = a.phase === "armed";
    const diff = aArmed ? a.distanceAtr - b.distanceAtr : b.distanceAtr - a.distanceAtr;
    if (diff < 1.5) return aArmed ? -1 : 1;
  }
  const distDiff = a.distanceAtr - b.distanceAtr;
  if (Math.abs(distDiff) > 0.05) return distDiff;
  const tfDiff = TF_SPEED_RANK[a.timeframe] - TF_SPEED_RANK[b.timeframe];
  if (tfDiff !== 0) return tfDiff;
  return b.rr - a.rr;
}

/** Deduplicates per coin (keeping highest-priority setup) and sorts fastest-first. */
export function rankQueueCandidates<T extends ScoredQueueCandidate>(items: T[]): T[] {
  const bestByCoin = new Map<string, T>();
  for (const item of items) {
    const prev = bestByCoin.get(item.coin);
    if (!prev || compareQueuePriority(item, prev) < 0) {
      bestByCoin.set(item.coin, item);
    }
  }
  return [...bestByCoin.values()].sort(compareQueuePriority);
}

export type ActivePendingOrderView = {
  id: number;
  symbol: string;
  coin: string;
  timeframe: Timeframe;
  phase: "armed" | "pre-arm";
  distanceAtr: number;
};

/**
 * When the active venue queue is full, checks if an incoming faster/closer setup
 * should displace a slower resting order back into the bot's internal watch queue.
 * Never evicts a confirmed Armed order for a Pre-Arm order, and avoids churn for tiny diffs.
 */
export function pickSwapVictim(opts: {
  incoming: ScoredQueueCandidate;
  activePending: ActivePendingOrderView[];
  htfMaxPositions: unknown;
  htfOpenCount: number;
  htfPendingCount: number;
}): ActivePendingOrderView | null {
  if (!opts.activePending.length) return null;
  if (shouldStageInWatchQueue(opts.incoming)) return null;

  const htfMax = clampHtfMaxPositions(opts.htfMaxPositions);
  const incomingIsHtf = isHtfTf(opts.incoming.timeframe);
  const htfAtCap = incomingIsHtf && htfMax > 0 && opts.htfOpenCount + opts.htfPendingCount >= htfMax;

  const evictable = opts.activePending.filter((p) => {
    if (htfAtCap && !isHtfTf(p.timeframe)) return false;
    if (p.phase === "pre-arm") return true;
    return opts.incoming.phase === "armed" && p.distanceAtr - opts.incoming.distanceAtr >= 1.25;
  });
  if (!evictable.length) return null;

  evictable.sort((a, b) => {
    if (a.phase !== b.phase) return a.phase === "pre-arm" ? -1 : 1;
    return b.distanceAtr - a.distanceAtr;
  });
  const worst = evictable[0]!;

  if (opts.incoming.phase === "armed" && worst.phase === "pre-arm") {
    return opts.incoming.distanceAtr <= worst.distanceAtr + 0.5 ? worst : null;
  }
  return worst.distanceAtr - opts.incoming.distanceAtr >= SWAP_IMPROVEMENT_ATR ? worst : null;
}
