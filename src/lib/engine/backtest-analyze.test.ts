import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeBacktest, journalToAnalyzed, type AnalyzedTrade } from "./backtest-analyze.ts";
import type { JournalTrade } from "./journal.ts";
import type { Side } from "./types.ts";

function t(p: Partial<AnalyzedTrade> & { side: Side; pnlR: number; reason: AnalyzedTrade["reason"] }): AnalyzedTrade {
  return {
    i: 0,
    entry: 100,
    sl: 99,
    tp: 102,
    exit: 99,
    entryOrigin: "armed_limit",
    pnl: p.pnlR * 10,
    feesUsd: 0,
    maeR: 1,
    mfeR: 0.2,
    hasExcursion: true,
    capture: null,
    givebackR: 0,
    barsHeld: 3,
    hasBarsHeld: true,
    holdMs: 3 * 3600_000,
    plannedRr: 2,
    entryWhy: p.side === "long" ? "FTC support · FTC limit fill" : "FTC resistance · FTC limit fill",
    opened: 1,
    closed: 2,
    scratch: p.pnlR > 0 && p.pnlR < 0.3,
    noProfit: p.pnlR <= 0,
    stoppedFromProfit: false,
    missedTp: false,
    ...p,
  };
}

describe("analyzeBacktest", () => {
  it("flags shorts as the side that ate the most stops", () => {
    const rows: AnalyzedTrade[] = [
      t({ side: "long", pnlR: 1.5, reason: "tp", mfeR: 1.6, capture: 0.94, i: 0 }),
      t({ side: "long", pnlR: 1.4, reason: "tp", mfeR: 1.5, capture: 0.93, i: 1 }),
      t({ side: "long", pnlR: 1.2, reason: "tp", mfeR: 1.3, capture: 0.92, i: 2 }),
      t({ side: "short", pnlR: -1, reason: "sl", mfeR: 0.1, maeR: 1.05, i: 3 }),
      t({ side: "short", pnlR: -1, reason: "sl", mfeR: 0.05, maeR: 1.1, i: 4 }),
      t({ side: "short", pnlR: -1, reason: "sl", mfeR: 0.2, maeR: 1.02, i: 5 }),
      t({ side: "short", pnlR: 0.1, reason: "be", mfeR: 0.4, scratch: true, noProfit: false, i: 6 }),
    ];
    const a = analyzeBacktest(rows, 9);
    assert.equal(a.n, 7);
    assert.equal(a.signals, 9);
    const shorts = a.bySide.find((s) => s.key === "short");
    const longs = a.bySide.find((s) => s.key === "long");
    assert.ok(shorts && longs);
    assert.ok(shorts.slPct > longs.slPct);
    assert.ok(a.findings.some((f) => f.kind === "side_sl_heavy" && f.side === "short"));
    assert.ok(a.findings.some((f) => f.kind === "side_strong" && f.side === "long"));
    assert.equal(a.worstStops[0]?.side, "short");
    assert.equal(a.bestWins[0]?.side, "long");
  });

  it("separates tiny profits from real winners and givebacks", () => {
    const rows: AnalyzedTrade[] = [
      t({ side: "long", pnlR: 0.12, reason: "be", scratch: true, noProfit: false, mfeR: 0.5, givebackR: 0.38, stoppedFromProfit: true, i: 0 }),
      t({ side: "long", pnlR: 0.08, reason: "be", scratch: true, noProfit: false, mfeR: 0.6, givebackR: 0.52, stoppedFromProfit: true, i: 1 }),
      t({ side: "long", pnlR: 2.2, reason: "tp", mfeR: 2.3, capture: 0.96, i: 2 }),
      t({ side: "short", pnlR: -1, reason: "sl", missedTp: true, mfeR: 1.9, plannedRr: 2, givebackR: 1.9, stoppedFromProfit: true, i: 3 }),
      t({ side: "short", pnlR: -1, reason: "sl", missedTp: true, mfeR: 1.8, plannedRr: 2, i: 4 }),
      t({ side: "short", pnlR: 0, reason: "be", noProfit: true, mfeR: 0.4, stoppedFromProfit: true, i: 5 }),
      t({ side: "long", pnlR: 0.2, reason: "be", scratch: true, noProfit: false, i: 6 }),
      t({ side: "long", pnlR: 1.8, reason: "tp", mfeR: 1.9, capture: 0.95, i: 7 }),
    ];
    const a = analyzeBacktest(rows);
    assert.ok(a.scratchN >= 3);
    assert.ok(a.missedTpN >= 2);
    assert.ok(a.givebacks.length >= 3);
    assert.ok(a.findings.some((f) => f.kind === "scratch_heavy" || f.kind === "giveback_heavy"));
    assert.ok(a.findings.some((f) => f.kind === "missed_tp"));
    assert.equal(a.hist.find((h) => h.key === "0-0.3")?.n, 4);
  });

  it("ranks indicator · timeframe · side batches for engine work", () => {
    const rows: AnalyzedTrade[] = [
      t({ side: "short", pnlR: -1, reason: "sl", indicator: "APEX1", timeframe: "15m", i: 0 }),
      t({ side: "short", pnlR: -1, reason: "sl", indicator: "APEX1", timeframe: "15m", i: 1 }),
      t({ side: "short", pnlR: -1, reason: "sl", indicator: "APEX1", timeframe: "15m", i: 2 }),
      t({ side: "long", pnlR: 1.5, reason: "tp", indicator: "TREX1", timeframe: "1h", i: 3 }),
      t({ side: "long", pnlR: 1.2, reason: "tp", indicator: "TREX1", timeframe: "1h", i: 4 }),
      t({ side: "long", pnlR: 0.1, reason: "be", indicator: "TREX1", timeframe: "1h", scratch: true, noProfit: false, i: 5 }),
      t({ side: "long", pnlR: 0.05, reason: "be", indicator: "KETEX", timeframe: "5m", scratch: true, noProfit: false, i: 6 }),
      t({ side: "long", pnlR: -0.2, reason: "be", indicator: "KETEX", timeframe: "5m", i: 7 }),
    ];
    const a = analyzeBacktest(rows);
    assert.ok(a.byCombo.some((s) => s.key === "APEX1 · 15m · short" && s.slPct === 100));
    assert.ok(a.findings.some((f) => f.kind === "combo_sl_heavy" && f.extra === "APEX1 · 15m · short"));
    assert.ok(a.findings.some((f) => f.kind === "combo_strong" && f.extra === "TREX1 · 1h · long"));
    assert.ok(a.findings.some((f) => f.kind === "combo_dead"));
    const ketex = a.byCombo.find((s) => s.key.includes("KETEX"));
    assert.ok(ketex && ketex.deadPct >= 50);
  });

  it("compares Pre-Arm, FTC Limit, and Market origins cleanly and flags leaders/leaks", () => {
    const rows: AnalyzedTrade[] = [
      t({ side: "long", pnlR: 2, pnl: 40, reason: "tp", entryOrigin: "pre_arm", entryWhy: "Pre-arm FTC limit · FTC limit fill", i: 0 }),
      t({ side: "long", pnlR: 1.5, pnl: 30, reason: "tp", entryOrigin: "pre_arm", entryWhy: "Pre-arm FTC limit · FTC limit fill", i: 1 }),
      t({ side: "short", pnlR: -1, pnl: -20, reason: "sl", entryOrigin: "armed_limit", entryWhy: "APEX 1R · FTC limit fill", i: 2 }),
      t({ side: "short", pnlR: -1, pnl: -20, reason: "sl", entryOrigin: "armed_limit", entryWhy: "APEX 1R · FTC limit fill", i: 3 }),
      t({ side: "long", pnlR: 0.5, pnl: 10, reason: "tp", entryOrigin: "market", entryWhy: "TREX 1.0R bar close", i: 4 }),
    ];
    const a = analyzeBacktest(rows);
    assert.deepEqual(
      a.byEntryOrigin.map((o) => o.key),
      ["pre_arm", "armed_limit", "market"],
    );
    const pre = a.byEntryOrigin.find((o) => o.key === "pre_arm");
    const armed = a.byEntryOrigin.find((o) => o.key === "armed_limit");
    assert.equal(pre?.wr, 100);
    assert.equal(pre?.netUsd, 70);
    assert.equal(armed?.slPct, 100);
    assert.equal(armed?.netUsd, -40);
    assert.ok(a.findings.some((f) => f.kind === "origin_strong" && f.extra === "pre_arm"));
    assert.ok(a.findings.some((f) => f.kind === "origin_weak" && f.extra === "armed_limit"));
  });

  it("empty window yields a single no_trades finding", () => {
    const a = analyzeBacktest([]);
    assert.equal(a.n, 0);
    assert.deepEqual(
      a.findings.map((f) => f.kind),
      ["no_trades"],
    );
  });
});

describe("journalToAnalyzed + authenticity", () => {
  it("maps closed paper fills into the analyzer", () => {
    const row = {
      id: 1,
      mode: "paper",
      venue: "paper",
      symbol: "BTCUSDT",
      timeframe: "15m",
      indicator: "APEX1",
      side: "long",
      entry: 100,
      sl: 99,
      tp: 102,
      qty: 1,
      leverage: 10,
      notional_usd: 1000,
      risk_usd: 10,
      opened_at: "2026-01-01T00:00:00.000Z",
      closed_at: "2026-01-01T03:00:00.000Z",
      exit_px: 102,
      exit_reason: "tp",
      pnl_usd: 18,
      pnl_r: 2,
      fees_usd: 1,
      status: "closed",
      exchange_order_id: null,
      orig_sl: 99,
      mae_r: 0.2,
      mfe_r: 2.1,
      bars_held: 12,
      signal_reason: "APEX 1R FTC long",
      rr_planned: 2,
    } as JournalTrade;
    const [one] = journalToAnalyzed([row, { ...row, id: 2, status: "open" }]);
    assert.equal(one?.reason, "tp");
    assert.equal(one?.indicator, "APEX1");
    assert.equal(one?.missedTp, false);
    assert.ok((one?.capture ?? 0) > 0.9);
    const a = analyzeBacktest(journalToAnalyzed([row]));
    assert.equal(a.n, 1);
    assert.equal(a.byCombo[0]?.key, "APEX1 · 15m · long");
  });

  it("counts fee-negative BE fills as losses, preserves liq/trim exits, and excludes null excursions from avgMae/avgMfe", () => {
    const feeLossBe = {
      id: 10,
      mode: "paper",
      venue: "paper",
      symbol: "SOLUSDT",
      timeframe: "5m",
      indicator: "TREX1",
      side: "long",
      entry: 178.42,
      sl: 176.91,
      tp: 179.93,
      qty: 55,
      leverage: 20,
      notional_usd: 9813,
      risk_usd: 83,
      opened_at: "2026-01-01T00:00:00.000Z",
      closed_at: "2026-01-01T01:00:00.000Z",
      exit_px: 178.44,
      exit_reason: "be",
      pnl_usd: -6,
      pnl_r: 0.01,
      fees_usd: 8,
      status: "closed",
      exchange_order_id: null,
      orig_sl: 176.91,
      mae_r: 0.2,
      mfe_r: 0.5,
      bars_held: 14,
      signal_reason: "Pre-arm FTC limit · FTC limit fill",
      rr_planned: 1,
    } as JournalTrade;

    const liqRow = {
      ...feeLossBe,
      id: 11,
      symbol: "DOGEUSDT",
      exit_reason: "liq",
      pnl_usd: -120,
      pnl_r: -1.5,
      mae_r: null,
      mfe_r: null,
      bars_held: null,
      signal_reason: "APEX 1R · FTC limit fill",
    } as JournalTrade;

    const trimRow = {
      ...feeLossBe,
      id: 12,
      symbol: "AVAXUSDT",
      exit_reason: "excess trim",
      pnl_usd: 15,
      pnl_r: 0.18,
      mae_r: null,
      mfe_r: null,
      bars_held: null,
      signal_reason: "HALC box · bar close",
    } as JournalTrade;

    const analyzed = journalToAnalyzed([feeLossBe, liqRow, trimRow]);
    assert.equal(analyzed[0]?.entryOrigin, "pre_arm");
    assert.equal(analyzed[0]?.noProfit, true);
    assert.equal(analyzed[1]?.reason, "liq");
    assert.equal(analyzed[1]?.hasExcursion, false);
    assert.equal(analyzed[2]?.reason, "excess trim");

    const stats = analyzeBacktest(analyzed);
    assert.equal(stats.liqN, 1);
    assert.equal(stats.trimN, 1);
    assert.equal(stats.excursionSampleN, 1);
    // Only the 1st trade had mae_r=0.2, mfe_r=0.5 (nulls must NOT drag average down toward 0)
    assert.ok(Math.abs(stats.avgMae - 0.2) < 1e-9);
    assert.ok(Math.abs(stats.avgMfe - 0.5) < 1e-9);
    // Only trimRow is net USD profitable (+15) -> 1/3 wins = 33.33%
    assert.ok(Math.abs(stats.wr - 100 / 3) < 0.05);
    assert.equal(stats.netUsd, -111);
    assert.equal(stats.feesUsd, 24);
  });

  it("identifies DEMO_JOURNAL rows cleanly without false-positiving real bot fills", async () => {
    const { isDemoSampleTrade, analyzeLimitFunnel } = await import("./backtest-analyze.ts");
    const sampleLike = {
      symbol: "BTCUSDT",
      timeframe: "15m",
      indicator: "APEX1",
      side: "long",
      entry: 108420,
      signal_reason: "APEX 1R FTC long · 15m · stop floor held",
      exchange_order_id: null,
    };
    const realBot = {
      symbol: "BTCUSDT",
      timeframe: "15m",
      indicator: "APEX1",
      side: "long",
      entry: 108420,
      signal_reason: "APEX 1R · Pre-arm FTC limit · FTC limit fill",
      exchange_order_id: null,
    };
    assert.equal(isDemoSampleTrade(sampleLike), true);
    assert.equal(isDemoSampleTrade(realBot), false);

    const funnel = analyzeLimitFunnel([
      { id: 1, mode: "paper", venue: "paper", symbol: "BTCUSDT", timeframe: "15m", indicator: "APEX1", side: "long", status: "filled", reason: "Pre-arm FTC limit" },
      { id: 2, mode: "paper", venue: "paper", symbol: "ETHUSDT", timeframe: "15m", indicator: "APEX1", side: "short", status: "cancelled", cancel_reason: "pattern failed", reason: "Pre-arm FTC limit" },
      { id: 3, mode: "paper", venue: "paper", symbol: "SOLUSDT", timeframe: "1h", indicator: "HALC", side: "long", status: "pending", reason: "HALC box FTC" },
      { id: 4, mode: "paper", venue: "paper", symbol: "DOGEUSDT", timeframe: "15m", indicator: "TREX1", side: "long", status: "filled", reason: "TREX 1.0R FTC limit" },
    ]);
    assert.equal(funnel.all.total, 4);
    assert.equal(funnel.preArm.filled, 1);
    assert.equal(funnel.preArm.cancelled, 1);
    assert.equal(funnel.preArm.fillRatePct, 50);
    assert.equal(funnel.preArm.cancelReasons[0]?.reason, "pattern failed");
    assert.equal(funnel.armedLimit.pending, 1);
    assert.equal(funnel.armedLimit.filled, 1);
    assert.equal(funnel.armedLimit.fillRatePct, 100);
  });
});
