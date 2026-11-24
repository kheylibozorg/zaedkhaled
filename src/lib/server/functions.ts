import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { FALLBACK_UNIVERSE, filterByMinCap, minCapUsd, looksLikeFallbackUniverse } from "@/lib/market/universe";
import { fetchKlinesCached } from "@/lib/market/klines";
import { clearListedCache } from "@/lib/market/venues";
import { onlyClosedBars, runIndicator } from "@/lib/engine/run";
import { SCAN_RULE, type IndicatorName, type Timeframe, type VenueId } from "@/lib/engine/types";
import {
  cancelLimitOrder,
  clearUniverse,
  getLimitOrderById,
  getSettings,
  listClosedPositions,
  listEquity,
  listOpenPositions,
  listPendingLimitOrders,
  listRecentLimitOrders,
  listScanLog,
  listSignals,
  listUniverse,
  listWatchLimitOrders,
  patchSettings,
  publicSettings,
  replaceUniverse,
  resetJournal,
  rotateTickToken,
  saveTradeNote,
  seedDemoJournal,
  maybeSeedJournal,
  setScanCursor,
  stats,
} from "./desk.server";
import { lockOperator, lockStatus, requireOperator, setOperatorPin, unlockOperator } from "./lock.server";
import { bookVenue, getAdapter, venueSymbol } from "@/lib/exchanges/registry";
import { normalizeLeverageRange } from "@/lib/exchanges/lev-cap";
import { stringifyLevSizeTiers } from "@/lib/engine/lev-size";
import { isTelegramChatId, isTelegramToken, parseTelegramVenues, stringifyTelegramVenues } from "@/lib/telegram";
import { accountFrom, clearUniverseCache, hasLiveKeys, overlayLiveSnapshot, refreshUniverse, runTick } from "./tick.server";
import { sendTelegramTest } from "./telegram.server";

export const getDesk = createServerFn({ method: "GET" }).handler(async () => {
  await maybeSeedJournal();
  const lock = await lockStatus();
  const settings = publicSettings(await getSettings(), { unlocked: lock.unlocked });
  const venue = bookVenue(settings.venue);
  let universe = await listUniverse();
  const bookStale =
    !universe.length ||
    !settings.universeVenue ||
    bookVenue(settings.universeVenue) !== venue ||
    looksLikeFallbackUniverse(universe);
  if (bookStale) {
    try {
      universe = (await refreshUniverse(minCapUsd(settings.minMarketCapUsd), venue, true)).map((a) => ({
        symbol: a.symbol,
        base: a.base,
        name: a.name,
        market_cap_usd: a.marketCapUsd,
        volume_24h_usd: a.volume24hUsd,
        max_leverage: a.maxLeverage,
        venue_symbol: a.venueSymbol ?? a.symbol,
      }));
    } catch {
      if (venue === "paper") {
        await replaceUniverse(FALLBACK_UNIVERSE);
        universe = await listUniverse();
      } else {
        try {
          await clearUniverse();
        } catch {
          /* keep whatever is stored; the scan path will refuse a mismatched book */
        }
        universe = [];
      }
    }
  }
  universe = filterByMinCap(universe, minCapUsd(settings.minMarketCapUsd), (a) => Number(a.market_cap_usd));
  const [openRaw, closed, signals, equity, scans, st, pendingLimits, watchLimits, recentLimits] = await Promise.all([
    listOpenPositions(),
    listClosedPositions(60),
    listSignals(60),
    listEquity(80),
    listScanLog(24),
    stats(),
    listPendingLimitOrders(),
    listWatchLimitOrders(),
    listRecentLimitOrders(60),
  ]);
  const live = await overlayLiveSnapshot(settings, openRaw);
  return {
    settings: live.settings,
    lock,
    open: live.open,
    closed,
    signals,
    pendingLimits,
    watchLimits,
    recentLimits,
    equity: equity.reverse(),
    scans,
    universe,
    stats: st,
  };
});

export const cancelQueuedLimitOrder = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.number().int().positive() }))
  .handler(async ({ data }) => {
    await requireOperator();
    const order = await getLimitOrderById(data.id);
    if (!order || (order.status !== "pending" && order.status !== "watch")) {
      return { ok: true as const, cancelled: false as const };
    }
    if (order.status === "pending" && order.mode === "live" && order.exchange_order_id) {
      const settings = await getSettings();
      const venue = bookVenue(order.venue || settings.venue);
      if (venue !== "paper" && hasLiveKeys(settings, venue)) {
        const adapter = getAdapter(venue);
        if (adapter?.cancelOrder) {
          const res = await adapter.cancelOrder(accountFrom(settings, venue), {
            symbol: venueSymbol(venue, order.symbol),
            orderId: order.exchange_order_id,
          });
          if (!res.ok) {
            throw new Error(res.message || "Live venue cancel failed");
          }
        }
      }
    }
    await cancelLimitOrder(order.id, "operator cancelled");
    return { ok: true as const, cancelled: true as const };
  });

export const tickNow = createServerFn({ method: "POST" })
  .validator(z.object({ forceUniverse: z.boolean().optional(), source: z.string().max(32).optional() }).optional())
  .handler(async ({ data }) => {
    const lock = await lockStatus();
    if (lock.hasPin && !lock.unlocked) {
      throw new Error("Desk is locked. Unlock to run a manual scan.");
    }
    return runTick({ forceUniverse: data?.forceUniverse, source: data?.source ?? "manual" });
  });

export const rotateDeskToken = createServerFn({ method: "POST" }).handler(async () => {
  await requireOperator();
  const row = await rotateTickToken();
  return publicSettings(row, { unlocked: true });
});

export const saveDeskSettings = createServerFn({ method: "POST" })
  .validator(
    z.object({
      mode: z.enum(["paper", "live"]).optional(),
      venue: z.enum(["paper", "hyperliquid", "lighter", "aster", "ourbit"]).optional(),
      risk_pct: z.number().min(0.1).max(5).optional(),
      capital_pct: z.number().min(1).max(100).optional(),
      min_leverage: z.number().int().min(1).max(200).optional(),
      max_leverage: z.number().int().min(1).max(200).optional(),
      stack_lev_count: z.number().int().min(0).max(20).optional(),
      stack_lev_cap: z.number().int().min(1).max(200).optional(),
      lev_size_tiers: z
        .array(
          z.object({
            leverage: z.number().int().min(1).max(200),
            capitalPct: z.number().min(1).max(100),
          }),
        )
        .max(20)
        .optional(),
      capital_base: z.enum(["total", "free"]).optional(),
      max_positions: z.number().int().min(1).max(20).optional(),
      htf_max_positions: z.number().int().min(0).max(20).optional(),
      min_market_cap_usd: z.number().min(0).max(5e12).optional(),
      equity_usd: z.number().positive().optional(),
      starting_equity_usd: z.number().positive().optional(),
      live_enabled: z.number().int().min(0).max(1).optional(),
      bot_enabled: z.number().int().min(0).max(1).optional(),
      paper_24h: z.number().int().min(0).max(1).optional(),
      scan_batch: z.number().int().min(0).max(250).optional(),
      lighter_api_key: z.string().nullable().optional(),
      lighter_api_private_key: z.string().nullable().optional(),
      lighter_account_index: z.number().int().nullable().optional(),
      lighter_api_key_index: z.number().int().nullable().optional(),
      aster_api_key: z.string().nullable().optional(),
      aster_api_secret: z.string().nullable().optional(),
      ourbit_api_key: z.string().nullable().optional(),
      ourbit_api_secret: z.string().nullable().optional(),
      hyperliquid_private_key: z.string().nullable().optional(),
      hyperliquid_wallet_address: z.string().nullable().optional(),
      engine_gates: z.string().max(8000).optional(),
      telegram_bot_token: z.string().max(200).nullable().optional(),
      telegram_chat_id: z.string().max(64).nullable().optional(),
      telegram_venues: z.string().max(2000).optional(),
      entry_mode: z.enum(["limit", "market"]).optional(),
      safe_limit_mode: z.number().int().min(0).max(1).optional(),
      limit_ttl_bars: z.number().int().min(0).max(48).optional(),
      max_limit_queue: z.number().int().min(0).max(40).optional(),
      auto_trim_excess: z.number().int().min(0).max(1).optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireOperator();
    if (data.mode === "live" && data.venue === "paper") {
      throw new Error("Paper is simulation only. Pick Hyperliquid, Lighter, Aster, or OURBIT for live fills.");
    }
    const before = await getSettings();
    const { lev_size_tiers, telegram_bot_token, telegram_chat_id, telegram_venues, ...rest } = data;
    const patch: typeof rest & {
      lev_size_tiers?: string;
      telegram_bot_token?: string | null;
      telegram_chat_id?: string | null;
      telegram_venues?: string;
    } = { ...rest };
    if (lev_size_tiers !== undefined) {
      patch.lev_size_tiers = stringifyLevSizeTiers(lev_size_tiers);
    }
    if (patch.min_leverage !== undefined || patch.max_leverage !== undefined) {
      const norm = normalizeLeverageRange(
        patch.min_leverage ?? before.min_leverage ?? 1,
        patch.max_leverage ?? before.max_leverage ?? 200,
      );
      patch.min_leverage = norm.min;
      patch.max_leverage = norm.max;
    }
    if (telegram_bot_token != null && telegram_bot_token.trim()) {
      if (!isTelegramToken(telegram_bot_token)) {
        throw new Error("توکن ربات تلگرام اشتباه است. همان متن BotFather را بچسبان.");
      }
      patch.telegram_bot_token = telegram_bot_token.trim();
    }
    if (telegram_chat_id != null) {
      const chat = telegram_chat_id.trim();
      if (chat && !isTelegramChatId(chat)) {
        throw new Error("چت آیدی کانال باید @channel یا عدد باشد، مثل -1001234567890.");
      }
      patch.telegram_chat_id = chat;
    }
    if (telegram_venues != null) {
      const prefs = parseTelegramVenues(telegram_venues);
      for (const id of Object.keys(prefs) as Array<keyof typeof prefs>) {
        const chat = prefs[id].chatId;
        if (chat && !isTelegramChatId(chat)) {
          throw new Error(`چت اختصاصی ${id} باید @channel یا عدد -100… باشد.`);
        }
      }
      patch.telegram_venues = stringifyTelegramVenues(prefs);
    }
    const inferred: VenueId | undefined = data.venue
      ? data.venue
      : data.hyperliquid_private_key
        ? "hyperliquid"
        : data.lighter_api_private_key
          ? "lighter"
          : data.aster_api_secret
            ? "aster"
            : data.ourbit_api_key && data.ourbit_api_secret
              ? "ourbit"
              : undefined;
    if (inferred) patch.venue = inferred;
    const newKeys = Boolean(
      patch.hyperliquid_private_key ||
        patch.lighter_api_private_key ||
        patch.aster_api_secret ||
        (patch.ourbit_api_key && patch.ourbit_api_secret),
    );
    const row = await patchSettings(patch);
    const venueChanged = Boolean(patch.venue && patch.venue !== before.venue);
    const modeChanged = Boolean(patch.mode && patch.mode !== before.mode);
    const capChanged =
      patch.min_market_cap_usd != null &&
      minCapUsd(patch.min_market_cap_usd) !== minCapUsd(before.min_market_cap_usd);
    if (capChanged) {
      try {
        await setScanCursor(0);
      } catch {
        /* cursor reset is best-effort */
      }
    }
    if (venueChanged || modeChanged || newKeys) {
      const v = bookVenue(row.venue);
      try {
        await setScanCursor(0);
      } catch {
        /* cursor reset is best-effort */
      }
      try {
        clearListedCache(v);
        clearUniverseCache();
        await refreshUniverse(minCapUsd(row.min_market_cap_usd), v, true);
      } catch {
        if (v !== "paper") {
          try {
            await clearUniverse();
          } catch {
            /* next getDesk retries */
          }
        }
      }
    }
    return publicSettings(row, { unlocked: true });
  });

export const setDeskPin = createServerFn({ method: "POST" })
  .validator(z.object({ pin: z.string().min(6).max(64) }))
  .handler(async ({ data }) => {
    return setOperatorPin(data.pin);
  });

export const unlockDesk = createServerFn({ method: "POST" })
  .validator(z.object({ pin: z.string().min(1).max(64) }))
  .handler(async ({ data }) => {
    return unlockOperator(data.pin);
  });

export const lockDesk = createServerFn({ method: "POST" }).handler(async () => {
  return lockOperator();
});

export const refreshCoins = createServerFn({ method: "POST" }).handler(async () => {
  const lock = await lockStatus();
  if (lock.hasPin && !lock.unlocked) {
    throw new Error("Desk is locked.");
  }
  const s = await getSettings();
  const venue = bookVenue(s.venue);
  clearListedCache(venue);
  clearUniverseCache();
  const assets = await refreshUniverse(minCapUsd(s.min_market_cap_usd), venue, true);
  return { count: assets.length, venue };
});

export const testVenue = createServerFn({ method: "POST" })
  .validator(z.object({ venue: z.enum(["hyperliquid", "lighter", "aster", "ourbit"]) }))
  .handler(async ({ data }) => {
    await requireOperator();
    const settings = await getSettings();
    const adapter = getAdapter(data.venue as VenueId);
    if (!adapter) return { ok: false, message: "No adapter" };
    const res = await adapter.testConnection(accountFrom(settings, data.venue));
    if (res.ok) {
      try {
        await patchSettings({
          venue: data.venue,
        });
      } catch {
        /* venue switch is best-effort; the ping itself succeeded */
      }
      try {
        clearListedCache(data.venue as VenueId);
        clearUniverseCache();
        const assets = await refreshUniverse(minCapUsd(settings.min_market_cap_usd), data.venue as VenueId, true);
        return {
          ok: true,
          message: `${res.message} · ${assets.length} perps from ${adapter.label}`,
        };
      } catch (e) {
        return {
          ok: true,
          message: `${res.message} · book failed (${e instanceof Error ? e.message : "listed markets"})`,
        };
      }
    }
    return res;
  });

export const testTelegram = createServerFn({ method: "POST" })
  .validator(z.object({ venue: z.enum(["paper", "hyperliquid", "lighter", "aster", "ourbit"]) }))
  .handler(async ({ data }) => {
    await requireOperator();
    return sendTelegramTest(await getSettings(), data.venue);
  });

export const getJournal = createServerFn({ method: "GET" }).handler(async () => {
  await maybeSeedJournal();
  const lock = await lockStatus();
  const settings = publicSettings(await getSettings(), { unlocked: lock.unlocked });
  const [openRaw, closed, st] = await Promise.all([
    listOpenPositions(),
    listClosedPositions(2000),
    stats(),
  ]);
  const live = await overlayLiveSnapshot(settings, openRaw);
  return { settings: live.settings, lock, open: live.open, closed, stats: st };
});

export const resetDeskJournal = createServerFn({ method: "POST" })
  .validator(z.object({ scope: z.enum(["closed", "paper"]) }))
  .handler(async ({ data }) => {
    const lock = await lockStatus();
    if (lock.hasPin) await requireOperator();
    return resetJournal(data.scope);
  });

export const seedDeskJournal = createServerFn({ method: "POST" }).handler(async () => {
  const lock = await lockStatus();
  if (lock.hasPin) await requireOperator();
  return seedDemoJournal();
});

export const saveDeskTradeNote = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.number().int(), notes: z.string().max(2000) }))
  .handler(async ({ data }) => {
    const lock = await lockStatus();
    if (lock.hasPin) await requireOperator();
    return saveTradeNote(data.id, data.notes);
  });

export const probeBtc = createServerFn({ method: "GET" }).handler(async () => {
  const settings = await getSettings();
  const venue = bookVenue(settings.venue);
  const tf: Timeframe = "15m";
  const raw = await fetchKlinesCached("BTCUSDT", tf, 400, venue);
  const bars = onlyClosedBars(raw, tf);
  const htf = onlyClosedBars(await fetchKlinesCached("BTCUSDT", "1h", 200, venue), "1h");
  const htf2 = onlyClosedBars(await fetchKlinesCached("BTCUSDT", "4h", 120, venue), "4h");
  const engines = [];
  for (const name of SCAN_RULE[tf]) {
    const res = runIndicator(bars, tf, name as IndicatorName, htf, htf2);
    engines.push({
      name,
      count: res.signals.length,
      lastBias: res.lastBias,
      armed: res.armed,
      lastAtr: res.lastAtr,
      lastClose: res.lastClose,
      last: res.signals.slice(-3).map((s) => ({
        side: s.side,
        entry: s.entry,
        sl: s.sl,
        tp: s.tp,
        rr: s.rr,
        barTime: s.barTime,
        reason: s.reason,
      })),
    });
  }
  return {
    symbol: "BTCUSDT",
    tf,
    bars: bars.length,
    lastBar: bars[bars.length - 1]?.time ?? 0,
    engines,
  };
});
