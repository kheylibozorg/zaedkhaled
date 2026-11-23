import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canQueueLimitOrder,
  clampLimitTtlBars,
  evaluatePendingLimit,
  parseEntryMode,
  resolveLimitTtlBars,
  type PendingLimitSpec,
} from "./limit-queue.ts";
import { TF_MS, type ArmedSetup, type Bar } from "./types.ts";

const T0 = Date.UTC(2025, 0, 1);
const TF = "15m" as const;
const STEP = TF_MS[TF];

function barAt(idx: number, open: number, high: number, low: number, close: number): Bar {
  return { time: T0 + idx * STEP, open, high, low, close, volume: 100 };
}

function baseOrder(over?: Partial<PendingLimitSpec>): PendingLimitSpec {
  return {
    symbol: "BTCUSDT",
    timeframe: TF,
    indicator: "APEX15",
    side: "long",
    entry: 100,
    sl: 95,
    tp: 110,
    rr: 2,
    armedBarTime: T0,
    ftcWait: 8,
    ...over,
  };
}

function matchingArmed(over?: Partial<ArmedSetup>): ArmedSetup {
  return {
    indicator: "APEX15",
    side: "long",
    entry: 100,
    sl: 95,
    tp: 110,
    rr: 2,
    atr: 2,
    armAge: 1,
    ftcWait: 8,
    armedBarIndex: 270,
    armedBarTime: T0,
    reason: "test",
    ...over,
  };
}

describe("limit-queue settings & Safe Limit Cap", () => {
  it("parses entry mode and clamps TTL bars", () => {
    assert.equal(parseEntryMode("limit"), "limit");
    assert.equal(parseEntryMode("MARKET"), "market");
    assert.equal(parseEntryMode(undefined), "limit");
    assert.equal(clampLimitTtlBars(0), 0);
    assert.equal(clampLimitTtlBars(-5), 0);
    assert.equal(clampLimitTtlBars(6), 6);
    assert.equal(clampLimitTtlBars(120), 48);
    assert.equal(resolveLimitTtlBars(0, 12), 12);
    assert.equal(resolveLimitTtlBars(5, 12), 5);
  });

  it("enforces Safe Limit Cap (open + pending <= maxPositions) and HTF cap", () => {
    const base = {
      safeLimitMode: true,
      maxPositions: 3,
      htfMaxPositions: 2,
      timeframe: "15m" as const,
      coin: "ETH",
      heldCoins: new Set(["BTC"]),
      pendingCoins: new Set(["SOL"]),
      openCount: 1,
      pendingCount: 1,
      htfOpenCount: 0,
      htfPendingCount: 0,
      sideOn: true,
      side: "long" as const,
      entry: 100,
      sl: 95,
      tp: 110,
    };

    // 1 open + 1 pending = 2 < 3 -> allowed
    assert.deepEqual(canQueueLimitOrder(base), { ok: true });

    // 1 open + 2 pending = 3 >= 3 -> blocked in safe mode
    const blockedSafe = canQueueLimitOrder({ ...base, pendingCount: 2 });
    assert.equal(blockedSafe.ok, false);
    assert.equal((blockedSafe as { reason: string }).reason, "safe limit cap reached");

    // In unsafe mode, openCount (1) < 3 allows queueing even if pendingCount is 2
    const allowedUnsafe = canQueueLimitOrder({ ...base, safeLimitMode: false, pendingCount: 2 });
    assert.deepEqual(allowedUnsafe, { ok: true });

    // Duplicate held or pending coin is blocked
    assert.equal(canQueueLimitOrder({ ...base, coin: "BTC" }).ok, false);
    assert.equal(canQueueLimitOrder({ ...base, coin: "SOL" }).ok, false);

    // HTF safe cap (1h/4h)
    const htfBlocked = canQueueLimitOrder({
      ...base,
      timeframe: "1h",
      htfOpenCount: 1,
      htfPendingCount: 1,
    });
    assert.equal(htfBlocked.ok, false);
    assert.equal((htfBlocked as { reason: string }).reason, "safe htf cap reached");

    // Invalid geometry rejected
    assert.equal(canQueueLimitOrder({ ...base, side: "long", sl: 102 }).ok, false);
    assert.equal(canQueueLimitOrder({ ...base, side: "short", sl: 98, tp: 90 }).ok, false);
  });
});

describe("evaluatePendingLimit — style invalidation & fills", () => {
  it("cancels queued order immediately when max positions cap is reached", () => {
    const res = evaluatePendingLimit({
      order: baseOrder(),
      closedBars: [barAt(0, 102, 104, 101, 103)],
      ttlBars: 8,
      gateMuted: false,
      capReached: true,
      duplicateHeld: false,
      currentArmed: matchingArmed(),
    });
    assert.deepEqual(res, { action: "cancel", cancelReason: "max positions reached", barsElapsed: 0 });
  });

  it("fills at limit entry when price pulls back to FTC without breaching SL", () => {
    const bars = [
      barAt(0, 102, 104, 101, 103), // arming bar
      barAt(1, 103, 104, 101.2, 102), // still above entry 100
      barAt(2, 102, 103, 99.6, 101), // tags entry 100, low 99.6 > sl 95
    ];
    const res = evaluatePendingLimit({
      order: baseOrder(),
      closedBars: bars,
      ttlBars: 8,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: matchingArmed(),
    });
    assert.deepEqual(res, {
      action: "fill",
      fillBarTime: T0 + 2 * STEP,
      fillPrice: 100,
      barsWaited: 2,
    });
  });

  it("cancels as sl engulfed if SL is breached on the bar before or alongside entry tag", () => {
    const bars = [
      barAt(0, 102, 104, 101, 103),
      barAt(1, 102, 102, 94.5, 95), // plunges through both 100 and 95
    ];
    const res = evaluatePendingLimit({
      order: baseOrder(),
      closedBars: bars,
      ttlBars: 8,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: null,
    });
    assert.equal(res.action, "cancel");
    if (res.action === "cancel") {
      assert.equal(res.cancelReason, "sl engulfed");
    }
  });

  it("cancels as target reached without RTP when TP hits before returning to FTC", () => {
    const bars = [
      barAt(0, 102, 104, 101, 103),
      barAt(1, 103, 106, 102, 105), // rallies without pulling back to 100
      barAt(2, 105, 111, 104, 109), // hits TP 110 without RTP to 100
    ];
    const res = evaluatePendingLimit({
      order: baseOrder(),
      closedBars: bars,
      ttlBars: 8,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: matchingArmed(),
    });
    assert.equal(res.action, "cancel");
    if (res.action === "cancel") {
      assert.equal(res.cancelReason, "target reached without RTP");
    }
  });

  it("handles short target reached without RTP and short fills accurately", () => {
    const shortOrder = baseOrder({ side: "short", entry: 100, sl: 105, tp: 90 });
    const barsMiss = [
      barAt(0, 98, 99, 97, 98),
      barAt(1, 98, 99, 89.5, 91), // hits TP 90 without returning up to 100
    ];
    const missRes = evaluatePendingLimit({
      order: shortOrder,
      closedBars: barsMiss,
      ttlBars: 8,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: matchingArmed({ side: "short", entry: 100, sl: 105, tp: 90 }),
    });
    assert.equal(missRes.action, "cancel");
    if (missRes.action === "cancel") assert.equal(missRes.cancelReason, "target reached without RTP");

    const barsFill = [
      barAt(0, 98, 99, 97, 98),
      barAt(1, 98, 100.4, 97.5, 98), // tags 100, below SL 105
    ];
    const fillRes = evaluatePendingLimit({
      order: shortOrder,
      closedBars: barsFill,
      ttlBars: 8,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: matchingArmed({ side: "short", entry: 100, sl: 105, tp: 90 }),
    });
    assert.equal(fillRes.action, "fill");
  });

  it("cancels as queue expired when TTL bars elapse without fill", () => {
    const bars = [
      barAt(0, 102, 104, 101, 103),
      barAt(1, 103, 104, 101, 102),
      barAt(2, 102, 104, 101, 103),
      barAt(3, 103, 105, 101, 104),
    ];
    const res = evaluatePendingLimit({
      order: baseOrder({ ftcWait: 8 }),
      closedBars: bars,
      ttlBars: 3,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: matchingArmed(),
    });
    assert.equal(res.action, "cancel");
    if (res.action === "cancel") {
      assert.equal(res.cancelReason, "queue expired");
      assert.equal(res.barsElapsed, 3);
    }
  });

  it("cancels as pattern failed when closed-bar indicator disarms or flips side early", () => {
    const bars = [
      barAt(0, 102, 104, 101, 103),
      barAt(1, 103, 104, 101, 102),
    ];
    const disarmed = evaluatePendingLimit({
      order: baseOrder({ ftcWait: 8 }),
      closedBars: bars,
      ttlBars: 8,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: null,
    });
    assert.deepEqual(disarmed, { action: "cancel", cancelReason: "pattern failed", barsElapsed: 1 });

    const flipped = evaluatePendingLimit({
      order: baseOrder({ ftcWait: 8 }),
      closedBars: bars,
      ttlBars: 8,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: matchingArmed({ side: "short" }),
    });
    assert.deepEqual(flipped, { action: "cancel", cancelReason: "pattern failed", barsElapsed: 1 });
  });

  it("keeps pending if klines unavailable (currentArmed === undefined) unless cap/gate violated", () => {
    const res = evaluatePendingLimit({
      order: baseOrder(),
      closedBars: [],
      ttlBars: 8,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: undefined,
    });
    assert.deepEqual(res, { action: "keep", barsElapsed: 0 });
  });
});
