import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fallbackStopsFromAtr,
  findConflictingOpenPositionIds,
  hasMatchingLiveOpenPosition,
  isAsterProtectiveOrder,
  isProtectionMatched,
  matchVenuePositionToDesk,
  resolveProtectionPlan,
  shouldAdoptInsteadOfCancel,
  shouldRollbackRestingLimit,
  syncLiveStopsWithVenueEntry,
} from "./live-reconcile.ts";

describe("live position reconciliation & SL/TP recovery", () => {
  const now = 1_750_000_000_000;

  it("matches unmatched venue position back to pending, watch, or recently cancelled limit order", () => {
    const recovered = matchVenuePositionToDesk({
      venuePos: { symbol: "SOLUSDT", side: "long", qty: 5, entry: 151.0, leverage: 10 },
      orphans: [],
      limitOrders: [
        {
          id: 11,
          mode: "live",
          venue: "aster",
          symbol: "SOLUSDT",
          timeframe: "15m",
          indicator: "TREX1",
          side: "long",
          entry: 150.0,
          sl: 147.0,
          tp: 156.0,
          rr: 2.0,
          atr: 1.5,
          leverage: 10,
          armed_bar_time: 1_749_999_000_000,
          reason: "FTC limit",
          exchange_order_id: "998877",
          status: "cancelled",
          closed_at: new Date(now - 60_000).toISOString(),
        },
        {
          id: 12,
          mode: "live",
          venue: "aster",
          symbol: "SOLUSDT",
          timeframe: "1h",
          indicator: "APEX2",
          side: "long",
          entry: 150.5,
          sl: 148.0,
          tp: 155.5,
          rr: 2.0,
          atr: 1.2,
          leverage: 10,
          armed_bar_time: 1_749_999_300_000,
          reason: "pending limit",
          exchange_order_id: "998899",
          status: "pending",
          updated_at: new Date(now - 30_000).toISOString(),
        },
      ],
      signals: [],
      nowMs: now,
    });

    assert.ok(recovered);
    assert.equal(recovered.source, "limit");
    assert.equal(recovered.limitOrderId, 12);
    assert.equal(recovered.indicator, "APEX2");
    assert.equal(recovered.timeframe, "1h");
    assert.equal(recovered.sl, 148.0);
    assert.equal(recovered.tp, 155.5);
  });

  it("recovers falsely cancelled limit order within window when missing SL/TP on exchange", () => {
    const recovered = matchVenuePositionToDesk({
      venuePos: { symbol: "AVAX-PERP", side: "short", qty: 10, entry: 24.8, leverage: 20 },
      orphans: [],
      limitOrders: [
        {
          id: 44,
          mode: "live",
          venue: "aster",
          symbol: "AVAXUSDT",
          timeframe: "15m",
          indicator: "AEGIS",
          side: "short",
          entry: 25.0,
          sl: 25.5,
          tp: 24.0,
          rr: 2.0,
          atr: 0.3,
          leverage: 20,
          armed_bar_time: 1_749_998_000_000,
          reason: "AEGIS limit",
          exchange_order_id: "123",
          status: "cancelled",
          closed_at: new Date(now - 120_000).toISOString(),
        },
      ],
      signals: [],
      nowMs: now,
    });

    assert.ok(recovered);
    assert.equal(recovered.symbol, "AVAXUSDT");
    assert.equal(recovered.limitOrderId, 44);
    const plan = resolveProtectionPlan({
      side: "short",
      entry: 24.8,
      recovered,
      protection: { onVenue: true, hasSl: false, hasTp: false, unknown: false },
    });
    assert.equal(plan.needsUpdate, true);
    assert.equal(plan.source, "recovered");
    assert.ok(plan.sl > 24.8);
    assert.ok(plan.tp < 24.8);
    assert.ok(Math.abs(plan.sl - 25.3) < 1e-6);
    assert.ok(Math.abs(plan.tp - 23.8) < 1e-6);
  });

  it("recovers from recent signals when limit_orders row is absent and triggers immediate SL/TP", () => {
    const recovered = matchVenuePositionToDesk({
      venuePos: { symbol: "ETHUSDT", side: "long", qty: 1, entry: 3005, leverage: 25 },
      orphans: [],
      limitOrders: [],
      signals: [
        {
          id: 7,
          ts: new Date(now - 10_000).toISOString(),
          bar_time: 1_749_999_600_000,
          symbol: "ETHUSDT",
          timeframe: "15m",
          indicator: "KETEX",
          side: "long",
          entry: 3000,
          sl: 2970,
          tp: 3066,
          rr: 2.2,
          atr: 15,
          reason: "KETEX signal",
        },
      ],
      nowMs: now,
    });
    assert.ok(recovered);
    assert.equal(recovered.source, "signal");
    const plan = resolveProtectionPlan({
      side: "long",
      entry: 3005,
      recovered,
      protection: { onVenue: true, hasSl: false, hasTp: true, unknown: false, tpPrice: 3071 },
    });
    assert.equal(plan.needsUpdate, true);
    assert.equal(plan.sl, 2975);
    assert.equal(plan.tp, 3071);
  });

  it("preserves valid venue SL/TP when unmatched trade already has both stops on exchange", () => {
    const plan = resolveProtectionPlan({
      side: "long",
      entry: 100,
      recovered: null,
      protection: { onVenue: true, hasSl: true, hasTp: true, unknown: false, slPrice: 97, tpPrice: 106 },
    });
    assert.equal(plan.needsUpdate, false);
    assert.equal(plan.source, "venue");
    assert.equal(plan.sl, 97);
    assert.equal(plan.tp, 106);
  });

  it("computes ATR fallback SL/TP immediately when unmatched venue trade has no protection", () => {
    const plan = resolveProtectionPlan({
      side: "short",
      entry: 200,
      atr: 4,
      recovered: null,
      protection: { onVenue: true, hasSl: false, hasTp: false, unknown: false },
    });
    assert.equal(plan.needsUpdate, true);
    assert.equal(plan.source, "atr_fallback");
    assert.equal(plan.sl, 206);
    assert.equal(plan.tp, 191);

    const pctFallback = fallbackStopsFromAtr({ side: "long", entry: 100, atr: null });
    assert.ok(pctFallback.sl < 100 && pctFallback.tp > 100);
  });

  it("identifies conflicting paper/other-venue rows blocking positions_one_open_symbol_idx", () => {
    const openRows = [
      { id: 1, mode: "paper", venue: "paper", symbol: "BTCUSDT", side: "long" },
      { id: 2, mode: "live", venue: "aster", symbol: "ETHUSDT", side: "long" },
      { id: 3, mode: "live", venue: "ourbit", symbol: "SOL_USDT", side: "short" },
    ];
    assert.deepEqual(findConflictingOpenPositionIds({ symbol: "BTCUSDT" }, openRows, "aster"), [1]);
    assert.deepEqual(findConflictingOpenPositionIds({ symbol: "ETHUSDT" }, openRows, "aster"), []);
    assert.deepEqual(findConflictingOpenPositionIds({ symbol: "SOLUSDT" }, openRows, "aster"), [3]);
    assert.equal(hasMatchingLiveOpenPosition({ symbol: "ETHUSDT" }, openRows, "aster"), true);
    assert.equal(hasMatchingLiveOpenPosition({ symbol: "BTCUSDT" }, openRows, "aster"), false);
  });

  it("adopts instead of cancelling when exchange holds position and rolls back untracked resting limit", () => {
    assert.equal(shouldAdoptInsteadOfCancel({ venueHasPosition: true }), true);
    assert.equal(shouldAdoptInsteadOfCancel({ venueHasPosition: false }), false);
    assert.equal(shouldRollbackRestingLimit({ resting: true, filled: false, dbPersisted: false }), true);
    assert.equal(shouldRollbackRestingLimit({ resting: true, filled: false, dbPersisted: true }), false);
    assert.equal(shouldRollbackRestingLimit({ resting: false, filled: true, dbPersisted: false }), false);
  });

  it("filters Aster protective orders without grabbing resting entry limit orders", () => {
    assert.equal(isAsterProtectiveOrder({ type: "STOP", origType: "STOP", reduceOnly: true, clientOrderId: "psl1" }), true);
    assert.equal(
      isAsterProtectiveOrder({ type: "TAKE_PROFIT_MARKET", origType: "TAKE_PROFIT_MARKET", reduceOnly: false }),
      true,
    );
    assert.equal(isAsterProtectiveOrder({ type: "LIMIT", origType: "LIMIT", reduceOnly: false, clientOrderId: "entry1" }), false);
  });

  it("rebases SL/TP with venue entry and repairs collapsed near-0R or BE stops", () => {
    // Entry shifted on venue from 100 to 101 for short: SL 105->106, TP 90->91
    const shifted = syncLiveStopsWithVenueEntry({
      side: "short",
      prevEntry: 100,
      liveEntry: 101,
      sl: 105,
      origSl: 105,
      tp: 90,
      rr: 2,
    });
    assert.equal(shifted.changed, true);
    assert.equal(shifted.entry, 101);
    assert.equal(shifted.sl, 106);
    assert.equal(shifted.tp, 91);

    // ZKC collapsed case: entry shifted down to 0.022510 right onto TP 0.022500 with SL 0.022710 -> repairs TP & restores >= min R:R
    const collapsed = syncLiveStopsWithVenueEntry({
      side: "short",
      prevEntry: 0.02251,
      liveEntry: 0.02251,
      sl: 0.02271,
      origSl: 0.02271,
      tp: 0.0225,
      atr: 0.0001,
      rr: 2,
    });
    assert.equal(collapsed.changed, true);
    assert.ok(collapsed.sl > collapsed.entry);
    assert.ok(collapsed.tp < collapsed.entry);
    assert.ok(Math.abs(collapsed.entry - collapsed.tp) >= Math.abs(collapsed.sl - collapsed.entry) * 0.25);

    // Breakeven stop sitting at entry must be rejected in favor of origSl
    const beRestored = syncLiveStopsWithVenueEntry({
      side: "short",
      prevEntry: 100,
      liveEntry: 100,
      sl: 100,
      origSl: 105,
      tp: 90,
      rr: 2,
    });
    assert.equal(beRestored.changed, true);
    assert.equal(beRestored.sl, 105);
    assert.equal(beRestored.tp, 90);
  });

  it("isProtectionMatched rejects missing, wrong-side, drifted, or BE venue protection orders", () => {
    assert.equal(
      isProtectionMatched({
        side: "short",
        entry: 100,
        wantSl: 105,
        wantTp: 90,
        prot: { onVenue: true, hasSl: true, hasTp: true, unknown: false, slPrice: 105, tpPrice: 90 },
      }),
      true,
    );
    // Rejects BE stop at entry
    assert.equal(
      isProtectionMatched({
        side: "short",
        entry: 100,
        wantSl: 105,
        wantTp: 90,
        prot: { onVenue: true, hasSl: true, hasTp: true, unknown: false, slPrice: 100, tpPrice: 90 },
      }),
      false,
    );
    // Rejects stale/drifted TP
    assert.equal(
      isProtectionMatched({
        side: "short",
        entry: 100,
        wantSl: 105,
        wantTp: 90,
        prot: { onVenue: true, hasSl: true, hasTp: true, unknown: false, slPrice: 105, tpPrice: 95 },
      }),
      false,
    );
  });
});

