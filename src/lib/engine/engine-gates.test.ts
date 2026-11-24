import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearTfSideForSide,
  countArmed,
  countPhasesArmed,
  countSidesArmed,
  isEngineOn,
  isEntryPhaseAllowed,
  isPhaseOn,
  isSideOn,
  parseEngineGates,
  parseEntryPhaseMode,
  parseMarginMode,
  parsePhaseGates,
  parseSideGates,
  parseTfSideGates,
  scanNames,
  serializeEngineGates,
  setAllEngines,
  setAllPhases,
  setAllSides,
  setEngineCol,
  setEngineGate,
  setEngineRow,
  setPhaseGate,
  setSideGate,
  setTfSideGate,
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

  it("mutes a single timeframe side for one engine without muting other timeframes or the other side", () => {
    const tfSides = setTfSideGate({}, "APEX1", "15m", "short", false);
    assert.equal(isSideOn({}, "APEX1", "short", "15m", tfSides), false);
    assert.equal(isSideOn({}, "APEX1", "long", "15m", tfSides), true);
    assert.equal(isSideOn({}, "APEX1", "short", "5m", tfSides), true);
    assert.equal(isSideOn({}, "APEX1", "short", "1h", tfSides), true);
    assert.equal(isSideOn({}, "APEX2", "short", "15m", tfSides), true);

    const engineSides = setSideGate({}, "APEX2", "long", false);
    assert.equal(isSideOn(engineSides, "APEX2", "long", "15m", tfSides), false);
    assert.equal(isSideOn(engineSides, "APEX2", "short", "15m", tfSides), true);

    const cleared = clearTfSideForSide(tfSides, "short", "APEX1");
    assert.equal(isSideOn({}, "APEX1", "short", "15m", cleared), true);
  });

  it("round-trips per-timeframe sides in compact JSON and ignores invalid entries", () => {
    const gates = setEngineGate({}, "TREX1", "4h", false);
    const sides = setSideGate({}, "HALC", "long", false);
    const tfSides = setTfSideGate(setTfSideGate({}, "APEX1", "15m", "short", false), "KETEX", "1h", "long", false);
    const raw = serializeEngineGates(gates, sides, tfSides);
    assert.equal(raw.includes("true"), false);

    const parsedGates = parseEngineGates(raw);
    const parsedSides = parseSideGates(raw);
    const parsedTfSides = parseTfSideGates(raw);

    assert.equal(isEngineOn(parsedGates, "TREX1", "4h"), false);
    assert.equal(isEngineOn(parsedGates, "APEX1", "15m"), true);
    assert.equal(isSideOn(parsedSides, "HALC", "long", "15m", parsedTfSides), false);
    assert.equal(isSideOn(parsedSides, "APEX1", "short", "15m", parsedTfSides), false);
    assert.equal(isSideOn(parsedSides, "APEX1", "long", "15m", parsedTfSides), true);
    assert.equal(isSideOn(parsedSides, "APEX1", "short", "5m", parsedTfSides), true);
    assert.equal(isSideOn(parsedSides, "KETEX", "long", "1h", parsedTfSides), false);

    const junk = parseTfSideGates(
      '{"_tfSides":{"NOPE":{"15m":{"short":false}},"APEX1":{"9m":{"short":false},"15m":{"short":false,"long":"bad"}}}}',
    );
    assert.equal(isSideOn({}, "APEX1", "short", "15m", junk), false);
    assert.equal(isSideOn({}, "APEX1", "long", "15m", junk), true);
    assert.equal(isSideOn({}, "NOPE", "short", "15m", junk), true);
  });

  it("parses entry_phase_mode and margin_mode with safe defaults", () => {
    assert.equal(parseEntryPhaseMode(null), "both");
    assert.equal(parseEntryPhaseMode("pre_arm"), "pre_arm");
    assert.equal(parseEntryPhaseMode("pre-arm"), "pre_arm");
    assert.equal(parseEntryPhaseMode("armed"), "armed");
    assert.equal(parseEntryPhaseMode("other"), "both");

    assert.equal(parseMarginMode(null), "cross");
    assert.equal(parseMarginMode("cross"), "cross");
    assert.equal(parseMarginMode("isolated"), "isolated");
    assert.equal(parseMarginMode("weird"), "cross");
  });

  it("supports per-engine pre-arm & armed FTC phase gates + global phase mode", () => {
    assert.equal(countPhasesArmed({}).preArmOn, 11);
    assert.equal(countPhasesArmed({}).armedOn, 11);
    assert.equal(isPhaseOn({}, "APEX1", "pre-arm"), true);
    assert.equal(isPhaseOn({}, "APEX1", "armed"), true);

    const phases = setPhaseGate(setAllPhases({}, "pre-arm", false), "APEX1", "pre-arm", true);
    assert.equal(isPhaseOn(phases, "APEX1", "pre-arm"), true);
    assert.equal(isPhaseOn(phases, "APEX2", "pre-arm"), false);
    assert.equal(isPhaseOn(phases, "APEX2", "armed"), true);

    assert.equal(isEntryPhaseAllowed("both", phases, "APEX1", "pre-arm"), true);
    assert.equal(isEntryPhaseAllowed("both", phases, "APEX2", "pre-arm"), false);
    assert.equal(isEntryPhaseAllowed("armed", phases, "APEX1", "pre-arm"), false);
    assert.equal(isEntryPhaseAllowed("armed", phases, "APEX2", "armed"), true);
    assert.equal(isEntryPhaseAllowed("pre_arm", phases, "APEX1", "armed"), false);
    assert.equal(isEntryPhaseAllowed("pre_arm", phases, "APEX1", "pre-arm"), true);

    const raw = serializeEngineGates({}, {}, {}, phases);
    assert.equal(raw.includes("true"), false);
    const reparsed = parsePhaseGates(raw);
    assert.equal(isPhaseOn(reparsed, "APEX1", "pre-arm"), true);
    assert.equal(isPhaseOn(reparsed, "APEX2", "pre-arm"), false);
    assert.equal(isPhaseOn(reparsed, "APEX2", "armed"), true);
  });
});
