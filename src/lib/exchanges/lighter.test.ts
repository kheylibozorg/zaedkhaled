import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyLighterProtection, parseLighterTrade, scaleLighterInt } from "./lighter.ts";

describe("Lighter unit helpers", () => {
  it("scales integers strictly >= 1 by market decimals", () => {
    assert.equal(scaleLighterInt(1.2345, 2), 123);
    assert.equal(scaleLighterInt(0.00001, 2), 1);
    assert.equal(scaleLighterInt(0.5, 4), 5000);
  });

  it("classifies reduce-only SL and TP orders accurately without counting entry orders", () => {
    const empty = classifyLighterProtection(
      [{ order_index: 1, reduce_only: false, type: "limit", price: 100 }],
      95,
      110,
    );
    assert.deepEqual(empty, { hasSl: false, hasTp: false, slPrice: undefined, tpPrice: undefined });

    const byType = classifyLighterProtection(
      [
        { order_index: 10, reduce_only: true, type: "stop-loss", trigger_price: 95 },
        { order_index: 11, reduce_only: true, type: "take-profit", trigger_price: 110 },
      ],
      95,
      110,
    );
    assert.deepEqual(byType, { hasSl: true, hasTp: true, slPrice: 95, tpPrice: 110 });

    const byPrice = classifyLighterProtection(
      [
        { order_index: 12, reduce_only: true, type: "trigger", trigger_price: 95.1 },
        { order_index: 13, reduce_only: true, type: "trigger", trigger_price: 109.9 },
      ],
      95,
      110,
    );
    assert.deepEqual(byPrice, { hasSl: true, hasTp: true, slPrice: 95.1, tpPrice: 109.9 });

    const slOnly = classifyLighterProtection(
      [{ order_index: 14, reduce_only: true, type: 2, trigger_price: 95 }],
      95,
      110,
    );
    assert.deepEqual(slOnly, { hasSl: true, hasTp: false, slPrice: 95, tpPrice: undefined });
  });

  it("maps Lighter raw trades to signed BUY/SELL VenueTrade rows with fee computation", () => {
    const buy = parseLighterTrade(
      {
        market_id: 1,
        ask_account_id: 99,
        bid_account_id: 42,
        ask_id: 1001,
        bid_id: 2002,
        is_maker_ask: true,
        price: "100",
        size: "2",
        usd_amount: "200",
        timestamp: 1700000000,
        taker_fee: 5,
        maker_fee: 2,
      },
      42,
    );
    assert.deepEqual(buy, {
      time: 1700000000000,
      side: "BUY",
      price: 100,
      qty: 2,
      realizedPnl: 0,
      commission: (200 * 5) / 10_000,
      orderId: "2002",
    });

    const makerSell = parseLighterTrade(
      {
        market_id: 1,
        ask_account_id: 42,
        bid_account_id: 88,
        ask_id: 3003,
        bid_id: 4004,
        is_maker_ask: true,
        price: "110",
        size: "2",
        usd_amount: "220",
        timestamp: 1700000600000,
        taker_fee: 5,
        maker_fee: 2,
      },
      42,
    );
    assert.deepEqual(makerSell, {
      time: 1700000600000,
      side: "SELL",
      price: 110,
      qty: 2,
      realizedPnl: 0,
      commission: (220 * 2) / 10_000,
      orderId: "3003",
    });

    assert.equal(parseLighterTrade({ ask_account_id: 1, bid_account_id: 2, price: "10", size: "1" }, 42), null);
  });
});
