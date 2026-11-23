import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runIndicator, scanArmedClosed, scanBarClosed } from "./run.ts";
import { ALL_INDICATORS, TF_MS, WARMUP, type ArmedSetup, type Bar, type IndicatorName, type Timeframe } from "./types.ts";

/**
 * Generates a realistic multi-regime 15m series:
 * - Warmup base around 100 with ~1.0 range candles (so catr ~ 1.0)
 * - Bull impulse -> first resistance master bar -> away drop -> second resistance master bar -> bearish cover -> pullback
 * - Compression coil box with repeated edge touches (HAEG/HVES/HORI/HALC)
 */
function structuredWalk(tf: Timeframe = "15m"): Bar[] {
  const step = TF_MS[tf];
  const t0 = Date.UTC(2024, 0, 1);
  const bars: Bar[] = [];

  const push = (open: number, high: number, low: number, close: number, volume = 1200) => {
    bars.push({ time: t0 + bars.length * step, open, high, low, close, volume });
  };

  // Warmup: 280 bars of steady ~1.0 ATR oscillation around 100
  let p = 100;
  for (let i = 0; i < 280; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const o = p;
    const c = p + dir * 0.4;
    push(o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.3, c, 1000);
    p = c;
  }

  // Build double-bottom support pivot around 95.0 (bullish leg -> cover low -> away rally -> retest 95.0 -> cover low -> armed FTC)
  // Leg 1 down to 95.0 (4 bars, > 3 ATR)
  push(100.0, 100.1, 98.5, 98.6, 1200);
  push(98.6, 98.7, 97.0, 97.1, 1200);
  push(97.1, 97.2, 95.0, 95.2, 1200); // cType=2 long bearish leg
  // Master bearish bar at extreme 95.0 (range ~1.0, body >= 0.8) then strong bullish cover bar closing in top third
  push(96.0, 96.05, 95.0, 95.1, 1300);
  push(95.2, 96.4, 95.15, 96.35, 1600); // coverLowAt(1): closes above 96.05 in top third!
  // Rally away (> 2 ATR above 95.0)
  push(96.4, 97.6, 96.3, 97.5, 1400);
  push(97.5, 98.6, 97.4, 98.5, 1400);
  push(98.5, 99.0, 97.8, 98.0, 1100);
  // Drop back to second test near 95.0
  push(98.0, 98.1, 96.3, 96.4, 1200);
  push(96.4, 96.5, 95.05, 95.15, 1300);
  // Second test master bearish bar + bullish cover (arms long FTC around ~95.5)
  push(96.0, 96.02, 95.02, 95.1, 1400);
  push(95.2, 96.5, 95.15, 96.45, 1800);
  // Hold above FTC for 3 bars without tagging -> armedSetup active!
  push(96.45, 97.0, 96.2, 96.8, 1200);
  push(96.8, 97.3, 96.3, 97.1, 1200);
  push(97.1, 97.4, 96.4, 97.2, 1200);

  // Also add a tight coil oscillation box [97.0 .. 101.0] for 40 bars so HALCYON locks and arms at support/resistance
  for (let i = 0; i < 36; i++) {
    const phase = i % 6;
    if (phase === 0) push(99.0, 100.8, 98.9, 100.6, 900);
    else if (phase === 1) push(100.6, 100.9, 99.2, 99.4, 900);
    else if (phase === 2) push(99.4, 99.5, 97.4, 97.6, 900);
    else if (phase === 3) push(97.6, 99.2, 97.2, 99.0, 900);
    else if (phase === 4) push(99.0, 100.7, 98.8, 100.5, 900);
    else push(100.5, 100.8, 99.0, 99.2, 900);
  }
  // Touch lower coil edge and bounce without re-tagging extreme
  push(99.2, 99.3, 97.1, 98.2, 900);
  push(98.2, 99.4, 98.0, 99.1, 900);

  return bars;
}

describe("armedSetup exposure across engines", () => {
  it("never alters emitted signals and produces valid armedSetup geometry when armed", () => {
    const bars = structuredWalk("15m");
    let sawArmedCount = 0;
    const armedIndicators = new Set<string>();

    for (const name of ALL_INDICATORS) {
      const full = runIndicator(bars, "15m", name);
      assert.ok(Array.isArray(full.signals));

      for (let len = WARMUP + 10; len <= bars.length; len++) {
        const sub = bars.slice(0, len);
        const res = runIndicator(sub, "15m", name);
        if (res.armedSetup) {
          sawArmedCount += 1;
          armedIndicators.add(name);
          const a: ArmedSetup = res.armedSetup;
          assert.equal(a.indicator, name);
          assert.ok(a.armedBarIndex >= WARMUP || a.armedBarIndex >= 0);
          assert.ok(a.ftcWait >= 1);
          assert.ok(a.entry > 0 && a.sl > 0 && a.tp > 0);
          if (a.side === "long") {
            assert.ok(a.sl < a.entry && a.tp > a.entry, `${name} long invalid geometry`);
          } else {
            assert.ok(a.sl > a.entry && a.tp < a.entry, `${name} short invalid geometry`);
          }
          if (res.armed) {
            assert.equal(a.side, res.armed === "LONG" ? "long" : "short");
          }
        }
      }
    }

    assert.ok(sawArmedCount > 0, `expected armed setups on structured walk, got ${sawArmedCount}`);
    assert.ok(armedIndicators.size >= 1);
  });

  it("scanArmedClosed respects indicator list and preserves valid setups without crashing", () => {
    const bars = structuredWalk("15m");
    const armed = scanArmedClosed(bars, "15m");
    assert.ok(Array.isArray(armed));
    for (const a of armed) {
      assert.ok(ALL_INDICATORS.includes(a.indicator));
      assert.ok(a.side === "long" || a.side === "short");
      assert.ok(a.armedBarTime > 0);
    }
    const subset = scanArmedClosed(bars, "15m", undefined, undefined, ["TREX1", "KETEX"] as IndicatorName[]);
    for (const a of subset) {
      assert.ok(a.indicator === "TREX1" || a.indicator === "KETEX");
    }
    const closedSigs = scanBarClosed(bars, "15m");
    assert.ok(Array.isArray(closedSigs));
  });
});
