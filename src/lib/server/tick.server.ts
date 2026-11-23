import { fetchKlinesCached } from "@/lib/market/klines";
import { FALLBACK_UNIVERSE, fetchUniverse, fetchVenueUniverse, filterByMinCap, minCapUsd, looksLikeFallbackUniverse } from "@/lib/market/universe";
import { fetchVenueLastPrice } from "@/lib/market/venues";
import { onlyClosedBars, runIndicator, scanArmedClosed, scanBarClosed, type ArmedSetup } from "@/lib/engine/run";
import { parseEngineGates, parseSideGates, scanNames, isEngineOn, isSideOn } from "@/lib/engine/engine-gates";
import {
  PAPER_MAKER_BPS,
  PAPER_MIN_NOTIONAL_USD,
  PAPER_TAKER_BPS,
  applyPaperSlippage,
  estimatePaperFee,
  estimatePaperFundingUsd,
  exitPathBars,
  origStopPx,
  paperSlippageBps,
  pathExcursion,
  rebaseStopsFromFill,
  resolveLimitFill5mTime,
  closeFromVenueTrades,
  sizePosition,
  walkPath,
  netClosePnl,
  netPnlR,
  liveFillReverted,
} from "@/lib/engine/paper";
import { capitalPctForLeverage, DEFAULT_CAPITAL_PCT, parseCapitalBase, parseLevSizeTiers } from "@/lib/engine/lev-size";
import {
  barFillKey,
  fillCoin,
  heldCoins as coinsHeld,
  coinsOf,
  concurrentOpenCount,
  clampMaxPositions,
  leverageOverCap,
  marginOverBudget,
  skipFill,
  countHtfOpen,
  clampHtfMaxPositions,
  isHtfTf,
} from "@/lib/engine/fill-gates";
import {
  canQueueLimitOrder,
  evaluatePendingLimit,
  parseEntryMode,
  resolveLimitTtlBars,
} from "@/lib/engine/limit-queue";
import {
  findPreArmedSetup,
  isPreArmReason,
  preArmMatchesOrder,
  scanPreArmedClosed,
  type PreArmedSetup,
} from "@/lib/engine/pre-arm";
import { FEE_BPS, HTF2_OF, HTF_OF, TF_MS, WARMUP, type IndicatorName, type KlineTf, type Timeframe, type VenueId } from "@/lib/engine/types";
import {
  dueTimeframes,
  interleaveSlices,
  isFreshSignal,
  latestClosedOpen,
  nextTfCursor,
  parseCursors,
  prefixCompleted,
  scanLastN,
  type TfCursor,
} from "@/lib/engine/scan-schedule";
import { bookVenue, chartHostLabel, getAdapter, resolveMaxLeverage, sameCoin, venueSymbol } from "@/lib/exchanges/registry";
import { venueMaxLeverage, loadPublicLeverageMaps } from "@/lib/exchanges/leverage";
import { capLeverage, stackedUserLevCap } from "@/lib/exchanges/lev-cap";
import type { ExchangeAccount, ExchangeAdapter, PlaceOrderResult, ProtectionSnapshot, VenueOpenOrder } from "@/lib/exchanges/types";
import { readVenueWallet, usedMarginUsd, attachAvailable } from "@/lib/exchanges/wallet";
import {
  alreadyFilled,
  acquireTickLock,
  bumpEquity,
  cancelLimitOrder,
  closePosition,
  dropOrphanFill,
  getSettings,
  heartbeatTickLock,
  insertLimitOrder,
  insertPosition,
  insertSignal,
  listBarFills,
  listOpenPositions,
  listOrphanFills,
  listPendingLimitOrders,
  listRecentLimitOrders,
  listUniverse,
  logScan,
  markLimitOrderFilled,
  publicSettings,
  rememberOrphanFill,
  releaseTickLock,
  replaceUniverse,
  setEquity,
  setScanCursor,
  setUniverseVenue,
  snapshotEquity,
  touchTick,
  updatePositionSl,
  markScanProgress,
  type LimitOrderRow,
  type PositionRow,
  type SettingsRow,
} from "./desk.server";
import { notifySignalsTelegram } from "./telegram.server";
import type { TelegramSignal } from "@/lib/telegram";
import { trexBeAtR } from "@/lib/engine/trex";

const SCAN_BARS = 360;
const MIN_BARS = WARMUP + 12;
const SCAN_CONCURRENCY = 16;
const MAX_BATCH = 250;
const UNIVERSE_TTL_MS = 30 * 60_000;
const LOCK_HEARTBEAT_MS = 5_000;

export function tickBudgetMs() {
  const override = Number(process.env.TICK_BUDGET_MS);
  if (Number.isFinite(override) && override >= 3_000) return Math.min(55_000, override);
  if (process.env.VERCEL) {
    const cap = Number(process.env.VERCEL_MAX_DURATION);
    if (Number.isFinite(cap) && cap >= 15) return Math.min(55_000, cap * 1000 - 2_000);
    return 8_000;
  }
  return 45_000;
}

type StampedAsset = Awaited<ReturnType<typeof fetchVenueUniverse>>[number];
let universeCache: { at: number; venue: VenueId; assets: StampedAsset[] } | null = null;

export function clearUniverseCache() {
  universeCache = null;
}

export function hasLiveKeys(s: SettingsRow, venue: VenueId) {
  if (venue === "hyperliquid") {
    const w = (s.hyperliquid_wallet_address ?? "").trim();
    return Boolean(s.hyperliquid_private_key) && /^0x[0-9a-fA-F]{40}$/.test(w);
  }
  if (venue === "lighter") return Boolean(s.lighter_api_private_key && s.lighter_account_index != null);
  if (venue === "aster") {
    const pk = (s.aster_api_secret ?? "").trim();
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) return true;
    return Boolean(s.aster_api_key && s.aster_api_secret);
  }
  if (venue === "ourbit") return Boolean(s.ourbit_api_key && s.ourbit_api_secret);
  return false;
}

export function accountFrom(s: SettingsRow, venue: VenueId): ExchangeAccount {
  if (venue === "aster") {
    return {
      venue,
      apiKey: s.aster_api_key ?? undefined,
      apiSecret: s.aster_api_secret ?? undefined,
      walletAddress: s.aster_api_key ?? undefined,
      privateKey: s.aster_api_secret ?? undefined,
    };
  }
  if (venue === "ourbit") {
    return { venue, apiKey: s.ourbit_api_key ?? undefined, apiSecret: s.ourbit_api_secret ?? undefined };
  }
  if (venue === "hyperliquid") {
    return {
      venue,
      privateKey: s.hyperliquid_private_key ?? undefined,
      walletAddress: s.hyperliquid_wallet_address ?? undefined,
    };
  }
  return {
    venue: "lighter",
    apiKey: s.lighter_api_key ?? undefined,
    privateKey: s.lighter_api_private_key ?? undefined,
    accountIndex: s.lighter_account_index ?? undefined,
    apiKeyIndex: s.lighter_api_key_index ?? 2,
  };
}

const ORPHAN_MARK = "UNPROTECTED flatten failed";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Overlay live venue balance / fill onto the desk payload. Style unchanged. */
export async function overlayLiveSnapshot<
  T extends { mode: string; venue: string; liveEnabled: boolean; equityUsd: number; availableUsd?: number },
>(settings: T, open: PositionRow[]): Promise<{ settings: T; open: PositionRow[] }> {
  const venue = bookVenue(settings.venue);
  if (settings.mode !== "live" || venue === "paper") {
    return { settings: attachAvailable(settings, open), open };
  }
  const row = await getSettings().catch(() => null);
  if (!row || !hasLiveKeys(row, venue)) return { settings: attachAvailable(settings, open), open };
  const adapter = getAdapter(venue);
  if (!adapter) return { settings: attachAvailable(settings, open), open };
  const acc = accountFrom(row, venue);
  let next = settings;
  try {
    const w = await withTimeout(readVenueWallet(adapter, acc), 5000);
    if (w) {
      next = { ...next, equityUsd: w.equity, availableUsd: w.available };
      await setEquity(w.equity).catch(() => undefined);
    } else {
      next = attachAvailable(next, open);
    }
  } catch {
    next = attachAvailable(next, open);
  }
  if (!open.length) return { settings: next, open };
  try {
    const vpos = await withTimeout(adapter.fetchPositions(acc), 5000);
    const mapped = open.map((p) => {
      const hit = vpos.find((x) => sameCoin(x.symbol, p.symbol) || sameCoin(x.symbol, venueSymbol(venue, p.symbol)));
      if (!hit) return p;
      return {
        ...p,
        entry: hit.entry > 0 ? hit.entry : p.entry,
        qty: hit.qty > 0 ? hit.qty : p.qty,
        leverage: hit.leverage > 0 ? hit.leverage : p.leverage,
        pnl_usd: Number.isFinite(hit.upl) ? hit.upl : p.pnl_usd,
      };
    });
    return { settings: next, open: mapped };
  } catch {
    return { settings: next, open };
  }
}

async function resolveLiveExit(
  adapter: ExchangeAdapter,
  acc: ExchangeAccount,
  venue: VenueId,
  pos: {
    symbol: string;
    side: string;
    entry: number | string;
    sl: number | string;
    orig_sl?: number | null;
    qty: number | string;
    risk_usd: number | string;
    fees_usd: number | string;
    opened_at: string;
  },
  fallbackPx: number,
) {
  const side = pos.side as "long" | "short";
  const entry = Number(pos.entry);
  const origPx = origStopPx({
    side,
    entry,
    sl: Number(pos.sl),
    origSl: pos.orig_sl,
    qty: Number(pos.qty),
    risk: Number(pos.risk_usd),
  });
  const slDist = Math.abs(entry - origPx);
  let exit = fallbackPx;
  let pnl: number | null = null;
  let fees: number | null = null;
  if (adapter.fetchTrades) {
    try {
      const openedAt = new Date(pos.opened_at).getTime();
      const trades = await adapter.fetchTrades(acc, {
        symbol: venueSymbol(venue, pos.symbol),
        startTime: Math.max(0, openedAt - 15_000),
      });
      const hit = closeFromVenueTrades({ side, entry, trades, openedAt });
      if (hit) {
        exit = hit.exit;
        pnl = hit.pnl;
        fees = hit.fees;
      }
    } catch {
      /* paper fallback */
    }
  }
  if (pnl == null) {
    const settled = netClosePnl({
      side,
      entry,
      exit,
      qty: Number(pos.qty),
      riskUsd: Number(pos.risk_usd),
      openFee: Number(pos.fees_usd),
    });
    pnl = settled.pnl;
    if (fees == null) fees = settled.fees;
  }
  if (fees == null) {
    const settled = netClosePnl({
      side,
      entry,
      exit,
      qty: Number(pos.qty),
      riskUsd: Number(pos.risk_usd),
      openFee: Number(pos.fees_usd),
    });
    fees = settled.fees;
    if (pnl == null) pnl = settled.pnl;
  }
  const priceR = slDist > 0 ? (side === "long" ? exit - entry : entry - exit) / slDist : 0;
  const pnlR = netPnlR(pnl, Number(pos.risk_usd), priceR);
  return { exit, pnl, pnlR, fees };
}

async function confirmLiveFill(
  adapter: ExchangeAdapter,
  acc: ExchangeAccount,
  symbol: string,
  sl: number,
  tp: number,
  orderId?: string,
): Promise<PlaceOrderResult> {
  let last: ProtectionSnapshot = { onVenue: false, hasSl: false, hasTp: false, unknown: true };
  for (let i = 0; i < 5; i++) {
    try {
      last = await adapter.fetchProtection(acc, { symbol, sl, tp });
      if (!last.unknown && last.onVenue && last.hasSl && last.hasTp) {
        return { ok: true, orderId, message: "fill confirmed · SL/TP on venue" };
      }
      if (!last.unknown && !last.onVenue) break;
    } catch {
      last = { onVenue: false, hasSl: false, hasTp: false, unknown: true };
    }
    if (i < 4) await sleep(400);
  }
  const why = last.unknown
    ? "live fill unconfirmed (venue read failed)"
    : !last.onVenue
      ? "live fill not on venue"
      : `live fill missing ${[!last.hasSl && "SL", !last.hasTp && "TP"].filter(Boolean).join("+")}`;
  try {
    const closed = await adapter.closePosition(acc, symbol);
    const flat = closed.ok || closed.message === "flat";
    if (flat) return { ok: false, orderId, message: `${why} — flattened, no unprotected position left` };
    return { ok: false, liveOpen: true, orderId, message: `${why} — flatten failed (${closed.message})` };
  } catch (e) {
    return {
      ok: false,
      liveOpen: true,
      orderId,
      message: `${why} — flatten failed (${e instanceof Error ? e.message : "close threw"})`,
    };
  }
}

function isOrphanPosition(pos: { signal_reason?: string | null }) {
  return typeof pos.signal_reason === "string" && pos.signal_reason.includes(ORPHAN_MARK);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function resolveBatch(raw: number, universeLen: number) {
  if (!universeLen) return 0;
  if (!Number.isFinite(raw) || raw <= 0) return Math.min(MAX_BATCH, universeLen);
  return Math.min(MAX_BATCH, universeLen, Math.max(1, Math.round(raw)));
}

export async function refreshUniverse(minMcap: number, venue: VenueId = "paper", force = false) {
  const floor = minCapUsd(minMcap);
  const book = bookVenue(venue);
  if (
    !force &&
    universeCache &&
    universeCache.venue === book &&
    Date.now() - universeCache.at < UNIVERSE_TTL_MS &&
    universeCache.assets.length
  ) {
    return filterByMinCap(universeCache.assets, floor, (a) => a.marketCapUsd);
  }
  let listed: StampedAsset[] = [];
  let listedErr: Error | null = null;
  try {
    listed = await fetchVenueUniverse(book, force);
  } catch (e) {
    listedErr = e instanceof Error ? e : new Error(`${book} listed markets empty`);
    listed = [];
  }
  if (!listed.length && universeCache && universeCache.venue === book && universeCache.assets.length) {
    return filterByMinCap(universeCache.assets, floor, (a) => a.marketCapUsd);
  }
  if (!listed.length) {
    const existing = await listUniverse().catch(() => []);
    const stored = await getSettings().catch(() => null);
    const storedVenue = stored?.universe_venue ? bookVenue(stored.universe_venue) : null;
    if (existing.length && storedVenue === book) {
      return filterByMinCap(
        existing.map((a) => ({
          symbol: a.symbol,
          base: a.base,
          name: a.name,
          marketCapUsd: Number(a.market_cap_usd),
          volume24hUsd: Number(a.volume_24h_usd),
          maxLeverage: Number(a.max_leverage),
          venueSymbol: a.venue_symbol ?? a.symbol,
        })),
        floor,
        (a) => a.marketCapUsd,
      );
    }
    if (book === "paper") {
      try {
        listed = await fetchUniverse(0);
      } catch {
        listed = [];
      }
      if (!listed.length) listed = FALLBACK_UNIVERSE.slice();
    } else if (!listed.length) {
      throw listedErr ?? new Error(`${book} listed markets empty`);
    }
  }
  try {
    await loadPublicLeverageMaps();
  } catch {
    /* stamp with defaults */
  }
  const stamped = await Promise.all(
    listed.map(async (a) => ({
      ...a,
      maxLeverage: a.maxLeverage > 0 ? capLeverage(a.maxLeverage) : await venueMaxLeverage(book, a.symbol),
    })),
  );
  await replaceUniverse(stamped);
  if (looksLikeFallbackUniverse(stamped)) {
    universeCache = null;
    await setUniverseVenue("");
  } else {
    await setUniverseVenue(book);
    universeCache = { at: Date.now(), venue: book, assets: stamped };
  }
  return filterByMinCap(stamped, floor, (a) => a.marketCapUsd);
}

export async function restampUniverseLeverage(venue: VenueId) {
  const rows = await listUniverse();
  if (!rows.length) return [];
  const stamped = await Promise.all(
    rows.map(async (a) => ({
      symbol: a.symbol,
      base: a.base,
      name: a.name,
      marketCapUsd: Number(a.market_cap_usd),
      volume24hUsd: Number(a.volume_24h_usd),
      maxLeverage: await venueMaxLeverage(venue, a.symbol),
      venueSymbol: a.venue_symbol ?? a.symbol,
    })),
  );
  await replaceUniverse(stamped);
  await setUniverseVenue(venue);
  return stamped;
}

export async function runTick(opts?: { forceUniverse?: boolean; batch?: number; source?: string }) {
  const t0 = Date.now();
  const source = opts?.source ?? "manual";
  const lock = await acquireTickLock();
  if (!lock) {
    return {
      ok: true,
      skipped: true,
      reason: "tick already running",
      public: publicSettings(await getSettings()),
    };
  }
  const hb = setInterval(() => {
    void heartbeatTickLock(lock);
  }, LOCK_HEARTBEAT_MS);
  hb.unref?.();
  try {
    return await runTickBody({ ...opts, source, t0, lock });
  } finally {
    clearInterval(hb);
    await releaseTickLock(lock);
  }
}

async function runTickBody(opts: { forceUniverse?: boolean; batch?: number; source: string; t0: number; lock: string }) {
  const t0 = opts.t0;
  const settings = await getSettings();
  if (!settings.bot_enabled) {
    await touchTick(opts.source);
    return { ok: true, skipped: true, reason: "bot off", public: publicSettings(await getSettings()) };
  }

  const venue = bookVenue(settings.venue);
  const minMcap = minCapUsd(settings.min_market_cap_usd);

  let universe: Array<{
    symbol: string;
    base: string;
    name: string;
    market_cap_usd: number;
    volume_24h_usd: number;
    max_leverage: number;
  }>;
  try {
    const fresh = await refreshUniverse(minMcap, venue, Boolean(opts?.forceUniverse));
    universe = fresh.map((a) => ({
      symbol: a.symbol,
      base: a.base,
      name: a.name,
      market_cap_usd: a.marketCapUsd,
      volume_24h_usd: a.volume24hUsd,
      max_leverage: a.maxLeverage,
    }));
  } catch {
    const stored = await getSettings().catch(() => null);
    const existing = await listUniverse().catch(() => []);
    if (existing.length && bookVenue(stored?.universe_venue ?? "") === venue) {
      universe = filterByMinCap(existing, minMcap, (a) => Number(a.market_cap_usd));
    } else {
      universe = [];
    }
  }

  const open = await listOpenPositions();
  let closed = 0;
  let opened = 0;
  let signals = 0;
  let scanned = 0;

  const openSyms = [...new Set(open.map((p) => p.symbol))];
  const lastBars = new Map<string, Awaited<ReturnType<typeof fetchKlinesCached>>>();
  await mapPool(openSyms, 4, async (sym) => {
    try {
      const bars = await fetchKlinesCached(sym, "5m", 96, venue);
      lastBars.set(sym, bars);
    } catch {
      /* skip */
    }
  });

  let equity = Number(settings.equity_usd);
  let usedMargin = usedMarginUsd(open);
  let available = Math.max(0, equity - usedMargin);
  const wantLive = settings.mode === "live" && venue !== "paper";
  const live =
    wantLive &&
    Boolean(settings.live_enabled) &&
    hasLiveKeys(settings, venue);
  const liveBlock = wantLive && !live
    ? !hasLiveKeys(settings, venue)
      ? `${venue} keys incomplete — live blocked, not opening paper`
      : `live not armed — not opening paper`
    : "";
  const acc = accountFrom(settings, venue === "paper" ? "lighter" : venue);
  const adapter = live ? getAdapter(venue) : null;
  let liveBalReady = !live;
  let liveBookReady = !live;
  if (live && adapter) {
    try {
      const w = await withTimeout(readVenueWallet(adapter, acc), 8000);
      if (w) {
        equity = w.equity;
        available = w.available;
        liveBalReady = true;
        await setEquity(equity);
      }
    } catch {
      liveBalReady = false;
    }
    if (!liveBalReady) {
      equity = 0;
      available = 0;
    }
    try {
      const pending = await listOrphanFills();
      for (const o of pending) {
        try {
          const res = await adapter.closePosition(acc, venueSymbol(venue, o.symbol));
          if (res.ok || res.message === "flat") {
            await dropOrphanFill(o.symbol);
            continue;
          }
        } catch {
          /* book a desk row so the open-loop retry can flatten */
        }
        try {
          const id = await insertPosition({
            mode: "live",
            venue,
            symbol: o.symbol,
            timeframe: o.timeframe || "5m",
            indicator: o.indicator || "ORPHAN",
            side: o.side,
            entry: o.entry,
            sl: o.sl,
            tp: o.tp,
            qty: o.qty,
            leverage: o.leverage,
            notional: o.notional,
            risk: o.risk,
            fees: o.fees,
            orderId: o.orderId,
            barTime: o.barTime,
            origSl: o.origSl ?? o.sl,
            signalReason: `${o.reason ?? ""} · ${ORPHAN_MARK}`,
            margin: o.notional / Math.max(1, o.leverage),
          });
          if (id) await dropOrphanFill(o.symbol);
        } catch {
          /* keep the JSON breadcrumb */
        }
      }
    } catch {
      /* orphan column may be missing until migrate */
    }
  }

  for (const pos of open) {
    if (pos.mode === "live") {
      if (!live || !adapter) continue;
      if (pos.venue && pos.venue !== "paper" && bookVenue(pos.venue) !== venue) continue;
    }
    if (live && adapter && pos.mode === "live" && isOrphanPosition(pos)) {
      try {
        const res = await adapter.closePosition(acc, venueSymbol(venue, pos.symbol));
        if (res.ok || res.message === "flat") {
          let exitPx = Number(pos.entry);
          try {
            const last = await fetchVenueLastPrice(venue, pos.symbol);
            if (Number.isFinite(last)) exitPx = last;
          } catch {
            /* keep entry */
          }
          const resolved = await resolveLiveExit(adapter, acc, venue, pos, exitPx);
          const holdMs = Math.max(0, Date.now() - new Date(pos.opened_at).getTime());
          await closePosition(pos.id, resolved.exit, "flatten retry", resolved.pnl, resolved.pnlR, {
            holdMs,
            beMoved: false,
            feesUsd: resolved.fees,
          });
          closed += 1;
          continue;
        }
      } catch {
        /* still walk SL/TP below; retry flatten next tick */
      }
    }
    if (live && adapter && pos.mode === "live") {
      const vs = venueSymbol(venue, pos.symbol);
      const side = pos.side as "long" | "short";
      const deskSl = Number(pos.sl);
      const tpNow = Number(pos.tp);
      const qtyNow = Number(pos.qty);
      const entryPx = Number(pos.entry);
      // Venue stop stays the signal stop. Never the entry — a mark tick there is a fee, not a BE.
      const venueSl = origStopPx({
        side,
        entry: entryPx,
        sl: deskSl,
        origSl: pos.orig_sl,
        qty: pos.qty,
        risk: pos.risk_usd,
      });
      try {
        const prot = await adapter.fetchProtection(acc, { symbol: vs, sl: venueSl, tp: tpNow });
        const deskAtEntry = Math.abs(deskSl - entryPx) <= 1e-8 * Math.max(1, entryPx);
        const restoreOrig = deskAtEntry && Math.abs(venueSl - entryPx) > 1e-8 * Math.max(1, entryPx);
        if (!prot.unknown && prot.onVenue && (restoreOrig || !prot.hasSl || !prot.hasTp)) {
          try {
            await adapter.updateStop(acc, {
              symbol: vs,
              side,
              sl: venueSl,
              tp: tpNow,
              qty: qtyNow,
            });
            if (restoreOrig) {
              try {
                await updatePositionSl(pos.id, venueSl);
              } catch {
                /* desk catches up next tick */
              }
            }
          } catch {
            /* retry next tick — do not flatten at entry because the stop read blipped */
          }
        }
      } catch {
        /* next tick retries protection */
      }
    }
    const rawBars = lastBars.get(pos.symbol);
    if (!rawBars?.length) continue;
    const livePos = Boolean(live && adapter && pos.mode === "live");
    // Paper and live both evaluate exits strictly on closed 5m bars so forming wicks never fake-close paper.
    const bars = onlyClosedBars(rawBars, "5m");
    if (!bars.length) continue;
    const side = pos.side as "long" | "short";
    const entry = Number(pos.entry);
    const deskSl = Number(pos.sl);
    let slNow = livePos
      ? origStopPx({
          side,
          entry,
          sl: deskSl,
          origSl: pos.orig_sl,
          qty: pos.qty,
          risk: pos.risk_usd,
        })
      : deskSl;
    const tpNow = Number(pos.tp);
    const tf = (pos.timeframe as Timeframe) in TF_MS ? (pos.timeframe as Timeframe) : "5m";
    const tfMs = TF_MS[tf];
    const openedMs = new Date(pos.opened_at).getTime();
    const barTime = Number(pos.bar_time);
    const isLimitFill = typeof pos.signal_reason === "string" && /limit/i.test(pos.signal_reason);
    const path = exitPathBars({
      bars5m: bars,
      barTime,
      tfMs,
      openedMs,
      isLimitFill,
    });
    if (!path.length) continue;
    const walked = walkPath({
      side,
      entry,
      sl: slNow,
      tp: tpNow,
      bars: path,
      beAtR: trexBeAtR(pos.indicator),
      leverage: !livePos ? Number(pos.leverage) || 1 : undefined,
    });
    if (walked.beMoved && Math.abs(walked.sl - slNow) > 1e-12) {
      const atEntry = Math.abs(walked.sl - entry) <= 1e-8 * Math.max(1, entry);
      // TREX BE is applied inside walkPath on the closed candle. Do not rest that stop
      // on the venue — one tick back through entry would flatten before the target.
      if (!(livePos && atEntry)) {
      let venueOk = true;
      if (live && adapter && pos.mode === "live") {
        try {
          const res = await adapter.updateStop(acc, {
            symbol: venueSymbol(venue, pos.symbol),
            side,
            sl: walked.sl,
            tp: tpNow,
            qty: Number(pos.qty),
          });
          venueOk = res.ok;
        } catch {
          venueOk = false;
        }
      }
      if (venueOk) {
        try {
          await updatePositionSl(pos.id, walked.sl);
          slNow = walked.sl;
        } catch {
          /* keep original stop */
        }
      }
      }
    }
    const reason = walked.hit?.reason ?? null;
    if (reason) {
      const why = walked.hit?.liquidated ? "liq" : reason;
      const paperExit = walked.hit!.exit;
      if (live && adapter && pos.mode === "live") {
        let last = paperExit;
        try {
          const px = await fetchVenueLastPrice(venue, pos.symbol);
          if (Number.isFinite(px) && px > 0) last = px;
        } catch {
          /* if the last price is unread, do not market-flatten at a guess */
          continue;
        }
        // Wick tagged the paper level and came back to entry. Leave the resting
        // limit stop; a market close here is the fee loop, not the paper result.
        if (liveFillReverted({ entry, exit: paperExit, last })) continue;
        try {
          const res = await adapter.closePosition(acc, venueSymbol(venue, pos.symbol));
          if (!res.ok) continue;
        } catch {
          continue;
        }
      }
      const origPx = origStopPx({
        side,
        entry,
        sl: Number(pos.sl),
        origSl: pos.orig_sl,
        qty: pos.qty,
        risk: pos.risk_usd,
      });
      const until = walked.hit ? path.filter((b) => b.time <= walked.hit!.barTime) : path;
      const { maeR, mfeR } = pathExcursion({ side, entry, origSl: origPx, bars: until });
      const openMs = isLimitFill && Number.isFinite(openedMs) && openedMs > 0
        ? openedMs
        : Number.isFinite(barTime) && barTime > 0
          ? barTime
          : openedMs;
      const closeMs = walked.hit?.barTime ?? Date.now();
      const holdMs = Math.max(0, closeMs - openMs);
      let exit = walked.hit!.exit;
      if (!livePos && !walked.hit?.liquidated && reason !== "tp") {
        const closeSlipBps = paperSlippageBps({
          entry: exit,
          atr: pos.atr_at_entry ?? undefined,
          kind: reason === "be" ? "be_exit" : "sl_exit",
        });
        exit = applyPaperSlippage(exit, side, "close", closeSlipBps);
      }
      const settled = netClosePnl({
        side,
        entry,
        exit,
        qty: Number(pos.qty),
        riskUsd: Number(pos.risk_usd),
        openFee: Number(pos.fees_usd),
        closeFeeBps: !livePos
          ? reason === "tp" && !walked.hit?.liquidated
            ? PAPER_MAKER_BPS
            : PAPER_TAKER_BPS
          : FEE_BPS,
        fundingUsd: !livePos ? estimatePaperFundingUsd(Number(pos.notional_usd), holdMs) : 0,
      });
      let pnl = settled.pnl;
      let pnlR = settled.pnlR;
      let fees = settled.fees;
      if (live && adapter && pos.mode === "live") {
        const resolved = await resolveLiveExit(adapter, acc, venue, pos, exit);
        exit = resolved.exit;
        pnl = resolved.pnl;
        pnlR = resolved.pnlR;
        fees = resolved.fees;
      }
      await closePosition(pos.id, exit, why, pnl, pnlR, {
        maeR,
        mfeR,
        barsHeld: walked.barsHeld,
        holdMs,
        beMoved: walked.beMoved,
        feesUsd: fees,
      });
      if (live && pos.mode === "live") {
        /* equity comes from the venue wallet, not the paper delta */
      } else {
        equity += pnl;
        await bumpEquity(pnl);
      }
      closed += 1;
    }
  }

  let venueBook: Array<{ symbol: string; side: "long" | "short"; qty: number }> | null = null;
  let walletAfterClose = false;
  if (live && adapter) {
    try {
      const exPos = await adapter.fetchPositions(acc);
      venueBook = exPos;
      liveBookReady = true;
      const still = await listOpenPositions();
      for (const pos of still) {
        if (pos.mode !== "live") continue;
        if (pos.venue && pos.venue !== "paper" && bookVenue(pos.venue) !== venue) continue;
        const age = Date.now() - new Date(pos.opened_at).getTime();
        if (age < 45_000) continue;
        const onEx = exPos.some((p) => sameCoin(p.symbol, pos.symbol) || sameCoin(p.symbol, venueSymbol(venue, pos.symbol)));
        if (onEx) continue;
        let exitPx = Number(pos.entry);
        try {
          const last = await fetchVenueLastPrice(venue, pos.symbol);
          if (Number.isFinite(last)) exitPx = last;
        } catch {
          /* keep entry */
        }
        const resolved = await resolveLiveExit(adapter, acc, venue, pos, exitPx);
        const holdMs = Math.max(0, Date.now() - new Date(pos.opened_at).getTime());
        await closePosition(pos.id, resolved.exit, "venue", resolved.pnl, resolved.pnlR, {
          holdMs,
          beMoved: false,
          feesUsd: resolved.fees,
        });
        closed += 1;
      }
    } catch {
      liveBookReady = false;
      /* venue read failed — keep desk rows, do not treat as all-flat */
    }
    if (liveBalReady) {
      try {
        const w = await withTimeout(readVenueWallet(adapter, acc), 5000);
        if (w) {
          equity = w.equity;
          available = w.available;
          await setEquity(equity);
          walletAfterClose = true;
        }
      } catch {
        /* keep last live wallet */
      }
    }
  }

  const stillOpen = await listOpenPositions();
  const held = coinsHeld(
    stillOpen.map((p) => p.symbol),
    venueBook?.map((p) => p.symbol),
  );
  const filledBars = new Set<string>();
  try {
    const recent = await listBarFills(Date.now() - TF_MS["4h"] * 2);
    for (const row of recent) {
      filledBars.add(barFillKey(row.symbol, row.timeframe, Number(row.bar_time)));
    }
  } catch {
    for (const p of stillOpen) {
      if (p.bar_time) filledBars.add(barFillKey(p.symbol, p.timeframe, Number(p.bar_time)));
    }
  }
  usedMargin = usedMarginUsd(stillOpen);
  if (!walletAfterClose) {
    available = Math.max(0, equity - usedMargin);
  }

  const nowMs = Date.now();
  const entryMode = parseEntryMode(settings.entry_mode);
  const safeLimitMode = settings.safe_limit_mode == null ? true : Boolean(Number(settings.safe_limit_mode));
  const maxPos = clampMaxPositions(settings.max_positions);
  const htfMax = clampHtfMaxPositions(settings.htf_max_positions);
  let openCount = concurrentOpenCount(stillOpen.length, venueBook?.length ?? 0);
  let htfOpen = countHtfOpen(stillOpen.map((p) => p.timeframe));
  const openLevs = stillOpen.map((p) => Number(p.leverage) || 0);
  const engineGates = parseEngineGates(settings.engine_gates);
  const sideGates = parseSideGates(settings.engine_gates);
  const pendingTelegram: TelegramSignal[] = [];

  const pendingOrders = await listPendingLimitOrders();
  const resolvedPendingIds = new Set<number>();

  async function cancelPendingRow(o: LimitOrderRow, reason: string) {
    if (o.mode === "live" && live && adapter?.cancelOrder && o.exchange_order_id) {
      try {
        await withTimeout(
          adapter.cancelOrder(acc, {
            symbol: venueSymbol(venue, o.symbol),
            orderId: o.exchange_order_id,
          }),
          5000,
        );
      } catch {
        /* best-effort venue cancel */
      }
    }
    await cancelLimitOrder(o.id, reason);
  }

  async function cancelRemainingPending(reason: string) {
    for (const rem of pendingOrders) {
      if (resolvedPendingIds.has(rem.id)) continue;
      resolvedPendingIds.add(rem.id);
      await cancelPendingRow(rem, reason);
    }
  }

  if (pendingOrders.length) {
    if (openCount >= maxPos) {
      await cancelRemainingPending("max positions reached");
    } else {
      let liveOpenOrders: VenueOpenOrder[] | null = null;
      const livePendingOrders = pendingOrders.filter((o) => o.mode === "live");
      if (live && adapter?.fetchOpenOrders && livePendingOrders.length) {
        const livePendingSyms = [...new Set(livePendingOrders.map((o) => venueSymbol(venue, o.symbol)))];
        try {
          if (livePendingSyms.length === 1) {
            liveOpenOrders = await withTimeout(adapter.fetchOpenOrders(acc, livePendingSyms[0]), 5000);
          } else if (livePendingSyms.length <= 6) {
            const perSym = await withTimeout(
              Promise.all(livePendingSyms.map((vs) => adapter.fetchOpenOrders!(acc, vs))),
              6000,
            );
            liveOpenOrders = perSym.flat();
          } else {
            liveOpenOrders = await withTimeout(adapter.fetchOpenOrders(acc), 6000);
          }
        } catch {
          liveOpenOrders = null;
        }
      }

      const pendingNeed = new Set<string>();
      for (const o of pendingOrders) {
        const tf = (o.timeframe as Timeframe) in TF_MS ? (o.timeframe as Timeframe) : "5m";
        pendingNeed.add(`${o.symbol}|${tf}`);
        pendingNeed.add(`${o.symbol}|${HTF_OF[tf]}`);
        pendingNeed.add(`${o.symbol}|${HTF2_OF[tf]}`);
      }
      const pendingBarsMap = new Map<string, ReturnType<typeof onlyClosedBars>>();
      await mapPool([...pendingNeed], 6, async (key) => {
        const [sym, rawTf] = key.split("|") as [string, KlineTf];
        const limit = rawTf === "1d" || rawTf === "1w" ? 80 : SCAN_BARS;
        try {
          const bars = await fetchKlinesCached(sym, rawTf, limit, venue);
          pendingBarsMap.set(key, onlyClosedBars(bars, rawTf));
        } catch {
          pendingBarsMap.set(key, []);
        }
      });

      for (const o of pendingOrders) {
        if (resolvedPendingIds.has(o.id)) continue;
        if (openCount >= maxPos) {
          await cancelRemainingPending("max positions reached");
          break;
        }
        const tf = (o.timeframe as Timeframe) in TF_MS ? (o.timeframe as Timeframe) : "5m";
        const coin = fillCoin(o.symbol);
        const side = o.side === "short" ? ("short" as const) : ("long" as const);

        if (o.mode === "live") {
          if (!live || !adapter) continue;
          if (o.venue && o.venue !== "paper" && bookVenue(o.venue) !== venue) continue;
          const vs = venueSymbol(venue, o.symbol);
          const venueHit = venueBook?.find((p) => sameCoin(p.symbol, o.symbol) || sameCoin(p.symbol, vs));
          if (venueHit && !stillOpen.some((p) => sameCoin(p.symbol, o.symbol))) {
            const htfFull = isHtfTf(tf) && htfMax > 0 && htfOpen >= htfMax;
            if (openCount >= maxPos || htfFull) {
              await adapter.closePosition(acc, vs).catch(() => undefined);
              resolvedPendingIds.add(o.id);
              await cancelLimitOrder(o.id, openCount >= maxPos ? "max positions reached" : "htf cap reached");
              continue;
            }
            let liveEntry = Number(o.entry);
            let liveQty = Number(o.qty);
            let liveLev = Number(o.leverage) || 1;
            try {
              const book = await adapter.fetchPositions(acc);
              const hit = book.find((p) => sameCoin(p.symbol, o.symbol) || sameCoin(p.symbol, vs));
              if (hit) {
                if (hit.entry > 0) liveEntry = hit.entry;
                if (hit.qty > 0) liveQty = hit.qty;
                if (hit.leverage > 0) liveLev = hit.leverage;
              }
            } catch {
              /* use order numbers */
            }
            const rebased = rebaseStopsFromFill({
              paperEntry: Number(o.entry),
              fill: liveEntry,
              sl: Number(o.sl),
              tp: Number(o.tp),
            });
            const prot: ProtectionSnapshot = await adapter.fetchProtection(acc, { symbol: vs, sl: rebased.sl, tp: rebased.tp }).catch(() => ({
              onVenue: true,
              hasSl: false,
              hasTp: false,
              unknown: true,
            }));
            let fillConfirm: PlaceOrderResult | null = null;
            if (prot.unknown || !prot.hasSl || !prot.hasTp) {
              await adapter
                .updateStop(acc, { symbol: vs, side, sl: rebased.sl, tp: rebased.tp, qty: liveQty })
                .catch(() => undefined);
              fillConfirm = await confirmLiveFill(adapter, acc, vs, rebased.sl, rebased.tp, o.exchange_order_id ?? undefined);
            }
            const fillNotional = liveQty * liveEntry;
            const fillMargin = fillNotional / Math.max(1, liveLev);
            const fillRisk = liveQty * Math.abs(liveEntry - rebased.sl);
            const fillFees = (fillNotional * FEE_BPS) / 10000;
            const fillBarTime = latestClosedOpen(TF_MS[tf], nowMs);
            const orphan = Boolean(fillConfirm && !fillConfirm.ok && fillConfirm.liveOpen);
            if (fillConfirm && !fillConfirm.ok && !fillConfirm.liveOpen) {
              resolvedPendingIds.add(o.id);
              await cancelLimitOrder(o.id, "venue cancelled");
              continue;
            }
            const posId = await insertPosition({
              mode: "live",
              venue,
              symbol: o.symbol,
              timeframe: tf,
              indicator: o.indicator,
              side,
              entry: liveEntry,
              sl: rebased.sl,
              tp: rebased.tp,
              qty: liveQty,
              leverage: liveLev,
              notional: fillNotional,
              risk: fillRisk,
              fees: fillFees,
              orderId: o.exchange_order_id ?? undefined,
              barTime: fillBarTime,
              origSl: rebased.sl,
              atr: o.atr ?? undefined,
              equityAtOpen: equity,
              rrPlanned: Number(o.rr),
              margin: fillMargin,
              signalReason: orphan ? `${o.reason ?? ""} · ${ORPHAN_MARK}` : o.reason ?? "",
            });
            resolvedPendingIds.add(o.id);
            await markLimitOrderFilled(o.id);
            if (posId) {
              openCount += 1;
              opened += 1;
              if (isHtfTf(tf)) htfOpen += 1;
              held.add(coin);
              filledBars.add(barFillKey(o.symbol, tf, fillBarTime));
              openLevs.push(liveLev);
              usedMargin += fillMargin;
              available = Math.max(0, available - fillMargin);
              const saved = await insertSignal({
                barTime: fillBarTime,
                symbol: o.symbol,
                timeframe: tf,
                indicator: o.indicator,
                side,
                entry: liveEntry,
                sl: rebased.sl,
                tp: rebased.tp,
                rr: Number(o.rr),
                atr: o.atr ?? 0,
                reason: `${o.reason ?? ""} · limit fill`,
                taken: true,
              }).catch(() => ({ id: 0, created: false }));
              if (saved.created) {
                pendingTelegram.push({
                  symbol: o.symbol,
                  timeframe: tf,
                  indicator: o.indicator,
                  side,
                  entry: liveEntry,
                  sl: rebased.sl,
                  tp: rebased.tp,
                  rr: Number(o.rr),
                  reason: `${o.reason ?? ""} · limit fill`,
                  taken: true,
                  skip: "",
                });
              }
              if (openCount >= maxPos) {
                await cancelRemainingPending("max positions reached");
                break;
              }
            }
            continue;
          }
          if (liveBookReady && liveOpenOrders != null && o.exchange_order_id) {
            const stillResting = liveOpenOrders.some(
              (ord) =>
                ord.orderId === o.exchange_order_id ||
                sameCoin(ord.symbol, o.symbol) ||
                sameCoin(ord.symbol, vs),
            );
            if (!stillResting) {
              resolvedPendingIds.add(o.id);
              await cancelLimitOrder(o.id, "venue cancelled");
              continue;
            }
          }
        }

        const bars = pendingBarsMap.get(`${o.symbol}|${tf}`) ?? [];
        const htfBars = pendingBarsMap.get(`${o.symbol}|${HTF_OF[tf]}`) ?? [];
        const htf2Bars = pendingBarsMap.get(`${o.symbol}|${HTF2_OF[tf]}`) ?? [];
        let currentArmed: ArmedSetup | null | undefined = undefined;
        let currentPreArmed: PreArmedSetup | null | undefined = undefined;
        const preArmOrder = isPreArmReason(o.reason);
        if (bars.length >= MIN_BARS) {
          try {
            const htfOpt = htfBars.length > 20 ? htfBars : undefined;
            const htf2Opt = htf2Bars.length > 10 ? htf2Bars : undefined;
            const res = runIndicator(
              bars,
              tf,
              o.indicator as IndicatorName,
              htfOpt,
              htf2Opt,
            );
            currentArmed = res.armedSetup ?? null;
            if (preArmOrder) {
              if (currentArmed && currentArmed.side === side) {
                currentPreArmed = null;
              } else {
                currentPreArmed = findPreArmedSetup(
                  bars,
                  tf,
                  o.indicator as IndicatorName,
                  htfOpt,
                  htf2Opt,
                );
              }
            }
          } catch {
            currentArmed = undefined;
            currentPreArmed = undefined;
          }
        }
        const gateMuted =
          !isEngineOn(engineGates, o.indicator as IndicatorName, tf) ||
          !isSideOn(sideGates, o.indicator, side);
        const evalRes = evaluatePendingLimit({
          order: {
            symbol: o.symbol,
            timeframe: tf,
            indicator: o.indicator as IndicatorName,
            side,
            entry: Number(o.entry),
            sl: Number(o.sl),
            tp: Number(o.tp),
            rr: Number(o.rr),
            beAtR: o.be_at_r,
            armedBarTime: Number(o.armed_bar_time),
            ftcWait: Number(o.ftc_wait) || 8,
            reason: o.reason,
          },
          closedBars: bars,
          ttlBars: resolveLimitTtlBars(settings.limit_ttl_bars, o.ftc_wait),
          gateMuted,
          capReached: openCount >= maxPos,
          htfCapReached: htfMax > 0 && htfOpen >= htfMax,
          duplicateHeld: held.has(coin),
          currentArmed,
          currentPreArmed,
        });

        if (evalRes.action === "cancel") {
          resolvedPendingIds.add(o.id);
          await cancelPendingRow(o, evalRes.cancelReason);
          continue;
        }

        if (evalRes.action === "fill" && o.mode !== "live") {
          const fillMargin = Number(o.margin_usd) || 0;
          if (openCount >= maxPos) {
            resolvedPendingIds.add(o.id);
            await cancelRemainingPending("max positions reached");
            break;
          }
          if (held.has(coin)) {
            resolvedPendingIds.add(o.id);
            await cancelLimitOrder(o.id, "duplicate symbol");
            continue;
          }
          if (isHtfTf(tf) && htfMax > 0 && htfOpen >= htfMax) {
            resolvedPendingIds.add(o.id);
            await cancelLimitOrder(o.id, "htf cap reached");
            continue;
          }
          if (available <= 0) {
            resolvedPendingIds.add(o.id);
            await cancelLimitOrder(o.id, "max positions reached");
            continue;
          }
          const fillNotional = Number(o.notional_usd) || Number(o.qty) * evalRes.fillPrice;
          if (fillNotional < PAPER_MIN_NOTIONAL_USD) {
            resolvedPendingIds.add(o.id);
            await cancelLimitOrder(o.id, "pattern failed");
            continue;
          }
          // Resolve exact 5m fill bar so HTF limit fills start 5m SL/TP checks right after the touch.
          let fill5mTime: number | null = null;
          try {
            const raw5m = lastBars.get(o.symbol) ?? (await fetchKlinesCached(o.symbol, "5m", SCAN_BARS, venue));
            const closed5mBars = onlyClosedBars(raw5m, "5m");
            fill5mTime = resolveLimitFill5mTime({
              bars5m: closed5mBars,
              fillBarTime: evalRes.fillBarTime,
              tfMs: TF_MS[tf],
              side,
              entry: evalRes.fillPrice,
              sl: Number(o.sl),
            });
          } catch {
            fill5mTime = null;
          }
          const fillFees = estimatePaperFee(fillNotional, PAPER_MAKER_BPS);
          const posId = await insertPosition({
            mode: "paper",
            venue: "paper",
            symbol: o.symbol,
            timeframe: tf,
            indicator: o.indicator,
            side,
            entry: evalRes.fillPrice,
            sl: Number(o.sl),
            tp: Number(o.tp),
            qty: Number(o.qty),
            leverage: Number(o.leverage) || 1,
            notional: fillNotional,
            risk: Number(o.risk_usd) || Number(o.qty) * Math.abs(evalRes.fillPrice - Number(o.sl)),
            fees: fillFees,
            barTime: evalRes.fillBarTime,
            openedAt: fill5mTime ? new Date(fill5mTime).toISOString() : undefined,
            origSl: Number(o.sl),
            atr: o.atr ?? undefined,
            equityAtOpen: equity,
            rrPlanned: Number(o.rr),
            margin: fillMargin,
            signalReason: `${o.reason ?? ""} · FTC limit fill`,
          });
          resolvedPendingIds.add(o.id);
          if (posId) {
            await markLimitOrderFilled(o.id);
            openCount += 1;
            opened += 1;
            if (isHtfTf(tf)) htfOpen += 1;
            held.add(coin);
            filledBars.add(barFillKey(o.symbol, tf, evalRes.fillBarTime));
            openLevs.push(Number(o.leverage) || 1);
            usedMargin += fillMargin;
            available = Math.max(0, available - fillMargin);
            const saved = await insertSignal({
              barTime: evalRes.fillBarTime,
              symbol: o.symbol,
              timeframe: tf,
              indicator: o.indicator,
              side,
              entry: evalRes.fillPrice,
              sl: Number(o.sl),
              tp: Number(o.tp),
              rr: Number(o.rr),
              atr: o.atr ?? 0,
              reason: `${o.reason ?? ""} · FTC limit fill`,
              taken: true,
            }).catch(() => ({ id: 0, created: false }));
            if (saved.created) {
              pendingTelegram.push({
                symbol: o.symbol,
                timeframe: tf,
                indicator: o.indicator,
                side,
                entry: evalRes.fillPrice,
                sl: Number(o.sl),
                tp: Number(o.tp),
                rr: Number(o.rr),
                reason: `${o.reason ?? ""} · FTC limit fill`,
                taken: true,
                skip: "",
              });
            }
            if (openCount >= maxPos) {
              await cancelRemainingPending("max positions reached");
              break;
            }
          } else {
            await cancelLimitOrder(o.id, "duplicate symbol");
          }
        }
      }
    }
  }

  const scanDone = {
    "5m": Number(settings.scan_done_5m) || 0,
    "15m": Number(settings.scan_done_15m) || 0,
    "1h": Number(settings.scan_done_1h) || 0,
    "4h": Number(settings.scan_done_4h) || 0,
  };
  const tfs = dueTimeframes(nowMs, scanDone, opts.source);
  if (!tfs.length) {
    if (pendingTelegram.length) {
      await notifySignalsTelegram(settings, venue, pendingTelegram).catch(() => undefined);
    }
    if (opened > 0 || closed > 0) {
      await snapshotEquity(equity, (await listOpenPositions()).length, settings.mode).catch(() => undefined);
    }
    await touchTick(opts.source);
    return {
      ok: true,
      skipped: true,
      reason: "waiting for next closed bar",
      scanned: 0,
      signals: 0,
      opened,
      closed,
      durationMs: Date.now() - t0,
      coins: 0,
      universe: universe.length,
      tfs,
      public: publicSettings(await getSettings()),
    };
  }

  const tradeable = universe;
  const batch = resolveBatch(opts?.batch ?? Number(settings.scan_batch), tradeable.length);
  const closed5m = latestClosedOpen(TF_MS["5m"], nowMs);
  const cursors = parseCursors(settings.scan_cursors);
  if (!settings.scan_cursors) {
    const legacy = Number(settings.scan_cursor) || 0;
    const epoch = Number(settings.scan_epoch_ms) || 0;
    cursors["5m"] = { c: legacy, e: epoch };
  }
  type TfWork = { tf: Timeframe; closedOpen: number; cur: number; slice: typeof tradeable; done: boolean[] };
  const tfWork: TfWork[] = tfs.map((tf) => {
    const closedOpen = latestClosedOpen(TF_MS[tf], nowMs);
    const saved = cursors[tf] ?? { c: 0, e: 0 };
    const cur = saved.e !== closedOpen && closedOpen > 0 ? 0 : saved.c;
    const slice: typeof tradeable = [];
    const n = Math.min(batch, tradeable.length);
    for (let k = 0; k < n; k++) slice.push(tradeable[(cur + k) % Math.max(1, tradeable.length)]!);
    return { tf, closedOpen, cur, slice, done: slice.map(() => false) };
  });
  const planned = new Map<string, Timeframe[]>();
  const slice: typeof tradeable = [];
  const tagged = tfWork.map((w) => w.slice.map((a) => ({ a, tf: w.tf })));
  for (const row of interleaveSlices(tagged)) {
    const list = planned.get(row.a.symbol);
    if (list) {
      if (!list.includes(row.tf)) list.push(row.tf);
    } else {
      planned.set(row.a.symbol, [row.tf]);
      slice.push(row.a);
    }
  }

  type Found = {
    symbol: string;
    timeframe: Timeframe;
    indicator: string;
    side: "long" | "short";
    entry: number;
    sl: number;
    tp: number;
    rr: number;
    atr: number;
    reason: string;
    barTime: number;
  };
  type FoundArmed = ArmedSetup & {
    symbol: string;
    timeframe: Timeframe;
    lastClosedBarTime: number;
    phase?: "pre-arm";
    matchTolerance?: number;
  };
  const found: Found[] = [];
  const foundArmed: FoundArmed[] = [];
  const foundPreArmed: FoundArmed[] = [];
  const seenSig = new Set<string>();
  const seenArmed = new Set<string>();
  const deadline = t0 + tickBudgetMs();
  let scannedCoins = 0;
  let tried = 0;
  const lastN = scanLastN(opts.source);
  const finished = new Set<string>();

  if (Date.now() + 1_500 < deadline) {
  await mapPool(slice, SCAN_CONCURRENCY, async (asset) => {
    if (Date.now() > deadline) return;
    tried += 1;
    try {
    const tfsHere = planned.get(asset.symbol) ?? tfs;
    const need = new Set<KlineTf>(tfsHere);
    for (const tf of tfsHere) {
      need.add(HTF_OF[tf]);
      need.add(HTF2_OF[tf]);
    }
    const loaded = new Map<KlineTf, Awaited<ReturnType<typeof fetchKlinesCached>>>();
    await Promise.all(
      [...need].map(async (tf) => {
        const limit = tf === "1d" || tf === "1w" ? 80 : SCAN_BARS;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const bars = await fetchKlinesCached(asset.symbol, tf, limit, venue);
            if (bars.length) {
              loaded.set(tf, bars);
              return;
            }
          } catch {
            /* retry once — empty is not cached */
          }
        }
        loaded.set(tf, []);
      }),
    );
    let any = false;
    const scannedTf = new Set<Timeframe>();
    for (const tf of tfsHere) {
      const raw = loaded.get(tf) ?? [];
      const closedBars = onlyClosedBars(raw, tf);
      if (closedBars.length < MIN_BARS) {
        if (raw.length) scannedTf.add(tf);
        continue;
      }
      scannedTf.add(tf);
      const htfTf = HTF_OF[tf];
      const htf2Tf = HTF2_OF[tf];
      const htfClosed = onlyClosedBars(loaded.get(htfTf) ?? [], htfTf);
      const htf2Closed = onlyClosedBars(loaded.get(htf2Tf) ?? [], htf2Tf);
      scanned += 1;
      any = true;
      const names = scanNames(tf, engineGates);
      if (entryMode === "limit") {
        const htfOpt = htfClosed.length > 20 ? htfClosed : undefined;
        const htf2Opt = htf2Closed.length > 10 ? htf2Closed : undefined;
        const armedList = scanArmedClosed(closedBars, tf, htfOpt, htf2Opt, names);
        const preArmedList = scanPreArmedClosed(closedBars, tf, htfOpt, htf2Opt, names);
        const lastClosedBarTime = closedBars[closedBars.length - 1]!.time;
        const armedIndHere = new Set<string>();
        for (const a of armedList) {
          armedIndHere.add(a.indicator);
          const key = `${asset.symbol}|${tf}|${a.indicator}|${a.armedBarTime}`;
          if (seenArmed.has(key)) continue;
          seenArmed.add(key);
          foundArmed.push({ ...a, symbol: asset.symbol, timeframe: tf, lastClosedBarTime });
        }
        for (const pre of preArmedList) {
          if (armedIndHere.has(pre.indicator)) continue;
          const key = `${asset.symbol}|${tf}|${pre.indicator}|${pre.armedBarTime}`;
          if (seenArmed.has(key)) continue;
          seenArmed.add(key);
          foundPreArmed.push({
            ...pre,
            symbol: asset.symbol,
            timeframe: tf,
            lastClosedBarTime,
            phase: "pre-arm",
            matchTolerance: pre.matchTolerance,
          });
        }
      } else {
        const sigs = scanBarClosed(
          closedBars,
          tf,
          htfClosed.length > 20 ? htfClosed : undefined,
          lastN,
          htf2Closed.length > 10 ? htf2Closed : undefined,
          names,
        );
        for (const s of sigs) {
          const key = `${asset.symbol}|${tf}|${s.indicator}|${s.barTime}`;
          if (seenSig.has(key)) continue;
          seenSig.add(key);
          found.push({
            symbol: asset.symbol,
            timeframe: tf,
            indicator: s.indicator,
            side: s.side,
            entry: s.entry,
            sl: s.sl,
            tp: s.tp,
            rr: s.rr,
            atr: s.atr,
            reason: s.reason,
            barTime: s.barTime,
          });
        }
      }
    }
    if (any) scannedCoins += 1;
    finished.add(asset.symbol);
    for (const work of tfWork) {
      const idx = work.slice.findIndex((a) => a.symbol === asset.symbol);
      if (idx >= 0 && scannedTf.has(work.tf)) work.done[idx] = true;
    }
    } catch {
      /* timeout/kline throw: leave done=false so the next ping retries this coin */
    }
  });
  }
  const scanIncomplete = Boolean(slice.length) && finished.size < slice.length;
  if (tradeable.length && slice.length) {
    const nextCursors: Record<string, TfCursor> = { ...cursors };
    const done: { "5m"?: number; "15m"?: number; "1h"?: number; "4h"?: number } = {};
    let next = Number(settings.scan_cursor) || 0;
    for (const work of tfWork) {
      const prefix = prefixCompleted(work.done);
      const stepped = nextTfCursor({
        cur: work.cur,
        epoch: work.closedOpen,
        closedOpen: work.closedOpen,
        universeLen: tradeable.length,
        prefixDone: prefix,
      });
      nextCursors[work.tf] = stepped.cursor;
      if (work.tf === "5m") next = stepped.cursor.c;
      if (stepped.wrapped) done[work.tf] = work.closedOpen;
    }
    try {
      await markScanProgress({
        cursor: next,
        epochMs: closed5m,
        cursors: nextCursors,
        done: Object.keys(done).length ? done : undefined,
      });
    } catch {
      await setScanCursor(next);
    }
  }

  const queuedCandidates = foundArmed.length || foundPreArmed.length ? [...foundArmed, ...foundPreArmed] : [];
  signals = entryMode === "limit" ? queuedCandidates.length : found.length;
  const remainingSlots = Math.max(0, maxPos - openCount);
  let used = 0;
  const capitalPctDefault = Number(settings.capital_pct) || DEFAULT_CAPITAL_PCT;
  const capitalBase = parseCapitalBase(settings.capital_base);
  const levSizeTiers = parseLevSizeTiers(settings.lev_size_tiers);
  const userLevCap = Math.min(200, Math.max(1, Math.round(Number(settings.max_leverage) || 200)));
  const rawStackCount = Number(settings.stack_lev_count);
  const stackCount = Number.isFinite(rawStackCount) ? Math.max(0, Math.round(rawStackCount)) : 2;
  const stackCap = Math.min(200, Math.max(1, Math.round(Number(settings.stack_lev_cap) || 75)));
  const levMemo = new Map<string, number>();

  async function coinMaxLev(sym: string) {
    let n = levMemo.get(sym);
    if (!n) {
      n = capLeverage(await resolveMaxLeverage(venue, venue === "paper" ? sym : venueSymbol(venue, sym), acc));
      levMemo.set(sym, n);
    }
    return n;
  }

  if (entryMode === "limit" && queuedCandidates.length) {
    const activeAfterRecon = await listPendingLimitOrders();
    const recentCancelledLimits = foundPreArmed.length ? await listRecentLimitOrders(80).catch(() => []) : [];
    const pendingCoins = coinsOf(activeAfterRecon.map((o) => o.symbol));
    let pendingCount = activeAfterRecon.length;
    let htfPendingCount = countHtfOpen(activeAfterRecon.map((o) => o.timeframe));
    let reservedPendingMargin = activeAfterRecon.reduce((accM, o) => accM + Math.max(0, Number(o.margin_usd) || 0), 0);

    for (const armed of queuedCandidates) {
      const coin = fillCoin(armed.symbol);
      const ttlBars = resolveLimitTtlBars(settings.limit_ttl_bars, armed.ftcWait);
      const barsSinceArm = Math.max(0, Math.round((armed.lastClosedBarTime - armed.armedBarTime) / TF_MS[armed.timeframe]));
      if (barsSinceArm >= ttlBars) continue;
      if (armed.phase === "pre-arm" && recentCancelledLimits.length) {
        const cooldownMs = ttlBars * TF_MS[armed.timeframe];
        const recentlyStoppedSameLevel = recentCancelledLimits.some((r) => {
          if (r.status !== "cancelled" || !isPreArmReason(r.reason)) return false;
          if (
            r.symbol !== armed.symbol ||
            r.timeframe !== armed.timeframe ||
            r.indicator !== armed.indicator ||
            r.side !== armed.side
          ) {
            return false;
          }
          if (
            r.cancel_reason !== "queue expired" &&
            r.cancel_reason !== "pattern failed" &&
            r.cancel_reason !== "sl engulfed" &&
            r.cancel_reason !== "target reached without RTP"
          ) {
            return false;
          }
          const closedMs = r.closed_at ? Date.parse(r.closed_at) : Date.parse(r.updated_at);
          if (!Number.isFinite(closedMs) || nowMs - closedMs > cooldownMs) return false;
          return preArmMatchesOrder(Number(r.entry), {
            entry: armed.entry,
            matchTolerance: armed.matchTolerance ?? armed.entry * 0.002,
          });
        });
        if (recentlyStoppedSameLevel) continue;
      }

      const gateCheck = canQueueLimitOrder({
        safeLimitMode,
        maxPositions: settings.max_positions,
        htfMaxPositions: settings.htf_max_positions,
        timeframe: armed.timeframe,
        coin,
        heldCoins: held,
        pendingCoins,
        openCount,
        pendingCount,
        htfOpenCount: htfOpen,
        htfPendingCount,
        sideOn: isSideOn(sideGates, armed.indicator, armed.side),
        side: armed.side,
        entry: armed.entry,
        sl: armed.sl,
        tp: armed.tp,
      });
      if (!gateCheck.ok) continue;

      if (filledBars.has(barFillKey(armed.symbol, armed.timeframe, armed.armedBarTime))) continue;
      if (
        await alreadyFilled({
          symbol: armed.symbol,
          timeframe: armed.timeframe,
          indicator: armed.indicator,
          side: armed.side,
          entry: armed.entry,
          barTime: armed.armedBarTime,
        })
      ) {
        continue;
      }
      if (live && (!liveBalReady || !liveBookReady)) continue;
      if (liveBlock) continue;

      if (live && adapter && liveBalReady) {
        try {
          const w = await withTimeout(readVenueWallet(adapter, acc), 5000);
          if (w) {
            equity = w.equity;
            available = Math.min(available, w.available);
          }
        } catch {
          /* keep last free cash */
        }
      }

      const sizingAvail = safeLimitMode ? Math.max(0, available - reservedPendingMargin) : available;
      if (sizingAvail <= 0) continue;

      const coinMax = await coinMaxLev(armed.symbol);
      const lev = Math.min(stackedUserLevCap(userLevCap, openLevs, stackCount, stackCap), coinMax);
      const capitalPct = capitalPctForLeverage(coinMax, capitalPctDefault, levSizeTiers);
      const sized = sizePosition({
        equity,
        capitalPct,
        entry: armed.entry,
        sl: armed.sl,
        leverage: lev,
        usedMargin,
        available: sizingAvail,
        capitalBase,
        minNotionalUsd: live ? 0 : PAPER_MIN_NOTIONAL_USD,
        feeBps: PAPER_MAKER_BPS,
      });
      if (!sized) continue;

      if (live && adapter) {
        if (!hasLiveKeys(settings, venue)) continue;
        if (!(await heartbeatTickLock(opts.lock))) continue;
        try {
          const liveLast = await fetchVenueLastPrice(venue, armed.symbol);
          if (Number.isFinite(liveLast) && liveLast > 0) {
            const slBreachedNow = armed.side === "long" ? liveLast <= armed.sl : liveLast >= armed.sl;
            if (slBreachedNow) continue;
          }
        } catch {
          /* proceed */
        }

        if (!adapter.placeLimitOrder) continue;
        pendingCoins.add(coin);
        let placedOrderId: string | undefined;
        try {
          const vs = venueSymbol(venue, armed.symbol);
          const lmtRes = await adapter.placeLimitOrder(acc, {
            symbol: vs,
            side: armed.side,
            qty: sized.qty,
            leverage: lev,
            entry: armed.entry,
            sl: armed.sl,
            tp: armed.tp,
          });
          if (!lmtRes.ok) {
            pendingCoins.delete(coin);
            continue;
          }
          placedOrderId = lmtRes.orderId;
          if (lmtRes.filled) {
            let fillPx = lmtRes.fillPrice && lmtRes.fillPrice > 0 ? lmtRes.fillPrice : armed.entry;
            let fillQty = lmtRes.filledQty && lmtRes.filledQty > 0 ? lmtRes.filledQty : sized.qty;
            let fillLev = lev;
            try {
              const book = await adapter.fetchPositions(acc);
              const hit = book.find((p) => sameCoin(p.symbol, armed.symbol) || sameCoin(p.symbol, vs));
              if (hit) {
                if (hit.entry > 0) fillPx = hit.entry;
                if (hit.qty > 0) fillQty = hit.qty;
                if (hit.leverage > 0) fillLev = hit.leverage;
              }
            } catch {
              /* use limit response values */
            }
            const rebased = rebaseStopsFromFill({
              paperEntry: armed.entry,
              fill: fillPx,
              sl: lmtRes.sl && lmtRes.sl > 0 ? lmtRes.sl : armed.sl,
              tp: lmtRes.tp && lmtRes.tp > 0 ? lmtRes.tp : armed.tp,
            });
            const fillSl = rebased.sl;
            const fillTp = rebased.tp;
            const fillNotional = fillQty * fillPx;
            const fillMargin = fillNotional / Math.max(1, fillLev);
            if (leverageOverCap(fillLev, lev) || marginOverBudget(fillMargin, sized.margin)) {
              await adapter.closePosition(acc, vs).catch(() => undefined);
              pendingCoins.delete(coin);
              filledBars.add(barFillKey(armed.symbol, armed.timeframe, armed.armedBarTime));
              continue;
            }
            const pxRef = Math.max(1e-8, fillPx);
            const needStopRebase =
              Math.abs(fillSl - (lmtRes.sl ?? armed.sl)) / pxRef > 1e-4 ||
              Math.abs(fillTp - (lmtRes.tp ?? armed.tp)) / pxRef > 1e-4;
            if (needStopRebase) {
              await adapter
                .updateStop(acc, { symbol: vs, side: armed.side, sl: fillSl, tp: fillTp, qty: fillQty })
                .catch(() => undefined);
            }
            const confirmed = await confirmLiveFill(adapter, acc, vs, fillSl, fillTp, placedOrderId);
            if (!confirmed.ok && !confirmed.liveOpen) {
              pendingCoins.delete(coin);
              continue;
            }
            const orphanImmediate = Boolean(!confirmed.ok && confirmed.liveOpen);
            const fillRisk = fillQty * Math.abs(fillPx - fillSl);
            const posId = await insertPosition({
              mode: "live",
              venue,
              symbol: armed.symbol,
              timeframe: armed.timeframe,
              indicator: armed.indicator,
              side: armed.side,
              entry: fillPx,
              sl: fillSl,
              tp: fillTp,
              qty: fillQty,
              leverage: Math.min(fillLev, lev),
              notional: fillNotional,
              risk: fillRisk,
              fees: lmtRes.feeUsd ?? estimatePaperFee(fillNotional, PAPER_TAKER_BPS),
              orderId: placedOrderId,
              barTime: armed.lastClosedBarTime,
              origSl: fillSl,
              atr: armed.atr,
              equityAtOpen: equity,
              rrPlanned: armed.rr,
              margin: fillMargin,
              signalReason: orphanImmediate
                ? `${armed.reason} · FTC limit immediate fill · ${ORPHAN_MARK}`
                : `${armed.reason} · FTC limit immediate fill`,
            });
            pendingCoins.delete(coin);
            if (posId) {
              openCount += 1;
              opened += 1;
              if (isHtfTf(armed.timeframe)) htfOpen += 1;
              held.add(coin);
              filledBars.add(barFillKey(armed.symbol, armed.timeframe, armed.lastClosedBarTime));
              openLevs.push(Math.min(fillLev, lev));
              usedMargin += fillMargin;
              available = Math.max(0, available - fillMargin);
              const savedSig = await insertSignal({
                barTime: armed.lastClosedBarTime,
                symbol: armed.symbol,
                timeframe: armed.timeframe,
                indicator: armed.indicator,
                side: armed.side,
                entry: fillPx,
                sl: fillSl,
                tp: fillTp,
                rr: armed.rr,
                atr: armed.atr,
                reason: `${armed.reason} · FTC limit immediate fill`,
                taken: true,
              }).catch(() => ({ id: 0, created: false }));
              if (savedSig.created) {
                pendingTelegram.push({
                  symbol: armed.symbol,
                  timeframe: armed.timeframe,
                  indicator: armed.indicator,
                  side: armed.side,
                  entry: fillPx,
                  sl: fillSl,
                  tp: fillTp,
                  rr: armed.rr,
                  reason: `${armed.reason} · FTC limit immediate fill`,
                  taken: true,
                  skip: "",
                });
              }
              if (openCount >= maxPos) {
                const leftover = await listPendingLimitOrders();
                for (const rem of leftover) await cancelPendingRow(rem, "max positions reached");
                break;
              }
            }
            continue;
          }
        } catch {
          pendingCoins.delete(coin);
          continue;
        }

        const saved = await insertLimitOrder({
          mode: "live",
          venue,
          symbol: armed.symbol,
          timeframe: armed.timeframe,
          indicator: armed.indicator,
          side: armed.side,
          entry: armed.entry,
          sl: armed.sl,
          tp: armed.tp,
          rr: armed.rr,
          atr: armed.atr,
          beAtR: trexBeAtR(armed.indicator),
          qty: sized.qty,
          leverage: lev,
          notionalUsd: sized.notional,
          riskUsd: sized.risk,
          marginUsd: sized.margin,
          armedBarTime: armed.armedBarTime,
          ftcWait: armed.ftcWait,
          maxWaitBars: ttlBars,
          reason: armed.reason,
          exchangeOrderId: placedOrderId ?? null,
        });
        if (saved.created) {
          pendingCount += 1;
          if (isHtfTf(armed.timeframe)) htfPendingCount += 1;
          reservedPendingMargin += sized.margin;
          pendingTelegram.push({
            symbol: armed.symbol,
            timeframe: armed.timeframe,
            indicator: armed.indicator,
            side: armed.side,
            entry: armed.entry,
            sl: armed.sl,
            tp: armed.tp,
            rr: armed.rr,
            reason: armed.reason,
            taken: false,
            queued: true,
            skip: "",
          });
        } else {
          pendingCoins.delete(coin);
        }
        continue;
      }

      const saved = await insertLimitOrder({
        mode: "paper",
        venue: "paper",
        symbol: armed.symbol,
        timeframe: armed.timeframe,
        indicator: armed.indicator,
        side: armed.side,
        entry: armed.entry,
        sl: armed.sl,
        tp: armed.tp,
        rr: armed.rr,
        atr: armed.atr,
        beAtR: trexBeAtR(armed.indicator),
        qty: sized.qty,
        leverage: lev,
        notionalUsd: sized.notional,
        riskUsd: sized.risk,
        marginUsd: sized.margin,
        armedBarTime: armed.armedBarTime,
        ftcWait: armed.ftcWait,
        maxWaitBars: ttlBars,
        reason: armed.reason,
      });
      if (saved.created) {
        pendingCoins.add(coin);
        pendingCount += 1;
        if (isHtfTf(armed.timeframe)) htfPendingCount += 1;
        reservedPendingMargin += sized.margin;
        pendingTelegram.push({
          symbol: armed.symbol,
          timeframe: armed.timeframe,
          indicator: armed.indicator,
          side: armed.side,
          entry: armed.entry,
          sl: armed.sl,
          tp: armed.tp,
          rr: armed.rr,
          reason: armed.reason,
          taken: false,
          queued: true,
          skip: "",
        });
      }
    }
  }

  for (const s of found) {
    let taken = false;
    let skip = "";
    const coin = fillCoin(s.symbol);
    const barKey = barFillKey(s.symbol, s.timeframe, s.barTime);
    const stale = !isFreshSignal(s.barTime, s.timeframe, Date.now());
    skip = skipFill({
      stale,
      sideOn: isSideOn(sideGates, s.indicator, s.side),
      coin,
      barKey,
      held,
      filledBars,
      used,
      remaining: remainingSlots,
      htf: isHtfTf(s.timeframe),
      htfOpen,
      htfMax,
      liveUnread:
        live && (!liveBalReady || !liveBookReady)
          ? !liveBalReady
            ? "live balance unread — not sending"
            : "live positions unread — not sending"
          : "",
    });
    if (!skip && (await alreadyFilled({
      symbol: s.symbol,
      timeframe: s.timeframe,
      indicator: s.indicator,
      side: s.side,
      entry: s.entry,
      barTime: s.barTime,
    }))) {
      skip = "already filled";
      filledBars.add(barKey);
    }
    if (!skip) {
      if (live && adapter && liveBalReady) {
        try {
          const w = await withTimeout(readVenueWallet(adapter, acc), 5000);
          if (w) {
            equity = w.equity;
            available = Math.min(available, w.available);
          }
        } catch {
          /* keep the last free pile */
        }
      }
      const coinMax = await coinMaxLev(s.symbol);
      const lev = Math.min(stackedUserLevCap(userLevCap, openLevs, stackCount, stackCap), coinMax);
      // Bucket on the coin's venue max, not the used (user/stack-capped) leverage.
      const capitalPct = capitalPctForLeverage(coinMax, capitalPctDefault, levSizeTiers);
      const sized = sizePosition({
        equity,
        capitalPct,
        entry: s.entry,
        sl: s.sl,
        leverage: lev,
        usedMargin,
        available,
        capitalBase,
        minNotionalUsd: live ? 0 : PAPER_MIN_NOTIONAL_USD,
        feeBps: PAPER_TAKER_BPS,
      });
      if (!sized) skip = available <= 0 ? "no free capital" : "size failed";
      else {
        let orderId: string | undefined;
        let placedLive = false;
        let orphan = false;
        let liveFillPx = 0;
        let liveFillQty = 0;
        let liveFillSl = s.sl;
        let liveFillTp = s.tp;
        let liveFillFees = sized.fees;
        let liveStopsPlaced = false;
        let liveLevActual = 0;
        if (liveBlock) skip = liveBlock;
        else if (live) {
          const ad = getAdapter(venue);
          if (!ad) skip = "no adapter";
          else if (!hasLiveKeys(settings, venue)) skip = `${venue} keys missing`;
          else if (!(await heartbeatTickLock(opts.lock))) skip = "tick lock lost";
          else {
            held.add(coin);
            try {
              const res = await ad.placeOrder(acc, {
                symbol: venueSymbol(venue, s.symbol),
                side: s.side,
                qty: sized.qty,
                leverage: lev,
                sl: s.sl,
                tp: s.tp,
                entry: s.entry,
              });
              if (res.fillPrice && res.fillPrice > 0) liveFillPx = res.fillPrice;
              if (res.filledQty && res.filledQty > 0) liveFillQty = res.filledQty;
              if (res.sl && res.sl > 0) {
                liveFillSl = res.sl;
                liveStopsPlaced = true;
              }
              if (res.tp && res.tp > 0) {
                liveFillTp = res.tp;
                liveStopsPlaced = true;
              }
              if (res.feeUsd != null && Number.isFinite(res.feeUsd)) liveFillFees = res.feeUsd;
              let final = res;
              if (res.ok || res.liveOpen || res.orderId) {
                if (res.ok || (!res.liveOpen && res.orderId)) {
                  final = await confirmLiveFill(
                    ad,
                    acc,
                    venueSymbol(venue, s.symbol),
                    liveFillSl,
                    liveFillTp,
                    res.orderId,
                  );
                }
              }
              if (final.ok) {
                orderId = final.orderId ?? res.orderId;
                placedLive = true;
              } else if (final.liveOpen) {
                orderId = final.orderId ?? res.orderId;
                placedLive = true;
                orphan = true;
              } else {
                skip = final.message;
              }
            } catch (e) {
              skip = e instanceof Error ? e.message : "order threw";
              try {
                const vs = venueSymbol(venue, s.symbol);
                const prot = await ad.fetchProtection(acc, { symbol: vs, sl: liveFillSl, tp: liveFillTp });
                if (!prot.unknown && prot.onVenue) {
                  const check = await confirmLiveFill(ad, acc, vs, liveFillSl, liveFillTp);
                  if (check.ok) {
                    orderId = check.orderId;
                    placedLive = true;
                    skip = "";
                  } else if (check.liveOpen) {
                    orderId = check.orderId;
                    placedLive = true;
                    orphan = true;
                    skip = "";
                  } else {
                    skip = check.message;
                  }
                }
              } catch {
                /* keep skip; nothing confirmed on venue */
              }
            }
            if (!placedLive) held.delete(coin);
          }
        }
        if (placedLive && adapter) {
          try {
            const book = await adapter.fetchPositions(acc);
            const hit = book.find(
              (p) => sameCoin(p.symbol, s.symbol) || sameCoin(p.symbol, venueSymbol(venue, s.symbol)),
            );
            if (hit) {
              if (hit.entry > 0) liveFillPx = hit.entry;
              if (hit.qty > 0) liveFillQty = hit.qty;
              if (hit.leverage > 0) liveLevActual = hit.leverage;
            }
          } catch {
            /* keep order result */
          }
          if (liveFillPx > 0) {
            const rebased = rebaseStopsFromFill({
              paperEntry: s.entry,
              fill: liveFillPx,
              sl: s.sl,
              tp: s.tp,
            });
            const px = Math.max(1e-8, liveFillPx);
            const slDrift = Math.abs(rebased.sl - liveFillSl) / px;
            const tpDrift = Math.abs(rebased.tp - liveFillTp) / px;
            liveFillSl = rebased.sl;
            liveFillTp = rebased.tp;
            if (!liveStopsPlaced || slDrift > 1e-4 || tpDrift > 1e-4) {
              try {
                await adapter.updateStop(acc, {
                  symbol: venueSymbol(venue, s.symbol),
                  side: s.side,
                  sl: liveFillSl,
                  tp: liveFillTp,
                  qty: liveFillQty || sized.qty,
                });
                liveStopsPlaced = true;
              } catch {
                /* SL/TP already on book at fill prices (Aster rebases inside placeOrder) */
              }
            }
          }
        }
        if (!skip) {
          let fillEntry = liveFillPx > 0 ? liveFillPx : s.entry;
          let fillQty = liveFillQty > 0 ? liveFillQty : sized.qty;
          let fillSl = liveFillSl;
          let fillTp = liveFillTp;
          if (!live) {
            const openSlipBps = paperSlippageBps({ entry: s.entry, atr: s.atr, kind: "market_open" });
            fillEntry = applyPaperSlippage(s.entry, s.side, "open", openSlipBps);
            const paperRebased = rebaseStopsFromFill({ paperEntry: s.entry, fill: fillEntry, sl: s.sl, tp: s.tp });
            fillSl = paperRebased.sl;
            fillTp = paperRebased.tp;
            fillQty = sized.notional / fillEntry;
          }
          const fillNotional = fillQty * fillEntry;
          const fillLev = liveLevActual > 0 ? liveLevActual : lev;
          const fillMargin = fillNotional / Math.max(1, fillLev);
          const fillRisk = fillQty * Math.abs(fillEntry - fillSl);
          const fillFees = live
            ? liveFillPx > 0
              ? liveFillFees || (fillNotional * FEE_BPS) / 10000
              : sized.fees
            : estimatePaperFee(fillNotional, PAPER_TAKER_BPS);
          const fill = {
            mode: live ? "live" : "paper",
            venue: live ? venue : "paper",
            symbol: s.symbol,
            timeframe: s.timeframe,
            indicator: s.indicator,
            side: s.side,
            entry: fillEntry,
            sl: fillSl,
            tp: fillTp,
            qty: fillQty,
            leverage: Math.min(fillLev, lev),
            notional: fillNotional || sized.notional,
            risk: fillRisk || sized.risk,
            fees: fillFees,
            orderId,
            barTime: s.barTime,
            origSl: fillSl,
            atr: s.atr,
            equityAtOpen: equity,
            rrPlanned: s.rr,
            margin: fillMargin,
          };
          const reason = orphan ? `${s.reason} · ${ORPHAN_MARK}` : s.reason;
          async function flattenLive() {
            if (!adapter) return false;
            try {
              const res = await adapter.closePosition(acc, venueSymbol(venue, s.symbol));
              return res.ok || res.message === "flat";
            } catch {
              return false;
            }
          }
          let bookFill = true;
          if (placedLive && (leverageOverCap(fillLev, lev) || marginOverBudget(fillMargin, sized.margin))) {
            skip = leverageOverCap(fillLev, lev) ? "leverage over cap" : "margin over cap";
            const flat = await flattenLive();
            if (flat) {
              bookFill = false;
              held.delete(coin);
              filledBars.add(barKey);
            } else {
              orphan = true;
            }
          }
          function markTaken() {
            held.add(coin);
            filledBars.add(barKey);
            openLevs.push(Math.min(fillLev, lev));
            used += 1;
            opened += 1;
            if (isHtfTf(s.timeframe)) htfOpen += 1;
            usedMargin += fillMargin;
            available = Math.max(0, available - fillMargin);
            taken = true;
          }
          async function bookOrphan() {
            return insertPosition({ ...fill, signalReason: `${s.reason} · ${ORPHAN_MARK}` });
          }
          async function stashOrphan() {
            try {
              await rememberOrphanFill({
                venue: fill.venue,
                symbol: fill.symbol,
                side: fill.side,
                qty: fill.qty,
                entry: fill.entry,
                sl: fill.sl,
                tp: fill.tp,
                leverage: fill.leverage,
                notional: fill.notional,
                risk: fill.risk,
                fees: fill.fees,
                timeframe: fill.timeframe,
                indicator: fill.indicator,
                barTime: fill.barTime,
                orderId: fill.orderId,
                origSl: fill.origSl,
                reason: s.reason,
              });
              return true;
            } catch {
              try {
                await logScan(0, 0, 0, 0, 0, `${ORPHAN_MARK} ${fill.symbol}`, opts.source, { touch: false });
              } catch {
                /* venue fetchPositions still retries next tick */
              }
              return false;
            }
          }
          if (bookFill) {
          try {
            const id = await insertPosition({
              ...fill,
              signalReason: orphan ? `${s.reason} · ${ORPHAN_MARK}` : reason,
            });
            if (!id) {
              skip = "already filled";
              filledBars.add(barKey);
              if (placedLive) {
                const flat = await flattenLive();
                if (!flat) {
                  const retry = await bookOrphan().catch(() => 0);
                  if (retry) {
                    markTaken();
                    skip = ORPHAN_MARK;
                  } else {
                    await stashOrphan();
                    skip = ORPHAN_MARK;
                  }
                } else {
                  held.delete(coin);
                }
              }
            } else {
              markTaken();
              if (orphan) skip = ORPHAN_MARK;
              if (openCount + used >= maxPos) {
                const leftover = await listPendingLimitOrders().catch(() => [] as LimitOrderRow[]);
                for (const rem of leftover) await cancelPendingRow(rem, "max positions reached").catch(() => undefined);
              }
            }
          } catch (e) {
            skip = e instanceof Error ? e.message : "position insert failed";
            if (placedLive) {
              const flat = await flattenLive();
              if (!flat) {
                try {
                  const retry = await bookOrphan();
                  if (retry) {
                    markTaken();
                    skip = ORPHAN_MARK;
                  } else {
                    await stashOrphan();
                    skip = ORPHAN_MARK;
                  }
                } catch {
                  await stashOrphan();
                  skip = ORPHAN_MARK;
                }
              } else {
                held.delete(coin);
              }
            }
          }
          }
        }
      }
    }
    try {
      const saved = await insertSignal({
        barTime: s.barTime,
        symbol: s.symbol,
        timeframe: s.timeframe,
        indicator: s.indicator,
        side: s.side,
        entry: s.entry,
        sl: s.sl,
        tp: s.tp,
        rr: s.rr,
        atr: s.atr,
        reason: s.reason,
        taken,
        skipReason: skip || undefined,
      });
      if (saved.created) {
        pendingTelegram.push({
          symbol: s.symbol,
          timeframe: s.timeframe,
          indicator: s.indicator,
          side: s.side,
          entry: s.entry,
          sl: s.sl,
          tp: s.tp,
          rr: s.rr,
          reason: s.reason,
          taken,
          skip: skip || "",
        });
      }
    } catch {
      /* schema mismatch must not abort the rest of the tick */
    }
  }

  if (pendingTelegram.length) {
    try {
      await notifySignalsTelegram(settings, venue, pendingTelegram);
    } catch {
      /* a telegram outage must not change the tick */
    }
  }

  const freshSettings = await getSettings();
  if (live && adapter && liveBalReady) {
    try {
      const w = await withTimeout(readVenueWallet(adapter, acc), 5000);
      if (w) {
        await setEquity(w.equity);
        freshSettings.equity_usd = w.equity;
      }
    } catch {
      /* snapshot whatever is stored */
    }
  }
  await snapshotEquity(Number(freshSettings.equity_usd), (await listOpenPositions()).length, freshSettings.mode);
  const ms = Date.now() - t0;
  const heads = slice.slice(0, 8).map((s) => s.base).join(",");
  const note = `${scannedCoins}/${tradeable.length} ${venue} perps · chart ${chartHostLabel(venue)} · ${tfs.join("/")}${scanIncomplete ? " · sweep continues next minute" : " · fresh close"} · ${heads}${slice.length > 8 ? "…" : ""}${liveBlock ? ` · ${liveBlock}` : ""}`;
  await logScan(scanned, signals, opened, closed, ms, note, opts.source);

  return {
    ok: true,
    skipped: false,
    scanned,
    signals,
    opened,
    closed,
    durationMs: ms,
    coins: scannedCoins,
    universe: universe.length,
    tfs,
    batch: slice.map((s) => s.symbol),
    public: publicSettings(await getSettings()),
  };
}

export async function markToMarket(symbol: string, venue: VenueId = "paper") {
  return fetchVenueLastPrice(venue, symbol);
}
