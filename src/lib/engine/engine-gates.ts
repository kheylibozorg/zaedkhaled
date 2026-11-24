import {
  ALL_INDICATORS,
  SCAN_RULE,
  type IndicatorName,
  type Side,
  type Timeframe,
} from "./types.ts";

export const ENGINE_TFS: Timeframe[] = ["5m", "15m", "1h", "4h"];
export const ENGINE_SIDES: Side[] = ["long", "short"];
export type EntryPhase = "pre-arm" | "armed";
export const ENGINE_PHASES: EntryPhase[] = ["pre-arm", "armed"];
export type EntryPhaseMode = "both" | "pre_arm" | "armed";
export type MarginMode = "cross" | "isolated";

export type EngineGates = Partial<Record<IndicatorName, Partial<Record<Timeframe, boolean>>>>;
export type SideGates = Partial<Record<IndicatorName, Partial<Record<Side, boolean>>>>;
export type TfSideGates = Partial<Record<IndicatorName, Partial<Record<Timeframe, Partial<Record<Side, boolean>>>>>>;
export type PhaseGates = Partial<Record<IndicatorName, Partial<Record<EntryPhase, boolean>>>>;

export const ENGINE_FAMILIES: { id: string; label: string; names: IndicatorName[] }[] = [
  { id: "apex", label: "APEX", names: ["APEX1", "APEX15", "APEX2"] },
  { id: "halcyon", label: "HALCYON", names: ["HAEG", "HVES", "HORI", "HALC"] },
  { id: "trex", label: "TREX", names: ["TREX1", "TREX12"] },
  { id: "ketex", label: "KETEX", names: ["KETEX"] },
  { id: "shetex", label: "SHETEX", names: ["SHETEX"] },
];

const NAME_SET = new Set<string>(ALL_INDICATORS);
const TF_SET = new Set<string>(ENGINE_TFS);
const SIDES_KEY = "_sides";
const TF_SIDES_KEY = "_tfSides";
const PHASES_KEY = "_phases";

export function parseEntryPhaseMode(raw: unknown): EntryPhaseMode {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "pre_arm" || s === "pre-arm") return "pre_arm";
  if (s === "armed") return "armed";
  return "both";
}

export function parseMarginMode(raw: unknown): MarginMode {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s === "isolated" ? "isolated" : "cross";
}

function parseGatesJson(raw: unknown): Record<string, unknown> | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    try {
      obj = JSON.parse(t);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  return obj as Record<string, unknown>;
}

export function parseEngineGates(raw: unknown): EngineGates {
  const obj = parseGatesJson(raw);
  if (!obj) return {};
  const out: EngineGates = {};
  for (const [name, row] of Object.entries(obj)) {
    if (name === SIDES_KEY || name === TF_SIDES_KEY || name === PHASES_KEY) continue;
    if (!NAME_SET.has(name) || !row || typeof row !== "object" || Array.isArray(row)) continue;
    const next: Partial<Record<Timeframe, boolean>> = {};
    for (const [tf, v] of Object.entries(row as Record<string, unknown>)) {
      if (!TF_SET.has(tf) || typeof v !== "boolean") continue;
      next[tf as Timeframe] = v;
    }
    if (Object.keys(next).length) out[name as IndicatorName] = next;
  }
  return out;
}

export function parseSideGates(raw: unknown): SideGates {
  const obj = parseGatesJson(raw);
  if (!obj) return {};
  const block = obj[SIDES_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const out: SideGates = {};
  for (const [name, row] of Object.entries(block as Record<string, unknown>)) {
    if (!NAME_SET.has(name) || !row || typeof row !== "object" || Array.isArray(row)) continue;
    const next: Partial<Record<Side, boolean>> = {};
    for (const [side, v] of Object.entries(row as Record<string, unknown>)) {
      if ((side !== "long" && side !== "short") || typeof v !== "boolean") continue;
      next[side] = v;
    }
    if (Object.keys(next).length) out[name as IndicatorName] = next;
  }
  return out;
}

export function parseTfSideGates(raw: unknown): TfSideGates {
  const obj = parseGatesJson(raw);
  if (!obj) return {};
  const block = obj[TF_SIDES_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const out: TfSideGates = {};
  for (const [name, tfMap] of Object.entries(block as Record<string, unknown>)) {
    if (!NAME_SET.has(name) || !tfMap || typeof tfMap !== "object" || Array.isArray(tfMap)) continue;
    const nextTf: Partial<Record<Timeframe, Partial<Record<Side, boolean>>>> = {};
    for (const [tf, sideMap] of Object.entries(tfMap as Record<string, unknown>)) {
      if (!TF_SET.has(tf) || !sideMap || typeof sideMap !== "object" || Array.isArray(sideMap)) continue;
      const nextSide: Partial<Record<Side, boolean>> = {};
      for (const [side, v] of Object.entries(sideMap as Record<string, unknown>)) {
        if ((side !== "long" && side !== "short") || typeof v !== "boolean") continue;
        nextSide[side] = v;
      }
      if (Object.keys(nextSide).length) nextTf[tf as Timeframe] = nextSide;
    }
    if (Object.keys(nextTf).length) out[name as IndicatorName] = nextTf;
  }
  return out;
}

export function parsePhaseGates(raw: unknown): PhaseGates {
  const obj = parseGatesJson(raw);
  if (!obj) return {};
  const block = obj[PHASES_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return {};
  const out: PhaseGates = {};
  for (const [name, row] of Object.entries(block as Record<string, unknown>)) {
    if (!NAME_SET.has(name) || !row || typeof row !== "object" || Array.isArray(row)) continue;
    const next: Partial<Record<EntryPhase, boolean>> = {};
    for (const [phase, v] of Object.entries(row as Record<string, unknown>)) {
      if ((phase !== "pre-arm" && phase !== "armed") || typeof v !== "boolean") continue;
      next[phase] = v;
    }
    if (Object.keys(next).length) out[name as IndicatorName] = next;
  }
  return out;
}

/** Missing cell = on. Only explicit false mutes that engine on that TF. */
export function isEngineOn(gates: EngineGates, name: IndicatorName, tf: Timeframe): boolean {
  return gates[name]?.[tf] !== false;
}

/**
 * Missing cell = on. Only explicit false mutes that engine's long or short,
 * either globally (`sides`) or specifically on `tf` (`tfSides`).
 */
export function isSideOn(
  sides: SideGates,
  name: string,
  side: Side,
  tf?: Timeframe,
  tfSides?: TfSideGates,
): boolean {
  if (!NAME_SET.has(name)) return true;
  if (sides[name as IndicatorName]?.[side] === false) return false;
  if (tf && tfSides?.[name as IndicatorName]?.[tf]?.[side] === false) return false;
  return true;
}

/** Missing cell = on. Only explicit false mutes pre-arm or armed FTC for that engine. */
export function isPhaseOn(phases: PhaseGates, name: string, phase: EntryPhase): boolean {
  if (!NAME_SET.has(name)) return true;
  return phases[name as IndicatorName]?.[phase] !== false;
}

export function isEntryPhaseAllowed(
  entryPhaseMode: EntryPhaseMode,
  phases: PhaseGates,
  name: string,
  phase: EntryPhase,
): boolean {
  if (entryPhaseMode === "pre_arm" && phase !== "pre-arm") return false;
  if (entryPhaseMode === "armed" && phase !== "armed") return false;
  return isPhaseOn(phases, name, phase);
}

export function setEngineGate(
  gates: EngineGates,
  name: IndicatorName,
  tf: Timeframe,
  on: boolean,
): EngineGates {
  return {
    ...gates,
    [name]: { ...(gates[name] ?? {}), [tf]: on },
  };
}

export function setSideGate(sides: SideGates, name: IndicatorName, side: Side, on: boolean): SideGates {
  return {
    ...sides,
    [name]: { ...(sides[name] ?? {}), [side]: on },
  };
}

export function setPhaseGate(phases: PhaseGates, name: IndicatorName, phase: EntryPhase, on: boolean): PhaseGates {
  return {
    ...phases,
    [name]: { ...(phases[name] ?? {}), [phase]: on },
  };
}

export function setTfSideGate(
  tfSides: TfSideGates,
  name: IndicatorName,
  tf: Timeframe,
  side: Side,
  on: boolean,
): TfSideGates {
  const prevRow = tfSides[name] ?? {};
  const prevCell = prevRow[tf] ?? {};
  return {
    ...tfSides,
    [name]: {
      ...prevRow,
      [tf]: {
        ...prevCell,
        [side]: on,
      },
    },
  };
}

export function clearTfSideForSide(tfSides: TfSideGates, side: Side, name?: IndicatorName): TfSideGates {
  const next: TfSideGates = { ...tfSides };
  const names = name ? [name] : ALL_INDICATORS;
  for (const ind of names) {
    const row = next[ind];
    if (!row) continue;
    const nextRow = { ...row };
    for (const tf of ENGINE_TFS) {
      const cell = nextRow[tf];
      if (!cell || cell[side] === undefined) continue;
      const copy = { ...cell };
      delete copy[side];
      if (Object.keys(copy).length) nextRow[tf] = copy;
      else delete nextRow[tf];
    }
    if (Object.keys(nextRow).length) next[ind] = nextRow;
    else delete next[ind];
  }
  return next;
}

export function setEngineRow(gates: EngineGates, name: IndicatorName, on: boolean): EngineGates {
  let next = gates;
  for (const tf of ENGINE_TFS) next = setEngineGate(next, name, tf, on);
  return next;
}

export function setEngineCol(gates: EngineGates, tf: Timeframe, on: boolean): EngineGates {
  let next = gates;
  for (const name of ALL_INDICATORS) next = setEngineGate(next, name, tf, on);
  return next;
}

export function setAllEngines(on: boolean): EngineGates {
  let next: EngineGates = {};
  for (const name of ALL_INDICATORS) next = setEngineRow(next, name, on);
  return next;
}

export function setAllSides(sides: SideGates, side: Side, on: boolean): SideGates {
  let next = sides;
  for (const name of ALL_INDICATORS) next = setSideGate(next, name, side, on);
  return next;
}

export function setAllPhases(phases: PhaseGates, phase: EntryPhase, on: boolean): PhaseGates {
  let next = phases;
  for (const name of ALL_INDICATORS) next = setPhaseGate(next, name, phase, on);
  return next;
}

export function countArmed(gates: EngineGates): { on: number; total: number } {
  const total = ALL_INDICATORS.length * ENGINE_TFS.length;
  let on = 0;
  for (const name of ALL_INDICATORS) {
    for (const tf of ENGINE_TFS) if (isEngineOn(gates, name, tf)) on += 1;
  }
  return { on, total };
}

export function countSidesArmed(sides: SideGates): { longOn: number; shortOn: number; total: number } {
  const total = ALL_INDICATORS.length;
  let longOn = 0;
  let shortOn = 0;
  for (const name of ALL_INDICATORS) {
    if (isSideOn(sides, name, "long")) longOn += 1;
    if (isSideOn(sides, name, "short")) shortOn += 1;
  }
  return { longOn, shortOn, total };
}

export function countPhasesArmed(phases: PhaseGates): { preArmOn: number; armedOn: number; total: number } {
  const total = ALL_INDICATORS.length;
  let preArmOn = 0;
  let armedOn = 0;
  for (const name of ALL_INDICATORS) {
    if (isPhaseOn(phases, name, "pre-arm")) preArmOn += 1;
    if (isPhaseOn(phases, name, "armed")) armedOn += 1;
  }
  return { preArmOn, armedOn, total };
}

/** SCAN_RULE order, minus muted cells. Empty object = every engine stays on. */
export function scanNames(tf: Timeframe, gates: EngineGates): IndicatorName[] {
  return SCAN_RULE[tf].filter((name) => isEngineOn(gates, name, tf));
}

export function serializeEngineGates(
  gates: EngineGates,
  sides: SideGates = {},
  tfSides: TfSideGates = {},
  phases: PhaseGates = {},
): string {
  const compact: Record<string, unknown> = {};
  for (const name of ALL_INDICATORS) {
    for (const tf of ENGINE_TFS) {
      if (isEngineOn(gates, name, tf)) continue;
      const row = (compact[name] as Record<string, boolean> | undefined) ?? {};
      row[tf] = false;
      compact[name] = row;
    }
  }
  const sideCompact: SideGates = {};
  for (const name of ALL_INDICATORS) {
    for (const side of ENGINE_SIDES) {
      if (isSideOn(sides, name, side)) continue;
      sideCompact[name] = sideCompact[name] ?? {};
      sideCompact[name]![side] = false;
    }
  }
  if (Object.keys(sideCompact).length) compact[SIDES_KEY] = sideCompact;

  const tfSideCompact: TfSideGates = {};
  for (const name of ALL_INDICATORS) {
    for (const tf of ENGINE_TFS) {
      for (const side of ENGINE_SIDES) {
        if (tfSides[name]?.[tf]?.[side] !== false) continue;
        tfSideCompact[name] = tfSideCompact[name] ?? {};
        tfSideCompact[name]![tf] = tfSideCompact[name]![tf] ?? {};
        tfSideCompact[name]![tf]![side] = false;
      }
    }
  }
  if (Object.keys(tfSideCompact).length) compact[TF_SIDES_KEY] = tfSideCompact;

  const phaseCompact: PhaseGates = {};
  for (const name of ALL_INDICATORS) {
    for (const phase of ENGINE_PHASES) {
      if (isPhaseOn(phases, name, phase)) continue;
      phaseCompact[name] = phaseCompact[name] ?? {};
      phaseCompact[name]![phase] = false;
    }
  }
  if (Object.keys(phaseCompact).length) compact[PHASES_KEY] = phaseCompact;

  return JSON.stringify(compact);
}
