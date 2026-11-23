import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  barFillKey,
  concurrentOpenCount,
  countHtfOpen,
  fillCoin,
  heldCoins,
  isHtfTf,
  leverageOverCap,
  marginOverBudget,
  remainingSlots,
  skipFill,
} from "./fill-gates.ts";

describe("fill gates — one coin, one candle, one fill", () => {
  it("treats FLORK and FLORKUSDT as the same coin", () => {
    assert.equal(fillCoin("FLORK"), "FLORK");
    assert.equal(fillCoin("FLORKUSDT"), "FLORK");
    assert.equal(barFillKey("FLORKUSDT", "15m", 100), barFillKey("FLORK", "15m", 100));
    const held = heldCoins(["FLORKUSDT"], ["FLORK"]);
    assert.equal(held.size, 1);
    assert.equal(held.has("FLORK"), true);
  });

  it("blocks a second engine on a coin that is already open", () => {
    const held = heldCoins(["FLORKUSDT"]);
    const skip = skipFill({
      coin: "FLORK",
      barKey: barFillKey("FLORK", "15m", 1),
      held,
      filledBars: new Set(),
      used: 0,
      remaining: 4,
    });
    assert.equal(skip, "already in symbol");
  });

  it("blocks TREX / SHETEX on the same 15m bar after the first engine filled — even if that trade already hit SL", () => {
    const bar = barFillKey("FLORKUSDT", "15m", 1_700_000_000_000);
    const filledBars = new Set([bar]);
    const skip = skipFill({
      coin: "FLORK",
      barKey: barFillKey("FLORK", "15m", 1_700_000_000_000),
      held: new Set(),
      filledBars,
      used: 0,
      remaining: 4,
    });
    assert.equal(skip, "already filled");
  });

  it("does not consume more concurrent slots than max_positions", () => {
    assert.equal(remainingSlots(3, 0, 0), 3);
    assert.equal(remainingSlots(3, 3, 0), 0);
    assert.equal(remainingSlots(3, 1, 3), 0);
    assert.equal(concurrentOpenCount(1, 4), 4);
    const skip = skipFill({
      coin: "BTC",
      barKey: "BTC|15m|1",
      held: new Set(),
      filledBars: new Set(),
      used: 3,
      remaining: 3,
    });
    assert.equal(skip, "max positions");
  });

  it("counts live venue rows when they outnumber the desk", () => {
    assert.equal(remainingSlots(4, 1, 4), 0);
    assert.equal(remainingSlots(4, 2, 1), 2);
  });

  it("blocks a stale candle the same way in paper and live", () => {
    assert.equal(
      skipFill({
        stale: true,
        coin: "BTC",
        barKey: "BTC|15m|1",
        held: new Set(),
        filledBars: new Set(),
        used: 0,
        remaining: 4,
      }),
      "stale bar",
    );
  });

  it("does not send a live order when the wallet or book was not read", () => {
    assert.equal(
      skipFill({
        coin: "BTC",
        barKey: "BTC|5m|1",
        held: new Set(),
        filledBars: new Set(),
        used: 0,
        remaining: 4,
        liveUnread: "live balance unread — not sending",
      }),
      "live balance unread — not sending",
    );
  });

  it("caps 1h+4h together so 5m/15m can still fill leftover slots", () => {
    const base = {
      coin: "ETH",
      barKey: "ETH|1h|1",
      held: new Set<string>(),
      filledBars: new Set<string>(),
      used: 4,
      remaining: 6,
      htfMax: 4,
      htfOpen: 4,
    };
    assert.equal(skipFill({ ...base, htf: true }), "htf cap");
    assert.equal(skipFill({ ...base, htf: false, barKey: "ETH|15m|1" }), "");
    assert.equal(skipFill({ ...base, htf: true, htfOpen: 3 }), "");
    assert.equal(skipFill({ ...base, htf: true, htfMax: 0 }), "");
  });

  it("counts only 1h and 4h as slow trades", () => {
    assert.equal(isHtfTf("1h"), true);
    assert.equal(isHtfTf("4h"), true);
    assert.equal(isHtfTf("15m"), false);
    assert.equal(countHtfOpen(["5m", "1h", "15m", "4h", "1h"]), 3);
  });
});

describe("live cap guards", () => {
  it("rejects a venue fill that came in above the asked leverage", () => {
    assert.equal(leverageOverCap(50, 25), true);
    assert.equal(leverageOverCap(25, 25), false);
    assert.equal(leverageOverCap(10, 25), false);
    assert.equal(leverageOverCap(0, 25), false);
  });

  it("rejects a fill whose margin overshoots the sized budget", () => {
    assert.equal(marginOverBudget(400, 300), true);
    assert.equal(marginOverBudget(301, 300), false);
    assert.equal(marginOverBudget(320, 300), true);
    assert.equal(marginOverBudget(300, 300), false);
  });
});
