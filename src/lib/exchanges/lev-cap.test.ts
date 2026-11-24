import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCoinWithinLeverageRange, normalizeLeverageRange, stackedUserLevCap } from "./lev-cap.ts";

describe("stackedUserLevCap", () => {
  it("keeps the user cap until N open trades exceed the stack cap", () => {
    assert.equal(stackedUserLevCap(200, [], 2, 75), 200);
    assert.equal(stackedUserLevCap(200, [200], 2, 75), 200);
    assert.equal(stackedUserLevCap(200, [200, 100], 2, 75), 75);
    assert.equal(stackedUserLevCap(200, [200, 100, 50], 2, 75), 75);
  });

  it("does not count trades at or below the stack cap", () => {
    assert.equal(stackedUserLevCap(200, [75, 75], 2, 75), 200);
    assert.equal(stackedUserLevCap(200, [50, 200], 2, 75), 200);
  });

  it("count 0 disables the rule", () => {
    assert.equal(stackedUserLevCap(200, [200, 200], 0, 75), 200);
  });

  it("never raises the user cap", () => {
    assert.equal(stackedUserLevCap(50, [200, 200], 2, 75), 50);
  });

  it("uses the configured count and cap", () => {
    assert.equal(stackedUserLevCap(200, [120], 1, 50), 50);
    assert.equal(stackedUserLevCap(200, [120], 3, 50), 200);
    assert.equal(stackedUserLevCap(200, [90, 90], 2, 80), 80);
  });
});

describe("leverage range", () => {
  it("normalizes min <= max within 1..200", () => {
    assert.deepEqual(normalizeLeverageRange(100, 125), { min: 100, max: 125 });
    assert.deepEqual(normalizeLeverageRange(150, 125), { min: 125, max: 125 });
    assert.deepEqual(normalizeLeverageRange(0, 300), { min: 1, max: 200 });
  });

  it("accepts coins at or above minLeverage and rejects coins below minLeverage", () => {
    assert.equal(isCoinWithinLeverageRange(5, 1), true);
    assert.equal(isCoinWithinLeverageRange(75, 100), false);
    assert.equal(isCoinWithinLeverageRange(100, 100), true);
    assert.equal(isCoinWithinLeverageRange(125, 100), true);
    assert.equal(isCoinWithinLeverageRange(200, 100), true);
  });
});
