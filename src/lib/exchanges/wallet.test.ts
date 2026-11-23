import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachAvailable, freeCapitalUsd, usedMarginUsd } from "./wallet.ts";

describe("usedMarginUsd", () => {
  it("locks notional / leverage for each open fill", () => {
    const used = usedMarginUsd([
      { notional_usd: 7500, leverage: 25 },
      { notional_usd: 5000, leverage: 5 },
    ]);
    assert.equal(used, 300 + 1000);
  });
});

describe("freeCapitalUsd", () => {
  it("paper: free = equity minus locked margin", () => {
    assert.equal(freeCapitalUsd({ equity: 10_000, usedMargin: 300 }), 9700);
  });

  it("live: uses the venue available pile and ignores locked margin", () => {
    assert.equal(
      freeCapitalUsd({ equity: 10_000, usedMargin: 9000, available: 850 }),
      850,
    );
  });
});

describe("attachAvailable", () => {
  it("paper desk shows equity minus open margin", () => {
    const s = attachAvailable(
      { mode: "paper", equityUsd: 10_000, availableUsd: undefined as number | undefined },
      [{ notional_usd: 7500, leverage: 25 }],
    );
    assert.equal(s.availableUsd, 9700);
  });

  it("live desk keeps the wallet available number", () => {
    const s = attachAvailable(
      { mode: "live", equityUsd: 10_000, availableUsd: 820 },
      [{ notional_usd: 9000, leverage: 10 }],
    );
    assert.equal(s.availableUsd, 820);
  });
});
