import { origStopPx, rebaseStopsFromFill } from "./paper";
import { isValidLimitGeometry } from "./limit-queue";
import { coinOf } from "../exchanges/meta";

export type VenueSide = "long" | "short";

export type VenuePositionInput = {
  symbol: string;
  side: VenueSide;
  qty: number;
  entry: number;
  leverage: number;
  upl?: number;
};

export type DeskOpenPositionRef = {
  id: number;
  mode: string;
  venue: string;
  symbol: string;
  side: string;
};

export type OrphanBreadcrumbRef = {
  venue: string;
  symbol: string;
  side: string;
  qty: number;
  entry: number;
  sl: number;
  tp: number;
  leverage: number;
  notional: number;
  risk: number;
  fees: number;
  timeframe: string;
  indicator: string;
  barTime?: number;
  orderId?: string;
  origSl?: number;
  reason?: string;
  at: number;
};

export type LimitOrderMatchRef = {
  id: number;
  mode: string;
  venue: string;
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  atr?: number | null;
  leverage?: number | null;
  armed_bar_time: number;
  reason?: string | null;
  exchange_order_id?: string | null;
  status: string;
  updated_at?: string | null;
  closed_at?: string | null;
  created_at?: string | null;
};

export type SignalMatchRef = {
  id: number;
  ts: string;
  bar_time: number;
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  atr?: number | null;
  reason?: string | null;
};

export type RecoveredPositionMeta = {
  source: "orphan" | "limit" | "signal";
  symbol: string;
  timeframe: string;
  indicator: string;
  paperEntry: number;
  sl: number;
  tp: number;
  rr: number;
  atr: number | null;
  barTime: number | null;
  leverage: number | null;
  orderId?: string;
  reason: string;
  limitOrderId?: number;
  limitOrderStatus?: string;
};

export type VenueProtectionRef = {
  onVenue: boolean;
  hasSl: boolean;
  hasTp: boolean;
  unknown: boolean;
  slPrice?: number;
  tpPrice?: number;
};

export type ProtectionPlan = {
  sl: number;
  tp: number;
  needsUpdate: boolean;
  source: "recovered" | "venue" | "atr_fallback";
};

function parseTsMs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

export function normalizeSide(raw: string): VenueSide {
  return String(raw).toLowerCase() === "short" ? "short" : "long";
}

export function findConflictingOpenPositionIds(
  venuePos: Pick<VenuePositionInput, "symbol">,
  openRows: DeskOpenPositionRef[],
  activeVenue: string,
): number[] {
  const coin = coinOf(venuePos.symbol);
  if (!coin) return [];
  const ids: number[] = [];
  for (const row of openRows) {
    if (coinOf(row.symbol) !== coin) continue;
    const sameModeVenue =
      row.mode === "live" && (!row.venue || row.venue === "paper" || row.venue.toLowerCase() === activeVenue.toLowerCase());
    if (!sameModeVenue) ids.push(row.id);
  }
  return ids;
}

export function hasMatchingLiveOpenPosition(
  venuePos: Pick<VenuePositionInput, "symbol">,
  openRows: DeskOpenPositionRef[],
  activeVenue: string,
): boolean {
  const coin = coinOf(venuePos.symbol);
  if (!coin) return false;
  return openRows.some((row) => {
    if (coinOf(row.symbol) !== coin) return false;
    if (row.mode !== "live") return false;
    return !row.venue || row.venue === "paper" || row.venue.toLowerCase() === activeVenue.toLowerCase();
  });
}

const CANCEL_RECOVERY_WINDOW_MS = 6 * 60 * 60_000;

export function matchVenuePositionToDesk(input: {
  venuePos: VenuePositionInput;
  orphans: OrphanBreadcrumbRef[];
  limitOrders: LimitOrderMatchRef[];
  signals: SignalMatchRef[];
  nowMs?: number;
}): RecoveredPositionMeta | null {
  const { venuePos, orphans, limitOrders, signals } = input;
  const nowMs = input.nowMs ?? Date.now();
  const coin = coinOf(venuePos.symbol);
  if (!coin) return null;

  const orphan = orphans.find(
    (o) => coinOf(o.symbol) === coin && normalizeSide(o.side) === venuePos.side,
  );
  if (orphan && Number(orphan.sl) > 0 && Number(orphan.tp) > 0) {
    return {
      source: "orphan",
      symbol: orphan.symbol,
      timeframe: orphan.timeframe || "5m",
      indicator: orphan.indicator || "ORPHAN",
      paperEntry: Number(orphan.entry) || venuePos.entry,
      sl: Number(orphan.origSl ?? orphan.sl),
      tp: Number(orphan.tp),
      rr:
        Math.abs(Number(orphan.entry) - Number(orphan.origSl ?? orphan.sl)) > 0
          ? Math.abs(Number(orphan.tp) - Number(orphan.entry)) /
            Math.abs(Number(orphan.entry) - Number(orphan.origSl ?? orphan.sl))
          : 1.5,
      atr: null,
      barTime: orphan.barTime && orphan.barTime > 0 ? orphan.barTime : null,
      leverage: orphan.leverage > 0 ? orphan.leverage : null,
      orderId: orphan.orderId,
      reason: orphan.reason || "venue sync",
    };
  }

  const statusRank: Record<string, number> = {
    pending: 0,
    filled: 1,
    watch: 2,
    cancelled: 3,
  };

  const matchingLimits = limitOrders
    .filter((o) => {
      if (coinOf(o.symbol) !== coin) return false;
      if (normalizeSide(o.side) !== venuePos.side) return false;
      if (!(Number(o.sl) > 0 && Number(o.tp) > 0)) return false;
      if (o.status === "cancelled") {
        const closedAt = parseTsMs(o.closed_at ?? o.updated_at ?? o.created_at);
        if (closedAt > 0 && nowMs - closedAt > CANCEL_RECOVERY_WINDOW_MS) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ra = statusRank[a.status] ?? 9;
      const rb = statusRank[b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      const ta = parseTsMs(a.updated_at ?? a.created_at);
      const tb = parseTsMs(b.updated_at ?? b.created_at);
      if (tb !== ta) return tb - ta;
      return b.id - a.id;
    });

  const bestLimit = matchingLimits[0];
  if (bestLimit) {
    return {
      source: "limit",
      symbol: bestLimit.symbol,
      timeframe: bestLimit.timeframe || "5m",
      indicator: bestLimit.indicator,
      paperEntry: Number(bestLimit.entry) || venuePos.entry,
      sl: Number(bestLimit.sl),
      tp: Number(bestLimit.tp),
      rr: Number(bestLimit.rr) || 1.5,
      atr: bestLimit.atr != null && Number.isFinite(Number(bestLimit.atr)) ? Number(bestLimit.atr) : null,
      barTime: Number(bestLimit.armed_bar_time) > 0 ? Number(bestLimit.armed_bar_time) : null,
      leverage: bestLimit.leverage && Number(bestLimit.leverage) > 0 ? Number(bestLimit.leverage) : null,
      orderId: bestLimit.exchange_order_id ?? undefined,
      reason: `${bestLimit.reason ?? "limit"} · venue sync`,
      limitOrderId: bestLimit.id,
      limitOrderStatus: bestLimit.status,
    };
  }

  const matchingSignals = signals
    .filter((s) => coinOf(s.symbol) === coin && normalizeSide(s.side) === venuePos.side && Number(s.sl) > 0 && Number(s.tp) > 0)
    .sort((a, b) => {
      const btDiff = Number(b.bar_time || 0) - Number(a.bar_time || 0);
      if (btDiff !== 0) return btDiff;
      return parseTsMs(b.ts) - parseTsMs(a.ts);
    });

  const bestSignal = matchingSignals[0];
  if (bestSignal) {
    return {
      source: "signal",
      symbol: bestSignal.symbol,
      timeframe: bestSignal.timeframe || "5m",
      indicator: bestSignal.indicator,
      paperEntry: Number(bestSignal.entry) || venuePos.entry,
      sl: Number(bestSignal.sl),
      tp: Number(bestSignal.tp),
      rr: Number(bestSignal.rr) || 1.5,
      atr: bestSignal.atr != null && Number.isFinite(Number(bestSignal.atr)) ? Number(bestSignal.atr) : null,
      barTime: Number(bestSignal.bar_time) > 0 ? Number(bestSignal.bar_time) : null,
      leverage: null,
      reason: `${bestSignal.reason ?? "signal"} · venue sync`,
    };
  }

  return null;
}

export function fallbackStopsFromAtr(input: {
  side: VenueSide;
  entry: number;
  atr?: number | null;
  rr?: number;
}): { sl: number; tp: number } {
  const { side, entry, atr } = input;
  const rr = input.rr && input.rr > 0 ? input.rr : 1.5;
  const rawDist =
    atr != null && Number.isFinite(atr) && atr > 0
      ? Math.max(atr * 1.5, entry * 0.005)
      : entry * 0.02;
  // Never compute SL <= 0 for longs
  const riskDist = side === "long" ? Math.min(rawDist, entry * 0.5) : rawDist;
  const sl = side === "long" ? entry - riskDist : entry + riskDist;
  const tp = side === "long" ? entry + riskDist * rr : Math.max(entry * 0.05, entry - riskDist * rr);
  return { sl, tp };
}

function validSideStop(side: VenueSide, entry: number, sl: number): boolean {
  return Number.isFinite(sl) && sl > 0 && (side === "long" ? sl < entry : sl > entry);
}

function validSideTarget(side: VenueSide, entry: number, tp: number): boolean {
  return Number.isFinite(tp) && tp > 0 && (side === "long" ? tp > entry : tp < entry);
}

function nearEntryPx(entry: number, px: number): boolean {
  return Math.abs(px - entry) <= 1e-4 * Math.max(1, entry);
}

function hasMinRewardRatio(entry: number, sl: number, tp: number): boolean {
  const slDist = Math.abs(entry - sl);
  const tpDist = Math.abs(tp - entry);
  return slDist > 0 && tpDist >= slDist * 0.25;
}

export function isProtectionMatched(opts: {
  side: VenueSide;
  entry: number;
  wantSl: number;
  wantTp: number;
  prot: VenueProtectionRef | null | undefined;
  tolFrac?: number;
}): boolean {
  const { side, entry, wantSl, wantTp, prot } = opts;
  if (!prot || prot.unknown || !prot.onVenue || !prot.hasSl || !prot.hasTp) return false;
  const tol = opts.tolFrac ?? 0.004;
  if (prot.slPrice != null && prot.slPrice > 0) {
    if (!validSideStop(side, entry, prot.slPrice) || nearEntryPx(entry, prot.slPrice)) return false;
    if (wantSl > 0 && Math.abs(prot.slPrice - wantSl) / Math.max(1e-12, wantSl) > tol) return false;
  }
  if (prot.tpPrice != null && prot.tpPrice > 0) {
    if (!validSideTarget(side, entry, prot.tpPrice) || nearEntryPx(entry, prot.tpPrice)) return false;
    if (wantTp > 0 && Math.abs(prot.tpPrice - wantTp) / Math.max(1e-12, wantTp) > tol) return false;
  }
  return true;
}

export function syncLiveStopsWithVenueEntry(opts: {
  side: VenueSide;
  prevEntry: number;
  liveEntry: number;
  sl: number;
  origSl?: number | null;
  tp: number;
  atr?: number | null;
  rr?: number | null;
}): { entry: number; sl: number; tp: number; changed: boolean } {
  const prevEntry = Number(opts.prevEntry);
  const entry = Number(opts.liveEntry) > 0 ? Number(opts.liveEntry) : prevEntry;
  const baseSl = origStopPx({
    side: opts.side,
    entry: prevEntry > 0 ? prevEntry : entry,
    sl: Number(opts.sl),
    origSl: opts.origSl,
  });
  let sl = baseSl;
  let tp = Number(opts.tp);
  const entryMoved = prevEntry > 0 && entry > 0 && Math.abs(entry - prevEntry) / prevEntry > 1e-4;
  if (entryMoved) {
    const rebased = rebaseStopsFromFill({
      paperEntry: prevEntry,
      fill: entry,
      sl: baseSl,
      tp,
    });
    sl = rebased.sl;
    tp = rebased.tp;
  }
  const geometryValid =
    entry > 0 &&
    isValidLimitGeometry(opts.side, entry, sl, tp) &&
    !nearEntryPx(entry, sl) &&
    !nearEntryPx(entry, tp) &&
    hasMinRewardRatio(entry, sl, tp);
  if (!geometryValid && entry > 0) {
    const fb = fallbackStopsFromAtr({
      side: opts.side,
      entry,
      atr: opts.atr,
      rr: opts.rr ?? undefined,
    });
    sl = fb.sl;
    tp = fb.tp;
  }
  const changed =
    entryMoved ||
    Math.abs(sl - Number(opts.sl)) / Math.max(1e-12, entry || 1) > 1e-6 ||
    Math.abs(tp - Number(opts.tp)) / Math.max(1e-12, entry || 1) > 1e-6;
  return { entry, sl, tp, changed };
}

export function resolveProtectionPlan(input: {
  side: VenueSide;
  entry: number;
  atr?: number | null;
  recovered: RecoveredPositionMeta | null;
  protection?: VenueProtectionRef | null;
}): ProtectionPlan {
  const { side, entry, atr, recovered, protection } = input;
  const prot = protection ?? { onVenue: true, hasSl: false, hasTp: false, unknown: true };
  const hasVenuePair =
    !prot.unknown &&
    prot.hasSl &&
    prot.hasTp &&
    prot.slPrice != null &&
    prot.tpPrice != null &&
    isValidLimitGeometry(side, entry, prot.slPrice, prot.tpPrice) &&
    !nearEntryPx(entry, prot.slPrice) &&
    !nearEntryPx(entry, prot.tpPrice) &&
    hasMinRewardRatio(entry, prot.slPrice, prot.tpPrice);

  if (recovered) {
    const rebased = rebaseStopsFromFill({
      paperEntry: recovered.paperEntry > 0 ? recovered.paperEntry : entry,
      fill: entry,
      sl: recovered.sl,
      tp: recovered.tp,
    });
    const fallback = fallbackStopsFromAtr({ side, entry, atr: recovered.atr ?? atr, rr: recovered.rr });
    let sl = validSideStop(side, entry, rebased.sl) ? rebased.sl : fallback.sl;
    let tp = validSideTarget(side, entry, rebased.tp) ? rebased.tp : fallback.tp;
    if (!hasMinRewardRatio(entry, sl, tp) || nearEntryPx(entry, tp)) {
      sl = fallback.sl;
      tp = fallback.tp;
    }
    const needsUpdate = !isProtectionMatched({
      side,
      entry,
      wantSl: sl,
      wantTp: tp,
      prot,
    });
    return { sl, tp, needsUpdate, source: "recovered" };
  }

  if (hasVenuePair) {
    return {
      sl: prot.slPrice!,
      tp: prot.tpPrice!,
      needsUpdate: false,
      source: "venue",
    };
  }

  const fallback = fallbackStopsFromAtr({ side, entry, atr });
  const existingSl =
    !prot.unknown && prot.hasSl && prot.slPrice != null && validSideStop(side, entry, prot.slPrice) && !nearEntryPx(entry, prot.slPrice)
      ? prot.slPrice
      : null;
  const existingTp =
    !prot.unknown && prot.hasTp && prot.tpPrice != null && validSideTarget(side, entry, prot.tpPrice) && !nearEntryPx(entry, prot.tpPrice)
      ? prot.tpPrice
      : null;

  const sl = existingSl ?? fallback.sl;
  const tp = existingTp ?? fallback.tp;
  const needsUpdate = prot.unknown || !prot.hasSl || !prot.hasTp || existingSl == null || existingTp == null;
  return { sl, tp, needsUpdate, source: "atr_fallback" };
}

export function shouldAdoptInsteadOfCancel(input: {
  venueHasPosition: boolean;
}): boolean {
  return input.venueHasPosition;
}

export function shouldRollbackRestingLimit(input: {
  resting: boolean;
  filled?: boolean;
  dbPersisted: boolean;
}): boolean {
  return Boolean(input.resting && !input.filled && !input.dbPersisted);
}

export function isAsterProtectiveOrder(o: {
  type?: string;
  origType?: string;
  reduceOnly?: boolean | string;
  clientOrderId?: string;
}): boolean {
  const typ = `${o.type ?? ""} ${o.origType ?? ""}`.toUpperCase();
  const cid = String(o.clientOrderId ?? "").toLowerCase();
  if (typ.includes("STOP") || typ.includes("TAKE_PROFIT")) return true;
  if (o.reduceOnly === true || String(o.reduceOnly).toLowerCase() === "true") return true;
  if (cid.startsWith("psl") || cid.startsWith("ptp")) return true;
  return false;
}
