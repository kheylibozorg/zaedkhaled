import { FEE_BPS, TF_MS, type Bar, type Signal, type Side } from "./types.ts";
import type { CapitalBase } from "./lev-size.ts";

const EPS = 1e-10;

/** Realistic perp maker / taker fees & minimum notional matching Aster / Hyperliquid / Lighter / OURBIT. */
export const PAPER_MAKER_BPS = 2;
export const PAPER_TAKER_BPS = 5;
export const PAPER_MIN_NOTIONAL_USD = 10;
export const PAPER_DEFAULT_MMR = 0.005;

export type PaperSlippageKind = "market_open" | "sl_exit" | "be_exit" | "limit_open" | "tp_exit";

/** Realistic half-spread + market impact slippage in bps based on order type & ATR%. */
export function paperSlippageBps(opts: {
  entry: number;
  atr?: number | null;
  kind: PaperSlippageKind;
}): number {
  if (opts.kind === "limit_open" || opts.kind === "tp_exit") return 0;
  const entry = Number(opts.entry);
  const atr = Number(opts.atr ?? 0);
  const atrBps = entry > 0 && atr > 0 && Number.isFinite(atr) ? (atr / entry) * 10_000 : 25;
  if (opts.kind === "market_open") {
    return Math.min(15, Math.max(3, 2 + atrBps * 0.05));
  }
  return Math.min(18, Math.max(4, 3 + atrBps * 0.06));
}

/** Applies adverse fill slippage to open or close prices. */
export function applyPaperSlippage(
  price: number,
  side: Side,
  role: "open" | "close",
  slipBps: number,
): number {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(slipBps) || slipBps <= 0) return price;
  const mult = slipBps / 10_000;
  const adverseUp = (role === "open" && side === "long") || (role === "close" && side === "short");
  return adverseUp ? price * (1 + mult) : price * (1 - mult);
}

/** Approximate perp liquidation price including maintenance margin rate. */
export function paperLiquidationPrice(
  side: Side,
  entry: number,
  leverage: number,
  mmr = PAPER_DEFAULT_MMR,
): number {
  const lev = Number(leverage);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(lev) || lev <= 1) {
    return side === "long" ? 0 : Number.POSITIVE_INFINITY;
  }
  const distFrac = Math.max(0.001, 1 / lev - Math.max(0, Math.min(0.05, mmr)));
  return side === "long" ? Math.max(0, entry * (1 - distFrac)) : entry * (1 + distFrac);
}

export function estimatePaperFee(notionalUsd: number, feeBps = PAPER_TAKER_BPS): number {
  return (Math.abs(notionalUsd) * Math.max(0, feeBps)) / 10_000;
}

/** Standard 8h perp funding accrual (~1 bp per 8h interval held). */
export function estimatePaperFundingUsd(notionalUsd: number, holdMs: number, ratePer8h = 0.0001): number {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0 || !Number.isFinite(holdMs) || holdMs < 8 * 3_600_000) {
    return 0;
  }
  const intervals = Math.floor(holdMs / (8 * 3_600_000));
  return Math.abs(notionalUsd) * Math.max(0, ratePer8h) * intervals;
}

export type PaperFill = {
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  qty: number;
  leverage: number;
  notional: number;
  risk: number;
  fees: number;
  indicator: string;
  timeframe: string;
  symbol: string;
  openedBarTime: number;
};

export type PaperExit = PaperFill & {
  exit: number;
  reason: "sl" | "tp" | "be";
  pnl: number;
  pnlR: number;
  closedBarTime: number;
};

/**
 * Margin = capitalPct of total equity or of free cash.
 * Always capped at free so a fill cannot spend locked margin.
 * Notional = margin × leverage.
 */
export function sizePosition(opts: {
  equity: number;
  capitalPct: number;
  entry: number;
  sl: number;
  leverage: number;
  usedMargin?: number;
  /** If set, this is the free pile (live wallet). Otherwise free = equity − usedMargin. */
  available?: number;
  /** total = % of whole account (default). free = % of leftover cash. */
  capitalBase?: CapitalBase;
  /** Venue minimum notional filter (e.g. $10). Default 0 for unit compatibility. */
  minNotionalUsd?: number;
  /** Fee rate in bps used for open fee estimate. Defaults to FEE_BPS. */
  feeBps?: number;
}) {
  const lev = Math.max(1, opts.leverage);
  const pct = Math.min(100, Math.max(1, opts.capitalPct));
  const free =
    opts.available != null && Number.isFinite(opts.available)
      ? Math.max(0, opts.available)
      : Math.max(0, opts.equity - Math.max(0, opts.usedMargin ?? 0));
  const pile = opts.capitalBase === "free" ? free : Math.max(0, opts.equity);
  const want = pile * (pct / 100);
  if (!(want > 0) || !(opts.entry > 0) || !(free > 0)) return null;
  const margin = Math.min(want, free * 0.995);
  if (!(margin > 0)) return null;
  const notional = margin * lev;
  if (opts.minNotionalUsd && opts.minNotionalUsd > 0 && notional < opts.minNotionalUsd) return null;
  const qty = notional / opts.entry;
  if (!(qty > 0)) return null;
  const slDist = Math.abs(opts.entry - opts.sl);
  const bps = opts.feeBps != null && Number.isFinite(opts.feeBps) ? opts.feeBps : FEE_BPS;
  return {
    qty,
    notional,
    margin,
    risk: qty * slDist,
    leverage: lev,
    fees: (notional * bps) / 10000,
  };
}

/** Same-bar SL+TP = SL, matching the APEX header contract. */
export function pathExit(side: Side, sl: number, tp: number, bar: Bar): "sl" | "tp" | null {
  if (side === "long") {
    const hitSl = bar.low <= sl;
    const hitTp = bar.high >= tp;
    if (hitSl && hitTp) return "sl";
    if (hitSl) return "sl";
    if (hitTp) return "tp";
    return null;
  }
  const hitSl = bar.high >= sl;
  const hitTp = bar.low <= tp;
  if (hitSl && hitTp) return "sl";
  if (hitSl) return "sl";
  if (hitTp) return "tp";
  return null;
}

/**
 * Bars that can resolve a paper fill: strictly after the signal candle.
 * Never the signal bar itself — that would instant-close on the entry candle.
 * Empty means the next candle is still forming; leave the trade open.
 */
export function barsAfterFill(bars: Bar[], barTime: number, tfMs: number): Bar[] {
  const t = Number(barTime);
  const ms = Number(tfMs);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(ms) || ms <= 0) return [];
  const start = t + ms;
  return bars.filter((b) => Number.isFinite(b.time) && b.time >= start - 2000);
}

/**
 * Find the exact closed 5m bar inside [fillBarTime, fillBarTime + tfMs) where a queued
 * limit order actually tagged entry. Falls back cleanly to null if out of window.
 */
export function resolveLimitFill5mTime(opts: {
  bars5m: Bar[];
  fillBarTime: number;
  tfMs: number;
  side: Side;
  entry: number;
  sl: number;
}): number | null {
  const { bars5m, fillBarTime, tfMs, side, entry, sl } = opts;
  if (!bars5m.length || !(fillBarTime > 0) || !(tfMs > 0)) return null;
  const windowEnd = fillBarTime + tfMs;
  for (const b of bars5m) {
    if (!Number.isFinite(b.time) || b.time < fillBarTime - 2000 || b.time >= windowEnd - 2000) continue;
    const slFirst = side === "long" ? b.low <= sl : b.high >= sl;
    const tagged = side === "long" ? b.low <= entry : b.high >= entry;
    if (tagged && !slFirst) return b.time;
    if (tagged) return b.time;
  }
  return null;
}

/**
 * Selects the closed 5m bars that occurred AFTER position fill.
 * For market fills on TF, signal triggers at barTime + tfMs.
 * For limit fills (especially 1h/4h limits filled inside an HTF candle), anchors to
 * the exact 5m fill bar (`openedMs`) instead of skipping up to 4 hours of 5m candles.
 */
export function exitPathBars(opts: {
  bars5m: Bar[];
  barTime: number;
  tfMs: number;
  openedMs: number;
  isLimitFill?: boolean;
}): Bar[] {
  const fiveM = TF_MS["5m"];
  if (opts.isLimitFill && Number.isFinite(opts.openedMs) && opts.openedMs > 0) {
    const fill5mBar = Math.floor(opts.openedMs / fiveM) * fiveM;
    return barsAfterFill(opts.bars5m, fill5mBar, fiveM);
  }
  if (Number.isFinite(opts.barTime) && opts.barTime > 0) {
    return barsAfterFill(opts.bars5m, opts.barTime, opts.tfMs);
  }
  if (Number.isFinite(opts.openedMs) && opts.openedMs > 0) {
    const open5mBar = Math.floor(opts.openedMs / fiveM) * fiveM;
    return barsAfterFill(opts.bars5m, open5mBar, fiveM);
  }
  return [];
}

export type PathHit = {
  reason: "sl" | "tp" | "be";
  exit: number;
  sl: number;
  barTime: number;
  liquidated?: boolean;
};

/**
 * Walk every bar after the fill (oldest first). First touch of SL/TP (or liquidation) wins.
 * TREX: once price travels beAtR in favor, stop moves to entry on that bar
 * before the same-bar SL/TP check — same as the paper simulator.
 */
export function walkPath(opts: {
  side: Side;
  entry: number;
  sl: number;
  tp: number;
  bars: Bar[];
  beAtR?: number | null;
  leverage?: number | null;
  mmr?: number;
}): { sl: number; beMoved: boolean; hit: PathHit | null; barsHeld: number } {
  let sl = opts.sl;
  const origSl = opts.sl;
  let beMoved = false;
  let i = 0;
  const lev = Number(opts.leverage ?? 0);
  const liqPx = lev > 1 ? paperLiquidationPrice(opts.side, opts.entry, lev, opts.mmr) : null;
  for (const bar of opts.bars) {
    i += 1;
    if (liqPx != null) {
      const liqHit = opts.side === "long" ? bar.low <= liqPx : bar.high >= liqPx;
      const slBeforeLiq =
        opts.side === "long" ? sl > liqPx && bar.low <= sl : sl < liqPx && bar.high >= sl;
      if (liqHit && !slBeforeLiq) {
        return {
          sl,
          beMoved,
          hit: { reason: "sl", exit: liqPx, sl, barTime: bar.time, liquidated: true },
          barsHeld: i,
        };
      }
    }
    let hit = pathExit(opts.side, sl, opts.tp, bar);
    if (!hit && opts.beAtR && !beMoved) {
      const dist = Math.abs(opts.entry - origSl);
      const fav = opts.side === "long" ? bar.high - opts.entry : opts.entry - bar.low;
      if (dist > 0 && fav >= opts.beAtR * dist) {
        sl = opts.entry;
        beMoved = true;
        hit = pathExit(opts.side, sl, opts.tp, bar);
      }
    }
    if (hit) {
      const atBe = beMoved && Math.abs(sl - opts.entry) <= EPS * Math.max(1, opts.entry);
      const reason: PathHit["reason"] = hit === "tp" ? "tp" : atBe ? "be" : "sl";
      const exit = hit === "sl" ? sl : opts.tp;
      return { sl, beMoved, hit: { reason, exit, sl, barTime: bar.time }, barsHeld: i };
    }
  }
  return { sl, beMoved, hit: null, barsHeld: i };
}

/** Reconstruct original stop if BE already pulled SL to entry. */
export function origStopPx(opts: {
  side: Side;
  entry: number;
  sl: number;
  origSl?: number | null;
  qty?: number | null;
  risk?: number | null;
}) {
  const orig = Number(opts.origSl);
  if (Number.isFinite(orig) && orig > 0 && Math.abs(opts.entry - orig) > 1e-12) return orig;
  if (Math.abs(opts.entry - opts.sl) > 1e-8) return opts.sl;
  const qty = Number(opts.qty);
  const risk = Number(opts.risk);
  const dist = qty > 0 && risk > 0 ? risk / qty : 0;
  if (!(dist > 0)) return opts.sl;
  return opts.side === "long" ? opts.entry - dist : opts.entry + dist;
}

/** Max adverse / favorable excursion in R, using the original stop distance. */
export function pathExcursion(opts: {
  side: Side;
  entry: number;
  origSl: number;
  bars: Bar[];
}): { maeR: number; mfeR: number } {
  const dist = Math.abs(opts.entry - opts.origSl);
  if (!(dist > 0) || !opts.bars.length) return { maeR: 0, mfeR: 0 };
  let mae = 0;
  let mfe = 0;
  for (const bar of opts.bars) {
    if (opts.side === "long") {
      mae = Math.max(mae, (opts.entry - bar.low) / dist);
      mfe = Math.max(mfe, (bar.high - opts.entry) / dist);
    } else {
      mae = Math.max(mae, (bar.high - opts.entry) / dist);
      mfe = Math.max(mfe, (opts.entry - bar.low) / dist);
    }
  }
  return { maeR: mae, mfeR: mfe };
}

export function pnlAt(
  side: Side,
  entry: number,
  exit: number,
  qty: number,
  openFee: number,
  closeFeeBps = FEE_BPS,
) {
  const gross = side === "long" ? (exit - entry) * qty : (entry - exit) * qty;
  const closeFee = estimatedCloseFee(exit, qty, closeFeeBps);
  return gross - Math.abs(openFee) - closeFee;
}

export function estimatedCloseFee(exit: number, qty: number, feeBps = FEE_BPS) {
  return (Math.abs(exit * qty) * feeBps) / 10000;
}

/** Open fee (given or estimated) + close fee. Round-trip commission for the journal. */
export function roundTripFees(opts: {
  qty: number;
  entry: number;
  exit: number;
  openFee?: number;
  openFeeBps?: number;
  closeFeeBps?: number;
}) {
  const openBps = opts.openFeeBps ?? FEE_BPS;
  const closeBps = opts.closeFeeBps ?? FEE_BPS;
  const open =
    opts.openFee != null && Number.isFinite(opts.openFee)
      ? Math.abs(opts.openFee)
      : (Math.abs(opts.entry * opts.qty) * openBps) / 10000;
  return open + estimatedCloseFee(opts.exit, opts.qty, closeBps);
}

/** Net R after fees: dollars made / dollars risked. Falls back to price R if risk is missing. */
export function netPnlR(pnlUsd: number, riskUsd: number, fallback = 0) {
  if (Number.isFinite(pnlUsd) && Number.isFinite(riskUsd) && riskUsd > 0) return pnlUsd / riskUsd;
  return fallback;
}

/** Gross price move minus round-trip commission (and optional funding). This is what the journal stores. */
export function netClosePnl(opts: {
  side: Side;
  entry: number;
  exit: number;
  qty: number;
  riskUsd: number;
  openFee?: number;
  openFeeBps?: number;
  closeFeeBps?: number;
  fundingUsd?: number;
}) {
  const openBps = opts.openFeeBps ?? FEE_BPS;
  const closeBps = opts.closeFeeBps ?? FEE_BPS;
  const openFee =
    opts.openFee != null && Number.isFinite(opts.openFee)
      ? Math.abs(opts.openFee)
      : (Math.abs(opts.entry * opts.qty) * openBps) / 10000;
  const funding = opts.fundingUsd != null && Number.isFinite(opts.fundingUsd) ? Math.max(0, opts.fundingUsd) : 0;
  const fees = openFee + estimatedCloseFee(opts.exit, opts.qty, closeBps) + funding;
  const pnl = pnlAt(opts.side, opts.entry, opts.exit, opts.qty, openFee, closeBps) - funding;
  return { pnl, fees, pnlR: netPnlR(pnl, opts.riskUsd) };
}

/** Shift SL/TP by the live fill vs the paper/signal entry. Distances stay the same. */
export function rebaseStopsFromFill(opts: {
  paperEntry: number;
  fill: number;
  sl: number;
  tp: number;
}): { sl: number; tp: number } {
  const paper = Number(opts.paperEntry);
  const fill = Number(opts.fill);
  if (!(paper > 0) || !(fill > 0) || !Number.isFinite(paper) || !Number.isFinite(fill)) {
    return { sl: opts.sl, tp: opts.tp };
  }
  const d = fill - paper;
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return { sl: opts.sl, tp: opts.tp };
  return { sl: opts.sl + d, tp: opts.tp + d };
}

/**
 * Live market-close guard. True when the last price is closer to entry than to
 * the paper stop/target — a thin-book wick already reverted, and a market
 * flatten would book a fee instead of the paper exit. Break-even (exit == entry)
 * is not reverted; that exit is the entry on purpose.
 */
export function liveFillReverted(opts: { entry: number; exit: number; last: number }) {
  const entry = Number(opts.entry);
  const exit = Number(opts.exit);
  const last = Number(opts.last);
  if (!(entry > 0) || !(exit > 0) || !(last > 0)) return false;
  if (Math.abs(exit - entry) <= 1e-8 * Math.max(1, entry)) return false;
  return Math.abs(last - exit) > Math.abs(last - entry);
}

export type VenueTradeLite = {
  time: number;
  side: string;
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
};

/** VWAP of closing fills + realized PnL actually booked on the venue. */
export function closeFromVenueTrades(opts: {
  side: Side;
  entry: number;
  trades: VenueTradeLite[];
  openedAt: number;
}): { exit: number; pnl: number; fees: number } | null {
  const closeSide = opts.side === "long" ? "SELL" : "BUY";
  const after = opts.trades.filter((t) => Number(t.time) >= opts.openedAt - 15_000);
  const closes = after.filter((t) => String(t.side).toUpperCase() === closeSide);
  if (!closes.length) return null;
  let notional = 0;
  let qty = 0;
  let pnl = 0;
  let fees = 0;
  let sawPnl = false;
  for (const t of after) {
    fees += Math.abs(Number(t.commission) || 0);
  }
  for (const t of closes) {
    const q = Math.abs(Number(t.qty) || 0);
    const px = Number(t.price) || 0;
    if (q > 0 && px > 0) {
      notional += px * q;
      qty += q;
    }
    const r = Number(t.realizedPnl);
    if (Number.isFinite(r) && r !== 0) {
      pnl += r;
      sawPnl = true;
    }
  }
  if (!(qty > 0)) return null;
  const exit = notional / qty;
  if (!sawPnl) {
    const gross = opts.side === "long" ? (exit - opts.entry) * qty : (opts.entry - exit) * qty;
    pnl = gross - fees;
  } else {
    pnl -= fees;
  }
  return { exit, pnl, fees };
}

export function simulateTrades(
  signals: Signal[],
  bars: Bar[],
  opts: { equity: number; capitalPct: number; leverage: number; symbol: string; timeframe: string },
) {
  const trades: PaperExit[] = [];
  let equity = opts.equity;
  let open: (PaperFill & { sigIndex: number; origSl: number; beAtR?: number; beMoved: boolean }) | null = null;
  const byBar = new Map<number, Signal[]>();
  for (const s of signals) {
    const list = byBar.get(s.barIndex) ?? [];
    list.push(s);
    byBar.set(s.barIndex, list);
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    if (open) {
      let hit = pathExit(open.side, open.sl, open.tp, bar);
      if (!hit && open.beAtR && !open.beMoved) {
        const dist = Math.abs(open.entry - open.origSl);
        const fav = open.side === "long" ? bar.high - open.entry : open.entry - bar.low;
        if (dist > 0 && fav >= open.beAtR * dist) {
          open.sl = open.entry;
          open.beMoved = true;
          hit = pathExit(open.side, open.sl, open.tp, bar);
        }
      }
      if (hit) {
        const atBe = open.beMoved && Math.abs(open.sl - open.entry) <= EPS * Math.max(1, open.entry);
        const reason: PaperExit["reason"] = hit === "tp" ? "tp" : atBe ? "be" : "sl";
        const exit = hit === "sl" ? open.sl : open.tp;
        const pnl = pnlAt(open.side, open.entry, exit, open.qty, open.fees);
        const slDist = Math.abs(open.entry - open.origSl);
        const pnlR = slDist > 0 ? ((open.side === "long" ? exit - open.entry : open.entry - exit) / slDist) : 0;
        equity += pnl;
        trades.push({
          ...open,
          exit,
          reason,
          pnl,
          pnlR,
          closedBarTime: bar.time,
        });
        open = null;
      }
    }
    if (!open) {
      const sigs = byBar.get(i);
      if (sigs && sigs[0]) {
        const s = sigs[0]!;
        const sized = sizePosition({
          equity,
          capitalPct: opts.capitalPct,
          entry: s.entry,
          sl: s.sl,
          leverage: opts.leverage,
        });
        if (sized) {
          open = {
            side: s.side,
            entry: s.entry,
            sl: s.sl,
            tp: s.tp,
            qty: sized.qty,
            leverage: sized.leverage,
            notional: sized.notional,
            risk: sized.risk,
            fees: sized.fees,
            indicator: s.indicator,
            timeframe: opts.timeframe,
            symbol: opts.symbol,
            openedBarTime: s.barTime,
            sigIndex: i,
            origSl: s.sl,
            beAtR: s.beAtR,
            beMoved: false,
          };
        }
      }
    }
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const netR = trades.reduce((a, t) => a + t.pnlR, 0);
  let peak = 0;
  let dd = 0;
  let run = 0;
  for (const t of trades) {
    run += t.pnlR;
    peak = Math.max(peak, run);
    dd = Math.min(dd, run - peak);
  }

  return {
    trades,
    equity,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (100 * wins.length) / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    expectR: trades.length ? netR / trades.length : 0,
    netR,
    maxDdR: dd,
  };
}
