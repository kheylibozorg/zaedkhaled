import {
  ALL_INDICATORS,
  SCAN_RULE,
  type IndicatorName,
  type Side,
  type Timeframe,
} from "./types.ts";

export const ENGINE_TFS: Timeframe[] = ["5m", "15m", "1h", "4h"];
export const ENGINE_SIDES: Side[] = ["long", "short"];

export type EngineGates = Partial<Record<IndicatorName, Partial<Record<Timeframe, boolean>>>>;
export type SideGates = Partial<Record<IndicatorName, Partial<Record<Side, boolean>>>>;

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

export function parseEngineGates(raw: unknown): EngineGates {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return {};
    try {
      obj = JSON.parse(t);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: EngineGates = {};
  for (const [name, row] of Object.entries(obj as Record<string, unknown>)) {
    if (name === SIDES_KEY) continue;
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
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return {};
    try {
      obj = JSON.parse(t);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const block = (obj as Record<string, unknown>)[SIDES_KEY];
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

/** Missing cell = on. Only explicit false mutes that engine on that TF. */
export function isEngineOn(gates: EngineGates, name: IndicatorName, tf: Timeframe): boolean {
  return gates[name]?.[tf] !== false;
}

/** Missing cell = on. Only explicit false mutes that engine's long or short. */
export function isSideOn(sides: SideGates, name: string, side: Side): boolean {
  if (!NAME_SET.has(name)) return true;
  return sides[name as IndicatorName]?.[side] !== false;
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

/** SCAN_RULE order, minus muted cells. Empty object = every engine stays on. */
export function scanNames(tf: Timeframe, gates: EngineGates): IndicatorName[] {
  return SCAN_RULE[tf].filter((name) => isEngineOn(gates, name, tf));
}

export function serializeEngineGates(gates: EngineGates, sides: SideGates = {}): string {
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
  return JSON.stringify(compact);
}
