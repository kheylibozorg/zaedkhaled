import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PAPER_MAKER_BPS,
  PAPER_MIN_NOTIONAL_USD,
  PAPER_TAKER_BPS,
  applyPaperSlippage,
  barsAfterFill,
  closeFromVenueTrades,
  estimatePaperFee,
  estimatePaperFundingUsd,
  exitPathBars,
  liveFillReverted,
  netClosePnl,
  paperLiquidationPrice,
  paperSlippageBps,
  pathExcursion,
  rebaseStopsFromFill,
  resolveLimitFill5mTime,
  sizePosition,
  walkPath,
} from "./paper.ts";
import { TF_MS, type Bar } from "./types.ts";

function bar(i: number, o: Partial<Bar> = {}): Bar {
  const t0 = Date.UTC(2024, 0, 1);
  return {
    time: t0 + i * 5 * 60_000,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: 1,
    ...o,
  };
}

describe("liveFillReverted — do not flatten a wick back at entry", () => {
  it("is reverted when price is back at entry after the paper stop was tagged", () => {
    assert.equal(liveFillReverted({ entry: 0.3225, exit: 0.3253, last: 0.3226 }), true);
  });
  it("is not reverted when price is still at the paper stop or target", () => {
    assert.equal(liveFillReverted({ entry: 10.474, exit: 10.59, last: 10.58 }), false);
    assert.equal(liveFillReverted({ entry: 10.474, exit: 9.2, last: 9.21 }), false);
  });
  it("does not treat a break-even exit as reverted", () => {
    assert.equal(liveFillReverted({ entry: 10.474, exit: 10.474, last: 10.48 }), false);
  });
});

describe("barsAfterFill — wait for the next closed candle", () => {
  it("does not use the signal candle as an exit path", () => {
    const tf = 5 * 60_000;
    const t0 = Date.UTC(2024, 0, 1);
    const signal = bar(0);
    const next = bar(1, { high: 111, close: 110 });
    assert.deepEqual(
      barsAfterFill([signal, next], t0, tf).map((b) => b.time),
      [next.time],
    );
  });
  it("returns empty while the next candle is still forming — leave the trade open", () => {
    const tf = 5 * 60_000;
    const t0 = Date.UTC(2024, 0, 1);
    assert.equal(barsAfterFill([bar(0)], t0, tf).length, 0);
  });
});

describe("walkPath — SL/TP across missed ticks", () => {
  it("closes on an older 5m bar even if the latest bar never tagged SL", () => {
    const bars: Bar[] = [
      bar(0),
      bar(1, { low: 89, high: 100.1, close: 95 }),
      bar(2, { low: 99.5, high: 100.4, close: 100 }),
    ];
    const hit = walkPath({
      side: "long",
      entry: 100,
      sl: 90,
      tp: 110,
      bars,
    });
    assert.equal(hit.hit?.reason, "sl");
    assert.equal(hit.hit?.exit, 90);
    assert.equal(hit.hit?.barTime, bars[1]!.time);
  });

  it("takes the first chronological hit, not the last bar", () => {
    const bars: Bar[] = [
      bar(0, { high: 111, low: 99.9, close: 110 }),
      bar(1, { high: 100.1, low: 89, close: 90 }),
    ];
    const hit = walkPath({
      side: "long",
      entry: 100,
      sl: 90,
      tp: 110,
      bars,
    });
    assert.equal(hit.hit?.reason, "tp");
    assert.equal(hit.hit?.exit, 110);
  });

  it("moves TREX stop to entry after +0.35R then can BE-exit on a later bar", () => {
    const bars: Bar[] = [
      bar(0, { high: 104, low: 100.1, close: 103.5 }),
      bar(1, { high: 103.2, low: 99.9, close: 100 }),
    ];
    const hit = walkPath({
      side: "long",
      entry: 100,
      sl: 90,
      tp: 110,
      bars,
      beAtR: 0.35,
    });
    assert.equal(hit.beMoved, true);
    assert.equal(hit.hit?.reason, "be");
    assert.equal(hit.hit?.exit, 100);
    assert.equal(hit.hit?.barTime, bars[1]!.time);
  });
});

describe("pathExcursion", () => {
  it("tracks MAE against the trade and MFE in favor, in R", () => {
    const bars: Bar[] = [
      bar(0, { low: 98, high: 101, close: 100 }),
      bar(1, { low: 96, high: 108, close: 107 }),
    ];
    const x = pathExcursion({
      side: "long",
      entry: 100,
      origSl: 90,
      bars,
    });
    assert.equal(x.maeR, 0.4);
    assert.equal(x.mfeR, 0.8);
  });
});

describe("rebaseStopsFromFill", () => {
  it("shifts SL/TP by the live fill vs paper entry, keeping distances", () => {
    const out = rebaseStopsFromFill({ paperEntry: 100, fill: 100.5, sl: 98, tp: 104 });
    assert.equal(out.sl, 98.5);
    assert.equal(out.tp, 104.5);
  });

  it("leaves SL/TP alone when fill is missing", () => {
    const out = rebaseStopsFromFill({ paperEntry: 100, fill: 0, sl: 98, tp: 104 });
    assert.equal(out.sl, 98);
    assert.equal(out.tp, 104);
  });
});

describe("closeFromVenueTrades", () => {
  it("uses venue closing fills for exit VWAP and realized PnL minus fees", () => {
    const openedAt = Date.UTC(2024, 0, 1, 12);
    const hit = closeFromVenueTrades({
      side: "long",
      entry: 100,
      openedAt,
      trades: [
        { time: openedAt, side: "BUY", price: 100.4, qty: 1, realizedPnl: 0, commission: -0.04 },
        { time: openedAt + 60_000, side: "SELL", price: 104, qty: 1, realizedPnl: 3.6, commission: -0.04 },
      ],
    });
    assert.ok(hit);
    assert.equal(hit!.exit, 104);
    assert.equal(Number(hit!.pnl.toFixed(4)), 3.52);
    assert.equal(Number(hit!.fees.toFixed(4)), 0.08);
  });

  it("falls back to gross minus actual commissions when the venue omits realized PnL", () => {
    const openedAt = Date.UTC(2024, 0, 1, 12);
    const hit = closeFromVenueTrades({
      side: "long",
      entry: 100,
      openedAt,
      trades: [
        { time: openedAt, side: "BUY", price: 100, qty: 2, realizedPnl: 0, commission: 0.08 },
        { time: openedAt + 60_000, side: "SELL", price: 110, qty: 2, realizedPnl: 0, commission: 0.088 },
      ],
    });
    assert.ok(hit);
    assert.equal(hit!.exit, 110);
    assert.equal(Number(hit!.fees.toFixed(4)), 0.168);
    assert.equal(Number(hit!.pnl.toFixed(4)), 20 - 0.168);
  });
});

describe("sizePosition — margin % × coin leverage", () => {
  it("5x at 15% matches 25x at 3% notional on $10k", () => {
    const low = sizePosition({ equity: 10_000, capitalPct: 15, entry: 100, sl: 98, leverage: 5 });
    const high = sizePosition({ equity: 10_000, capitalPct: 3, entry: 100, sl: 98, leverage: 25 });
    assert.ok(low && high);
    assert.equal(low.margin, 1500);
    assert.equal(high.margin, 300);
    assert.equal(low.notional, 7500);
    assert.equal(high.notional, 7500);
    assert.equal(low.qty, 75);
    assert.equal(high.qty, 75);
  });

  it("10x at 12% and 25x at 6% size to the configured notional", () => {
    const ten = sizePosition({ equity: 10_000, capitalPct: 12, entry: 50, sl: 49, leverage: 10 });
    const twentyFive = sizePosition({ equity: 10_000, capitalPct: 6, entry: 50, sl: 49, leverage: 25 });
    assert.ok(ten && twentyFive);
    assert.equal(ten.notional, 12_000);
    assert.equal(twentyFive.notional, 15_000);
  });

  it("sizes each fill as a percent of remaining free capital, not total equity", () => {
    const first = sizePosition({ equity: 10_000, capitalPct: 3, entry: 100, sl: 98, leverage: 25, capitalBase: "free" });
    assert.ok(first);
    assert.equal(first.margin, 300);

    const second = sizePosition({
      equity: 10_000,
      capitalPct: 15,
      entry: 50,
      sl: 49,
      leverage: 5,
      usedMargin: first.margin,
      capitalBase: "free",
    });
    assert.ok(second);
    assert.equal(second.margin, (10_000 - 300) * 0.15);
    assert.equal(second.notional, second.margin * 5);
  });

  it("from total equity keeps 15% of the whole account on the second fill", () => {
    const first = sizePosition({ equity: 10_000, capitalPct: 3, entry: 100, sl: 98, leverage: 25, capitalBase: "total" });
    assert.ok(first);
    assert.equal(first.margin, 300);

    const second = sizePosition({
      equity: 10_000,
      capitalPct: 15,
      entry: 50,
      sl: 49,
      leverage: 5,
      usedMargin: first.margin,
      capitalBase: "total",
    });
    assert.ok(second);
    assert.equal(second.margin, 1500);
  });

  it("uses the live available pile and ignores locked margin", () => {
    const sized = sizePosition({
      equity: 10_000,
      capitalPct: 15,
      entry: 100,
      sl: 98,
      leverage: 5,
      usedMargin: 9000,
      available: 850,
      capitalBase: "free",
    });
    assert.ok(sized);
    assert.equal(sized.margin, 850 * 0.15);
  });

  it("from total still never spends more than free cash", () => {
    const sized = sizePosition({
      equity: 10_000,
      capitalPct: 15,
      entry: 100,
      sl: 98,
      leverage: 5,
      usedMargin: 9200,
      capitalBase: "total",
    });
    assert.ok(sized);
    assert.equal(Number(sized.margin.toFixed(6)), 800 * 0.995);
  });

  it("sizes a leftover free pile instead of refusing the fill", () => {
    const sized = sizePosition({
      equity: 10_000,
      capitalPct: 15,
      entry: 100,
      sl: 98,
      leverage: 5,
      usedMargin: 9200,
      capitalBase: "free",
    });
    assert.ok(sized);
    assert.equal(Number(sized.margin.toFixed(6)), 120);
  });

  it("refuses when nothing is free", () => {
    const sized = sizePosition({
      equity: 10_000,
      capitalPct: 15,
      entry: 100,
      sl: 98,
      leverage: 5,
      usedMargin: 10_000,
    });
    assert.equal(sized, null);
  });
});

describe("netClosePnl — journal writes net dollars after round-trip fees", () => {
  it("subtracts open + close commission from gross and stores net R", () => {
    const openFee = (100 * 1 * 4) / 10000;
    const closeFee = (110 * 1 * 4) / 10000;
    const settled = netClosePnl({
      side: "long",
      entry: 100,
      exit: 110,
      qty: 1,
      riskUsd: 10,
      openFee,
    });
    assert.equal(Number(settled.fees.toFixed(6)), Number((openFee + closeFee).toFixed(6)));
    assert.equal(Number(settled.pnl.toFixed(6)), Number((10 - openFee - closeFee).toFixed(6)));
    assert.equal(settled.pnlR, settled.pnl / 10);
  });

  it("supports maker/taker fee rates and 8h funding accrual", () => {
    const openFee = estimatePaperFee(1000, PAPER_MAKER_BPS);
    const funding = estimatePaperFundingUsd(1000, 16 * 3_600_000);
    assert.equal(openFee, 0.2);
    assert.equal(Number(funding.toFixed(6)), 0.2);
    const settled = netClosePnl({
      side: "long",
      entry: 100,
      exit: 110,
      qty: 10,
      riskUsd: 50,
      openFeeBps: PAPER_MAKER_BPS,
      closeFeeBps: PAPER_MAKER_BPS,
      fundingUsd: funding,
    });
    const expectedCloseFee = (110 * 10 * PAPER_MAKER_BPS) / 10_000;
    assert.equal(Number(settled.fees.toFixed(6)), Number((openFee + expectedCloseFee + funding).toFixed(6)));
    assert.equal(Number(settled.pnl.toFixed(6)), Number((100 - settled.fees).toFixed(6)));
  });
});

describe("paper-live parity — slippage, min-notional, liquidation & HTF limit alignment", () => {
  it("applies 0 bps slippage for limit_open and tp_exit, positive adverse slippage for market_open and sl_exit", () => {
    assert.equal(paperSlippageBps({ entry: 100, atr: 1, kind: "limit_open" }), 0);
    assert.equal(paperSlippageBps({ entry: 100, atr: 1, kind: "tp_exit" }), 0);
    const mkt = paperSlippageBps({ entry: 100, atr: 1, kind: "market_open" });
    const sl = paperSlippageBps({ entry: 100, atr: 1, kind: "sl_exit" });
    assert.ok(mkt >= 3 && mkt <= 15);
    assert.ok(sl >= 4 && sl <= 18);
    assert.ok(applyPaperSlippage(100, "long", "open", mkt) > 100);
    assert.ok(applyPaperSlippage(100, "short", "open", mkt) < 100);
    assert.ok(applyPaperSlippage(100, "long", "close", sl) < 100);
    assert.ok(applyPaperSlippage(100, "short", "close", sl) > 100);
  });

  it("rejects positions below venue min notional and uses specified feeBps", () => {
    const tiny = sizePosition({
      equity: 100,
      capitalPct: 5,
      entry: 100,
      sl: 98,
      leverage: 1,
      minNotionalUsd: PAPER_MIN_NOTIONAL_USD,
    });
    assert.equal(tiny, null);
    const valid = sizePosition({
      equity: 100,
      capitalPct: 5,
      entry: 100,
      sl: 98,
      leverage: 5,
      minNotionalUsd: PAPER_MIN_NOTIONAL_USD,
      feeBps: PAPER_TAKER_BPS,
    });
    assert.ok(valid);
    assert.equal(valid.notional, 25);
    assert.equal(Number(valid.fees.toFixed(6)), (25 * PAPER_TAKER_BPS) / 10_000);
  });

  it("triggers liquidation inside walkPath before a wider SL is reached", () => {
    const liq = paperLiquidationPrice("long", 100, 20);
    assert.ok(liq > 94 && liq < 96);
    const hit = walkPath({
      side: "long",
      entry: 100,
      sl: 85,
      tp: 120,
      leverage: 20,
      bars: [bar(0, { high: 100.5, low: 94.5, close: 95 })],
    });
    assert.equal(hit.hit?.reason, "sl");
    assert.equal(hit.hit?.liquidated, true);
    assert.equal(hit.hit?.exit, liq);
  });

  it("anchors 4h limit fills to their exact 5m fill bar so subsequent 5m candles are monitored immediately", () => {
    const h4 = TF_MS["4h"];
    const m5 = TF_MS["5m"];
    const bar4h = Date.UTC(2024, 0, 1, 0, 0);
    const b0 = { ...bar(0), time: bar4h, low: 101, high: 102 };
    const b1 = { ...bar(1), time: bar4h + m5, low: 99.5, high: 101 }; // fills limit at 100
    const b2 = { ...bar(2), time: bar4h + 2 * m5, low: 98.5, high: 100 }; // immediately hits SL at 99!
    const fill5m = resolveLimitFill5mTime({
      bars5m: [b0, b1, b2],
      fillBarTime: bar4h,
      tfMs: h4,
      side: "long",
      entry: 100,
      sl: 99,
    });
    assert.equal(fill5m, b1.time);
    const monitored = exitPathBars({
      bars5m: [b0, b1, b2],
      barTime: bar4h,
      tfMs: h4,
      openedMs: fill5m!,
      isLimitFill: true,
    });
    assert.deepEqual(
      monitored.map((b) => b.time),
      [b2.time],
    );
  });
});
