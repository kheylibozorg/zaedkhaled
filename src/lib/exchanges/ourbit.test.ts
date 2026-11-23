import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listedFromOurbitContracts, listedFromOurbitTickers } from "./ourbit-listed.ts";
import {
  ourbitBarTimeMs,
  ourbitBody,
  ourbitCloseSide,
  ourbitKlineInterval,
  ourbitOpenSide,
  ourbitQuery,
  ourbitSign,
  ourbitTradeSide,
} from "./ourbit-sign.ts";

describe("OURBIT contract book", () => {
  it("keeps live USDT perps and drops hidden or inverse rows", () => {
    const fromBook = listedFromOurbitContracts(
      [
        { symbol: "BTC_USDT", quoteCoin: "USDT", state: 0, apiAllowed: true, isHidden: false, futureType: 1, maxLeverage: 500 },
        { symbol: "ETH_USDT", quoteCoin: "USDT", state: 0, apiAllowed: true, futureType: 1, maxLeverage: 200 },
        { symbol: "DOGE_USDC", quoteCoin: "USDC", state: 0, apiAllowed: true, futureType: 1, maxLeverage: 50 },
        { symbol: "XRP_USDT", quoteCoin: "USDT", state: 1, apiAllowed: true, futureType: 1, maxLeverage: 50 },
        { symbol: "SOL_USDT", quoteCoin: "USDT", state: 0, apiAllowed: false, futureType: 1, maxLeverage: 100 },
        { symbol: "PEPE_USDT", quoteCoin: "USDT", state: 0, apiAllowed: true, isHidden: true, futureType: 1, maxLeverage: 20 },
      ],
      new Map([["BTC_USDT", 9e9]]),
    );
    assert.equal(fromBook.length, 2);
    assert.equal(fromBook[0]?.base, "BTC");
    assert.equal(fromBook[0]?.venueSymbol, "BTC_USDT");
    assert.equal(fromBook[0]?.volume24hUsd, 9e9);
    assert.equal(fromBook[0]?.maxLeverage, 200);
    assert.equal(fromBook[1]?.base, "ETH");
    assert.equal(fromBook[1]?.maxLeverage, 200);
  });

  it("falls back to the 24h ticker book", () => {
    const fromTickers = listedFromOurbitTickers([
      { symbol: "SOL_USDT", amount24: "12" },
      { symbol: "ETHUSDT", amount24: "99" },
      { symbol: "SOL_USDT", amount24: "1" },
    ]);
    assert.equal(fromTickers.length, 1);
    assert.equal(fromTickers[0]?.base, "SOL");
    assert.equal(fromTickers[0]?.venueSymbol, "SOL_USDT");
  });
});

describe("OURBIT sign + enums", () => {
  it("signs accessKey + timestamp + params with HMAC-SHA256 hex", () => {
    const sig = ourbitSign("key", "secret", 1700000000000, "symbol=BTC_USDT");
    assert.equal(sig, "1103c061696e1decc6fe99b1ac06b463f7ac3e72d2e5126c549357ce9bd6231e");
    assert.equal(ourbitQuery({ b: 2, a: 1, skip: undefined }), "a=1&b=2");
    assert.equal(ourbitBody({ vol: 1, side: 1 }), '{"vol":1,"side":1}');
  });

  it("maps kline intervals, sides and unix seconds", () => {
    assert.equal(ourbitKlineInterval("5m"), "Min5");
    assert.equal(ourbitKlineInterval("1h"), "Min60");
    assert.equal(ourbitKlineInterval("4h"), "Hour4");
    assert.equal(ourbitOpenSide(true), 1);
    assert.equal(ourbitOpenSide(false), 3);
    assert.equal(ourbitCloseSide(true), 4);
    assert.equal(ourbitCloseSide(false), 2);
    assert.equal(ourbitTradeSide(4), "SELL");
    assert.equal(ourbitTradeSide(2), "BUY");
    assert.equal(ourbitBarTimeMs(1788972600), 1788972600000);
    assert.equal(ourbitBarTimeMs(1788972600000), 1788972600000);
  });
});
