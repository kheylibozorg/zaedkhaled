import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countArmed,
  countSidesArmed,
  isEngineOn,
  isSideOn,
  parseEngineGates,
  parseSideGates,
  scanNames,
  serializeEngineGates,
  setAllEngines,
  setAllSides,
  setEngineCol,
  setEngineGate,
  setEngineRow,
  setSideGate,
} from "./engine-gates.ts";
import { SCAN_RULE } from "./types.ts";

describe("engine gates", () => {
  it("empty / missing means every engine stays on", () => {
    assert.deepEqual(parseEngineGates(null), {});
    assert.deepEqual(parseEngineGates(""), {});
    assert.deepEqual(parseEngineGates("{}"), {});
    assert.equal(isEngineOn({}, "APEX1", "5m"), true);
    assert.deepEqual(scanNames("15m", {}), SCAN_RULE["15m"]);
    assert.equal(countArmed({}).on, 44);
  });

  it("mutes one indicator on one timeframe and keeps SCAN_RULE order", () => {
    const gates = setEngineGate({}, "APEX2", "15m", false);
    assert.equal(isEngineOn(gates, "APEX2", "15m"), false);
    assert.equal(isEngineOn(gates, "APEX2", "5m"), true);
    assert.equal(isEngineOn(gates, "APEX1", "15m"), true);
    const names = scanNames("15m", gates);
    assert.equal(names.includes("APEX2"), false);
    assert.deepEqual(names, SCAN_RULE["15m"].filter((n) => n !== "APEX2"));
  });

  it("row / column / all-off mute without inventing unknown keys", () => {
    const row = setEngineRow({}, "HALC", false);
    for (const tf of ["5m", "15m", "1h", "4h"] as const) {
      assert.equal(isEngineOn(row, "HALC", tf), false);
      assert.equal(isEngineOn(row, "HAEG", tf), true);
    }
    const col = setEngineCol({}, "4h", false);
    assert.equal(isEngineOn(col, "KETEX", "4h"), false);
    assert.equal(isEngineOn(col, "KETEX", "1h"), true);
    const off = setAllEngines(false);
    assert.equal(countArmed(off).on, 0);
    assert.deepEqual(scanNames("5m", off), []);
  });

  it("round-trips compact JSON and ignores junk keys", () => {
    const gates = setEngineGate(setEngineGate({}, "SHETEX", "1h", false), "TREX1", "5m", false);
    const raw = serializeEngineGates(gates);
    assert.equal(raw.includes("true"), false);
    const again = parseEngineGates(raw);
    assert.equal(isEngineOn(again, "SHETEX", "1h"), false);
    assert.equal(isEngineOn(again, "TREX1", "5m"), false);
    assert.equal(isEngineOn(again, "TREX1", "15m"), true);
    const junk = parseEngineGates('{"NOPE":{"5m":false},"APEX1":{"9m":false,"5m":"off","15m":false}}');
    assert.equal(isEngineOn(junk, "APEX1", "5m"), true);
    assert.equal(isEngineOn(junk, "APEX1", "15m"), false);
  });

  it("empty sides means every long and short stays on", () => {
    assert.deepEqual(parseSideGates(null), {});
    assert.deepEqual(parseSideGates("{}"), {});
    assert.equal(isSideOn({}, "APEX1", "long"), true);
    assert.equal(isSideOn({}, "APEX1", "short"), true);
    assert.equal(countSidesArmed({}).longOn, 11);
    assert.equal(countSidesArmed({}).shortOn, 11);
  });

  it("mutes one engine short without touching its long or other engines", () => {
    const sides = setSideGate({}, "APEX2", "short", false);
    assert.equal(isSideOn(sides, "APEX2", "short"), false);
    assert.equal(isSideOn(sides, "APEX2", "long"), true);
    assert.equal(isSideOn(sides, "APEX1", "short"), true);
  });

  it("all-long / all-short bulk mute keeps the other side", () => {
    const noShort = setAllSides({}, "short", false);
    assert.equal(countSidesArmed(noShort).shortOn, 0);
    assert.equal(countSidesArmed(noShort).longOn, 11);
    assert.equal(isSideOn(noShort, "KETEX", "short"), false);
    assert.equal(isSideOn(noShort, "KETEX", "long"), true);
    const noLong = setAllSides(noShort, "long", false);
    assert.equal(countSidesArmed(noLong).longOn, 0);
    const back = setAllSides(noLong, "short", true);
    assert.equal(isSideOn(back, "SHETEX", "short"), true);
    assert.equal(isSideOn(back, "SHETEX", "long"), false);
  });

  it("round-trips sides next to timeframe mutes and ignores junk", () => {
    const gates = setEngineGate({}, "TREX1", "5m", false);
    const sides = setSideGate({}, "HALC", "long", false);
    const raw = serializeEngineGates(gates, sides);
    assert.equal(raw.includes("true"), false);
    assert.equal(parseEngineGates(raw)["TREX1"]?.["5m"], false);
    assert.equal(isSideOn(parseSideGates(raw), "HALC", "long"), false);
    assert.equal(isSideOn(parseSideGates(raw), "HALC", "short"), true);
    assert.equal(isEngineOn(parseEngineGates(raw), "HALC", "5m"), true);
    const junk = parseSideGates('{"_sides":{"NOPE":{"long":false},"APEX1":{"long":false,"mid":false,"short":"off"}}}');
    assert.equal(isSideOn(junk, "APEX1", "long"), false);
    assert.equal(isSideOn(junk, "APEX1", "short"), true);
    assert.equal(isSideOn(junk, "NOPE", "long"), true);
  });
});
