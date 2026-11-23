import { defaultMaxLeverage } from "@/lib/market/binance";
import type { VenueId } from "@/lib/engine/types";
import { capLeverage } from "./lev-cap";
import { asterBracketRows, maxLeverageFromAsterTiers } from "./aster-brackets";
import { fetchLighterMarkets } from "./lighter";
import { coinOf } from "./meta";

export { capLeverage, LEV_CAP, stackedUserLevCap } from "./lev-cap";
export { asterBracketRows, maxLeverageFromAsterTiers } from "./aster-brackets";

type LevMap = Record<string, number>;

let cache: {
  at: number;
  maps: { hyperliquid: LevMap; lighter: LevMap; ourbit: LevMap; aster: LevMap };
} | null = null;

function put(map: LevMap, symbolOrCoin: string, lev: number) {
  const coin = coinOf(symbolOrCoin);
  if (!coin || !(lev > 0)) return;
  map[coin] = Math.max(map[coin] ?? 0, capLeverage(lev));
}

async function fetchHyperliquidMap(): Promise<LevMap> {
  const map: LevMap = {};
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });
    if (!res.ok) return map;
    const json = (await res.json()) as { universe?: Array<{ name: string; maxLeverage: number }> };
    for (const u of json.universe ?? []) put(map, u.name, u.maxLeverage);
  } catch {
    /* public meta down */
  }
  return map;
}

async function fetchLighterMap(): Promise<LevMap> {
  const map: LevMap = {};
  try {
    const rows = await fetchLighterMarkets();
    for (const r of rows) put(map, r.coin, r.maxLeverage);
  } catch {
    /* public books down */
  }
  return map;
}

async function fetchOurbitMap(): Promise<LevMap> {
  const map: LevMap = {};
  try {
    const res = await fetch("https://futures.ourbit.com/api/v1/contract/detail", {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return map;
    const json = (await res.json()) as {
      data?: Array<{ symbol?: string; maxLeverage?: number | string }>;
    };
    for (const c of json.data ?? []) {
      if (c.symbol) put(map, c.symbol, Number(c.maxLeverage ?? 0));
    }
  } catch {
    /* public info down */
  }
  return map;
}

async function fetchAsterMap(): Promise<LevMap> {
  const map: LevMap = {};
  try {
    const res = await fetch("https://www.asterdex.com/bapi/futures/v1/public/future/common/brackets", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return map;
    const json = (await res.json()) as unknown;
    for (const row of asterBracketRows(json)) {
      if (!row.symbol) continue;
      put(map, row.symbol, maxLeverageFromAsterTiers(row.riskBrackets ?? row.brackets));
    }
  } catch {
    /* public brackets down */
  }
  return map;
}

export async function loadPublicLeverageMaps() {
  const now = Date.now();
  if (cache && now - cache.at < 10 * 60_000) return cache.maps;
  const [hyperliquid, lighter, ourbit, aster] = await Promise.all([
    fetchHyperliquidMap(),
    fetchLighterMap(),
    fetchOurbitMap(),
    fetchAsterMap(),
  ]);
  cache = { at: now, maps: { hyperliquid, lighter, ourbit, aster } };
  return cache.maps;
}

/** Paper book is Aster — size to Aster's own max, not a blend of other venues. */
export async function publicMaxLeverage(symbol: string): Promise<number> {
  const maps = await loadPublicLeverageMaps();
  const coin = coinOf(symbol);
  return capLeverage(maps.aster[coin] || 25);
}

export async function venueMaxLeverage(venue: VenueId, symbol: string): Promise<number> {
  if (venue === "paper") return publicMaxLeverage(symbol);
  const maps = await loadPublicLeverageMaps();
  const coin = coinOf(symbol);
  if (venue === "hyperliquid") return capLeverage(maps.hyperliquid[coin] || defaultMaxLeverage(symbol));
  if (venue === "lighter") return capLeverage(maps.lighter[coin] || defaultMaxLeverage(symbol));
  if (venue === "ourbit") return capLeverage(maps.ourbit[coin] || defaultMaxLeverage(symbol));
  if (venue === "aster") return capLeverage(maps.aster[coin] || 25);
  return capLeverage(defaultMaxLeverage(symbol));
}
