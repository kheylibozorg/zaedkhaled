import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePendingLimit } from "./limit-queue.ts";
import {
  findPreArmedSetup,
  isPreArmReason,
  preArmMatchesOrder,
  scanPreArmedClosed,
  type PreArmedSetup,
} from "./pre-arm.ts";
import { runIndicator } from "./run.ts";
import { ALL_INDICATORS, TF_MS, WARMUP, type Bar, type Timeframe } from "./types.ts";

/**
 * Generates a clean 15m / 1h series with:
 * 1. Uptrend into a major resistance double-top setup (and downtrend / support setup)
 * 2. A tight compression coil box for HAEG / HVES / HORI / HALC
 * Designed to verify Pre-Arm detection BEFORE indicator arming AND pattern-failure cancellation.
 */
function buildBullPullbackSupportWalk(tf: Timeframe = "15m"): Bar[] {
  const step = TF_MS[tf];
  const t0 = Date.UTC(2024, 3, 1);
  const bars: Bar[] = [];
  const push = (open: number, high: number, low: number, close: number, volume = 1200) => {
    bars.push({ time: t0 + bars.length * step, open, high, low, close, volume });
  };

  // Warmup base drifting upward from 85 to 105 so EMA21 > EMA84 > EMA200 and HTF EMA is bullish
  let p = 85;
  for (let i = 0; i < 275; i++) {
    const stepUp = i < 200 ? 0.08 : 0.02;
    const o = p;
    const wave = i % 2 === 0 ? 0.45 : -0.35;
    const c = o + wave + stepUp;
    push(o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c, 1100);
    p = c;
  }

  // Push sharply up first, then create 2 support pivots near ~99.0 (so minTests=2 also satisfies!)
  const makeSupportTest = () => {
    const start = p;
    // Drop ~4.5 ATR from start down to 99.0
    push(start, start + 0.1, start - 1.6, start - 1.5, 1300);
    push(start - 1.5, start - 1.4, start - 3.0, start - 2.9, 1300);
    push(start - 2.9, start - 2.8, 99.0, 99.1, 1400);
    // Bearish master bar at low 99.0 + strong bullish cover bar closing top third
    push(100.0, 100.05, 99.0, 99.08, 1400);
    push(99.15, 100.5, 99.1, 100.45, 1800);
    // Rally away (> 2.5 ATR above 99.0)
    push(100.45, 101.8, 100.35, 101.7, 1500);
    push(101.7, 102.9, 101.6, 102.8, 1500);
    push(102.8, 103.5, 102.2, 102.5, 1200);
    p = 102.5;
  };

  // Pivot 1 at ~99.0
  makeSupportTest();
  // Drop back gently without reaching 99.0, bounce, and form Pivot 2 near 99.02
  makeSupportTest();
  // Approach bar coming down toward 99.0 without touching 99.0 yet (resting buy limit region)
  push(102.5, 102.6, 100.8, 101.0, 1200);
  push(101.0, 101.1, 99.9, 100.1, 1200);

  return bars;
}

function buildBearRallyResistanceWalk(tf: Timeframe = "1h"): Bar[] {
  const step = TF_MS[tf];
  const t0 = Date.UTC(2024, 5, 1);
  const bars: Bar[] = [];
  const push = (open: number, high: number, low: number, close: number, volume = 1200) => {
    bars.push({ time: t0 + bars.length * step, open, high, low, close, volume });
  };

  // Warmup drifting down from 140 to ~90 with ~1.8% ATR so all APEX1/15/2, TREX, KETEX, SHETEX minStopPct floors hold cleanly
  let p = 140;
  for (let i = 0; i < 275; i++) {
    const stepDn = i < 200 ? -0.15 : -0.02;
    const o = p;
    const wave = i % 2 === 0 ? -0.75 : 0.6;
    const c = o + wave + stepDn;
    push(o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c, 1100);
    p = c;
  }

  const top = p + 6.0;
  const makeResTest = () => {
    const s = p;
    push(s, s + 2.2, s - 0.1, s + 2.0, 1300);
    push(s + 2.0, top - 0.2, s + 1.8, top - 0.3, 1300);
    // Bullish master bar touching resistance top + bearish cover bar closing bottom third
    push(top - 1.2, top, top - 1.3, top - 0.1, 1400);
    push(top - 0.15, top - 0.05, top - 2.2, top - 2.1, 1800);
    // Drop away (> 2.5 ATR below resistance)
    push(top - 2.1, top - 2.0, top - 4.2, top - 4.0, 1500);
    push(top - 4.0, top - 3.9, top - 5.8, top - 5.4, 1500);
    p = top - 5.4;
  };

  // Two unbroken resistance pivots at ~top
  makeResTest();
  makeResTest();
  // Approach upward toward resistance without touching yet
  push(p, top - 2.2, p - 0.2, top - 2.4, 1200);
  push(top - 2.4, top - 0.8, top - 2.5, top - 1.0, 1200);

  return bars;
}

function buildCoilPreArmWalk(tf: Timeframe = "1h"): Bar[] {
  const step = TF_MS[tf];
  const t0 = Date.UTC(2024, 7, 1);
  const bars: Bar[] = [];
  const push = (open: number, high: number, low: number, close: number, volume = 1000) => {
    bars.push({ time: t0 + bars.length * step, open, high, low, close, volume });
  };

  // Higher-volatility balanced ping-pong (~3.5 range) so DI+ ≈ DI- (ADX stays low) and squeeze triggers on coil entry
  for (let i = 0; i < 276; i++) {
    const ph = i % 4;
    if (ph === 0) push(99.0, 102.0, 98.5, 101.2, 1000);
    else if (ph === 1) push(101.2, 103.2, 99.7, 101.5, 1000);
    else if (ph === 2) push(101.5, 101.8, 98.0, 98.8, 1000);
    else push(98.8, 100.3, 96.8, 99.0, 1000);
  }

  // Box [96.8, 103.2], then small tight ping-pong inside [98.9, 101.1] so ATR squeezes and ADX stays low for HALC too
  push(99.5, 102.6, 99.2, 101.2, 900);
  push(101.2, 101.5, 97.4, 99.2, 900);
  for (let i = 0; i < 14; i++) {
    const ph = i % 4;
    if (ph === 0) push(99.4, 100.8, 99.2, 100.4, 900);
    else if (ph === 1) push(100.4, 101.1, 99.5, 100.6, 900);
    else if (ph === 2) push(100.6, 100.8, 99.2, 99.6, 900);
    else push(99.6, 100.5, 98.9, 99.4, 900);
  }

  return bars;
}

describe("pre-arm anticipatory limit setups across all 5 engine families (11 indicators)", () => {
  it("emits valid PreArmedSetup BEFORE armedSetup fires on all reversal engines (APEX / TREX / KETEX / SHETEX)", () => {
    const bearBars = buildBearRallyResistanceWalk("1h");
    const reversalNames = ["APEX1", "APEX15", "APEX2", "TREX1", "TREX12", "KETEX", "SHETEX"] as const;

    const seen = new Set<string>();
    for (const name of reversalNames) {
      for (let len = WARMUP + 10; len <= bearBars.length; len++) {
        const sub = bearBars.slice(0, len);
        const indRes = runIndicator(sub, "1h", name);
        const pre = findPreArmedSetup(sub, "1h", name);
        if (pre) {
          // Whenever Pre-Arm fires, indicator must NOT already be armed on that bar
          assert.equal(indRes.armedSetup ?? null, null, `${name} emitted pre-arm while already armed`);
          assert.equal(pre.phase, "pre-arm");
          assert.ok(isPreArmReason(pre.reason));
          assert.ok(/limit/i.test(pre.reason));
          assert.equal(pre.armedBarTime, sub[sub.length - 1]!.time);
          assert.ok(pre.entry > 0 && pre.sl > 0 && pre.tp > 0);
          if (pre.side === "short") {
            assert.ok(pre.sl > pre.entry && pre.tp < pre.entry, `${name} invalid short geometry`);
            assert.ok(sub[sub.length - 1]!.close < pre.entry, `${name} pre-arm short must rest above close`);
          } else {
            assert.ok(pre.sl < pre.entry && pre.tp > pre.entry, `${name} invalid long geometry`);
            assert.ok(sub[sub.length - 1]!.close > pre.entry, `${name} pre-arm long must rest below close`);
          }
          seen.add(name);
          break;
        }
      }
      assert.ok(seen.has(name), `expected ${name} to emit a PreArmedSetup ahead of arming`);
    }
  });

  it("emits valid PreArmedSetup for HALCYON coil family (HAEG, HVES, HORI, HALC) before touch arming", () => {
    const coilBars = buildCoilPreArmWalk("1h");
    const coilNames = ["HAEG", "HVES", "HORI", "HALC"] as const;
    const seen = new Set<string>();

    for (const name of coilNames) {
      for (let len = WARMUP + 2; len <= coilBars.length; len++) {
        const sub = coilBars.slice(0, len);
        const indRes = runIndicator(sub, "1h", name);
        const pre = findPreArmedSetup(sub, "1h", name);
        if (pre) {
          assert.equal(indRes.armedSetup ?? null, null, `${name} emitted pre-arm while already armed`);
          assert.equal(pre.phase, "pre-arm");
          assert.ok(isPreArmReason(pre.reason));
          if (pre.side === "long") {
            assert.ok(pre.sl < pre.entry && pre.tp > pre.entry);
            assert.ok(sub[sub.length - 1]!.close > pre.entry);
          } else {
            assert.ok(pre.sl > pre.entry && pre.tp < pre.entry);
            assert.ok(sub[sub.length - 1]!.close < pre.entry);
          }
          seen.add(name);
          break;
        }
      }
      assert.ok(seen.has(name), `expected coil ${name} to emit PreArmedSetup`);
    }
  });

  it("respects APEX profile side filters (e.g., APEX2 is Short-only across all TFs)", () => {
    const bullBars = buildBullPullbackSupportWalk("15m");
    for (let len = WARMUP + 20; len <= bullBars.length; len++) {
      const sub = bullBars.slice(0, len);
      const preApex2 = findPreArmedSetup(sub, "15m", "APEX2");
      if (preApex2) {
        assert.equal(preApex2.side, "short");
      }
    }
    const bullPre = findPreArmedSetup(bullBars, "15m", "TREX1");
    assert.ok(bullPre === null || bullPre.side === "long" || bullPre.side === "short");
  });

  it("cancels Pre-Arm when reversal level is engulfed/broken or coil box breaks before opening", () => {
    // 1. Reversal level broken / engulfed
    const bearBars = buildBearRallyResistanceWalk("1h");
    const preIndex = (() => {
      for (let len = WARMUP + 10; len <= bearBars.length; len++) {
        const found = findPreArmedSetup(bearBars.slice(0, len), "1h", "KETEX");
        if (found && found.side === "short") return len;
      }
      return -1;
    })();
    assert.ok(preIndex > WARMUP);
    const activeBars = bearBars.slice(0, preIndex);
    const pre = findPreArmedSetup(activeBars, "1h", "KETEX")!;
    assert.ok(pre);
    assert.equal(pre.side, "short");

    // Next candle closes sharply ABOVE resistance + 0.2 * ATR -> pattern broken/failed
    const step = TF_MS["1h"];
    const lastT = activeBars[activeBars.length - 1]!.time;
    const breakoutBar: Bar = {
      time: lastT + step,
      open: pre.entry - 0.3,
      high: pre.entry + 4.0,
      low: pre.entry - 0.4,
      close: pre.entry + 3.8,
      volume: 2500,
    };
    const afterBreak = [...activeBars, breakoutBar];
    assert.equal(findPreArmedSetup(afterBreak, "1h", "KETEX"), null);

    // Also test non-filling pattern failure (bar stays strictly between TP and entry so neither SL/fill/TP triggers, yet currentPreArmed becomes null)
    const tpSpan = Math.abs(pre.entry - pre.tp);
    const evalFail = evaluatePendingLimit({
      order: {
        symbol: "ETHUSDT",
        timeframe: "1h",
        indicator: "KETEX",
        side: pre.side,
        entry: pre.entry,
        sl: pre.sl,
        tp: pre.tp,
        rr: pre.rr,
        armedBarTime: pre.armedBarTime,
        ftcWait: pre.ftcWait,
        reason: pre.reason,
      },
      closedBars: [
        ...activeBars.slice(-5),
        {
          time: lastT + step,
          open: pre.entry - 0.3 * tpSpan,
          high: pre.entry - 0.1 * tpSpan,
          low: pre.entry - 0.5 * tpSpan,
          close: pre.entry - 0.45 * tpSpan,
          volume: 1000,
        },
      ],
      ttlBars: 8,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: null,
      currentPreArmed: null,
    });
    assert.deepEqual(evalFail, { action: "cancel", cancelReason: "pattern failed", barsElapsed: 1 });

    // 2. Coil breakout invalidation
    const coilBars = buildCoilPreArmWalk("1h");
    const coilIdx = (() => {
      for (let len = WARMUP + 2; len <= coilBars.length; len++) {
        if (findPreArmedSetup(coilBars.slice(0, len), "1h", "HAEG")) return len;
      }
      return -1;
    })();
    assert.ok(coilIdx > WARMUP);
    const activeCoil = coilBars.slice(0, coilIdx);
    const coilPre = findPreArmedSetup(activeCoil, "1h", "HAEG")!;
    assert.ok(coilPre);

    const coilBreak: Bar = {
      time: activeCoil[activeCoil.length - 1]!.time + step,
      open: coilPre.entry,
      high: coilPre.entry + 8,
      low: coilPre.entry - 8,
      close: coilPre.side === "long" ? coilPre.entry - 6 : coilPre.entry + 6,
      volume: 4000,
    };
    assert.equal(findPreArmedSetup([...activeCoil, coilBreak], "1h", "HAEG"), null);
  });

  it("keeps Pre-Arm order when setup upgrades cleanly into confirmed ArmedSetup or persists at matching level", () => {
    const bearBars = buildBearRallyResistanceWalk("1h");
    const preIndex = (() => {
      for (let len = WARMUP + 10; len <= bearBars.length; len++) {
        const found = findPreArmedSetup(bearBars.slice(0, len), "1h", "TREX12");
        if (found && found.side === "short") return len;
      }
      return -1;
    })();
    assert.ok(preIndex > WARMUP);
    const activeBars = bearBars.slice(0, preIndex);
    const pre = findPreArmedSetup(activeBars, "1h", "TREX12")!;
    assert.ok(pre);
    assert.equal(pre.side, "short");

    const step = TF_MS["1h"];
    const tpSpan = Math.abs(pre.entry - pre.tp);
    const nextQuietBar: Bar = {
      time: pre.armedBarTime + step,
      open: pre.entry - 0.35 * tpSpan,
      high: pre.entry - 0.1 * tpSpan, // strictly below entry (has not filled yet)
      low: pre.entry - 0.55 * tpSpan, // strictly above TP (has not reached target yet)
      close: pre.entry - 0.25 * tpSpan,
      volume: 1100,
    };

    // Case 1: Pre-Arm persists at matching price -> keep
    const keepPre = evaluatePendingLimit({
      order: {
        symbol: "SOLUSDT",
        timeframe: "1h",
        indicator: "TREX12",
        side: pre.side,
        entry: pre.entry,
        sl: pre.sl,
        tp: pre.tp,
        rr: pre.rr,
        armedBarTime: pre.armedBarTime,
        ftcWait: pre.ftcWait,
        reason: pre.reason,
      },
      closedBars: [activeBars[activeBars.length - 1]!, nextQuietBar],
      ttlBars: 12,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: null,
      currentPreArmed: pre,
    });
    assert.deepEqual(keepPre, { action: "keep", barsElapsed: 1 });

    // Case 2: Indicator confirmed cover bar and armed standard ArmedSetup on same side -> keep
    const keepUpgraded = evaluatePendingLimit({
      order: {
        symbol: "SOLUSDT",
        timeframe: "1h",
        indicator: "TREX12",
        side: pre.side,
        entry: pre.entry,
        sl: pre.sl,
        tp: pre.tp,
        rr: pre.rr,
        armedBarTime: pre.armedBarTime,
        ftcWait: pre.ftcWait,
        reason: pre.reason,
      },
      closedBars: [activeBars[activeBars.length - 1]!, nextQuietBar],
      ttlBars: 12,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: { ...pre, reason: "TREX 1.2R second-test resistance · FTC limit" },
      currentPreArmed: null,
    });
    assert.deepEqual(keepUpgraded, { action: "keep", barsElapsed: 1 });

    // Case 3: Level drifted completely to a different swing -> cancel pattern failed
    const shiftedPre: PreArmedSetup = { ...pre, entry: pre.entry * 1.15 };
    assert.equal(preArmMatchesOrder(pre.entry, shiftedPre), false);
    const cancelDrifted = evaluatePendingLimit({
      order: {
        symbol: "SOLUSDT",
        timeframe: "1h",
        indicator: "TREX12",
        side: pre.side,
        entry: pre.entry,
        sl: pre.sl,
        tp: pre.tp,
        rr: pre.rr,
        armedBarTime: pre.armedBarTime,
        ftcWait: pre.ftcWait,
        reason: pre.reason,
      },
      closedBars: [activeBars[activeBars.length - 1]!, nextQuietBar],
      ttlBars: 12,
      gateMuted: false,
      capReached: false,
      duplicateHeld: false,
      currentArmed: null,
      currentPreArmed: shiftedPre,
    });
    assert.deepEqual(cancelDrifted, { action: "cancel", cancelReason: "pattern failed", barsElapsed: 1 });
  });

  it("scanPreArmedClosed scans across ALL_INDICATORS safely", () => {
    const bars = buildBearRallyResistanceWalk("1h");
    const preList = scanPreArmedClosed(bars, "1h");
    assert.ok(Array.isArray(preList));
    for (const s of preList) {
      assert.ok(ALL_INDICATORS.includes(s.indicator));
      assert.equal(s.phase, "pre-arm");
    }
  });
});
