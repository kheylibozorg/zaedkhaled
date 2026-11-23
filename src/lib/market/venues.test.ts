import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nativeSymbol, coinOf, bookVenue, isTradeableBase, venueLabel, looksLikeFallbackUniverse, chartHostLabel } from "../exchanges/meta.ts";
import { listedFromOurbitContracts, listedFromOurbitTickers } from "../exchanges/ourbit-listed.ts";
import { barFromBinanceRow, barFromHlCandle, barFromLighterCandle, barsFromOurbitKline, klineWindow, sortBars } from "./ohlcv.ts";

describe("venue-native markets", () => {
  it("names the pair the way that venue books it", () => {
    assert.equal(nativeSymbol("aster", "BTCUSDT"), "BTCUSDT");
    assert.equal(nativeSymbol("paper", "ETHUSDT"), "ETHUSDT");
    assert.equal(nativeSymbol("ourbit", "BTCUSDT"), "BTC_USDT");
    assert.equal(nativeSymbol("ourbit", "SOL"), "SOL_USDT");
    assert.equal(nativeSymbol("hyperliquid", "BTCUSDT"), "BTC");
    assert.equal(nativeSymbol("lighter", "ETHUSDT"), "ETH");
  });

  it("strips OURBIT underscore tails to the coin", () => {
    assert.equal(coinOf("BTC_USDT"), "BTC");
    assert.equal(coinOf("BTCUSDT"), "BTC");
    assert.equal(coinOf("BTC"), "BTC");
  });

  it("always sends a startTime window so OURBIT/Lighter are not one-bar replies", () => {
    const w = klineWindow("5m", 360, 1_700_000_000_000);
    assert.equal(w.count, 360);
    assert.equal(w.end - w.start, 360 * 5 * 60 * 1000);
    assert.ok(w.start < w.end);
  });

  it("parses Binance-style, Hyperliquid, Lighter and OURBIT candles to the same bar shape", () => {
    const binance = barFromBinanceRow([1_700, "10", "12", "9", "11", "33"]);
    const hl = barFromHlCandle({ t: 1_700, o: "10", h: "12", l: "9", c: "11", v: "33" });
    const lighter = barFromLighterCandle({ t: 1_700, o: 10, h: 12, l: 9, c: 11, v: 33 });
    const ourbit = barsFromOurbitKline(
      { time: [1.7], open: [10], high: [12], low: [9], close: [11], vol: [33] },
      10,
    )[0];
    assert.deepEqual(binance, { time: 1700, open: 10, high: 12, low: 9, close: 11, volume: 33 });
    assert.deepEqual(hl, binance);
    assert.deepEqual(lighter, binance);
    assert.deepEqual(ourbit, { time: 1700, open: 10, high: 12, low: 9, close: 11, volume: 33 });
    assert.equal(barFromBinanceRow(["x"]), null);
    assert.equal(barFromHlCandle({ t: 1, o: "bad" }), null);
  });

  it("sorts mixed candle order and drops dupes", () => {
    const out = sortBars(
      [
        { time: 3, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { time: 3, open: 2, high: 2, low: 2, close: 2, volume: 2 },
      ],
      10,
    );
    assert.deepEqual(
      out.map((b) => b.time),
      [1, 3],
    );
    assert.equal(out[1]?.close, 2);
  });

  it("book follows the selected venue even when fills are paper", () => {
    assert.equal(bookVenue("hyperliquid"), "hyperliquid");
    assert.equal(bookVenue("lighter"), "lighter");
    assert.equal(bookVenue("aster"), "aster");
    assert.equal(bookVenue("ourbit"), "ourbit");
    assert.equal(bookVenue("toobit"), "ourbit");
    assert.equal(bookVenue("paper"), "paper");
    assert.equal(bookVenue(null), "paper");
    assert.equal(bookVenue("nope"), "paper");
    assert.equal(venueLabel("ourbit"), "OURBIT");
    assert.equal(chartHostLabel("paper"), "Aster");
    assert.equal(chartHostLabel("aster"), "Aster");
    assert.equal(chartHostLabel("ourbit"), "OURBIT");
    assert.equal(chartHostLabel("hyperliquid"), "Hyperliquid");
  });

  it("skips stables and HIP-3 prefixes from the tradeable book", () => {
    assert.equal(isTradeableBase("BTCUSDT"), "BTC");
    assert.equal(isTradeableBase("ETH_USDT"), "ETH");
    assert.equal(isTradeableBase("USDT"), "");
    assert.equal(isTradeableBase("USDC"), "");
    assert.equal(isTradeableBase("xyz:TSLA"), "");
    assert.equal(isTradeableBase("kPEPE"), "KPEPE");
  });

  it("builds OURBIT perps from contract detail and from tickers", () => {
    const fromBook = listedFromOurbitContracts(
      [
        { symbol: "BTC_USDT", quoteCoin: "USDT", state: 0, apiAllowed: true, futureType: 1, maxLeverage: 100 },
        { symbol: "ETH_USDT", quoteCoin: "USDT", state: 0, apiAllowed: true, futureType: 1 },
        { symbol: "DOGE_USDC", quoteCoin: "USDC", state: 0, apiAllowed: true, futureType: 1 },
      ],
      new Map([["BTC_USDT", 9e9]]),
    );
    assert.equal(fromBook.length, 2);
    assert.equal(fromBook[0]?.base, "BTC");
    assert.equal(fromBook[0]?.venueSymbol, "BTC_USDT");
    assert.equal(fromBook[0]?.volume24hUsd, 9e9);
    assert.equal(fromBook[0]?.maxLeverage, 100);

    const fromTickers = listedFromOurbitTickers([
      { symbol: "SOL_USDT", amount24: "12" },
      { symbol: "ETHUSDT", amount24: "99" },
    ]);
    assert.equal(fromTickers.length, 1);
    assert.equal(fromTickers[0]?.base, "SOL");
    assert.equal(fromTickers[0]?.venueSymbol, "SOL_USDT");
  });

  it("flags the emergency 10-coin list so the desk retries the live book", () => {
    const rows = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE", "ADA", "TRX", "AVAX", "LINK"].map((base) => ({ base }));
    assert.equal(looksLikeFallbackUniverse(rows), true);
    assert.equal(looksLikeFallbackUniverse(rows.concat({ base: "SUI" })), false);
    assert.equal(looksLikeFallbackUniverse([{ base: "BTC" }]), false);
  });
});
