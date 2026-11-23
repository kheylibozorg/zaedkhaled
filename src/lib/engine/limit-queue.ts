import { isHtfTf, clampHtfMaxPositions, clampMaxPositions } from "./fill-gates.ts";
import { barsAfterFill } from "./paper.ts";
import { TF_MS, type ArmedSetup, type Bar, type IndicatorName, type Side, type Timeframe } from "./types.ts";

export type EntryMode = "limit" | "market";

export type LimitCancelReason =
  | "max positions reached"
  | "htf cap reached"
  | "sl engulfed"
  | "target reached without RTP"
  | "pattern failed"
  | "queue expired"
  | "gate muted"
  | "duplicate symbol"
  | "venue cancelled"
  | "operator cancelled";

export function parseEntryMode(raw: unknown): EntryMode {
  return String(raw ?? "").trim().toLowerCase() === "market" ? "market" : "limit";
}

export function clampLimitTtlBars(raw: unknown): number {
  const v = Math.round(Number(raw));
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(48, Math.max(1, v));
}

export function resolveLimitTtlBars(limitTtlBars: unknown, indicatorFtcWait: unknown): number {
  const custom = clampLimitTtlBars(limitTtlBars);
  if (custom > 0) return custom;
  const wait = Math.round(Number(indicatorFtcWait));
  if (!Number.isFinite(wait) || wait <= 0) return 8;
  return Math.min(48, Math.max(1, wait));
}

export function isValidLimitGeometry(side: Side, entry: number, sl: number, tp: number): boolean {
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp)) return false;
  if (!(entry > 0) || !(sl > 0) || !(tp > 0)) return false;
  return side === "long" ? sl < entry && tp > entry : sl > entry && tp < entry;
}

export function canQueueLimitOrder(opts: {
  safeLimitMode: boolean;
  maxPositions: unknown;
  htfMaxPositions: unknown;
  timeframe: Timeframe;
  coin: string;
  heldCoins: Set<string>;
  pendingCoins: Set<string>;
  openCount: number;
  pendingCount: number;
  htfOpenCount: number;
  htfPendingCount: number;
  sideOn: boolean;
  side: Side;
  entry: number;
  sl: number;
  tp: number;
}): { ok: true } | { ok: false; reason: string } {
  if (!opts.sideOn) return { ok: false, reason: "side muted" };
  if (!isValidLimitGeometry(opts.side, opts.entry, opts.sl, opts.tp)) {
    return { ok: false, reason: "invalid limit geometry" };
  }
  if (opts.heldCoins.has(opts.coin)) return { ok: false, reason: "already in symbol" };
  if (opts.pendingCoins.has(opts.coin)) return { ok: false, reason: "already queued" };

  const maxPos = clampMaxPositions(opts.maxPositions);
  if (opts.openCount >= maxPos) return { ok: false, reason: "max positions reached" };

  if (opts.safeLimitMode && opts.openCount + opts.pendingCount >= maxPos) {
    return { ok: false, reason: "safe limit cap reached" };
  }

  const htfMax = clampHtfMaxPositions(opts.htfMaxPositions);
  if (isHtfTf(opts.timeframe) && htfMax > 0) {
    if (opts.htfOpenCount >= htfMax) return { ok: false, reason: "htf cap reached" };
    if (opts.safeLimitMode && opts.htfOpenCount + opts.htfPendingCount >= htfMax) {
      return { ok: false, reason: "safe htf cap reached" };
    }
  }

  return { ok: true };
}

export type PendingLimitSpec = {
  symbol: string;
  timeframe: Timeframe;
  indicator: IndicatorName;
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  beAtR?: number | null;
  armedBarTime: number;
  ftcWait: number;
};

export type LimitEvaluation =
  | { action: "keep"; barsElapsed: number }
  | { action: "fill"; fillBarTime: number; fillPrice: number; barsWaited: number }
  | { action: "cancel"; cancelReason: LimitCancelReason; barsElapsed: number; atBarTime?: number };

/**
 * Evaluates a queued (unfilled) FTC limit order against desk caps, style invalidations,
 * indicator pattern persistence, and queue TTL.
 *
 * Style rules enforced without altering indicator math:
 * 1. When max_positions (or HTF cap) is already reached, cancel remaining queued orders.
 * 2. If price breaches SL / origin zone before tagging entry -> "sl engulfed".
 * 3. If price reaches TP without returning to FTC -> "target reached without RTP".
 * 4. If queue duration exceeds TTL bars -> "queue expired".
 * 5. If the closed-bar indicator no longer holds the same-side armed setup -> "pattern failed".
 */
export function evaluatePendingLimit(opts: {
  order: PendingLimitSpec;
  closedBars: Bar[];
  ttlBars: number;
  gateMuted: boolean;
  capReached: boolean;
  htfCapReached?: boolean;
  duplicateHeld: boolean;
  /** undefined = closed bars unavailable / indicator not evaluated; null = indicator disarmed */
  currentArmed: ArmedSetup | null | undefined;
}): LimitEvaluation {
  const { order } = opts;

  if (opts.capReached) {
    return { action: "cancel", cancelReason: "max positions reached", barsElapsed: 0 };
  }
  if (opts.htfCapReached && isHtfTf(order.timeframe)) {
    return { action: "cancel", cancelReason: "htf cap reached", barsElapsed: 0 };
  }
  if (opts.duplicateHeld) {
    return { action: "cancel", cancelReason: "duplicate symbol", barsElapsed: 0 };
  }
  if (opts.gateMuted) {
    return { action: "cancel", cancelReason: "gate muted", barsElapsed: 0 };
  }
  if (!isValidLimitGeometry(order.side, order.entry, order.sl, order.tp)) {
    return { action: "cancel", cancelReason: "pattern failed", barsElapsed: 0 };
  }

  const tfMs = TF_MS[order.timeframe];
  const barsAfter = barsAfterFill(opts.closedBars, order.armedBarTime, tfMs);
  const ttl = Math.max(1, Math.round(opts.ttlBars));
  let barsElapsed = 0;

  for (const bar of barsAfter) {
    barsElapsed += 1;
    const slBreached = order.side === "long" ? bar.low <= order.sl : bar.high >= order.sl;
    if (slBreached) {
      return { action: "cancel", cancelReason: "sl engulfed", barsElapsed, atBarTime: bar.time };
    }
    const tagged = order.side === "long" ? bar.low <= order.entry : bar.high >= order.entry;
    if (tagged) {
      return { action: "fill", fillBarTime: bar.time, fillPrice: order.entry, barsWaited: barsElapsed };
    }
    const targetWithoutRtp = order.side === "long" ? bar.high >= order.tp : bar.low <= order.tp;
    if (targetWithoutRtp) {
      return {
        action: "cancel",
        cancelReason: "target reached without RTP",
        barsElapsed,
        atBarTime: bar.time,
      };
    }
    if (barsElapsed >= ttl) {
      return { action: "cancel", cancelReason: "queue expired", barsElapsed, atBarTime: bar.time };
    }
  }

  if (opts.currentArmed !== undefined) {
    if (!opts.currentArmed || opts.currentArmed.side !== order.side) {
      const reason: LimitCancelReason =
        barsElapsed >= Math.max(1, order.ftcWait) ? "queue expired" : "pattern failed";
      return { action: "cancel", cancelReason: reason, barsElapsed };
    }
  }

  return { action: "keep", barsElapsed };
}
