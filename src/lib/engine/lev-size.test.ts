import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CAPITAL_PCT,
  DEFAULT_LEV_SIZE_TIERS,
  capitalPctForLeverage,
  clampCapitalPct,
  notionalPctOfEquity,
  parseCapitalBase,
  parseLevSizeTiers,
} from "./lev-size.ts";

describe("lev-size buckets", () => {
  it("buckets on the coin's max leverage, not the used (capped) leverage", () => {
    const tiers = DEFAULT_LEV_SIZE_TIERS;
    const d = DEFAULT_CAPITAL_PCT;
    const coinMax = 50;
    const used = 25;
    assert.equal(capitalPctForLeverage(coinMax, d, tiers), 3);
    assert.equal(notionalPctOfEquity(3, used), 75);
    assert.equal(capitalPctForLeverage(5, d, tiers), 15);
    assert.equal(notionalPctOfEquity(15, 5), 75);
  });

  it("uses the user's numbers: 5→15, 10→12, 25→6, else default 3", () => {
    const tiers = DEFAULT_LEV_SIZE_TIERS;
    const d = DEFAULT_CAPITAL_PCT;
    assert.equal(capitalPctForLeverage(5, d, tiers), 15);
    assert.equal(capitalPctForLeverage(10, d, tiers), 12);
    assert.equal(capitalPctForLeverage(25, d, tiers), 6);
    assert.equal(capitalPctForLeverage(20, d, tiers), 3);
    assert.equal(capitalPctForLeverage(50, d, tiers), 3);
    assert.equal(capitalPctForLeverage(200, d, tiers), 3);
  });

  it("5x at 15% matches 25x at 3% notional (75% of equity)", () => {
    assert.equal(notionalPctOfEquity(15, 5), 75);
    assert.equal(notionalPctOfEquity(3, 25), 75);
    assert.equal(notionalPctOfEquity(12, 10), 120);
    assert.equal(notionalPctOfEquity(6, 25), 150);
  });

  it("matches the leverage actually used after rounding, not a range", () => {
    const tiers = parseLevSizeTiers([
      { leverage: 5, capitalPct: 15 },
      { leverage: 10, capitalPct: 12 },
    ]);
    assert.equal(capitalPctForLeverage(5.4, 3, tiers), 15);
    assert.equal(capitalPctForLeverage(4, 3, tiers), 3);
    assert.equal(capitalPctForLeverage(6, 3, tiers), 3);
  });

  it("parses json, drops dupes, clamps pct, keeps custom rows", () => {
    const tiers = parseLevSizeTiers(
      JSON.stringify([
        { leverage: 50, capitalPct: 4 },
        { leverage: 5, capitalPct: 15 },
        { leverage: 5, capitalPct: 99 },
        { leverage: 0, capitalPct: 10 },
        { leverage: 25, capitalPct: 6 },
      ]),
    );
    assert.deepEqual(
      tiers.map((t) => t.leverage),
      [5, 25, 50],
    );
    assert.equal(tiers[2]?.capitalPct, 4);
    assert.equal(capitalPctForLeverage(50, 3, tiers), 4);
  });

  it("falls back to the published defaults on garbage input", () => {
    assert.deepEqual(
      parseLevSizeTiers("nope").map((t) => t.leverage),
      [5, 10, 25],
    );
    assert.equal(clampCapitalPct(Number.NaN), 3);
    assert.equal(clampCapitalPct(0), 1);
    assert.equal(clampCapitalPct(140), 100);
  });

  it("parses the capital base toggle, defaulting to total", () => {
    assert.equal(parseCapitalBase("free"), "free");
    assert.equal(parseCapitalBase("FREE"), "free");
    assert.equal(parseCapitalBase("total"), "total");
    assert.equal(parseCapitalBase(""), "total");
    assert.equal(parseCapitalBase(null), "total");
  });
});
