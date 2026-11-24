import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeLeverageRange, stackedUserLevCap } from "./lev-cap.ts";

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

  it("counts only positions inside [minLev..maxLev] when a range is configured and allows below-range trades", () => {
    // Range 100..125, max 3 open in range, then cap at 75x.
    // Below-range open trades (50x, 75x, 90x) do not consume the 3 slots.
    assert.equal(stackedUserLevCap(125, [50, 75, 90, 100, 125], 3, 75, 100), 125);
    // Once 3 open trades sit inside 100..125, subsequent cap drops to 75x.
    assert.equal(stackedUserLevCap(125, [50, 125, 100, 125], 3, 75, 100), 75);
    assert.equal(stackedUserLevCap(125, [100, 110, 125], 3, 75, 100), 75);
    // Below-range coins still take min(effectiveCap, coinMax), e.g., min(75, 50) = 50.
    assert.equal(Math.min(stackedUserLevCap(125, [100, 125, 125], 3, 75, 100), 50), 50);
  });
});

describe("leverage range", () => {
  it("normalizes min <= max within 1..200", () => {
    assert.deepEqual(normalizeLeverageRange(100, 125), { min: 100, max: 125 });
    assert.deepEqual(normalizeLeverageRange(150, 125), { min: 125, max: 125 });
    assert.deepEqual(normalizeLeverageRange(0, 300), { min: 1, max: 200 });
  });
});
