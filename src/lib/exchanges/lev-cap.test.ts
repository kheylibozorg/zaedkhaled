import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stackedUserLevCap } from "./lev-cap.ts";

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
