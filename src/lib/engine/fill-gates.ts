import { coinOf } from "../exchanges/meta.ts";

/** One coin key so FLORK and FLORKUSDT are the same slot. */
export function fillCoin(symbol: string) {
  return coinOf(symbol);
}

/** One fill per coin per candle, across every engine. */
export function barFillKey(symbol: string, timeframe: string, barTime: number) {
  return `${fillCoin(symbol)}|${timeframe}|${barTime}`;
}

export function coinsOf(symbols: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const s of symbols) {
    const c = fillCoin(s);
    if (c) out.add(c);
  }
  return out;
}

export function clampMaxPositions(n: unknown) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 4;
  return Math.min(20, Math.max(1, v));
}

/** Unique coins already on the desk or the live venue. */
export function heldCoins(deskSymbols: Iterable<string>, venueSymbols?: Iterable<string> | null) {
  return coinsOf([...(deskSymbols ?? []), ...((venueSymbols ?? []) as string[])]);
}

/**
 * Concurrent slots = the larger of desk rows and venue rows.
 * Three engines on one coin still count as three rows if they slipped in.
 */
export function concurrentOpenCount(deskRows: number, venueRows = 0) {
  return Math.max(0, Math.round(Number(deskRows) || 0), Math.round(Number(venueRows) || 0));
}

export function remainingSlots(maxPositions: unknown, deskRows: number, venueRows = 0) {
  return Math.max(0, clampMaxPositions(maxPositions) - concurrentOpenCount(deskRows, venueRows));
}

/** 1h + 4h occupy slots for a long time. Cap them so 5m/15m still fill. 0 = off. */
export const HTF_TFS = ["1h", "4h"] as const;

export function isHtfTf(tf: string | null | undefined) {
  const t = String(tf ?? "").toLowerCase();
  return t === "1h" || t === "4h";
}

export function clampHtfMaxPositions(n: unknown) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 4;
  return Math.min(20, Math.max(0, v));
}

export function countHtfOpen(timeframes: Iterable<string | null | undefined>) {
  let n = 0;
  for (const tf of timeframes) if (isHtfTf(tf)) n += 1;
  return n;
}

export function skipFill(opts: {
  stale?: boolean;
  sideOn?: boolean;
  coin: string;
  barKey: string;
  held: Set<string>;
  filledBars: Set<string>;
  used: number;
  remaining: number;
  liveUnread?: string;
  htf?: boolean;
  htfOpen?: number;
  htfMax?: number;
}): string {
  if (opts.stale) return "stale bar";
  if (opts.sideOn === false) return "side muted";
  if (opts.held.has(opts.coin)) return "already in symbol";
  if (opts.filledBars.has(opts.barKey)) return "already filled";
  if (opts.liveUnread) return opts.liveUnread;
  if (opts.used >= opts.remaining) return "max positions";
  const htfMax = clampHtfMaxPositions(opts.htfMax);
  if (opts.htf && htfMax > 0 && (opts.htfOpen ?? 0) >= htfMax) return "htf cap";
  return "";
}

/** True when the venue filled at a higher leverage than the desk asked for. */
export function leverageOverCap(actual: number, requested: number) {
  const want = Math.round(Number(requested));
  const got = Number(actual);
  if (!Number.isFinite(want) || want < 1) return false;
  if (!Number.isFinite(got) || got <= 0) return false;
  return got > want;
}

/** True when live fill margin overshoots the sized budget (slippage slack). */
export function marginOverBudget(actualMargin: number, budget: number, slackUsd = 1) {
  const got = Number(actualMargin);
  const want = Number(budget);
  if (!Number.isFinite(got) || !Number.isFinite(want) || want < 0) return false;
  return got > want + Math.max(0, slackUsd) && got > want * 1.05;
}
