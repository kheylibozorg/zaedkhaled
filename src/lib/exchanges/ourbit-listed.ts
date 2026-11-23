import { capLeverage } from "./lev-cap.ts";
import { isTradeableBase, nativeSymbol } from "./meta.ts";

export type ParsedListed = {
  base: string;
  symbol: string;
  venueSymbol: string;
  volume24hUsd: number;
  maxLeverage: number;
};

export type OurbitContractRow = {
  symbol?: string;
  baseCoin?: string;
  quoteCoin?: string;
  settleCoin?: string;
  state?: number;
  apiAllowed?: boolean;
  isHidden?: boolean;
  futureType?: number;
  maxLeverage?: number | string;
  contractSize?: number | string;
  minVol?: number | string;
  volUnit?: number | string;
  priceUnit?: number | string;
};

export type OurbitTickerRow = {
  symbol?: string;
  amount24?: number | string;
  lastPrice?: number | string;
};

function pushUnique(
  out: ParsedListed[],
  seen: Set<string>,
  rawSymbol: string,
  volume: number,
  maxLeverage: number,
) {
  const base = isTradeableBase(rawSymbol);
  if (!base || seen.has(base)) return;
  seen.add(base);
  out.push({
    base,
    symbol: `${base}USDT`,
    venueSymbol: nativeSymbol("ourbit", base),
    volume24hUsd: volume,
    maxLeverage: capLeverage(maxLeverage),
  });
}

function isLiveUsdtPerp(row: OurbitContractRow) {
  const quote = String(row.quoteCoin ?? row.settleCoin ?? "").toUpperCase();
  if (quote && quote !== "USDT") return false;
  if (row.state != null && Number(row.state) !== 0) return false;
  if (row.futureType != null && Number(row.futureType) !== 1) return false;
  if (row.apiAllowed === false) return false;
  if (row.isHidden === true) return false;
  return Boolean(row.symbol);
}

/** USDT-M perps from OURBIT /api/v1/contract/detail. */
export function listedFromOurbitContracts(
  contracts: OurbitContractRow[],
  volumes?: Map<string, number>,
): ParsedListed[] {
  const out: ParsedListed[] = [];
  const seen = new Set<string>();
  for (const c of contracts) {
    if (!isLiveUsdtPerp(c) || !c.symbol) continue;
    const vol = volumes?.get(c.symbol.toUpperCase()) ?? 0;
    pushUnique(out, seen, c.symbol, vol, Number(c.maxLeverage ?? 0));
  }
  return out;
}

/** Fallback book from the 24h contract ticker (`BTC_USDT`). */
export function listedFromOurbitTickers(rows: OurbitTickerRow[]): ParsedListed[] {
  const out: ParsedListed[] = [];
  const seen = new Set<string>();
  for (const t of rows) {
    const sym = (t.symbol ?? "").toUpperCase();
    if (!sym.endsWith("_USDT")) continue;
    pushUnique(out, seen, sym, Number(t.amount24 ?? 0) || 0, 0);
  }
  return out;
}
