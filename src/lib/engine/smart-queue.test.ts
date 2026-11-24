import assert from "node:assert/strict";
import test from "node:test";
import {
  approachDistanceAtr,
  clampMaxLimitQueue,
  pickSwapVictim,
  rankQueueCandidates,
  resolveEffectiveQueueCap,
  resolveSmartLimitTtlBars,
  shouldStageInWatchQueue,
} from "./smart-queue.ts";

test("clampMaxLimitQueue supports 0 (auto) and bounds 1..40", () => {
  assert.equal(clampMaxLimitQueue(0), 0);
  assert.equal(clampMaxLimitQueue(-5), 0);
  assert.equal(clampMaxLimitQueue(1), 1);
  assert.equal(clampMaxLimitQueue(12), 12);
  assert.equal(clampMaxLimitQueue(100), 40);
});

test("resolveEffectiveQueueCap honors safeLimitMode vs user maxLimitQueue", () => {
  assert.equal(
    resolveEffectiveQueueCap({ safeLimitMode: true, maxPositions: 4, openCount: 1, maxLimitQueue: 20 }),
    3,
  );
  assert.equal(
    resolveEffectiveQueueCap({ safeLimitMode: false, maxPositions: 4, openCount: 1, maxLimitQueue: 12 }),
    12,
  );
  assert.equal(
    resolveEffectiveQueueCap({ safeLimitMode: false, maxPositions: 6, openCount: 2, maxLimitQueue: 0 }),
    12,
  );
});

test("resolveSmartLimitTtlBars bounds 1h/4h auto TTL while preserving custom overrides", () => {
  assert.equal(resolveSmartLimitTtlBars("4h", 0, 8), 3);
  assert.equal(resolveSmartLimitTtlBars("1h", 0, 8), 5);
  assert.equal(resolveSmartLimitTtlBars("15m", 0, 8), 8);
  assert.equal(resolveSmartLimitTtlBars("4h", 10, 8), 10);
});

test("shouldStageInWatchQueue keeps distant 1h/4h Pre-Arm in bot watch and promotes hot-zone & Armed", () => {
  assert.equal(shouldStageInWatchQueue({ timeframe: "4h", phase: "pre-arm", distanceAtr: 2.1 }), true);
  assert.equal(shouldStageInWatchQueue({ timeframe: "1h", phase: "pre-arm", distanceAtr: 1.4 }), true);
  assert.equal(shouldStageInWatchQueue({ timeframe: "4h", phase: "pre-arm", distanceAtr: 0.9 }), false);
  assert.equal(shouldStageInWatchQueue({ timeframe: "4h", phase: "armed", distanceAtr: 2.5 }), false);
  assert.equal(shouldStageInWatchQueue({ timeframe: "5m", phase: "pre-arm", distanceAtr: 2.0 }), false);
});

test("approachDistanceAtr normalizes distance to entry", () => {
  assert.equal(approachDistanceAtr({ entry: 100, currentPrice: 101.5, atr: 1.5 }), 1);
  assert.equal(approachDistanceAtr({ entry: 100, currentPrice: 100, atr: 2 }), 0);
});

test("rankQueueCandidates orders Armed and closer setups ahead of distant Pre-Arm and deduplicates coins", () => {
  const ranked = rankQueueCandidates([
    {
      symbol: "ETHUSDT",
      coin: "ETH",
      timeframe: "1h",
      indicator: "APEX1",
      side: "long",
      phase: "pre-arm",
      distanceAtr: 2.4,
      rr: 2.0,
    },
    {
      symbol: "SOLUSDT",
      coin: "SOL",
      timeframe: "5m",
      indicator: "HALC",
      side: "short",
      phase: "pre-arm",
      distanceAtr: 0.3,
      rr: 1.0,
    },
    {
      symbol: "BTCUSDT",
      coin: "BTC",
      timeframe: "15m",
      indicator: "APEX1",
      side: "long",
      phase: "armed",
      distanceAtr: 0.6,
      rr: 1.0,
    },
    {
      symbol: "BTCUSDT",
      coin: "BTC",
      timeframe: "4h",
      indicator: "SHETEX",
      side: "long",
      phase: "pre-arm",
      distanceAtr: 1.8,
      rr: 1.8,
    },
  ]);

  assert.equal(ranked.length, 3);
  assert.equal(ranked[0]?.coin, "BTC");
  assert.equal(ranked[1]?.coin, "SOL");
  assert.equal(ranked[2]?.coin, "ETH");
});

test("pickSwapVictim evicts farthest Pre-Arm when faster setup arrives and protects Armed setups", () => {
  const victim = pickSwapVictim({
    incoming: {
      symbol: "SOLUSDT",
      coin: "SOL",
      timeframe: "5m",
      indicator: "APEX1",
      side: "short",
      phase: "pre-arm",
      distanceAtr: 0.25,
      rr: 1.0,
    },
    activePending: [
      { id: 1, symbol: "BTCUSDT", coin: "BTC", timeframe: "15m", phase: "armed", distanceAtr: 2.0 },
      { id: 2, symbol: "ETHUSDT", coin: "ETH", timeframe: "15m", phase: "pre-arm", distanceAtr: 0.7 },
      { id: 3, symbol: "AVAXUSDT", coin: "AVAX", timeframe: "1h", phase: "pre-arm", distanceAtr: 1.4 },
    ],
    htfMaxPositions: 4,
    htfOpenCount: 0,
    htfPendingCount: 1,
  });
  assert.equal(victim?.id, 3);

  const noVictimAgainstArmed = pickSwapVictim({
    incoming: {
      symbol: "SOLUSDT",
      coin: "SOL",
      timeframe: "5m",
      indicator: "APEX1",
      side: "short",
      phase: "pre-arm",
      distanceAtr: 0.2,
      rr: 1.0,
    },
    activePending: [
      { id: 1, symbol: "BTCUSDT", coin: "BTC", timeframe: "15m", phase: "armed", distanceAtr: 2.0 },
    ],
    htfMaxPositions: 4,
    htfOpenCount: 0,
    htfPendingCount: 0,
  });
  assert.equal(noVictimAgainstArmed, null);
});
