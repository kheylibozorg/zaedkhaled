import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asterBracketRows, maxLeverageFromAsterTiers } from "./aster-brackets.ts";

describe("aster leverage brackets", () => {
  it("reads maxOpenPosLeverage from the public web book", () => {
    const rows = asterBracketRows({
      code: "000000",
      data: {
        brackets: [
          {
            symbol: "BTCUSDT",
            riskBrackets: [
              { maxOpenPosLeverage: 200, minOpenPosLeverage: 151 },
              { maxOpenPosLeverage: 150, minOpenPosLeverage: 101 },
            ],
          },
          {
            symbol: "SUSHIUSDT",
            riskBrackets: [{ maxOpenPosLeverage: 5 }],
          },
        ],
      },
    });
    assert.equal(rows.length, 2);
    assert.equal(maxLeverageFromAsterTiers(rows[0]?.riskBrackets), 200);
    assert.equal(maxLeverageFromAsterTiers(rows[1]?.riskBrackets), 5);
  });

  it("reads signed v3 single-symbol object (not only arrays)", () => {
    const rows = asterBracketRows({
      symbol: "ETHUSDT",
      brackets: [{ initialLeverage: 75 }, { initialLeverage: 50 }],
    });
    assert.equal(rows.length, 1);
    assert.equal(maxLeverageFromAsterTiers(rows[0]?.brackets), 75);
  });

  it("reads signed v3 array of all symbols", () => {
    const rows = asterBracketRows([
      { symbol: "BTCUSDT", brackets: [{ initialLeverage: 125 }] },
    ]);
    assert.equal(maxLeverageFromAsterTiers(rows[0]?.brackets), 125);
  });
});
