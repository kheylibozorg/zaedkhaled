import assert from "node:assert/strict";
import test from "node:test";
import { selectExcessToClose } from "./excess-trim.ts";

test("selectExcessToClose returns empty when open positions are within maxPositions", () => {
  const res = selectExcessToClose(
    [
      {
        id: 1,
        symbol: "BTCUSDT",
        side: "long",
        entry: 100,
        qty: 1,
        risk_usd: 10,
        fees_usd: 0.1,
        opened_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 2,
        symbol: "ETHUSDT",
        side: "short",
        entry: 200,
        qty: 1,
        risk_usd: 10,
        fees_usd: 0.1,
        opened_at: "2026-01-01T00:05:00Z",
      },
    ],
    2,
    { BTCUSDT: 99, ETHUSDT: 205 },
  );
  assert.equal(res.length, 0);
});

test("selectExcessToClose picks positions with highest PnL / smallest loss first", () => {
  const positions = [
    {
      id: 1,
      symbol: "LOSER_BIG",
      side: "long",
      entry: 100,
      qty: 10,
      risk_usd: 50,
      fees_usd: 0.5,
      notional_usd: 1000,
      opened_at: "2026-01-01T00:00:00Z",
    },
    {
      id: 2,
      symbol: "LOSER_TINY",
      side: "long",
      entry: 100,
      qty: 10,
      risk_usd: 50,
      fees_usd: 0.5,
      notional_usd: 1000,
      opened_at: "2026-01-01T00:01:00Z",
    },
    {
      id: 3,
      symbol: "SMALL_GREEN",
      side: "short",
      entry: 100,
      qty: 10,
      risk_usd: 50,
      fees_usd: 0.5,
      notional_usd: 1000,
      opened_at: "2026-01-01T00:02:00Z",
    },
    {
      id: 4,
      symbol: "LOSER_MID",
      side: "long",
      entry: 100,
      qty: 10,
      risk_usd: 50,
      fees_usd: 0.5,
      notional_usd: 1000,
      opened_at: "2026-01-01T00:03:00Z",
    },
  ];

  // Max 2 concurrent -> 2 excess must be closed: SMALL_GREEN (+$10) and LOSER_TINY (-$1)
  const victims = selectExcessToClose(positions, 2, {
    LOSER_BIG: 95,    // -$50
    LOSER_TINY: 99.9, // -$1
    SMALL_GREEN: 99,  // +$10 (short)
    LOSER_MID: 98,    // -$20
  });

  assert.equal(victims.length, 2);
  assert.equal(victims[0]?.position.symbol, "SMALL_GREEN");
  assert.equal(victims[1]?.position.symbol, "LOSER_TINY");
});
