import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { rebaseStopsFromFill } from "@/lib/engine/paper";
import { defaultMaxLeverage } from "@/lib/market/binance";
import { coinOf, isTradeableBase, nativeSymbol } from "./meta";
import { capLeverage } from "./lev-cap";
import type {
  ExchangeAdapter,
  ExchangeAccount,
  ListedMarket,
  PlaceLimitOrderInput,
  PlaceLimitOrderResult,
  PlaceOrderInput,
  PlaceOrderResult,
  ProtectionSnapshot,
  UpdateStopInput,
  VenueOpenOrder,
  VenueTrade,
  WalletSnapshot,
} from "./types";

const BASE = "https://mainnet.zklighter.elliot.ai";

type BookDetail = {
  symbol?: string;
  market_id?: number;
  market_index?: number;
  min_base_amount?: string;
  max_leverage?: number;
  size_decimals?: number;
  price_decimals?: number;
  default_initial_margin_fraction?: number;
  min_initial_margin_fraction?: number;
  last_trade_price?: number;
  status?: string;
  daily_quote_token_volume?: number | string;
};

type MarketRow = {
  symbol: string;
  coin: string;
  marketIndex: number;
  maxLeverage: number;
  sizeDecimals: number;
  priceDecimals: number;
  minBase: number;
  lastPrice: number;
  status: string;
  volume24hUsd: number;
};

function wasmPaths() {
  const candidates: string[] = [
    join(process.cwd(), "wasm"),
    join(process.cwd(), "node_modules/lighter-ts-sdk"),
    join(process.cwd(), "lighter-wasm"),
  ];
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve("lighter-ts-sdk"));
    for (let i = 0; i < 8; i++) {
      candidates.push(dir);
      dir = dirname(dir);
    }
  } catch {
    /* resolve may fail under a bundler */
  }
  for (const root of candidates) {
    const nested = join(root, "wasm/lighter-signer.wasm");
    const nestedExec = join(root, "wasm/wasm_exec.js");
    if (existsSync(nested) && existsSync(nestedExec)) return { wasmPath: nested, wasmExecPath: nestedExec };
    const flat = join(root, "lighter-signer.wasm");
    const flatExec = join(root, "wasm_exec.js");
    if (existsSync(flat) && existsSync(flatExec)) return { wasmPath: flat, wasmExecPath: flatExec };
  }
  throw new Error("Lighter WASM signer files were not found next to lighter-ts-sdk.");
}

let marketsCache: { at: number; rows: MarketRow[] } | null = null;

export async function fetchLighterMarkets(): Promise<MarketRow[]> {
  const now = Date.now();
  if (marketsCache && now - marketsCache.at < 10 * 60_000 && marketsCache.rows.length) return marketsCache.rows;
  try {
    const res = await fetch(`${BASE}/api/v1/orderBookDetails`);
    if (!res.ok) throw new Error("lighter markets");
    const json = (await res.json()) as { order_book_details?: BookDetail[] } | BookDetail[];
    const rows = Array.isArray(json) ? json : json.order_book_details ?? [];
    const mapped = rows
      .map((r) => {
        const raw = (r.symbol ?? "").toUpperCase().replace(/[-_/]/g, "");
        const coin = raw.replace(/USDT|USD$/, "");
        const symbol = raw.endsWith("USDT") || raw.endsWith("USD") ? `${coin}USDT` : `${raw}USDT`;
        const minImf = Number(r.min_initial_margin_fraction ?? 0);
        const defImf = Number(r.default_initial_margin_fraction ?? 0);
        const fromMin = minImf > 0 ? Math.max(1, Math.round(10000 / minImf)) : 0;
        const fromDef = defImf > 0 ? Math.max(1, Math.round(10000 / defImf)) : 0;
        const marketIndex = Number(r.market_id ?? r.market_index);
        return {
          symbol,
          coin,
          marketIndex,
          maxLeverage: capLeverage(Number(r.max_leverage ?? 0) || fromMin || fromDef || 25),
          sizeDecimals: Number(r.size_decimals ?? 4),
          priceDecimals: Number(r.price_decimals ?? 2),
          minBase: Number(r.min_base_amount ?? 0),
          lastPrice: Number(r.last_trade_price ?? 0),
          status: String(r.status ?? "active").toLowerCase(),
          volume24hUsd: Number(r.daily_quote_token_volume ?? 0) || 0,
        };
      })
      .filter((r) => r.coin.length >= 2 && Number.isFinite(r.marketIndex));
    if (mapped.length) marketsCache = { at: now, rows: mapped };
    return mapped.length ? mapped : (marketsCache?.rows ?? []);
  } catch {
    return marketsCache?.rows ?? [];
  }
}

export function scaleLighterInt(n: number, decimals: number) {
  return Math.max(1, Math.round(n * 10 ** decimals));
}

function marketOf(markets: MarketRow[], symbol: string) {
  const coin = coinOf(symbol);
  return markets.find((m) => m.coin === coin || m.symbol === symbol.toUpperCase()) ?? null;
}

export type LighterActiveOrder = {
  order_index?: number;
  orderIndex?: number;
  client_order_index?: number;
  clientOrderIndex?: number;
  market_index?: number;
  market_id?: number;
  marketIndex?: number;
  is_ask?: boolean;
  price?: string | number;
  trigger_price?: string | number;
  remaining_base_amount?: string | number;
  reduce_only?: boolean;
  type?: string | number;
  status?: string;
};

type Signer = {
  initialize(): Promise<void>;
  ensureWasmClient(): Promise<void>;
  checkClient(useWasmCheck?: boolean): Promise<string | null>;
  createAuthToken(): Promise<string>;
  updateLeverage(marketIndex: number, marginMode: number, leverage: number): Promise<[unknown, string, string | null]>;
  createOtocoOrder(params: {
    mainOrder: {
      marketIndex: number;
      baseAmount: number;
      isAsk: boolean;
      orderType: number;
      price?: number;
      timeInForce?: number;
      clientOrderIndex?: number;
      avgExecutionPrice?: number;
      idealPrice?: number;
      maxSlippage?: number;
    };
    stopLoss: { triggerPrice: number; isLimit: boolean };
    takeProfit: { triggerPrice: number; isLimit: boolean };
  }): Promise<{ tx: unknown; hash: string; error: string | null }>;
  createOcoOrder(params: {
    orders: [
      {
        marketIndex: number;
        clientOrderIndex?: number;
        baseAmount: number;
        price: number;
        isAsk: boolean;
        orderType?: number;
        timeInForce?: number;
        reduceOnly?: boolean;
        triggerPrice?: number;
      },
      {
        marketIndex: number;
        clientOrderIndex?: number;
        baseAmount: number;
        price: number;
        isAsk: boolean;
        orderType?: number;
        timeInForce?: number;
        reduceOnly?: boolean;
        triggerPrice?: number;
      },
    ];
  }): Promise<{ tx: unknown; hash: string; error: string | null }>;
  cancelAllOrders(
    timeInForce: number,
    time: number,
    nonce?: number,
    cancelAllMarketIndex?: number,
  ): Promise<[unknown, unknown, string | null]>;
  cancelOrder(params: { marketIndex: number; orderIndex: number }): Promise<[unknown, string, string | null]>;
  createMarketOrder(params: {
    marketIndex: number;
    clientOrderIndex: number;
    baseAmount: number;
    avgExecutionPrice: number;
    isAsk: boolean;
    reduceOnly?: boolean;
  }): Promise<[unknown, string, string | null]>;
  getBestPrice(marketIndex: number, isAsk: boolean): Promise<number>;
  close(): Promise<void>;
};

const authCache = new Map<string, { token: string; expiresAt: number }>();

function authCacheKey(account: ExchangeAccount): string {
  return `${account.accountIndex ?? ""}:${account.apiKeyIndex ?? 2}`;
}

function invalidateLighterAuth(account: ExchangeAccount) {
  authCache.delete(authCacheKey(account));
}

async function withSigner<T>(account: ExchangeAccount, fn: (client: Signer) => Promise<T>): Promise<T> {
  if (!account.privateKey) throw new Error("Lighter API private key missing");
  if (account.accountIndex == null) throw new Error("Lighter account index missing");
  const { SignerClient } = await import("lighter-ts-sdk");
  const wasm = wasmPaths();
  const client = new SignerClient({
    url: BASE,
    network: "mainnet",
    privateKey: account.privateKey.trim(),
    accountIndex: account.accountIndex,
    apiKeyIndex: account.apiKeyIndex ?? 2,
    wasmConfig: wasm,
    enableWebSocket: false,
    enableBatching: false,
  }) as unknown as Signer;
  try {
    await client.initialize();
    await client.ensureWasmClient();
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
}

async function getLighterAuth(account: ExchangeAccount, existingClient?: Signer): Promise<string | null> {
  if (!account.privateKey || account.accountIndex == null) return null;
  const key = authCacheKey(account);
  const now = Date.now();
  const hit = authCache.get(key);
  if (hit && hit.expiresAt - now > 90_000) return hit.token;
  try {
    const token = existingClient
      ? await existingClient.createAuthToken()
      : await withSigner(account, (client) => client.createAuthToken());
    if (token) {
      authCache.set(key, { token, expiresAt: now + 8 * 60_000 });
      return token;
    }
  } catch {
    /* caller handles unauthenticated fallback / unknown */
  }
  return null;
}

/** Fetch active orders on one market with authenticated request. Returns null on read error. */
async function fetchActiveOrdersForMarket(
  account: ExchangeAccount,
  marketIndex: number,
  existingAuth?: string | null,
): Promise<LighterActiveOrder[] | null> {
  if (account.accountIndex == null) return null;
  let auth = existingAuth !== undefined ? existingAuth : await getLighterAuth(account);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const q = new URLSearchParams({
        account_index: String(account.accountIndex),
        market_id: String(marketIndex),
      });
      if (auth) q.set("auth", auth);
      const res = await fetch(`${BASE}/api/v1/accountActiveOrders?${q}`, {
        headers: auth ? { Authorization: auth } : undefined,
        signal: AbortSignal.timeout(8_000),
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0 && account.privateKey) {
        invalidateLighterAuth(account);
        auth = await getLighterAuth(account);
        continue;
      }
      if (!res.ok) return null;
      const json = (await res.json()) as { orders?: LighterActiveOrder[] } | LighterActiveOrder[];
      const orders = Array.isArray(json) ? json : json.orders ?? [];
      return orders.filter((o) => {
        const mkt = Number(o.market_index ?? o.market_id ?? o.marketIndex ?? marketIndex);
        return mkt === marketIndex;
      });
    } catch {
      return null;
    }
  }
  return null;
}

/** Inspect active reduce-only orders to verify SL and TP actually exist on book. */
export function classifyLighterProtection(
  orders: LighterActiveOrder[],
  sl: number,
  tp: number,
): { hasSl: boolean; hasTp: boolean } {
  let hasSl = false;
  let hasTp = false;
  const pxClose = (a: number, b: number) => {
    if (!(a > 0) || !(b > 0)) return false;
    return Math.abs(a - b) / Math.max(a, b) < 0.025;
  };
  for (const o of orders) {
    if (!o.reduce_only) continue;
    const rawType = String(o.type ?? "").toLowerCase();
    const numType = Number(o.type);
    const trigPx = Number(o.trigger_price ?? o.price ?? 0);
    if (
      rawType.includes("stop-loss") ||
      rawType === "sl" ||
      numType === 2 ||
      numType === 3 ||
      (sl > 0 && pxClose(trigPx, sl) && !pxClose(trigPx, tp))
    ) {
      hasSl = true;
    } else if (
      rawType.includes("take-profit") ||
      rawType === "tp" ||
      numType === 4 ||
      numType === 5 ||
      (tp > 0 && pxClose(trigPx, tp) && !pxClose(trigPx, sl))
    ) {
      hasTp = true;
    } else if (trigPx > 0 && sl > 0 && tp > 0) {
      if (Math.abs(trigPx - sl) <= Math.abs(trigPx - tp)) hasSl = true;
      else hasTp = true;
    }
  }
  return { hasSl, hasTp };
}

/** Top-of-book price directly from orderBookOrders scaled with exact priceDecimals. */
async function getBestPriceScaled(mkt: MarketRow, isAsk: boolean, client?: Signer): Promise<number> {
  try {
    const res = await fetch(`${BASE}/api/v1/orderBookOrders?market_id=${mkt.marketIndex}&limit=5`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const book = (await res.json()) as {
        asks?: Array<{ price?: string | number }>;
        bids?: Array<{ price?: string | number }>;
      };
      // Selling hits best bid; buying hits best ask.
      const levels = isAsk ? book.bids : book.asks;
      const top = Number(levels?.[0]?.price ?? 0);
      if (Number.isFinite(top) && top > 0) {
        return scaleLighterInt(top, mkt.priceDecimals);
      }
    }
  } catch {
    /* fallback below */
  }
  if (mkt.lastPrice > 0) return scaleLighterInt(mkt.lastPrice, mkt.priceDecimals);
  if (client) {
    try {
      return await client.getBestPrice(mkt.marketIndex, isAsk);
    } catch {
      /* empty */
    }
  }
  return 0;
}

export type RawLighterTrade = {
  trade_id?: number;
  market_id?: number;
  size?: string | number;
  price?: string | number;
  usd_amount?: string | number;
  ask_id?: number | string;
  bid_id?: number | string;
  ask_account_id?: number;
  bid_account_id?: number;
  is_maker_ask?: boolean;
  timestamp?: number;
  taker_fee?: number;
  maker_fee?: number;
};

export function parseLighterTrade(t: RawLighterTrade, accountIndex: number): VenueTrade | null {
  const isAsk = Number(t.ask_account_id) === accountIndex;
  const isBid = Number(t.bid_account_id) === accountIndex;
  if (!isAsk && !isBid) return null;
  const price = Number(t.price ?? 0);
  const qty = Math.abs(Number(t.size ?? 0));
  if (!(price > 0) || !(qty > 0)) return null;
  const usd = Math.abs(Number(t.usd_amount ?? 0)) || price * qty;
  const rawTs = Number(t.timestamp ?? 0);
  const time = rawTs > 0 && rawTs < 1e12 ? rawTs * 1000 : rawTs;
  const isMaker = (isAsk && Boolean(t.is_maker_ask)) || (isBid && !t.is_maker_ask);
  const feeBps = Number(isMaker ? t.maker_fee ?? 0 : t.taker_fee ?? 0);
  const commission = Number.isFinite(feeBps) && feeBps > 0 ? (usd * feeBps) / 10_000 : 0;
  return {
    time,
    side: isAsk ? "SELL" : "BUY",
    price,
    qty,
    realizedPnl: 0,
    commission,
    orderId: isAsk ? (t.ask_id != null ? String(t.ask_id) : undefined) : t.bid_id != null ? String(t.bid_id) : undefined,
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function accountQuery(account: ExchangeAccount) {
  const q =
    account.accountIndex != null
      ? `by=index&value=${account.accountIndex}`
      : account.apiKey
        ? `by=l1_address&value=${account.apiKey}`
        : null;
  if (!q) return null;
  const res = await fetch(`${BASE}/api/v1/account?${q}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) return null;
  return (await res.json()) as {
    accounts?: Array<{
      collateral?: string;
      available_balance?: string;
      total_order_count?: number;
      pending_order_count?: number;
      positions?: Array<{
        symbol: string;
        position?: string;
        avg_entry_price?: string;
        leverage?: string;
        unrealized_pnl?: string;
        market_id?: number;
      }>;
    }>;
    collateral?: string;
    available_balance?: string;
  };
}

export const lighterAdapter: ExchangeAdapter = {
  id: "lighter",
  label: "Lighter",
  kind: "dex",
  docs: "https://apidocs.lighter.xyz/docs/get-started",
  symbolOf: (base) => base,
  async listMarkets(): Promise<ListedMarket[]> {
    const rows = await fetchLighterMarkets();
    const out: ListedMarket[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.status && r.status !== "active") continue;
      const base = isTradeableBase(r.coin);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      out.push({
        base,
        symbol: `${base}USDT`,
        venueSymbol: nativeSymbol("lighter", base),
        volume24hUsd: r.volume24hUsd,
        maxLeverage: r.maxLeverage,
      });
    }
    return out;
  },
  async fetchMaxLeverage(symbol) {
    const markets = await fetchLighterMarkets();
    const row = marketOf(markets, symbol);
    return capLeverage(row?.maxLeverage || defaultMaxLeverage(symbol));
  },
  async fetchWallet(account): Promise<WalletSnapshot | null> {
    if (!account.apiKey && account.accountIndex == null) return null;
    try {
      const json = await accountQuery(account);
      if (!json) return null;
      const acc = json.accounts?.[0] ?? json;
      const available = Number(acc.available_balance ?? acc.collateral ?? 0);
      const equity = Number(acc.collateral ?? acc.available_balance ?? 0);
      if (!Number.isFinite(available) && !Number.isFinite(equity)) return null;
      const a = Number.isFinite(available) ? Math.max(0, available) : 0;
      const e = Number.isFinite(equity) ? Math.max(0, equity) : a;
      return { equity: e, available: a };
    } catch {
      return null;
    }
  },
  async fetchBalance(account) {
    const w = this.fetchWallet ? await this.fetchWallet(account) : null;
    return w?.available ?? null;
  },
  async placeOrder(account, order: PlaceOrderInput): Promise<PlaceOrderResult> {
    try {
      const markets = await fetchLighterMarkets();
      const mkt = marketOf(markets, order.symbol);
      if (!mkt) return { ok: false, message: `Lighter has no market for ${order.symbol}` };
      if (mkt.minBase > 0 && order.qty < mkt.minBase) {
        return { ok: false, message: `Lighter min size is ${mkt.minBase} ${mkt.coin}` };
      }
      const refPx = Number(order.entry ?? 0) || mkt.lastPrice;
      if (refPx > 0 && order.qty * refPx < 10) {
        return { ok: false, message: `Lighter min notional is $10 (got ${(order.qty * refPx).toFixed(2)})` };
      }
      const qty = scaleLighterInt(order.qty, mkt.sizeDecimals);
      const sl = scaleLighterInt(order.sl, mkt.priceDecimals);
      const tp = scaleLighterInt(order.tp, mkt.priceDecimals);
      const isAsk = order.side === "short";
      const hash = await withSigner(account, async (client) => {
        await getLighterAuth(account, client);
        try {
          await client.updateLeverage(mkt.marketIndex, 0, capLeverage(Math.min(order.leverage, mkt.maxLeverage)));
        } catch {
          /* already set */
        }
        const ideal = await getBestPriceScaled(mkt, isAsk, client);
        const otoco = await client.createOtocoOrder({
          mainOrder: {
            marketIndex: mkt.marketIndex,
            baseAmount: qty,
            isAsk,
            orderType: 1,
            clientOrderIndex: Date.now() % 1_000_000_000,
            avgExecutionPrice: ideal || undefined,
            idealPrice: ideal || undefined,
            maxSlippage: 0.015,
          },
          stopLoss: { triggerPrice: sl, isLimit: false },
          takeProfit: { triggerPrice: tp, isLimit: false },
        });
        if (otoco.error) throw new Error(otoco.error);
        if (!otoco.hash) {
          throw new Error("Lighter OTOCO did not confirm — no order sent");
        }
        return otoco.hash;
      });
      let pos: { qty: number; entry: number } | undefined;
      let readFailed = false;
      for (let i = 0; i < 4; i++) {
        if (i) await new Promise((r) => setTimeout(r, 350));
        try {
          pos = (await this.fetchPositions(account)).find((p) => coinOf(p.symbol) === mkt.coin);
          readFailed = false;
          if (pos?.qty) break;
        } catch {
          readFailed = true;
        }
      }
      if (readFailed && !pos?.qty) {
        try {
          const closed = await this.closePosition(account, order.symbol);
          const flat = closed.ok || closed.message === "flat";
          if (flat) return { ok: false, orderId: hash, message: "Lighter fill unconfirmed — flattened, no unprotected position left" };
          return {
            ok: false,
            liveOpen: true,
            orderId: hash,
            message: `Lighter fill unconfirmed — flatten failed (${closed.message})`,
          };
        } catch (err) {
          return {
            ok: false,
            liveOpen: true,
            orderId: hash,
            message: `Lighter fill unconfirmed — flatten failed (${err instanceof Error ? err.message : "close threw"})`,
          };
        }
      }
      if (!pos?.qty) {
        return { ok: false, orderId: hash, message: "Lighter OTOCO did not fill" };
      }

      const paperEntry = Number(order.entry ?? 0);
      const fillPx = pos.entry > 0 ? pos.entry : paperEntry;
      let finalSl = order.sl;
      let finalTp = order.tp;
      if (paperEntry > 0 && fillPx > 0) {
        const rebased = rebaseStopsFromFill({ paperEntry, fill: fillPx, sl: order.sl, tp: order.tp });
        const drift = Math.abs(rebased.sl - order.sl) / fillPx;
        if (drift > 1e-4) {
          const moved = await this.updateStop(account, {
            symbol: order.symbol,
            side: order.side,
            sl: rebased.sl,
            tp: rebased.tp,
            qty: pos.qty,
          });
          if (moved.ok) {
            finalSl = rebased.sl;
            finalTp = rebased.tp;
          }
        }
      }

      let prot: ProtectionSnapshot = { onVenue: true, hasSl: false, hasTp: false, unknown: true };
      for (let i = 0; i < 3; i++) {
        prot = await this.fetchProtection(account, { symbol: order.symbol, sl: finalSl, tp: finalTp });
        if (!prot.unknown && prot.hasSl && prot.hasTp) break;
        if (i < 2) await new Promise((r) => setTimeout(r, 350));
      }
      if (prot.unknown || !prot.hasSl || !prot.hasTp) {
        const missing = prot.unknown
          ? "SL/TP unconfirmed"
          : [!prot.hasSl && "SL", !prot.hasTp && "TP"].filter(Boolean).join("+") + " missing";
        try {
          const closed = await this.closePosition(account, order.symbol);
          const flat = closed.ok || closed.message === "flat";
          if (flat) {
            return { ok: false, orderId: hash, message: `Lighter filled but ${missing} — flattened, no unprotected position left` };
          }
          return {
            ok: false,
            liveOpen: true,
            orderId: hash,
            message: `Lighter filled but ${missing} — flatten failed (${closed.message})`,
          };
        } catch (err) {
          return {
            ok: false,
            liveOpen: true,
            orderId: hash,
            message: `Lighter filled but ${missing} — flatten failed (${err instanceof Error ? err.message : "close threw"})`,
          };
        }
      }
      return {
        ok: true,
        orderId: hash,
        fillPrice: fillPx || undefined,
        filledQty: pos.qty,
        sl: finalSl,
        tp: finalTp,
        message: `Lighter ${order.side} ${mkt.coin} · SL/TP on venue`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Lighter order failed" };
    }
  },
  async placeLimitOrder(account, order: PlaceLimitOrderInput): Promise<PlaceLimitOrderResult> {
    try {
      const markets = await fetchLighterMarkets();
      const mkt = marketOf(markets, order.symbol);
      if (!mkt) return { ok: false, message: `Lighter has no market for ${order.symbol}` };
      if (mkt.minBase > 0 && order.qty < mkt.minBase) {
        return { ok: false, message: `Lighter min size is ${mkt.minBase} ${mkt.coin}` };
      }
      if (order.qty * order.entry < 10) {
        return { ok: false, message: `Lighter min notional is $10 (got ${(order.qty * order.entry).toFixed(2)})` };
      }
      const qty = scaleLighterInt(order.qty, mkt.sizeDecimals);
      const entry = scaleLighterInt(order.entry, mkt.priceDecimals);
      const sl = scaleLighterInt(order.sl, mkt.priceDecimals);
      const tp = scaleLighterInt(order.tp, mkt.priceDecimals);
      const isAsk = order.side === "short";
      const hash = await withSigner(account, async (client) => {
        await getLighterAuth(account, client);
        try {
          await client.updateLeverage(mkt.marketIndex, 0, capLeverage(Math.min(order.leverage, mkt.maxLeverage)));
        } catch {
          /* already set */
        }
        const otoco = await client.createOtocoOrder({
          mainOrder: {
            marketIndex: mkt.marketIndex,
            baseAmount: qty,
            isAsk,
            orderType: 0,
            price: entry,
            timeInForce: 1,
            clientOrderIndex: Date.now() % 1_000_000_000,
          },
          stopLoss: { triggerPrice: sl, isLimit: false },
          takeProfit: { triggerPrice: tp, isLimit: false },
        });
        if (otoco.error) throw new Error(otoco.error);
        if (!otoco.hash) {
          throw new Error("Lighter limit OTOCO did not confirm — no order sent");
        }
        return otoco.hash;
      });
      await new Promise((r) => setTimeout(r, 350));
      try {
        const pos = (await this.fetchPositions(account)).find((p) => coinOf(p.symbol) === mkt.coin);
        if (pos?.qty) {
          const fillPx = pos.entry > 0 ? pos.entry : order.entry;
          const prot = await this.fetchProtection(account, { symbol: order.symbol, sl: order.sl, tp: order.tp });
          if (prot.unknown || !prot.hasSl || !prot.hasTp) {
            const moved = await this.updateStop(account, {
              symbol: order.symbol,
              side: order.side,
              sl: order.sl,
              tp: order.tp,
              qty: pos.qty,
            });
            if (!moved.ok) {
              const closed = await this.closePosition(account, order.symbol);
              const flat = closed.ok || closed.message === "flat";
              return {
                ok: false,
                liveOpen: !flat,
                orderId: hash,
                message: flat
                  ? "Lighter limit filled without SL/TP — flattened"
                  : `Lighter limit filled without SL/TP — flatten failed (${closed.message})`,
              };
            }
          }
          return {
            ok: true,
            filled: true,
            resting: false,
            orderId: hash,
            fillPrice: fillPx,
            filledQty: pos.qty,
            sl: order.sl,
            tp: order.tp,
            message: `Lighter limit filled immediately · SL/TP attached`,
          };
        }
      } catch {
        /* check resting below */
      }
      let orderIdxId = hash;
      try {
        const opens = await this.fetchOpenOrders!(account, order.symbol);
        const match = opens.find((o) => o.side === order.side);
        if (match?.orderId) orderIdxId = match.orderId;
      } catch {
        /* keep hash */
      }
      return {
        ok: true,
        resting: true,
        filled: false,
        orderId: orderIdxId,
        message: `Lighter OTOCO limit ${order.side} ${mkt.coin} resting`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Lighter limit failed" };
    }
  },
  async cancelOrder(account, input) {
    try {
      const markets = await fetchLighterMarkets();
      const mkt = marketOf(markets, input.symbol);
      if (!mkt) return { ok: false, message: `Lighter has no market for ${input.symbol}` };
      const numericId = Number(input.orderId);
      const isOrderIndex = /^\d+$/.test(String(input.orderId ?? "").trim()) && Number.isFinite(numericId) && numericId > 0;
      await withSigner(account, async (client) => {
        if (isOrderIndex) {
          const [, , err] = await client.cancelOrder({ marketIndex: mkt.marketIndex, orderIndex: numericId });
          if (err && !/not found|unknown/i.test(err)) throw new Error(err);
          return;
        }
        const auth = await getLighterAuth(account, client);
        const opens = (await fetchActiveOrdersForMarket(account, mkt.marketIndex, auth)) ?? [];
        for (const o of opens) {
          if (o.reduce_only) continue;
          const orderIndex = Number(o.order_index ?? o.orderIndex);
          if (!Number.isFinite(orderIndex) || orderIndex <= 0) continue;
          try {
            await client.cancelOrder({ marketIndex: mkt.marketIndex, orderIndex });
          } catch {
            /* try remaining entry orders */
          }
        }
      });
      return { ok: true, message: "cancelled" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Lighter cancel failed" };
    }
  },
  async fetchOpenOrders(account, symbol): Promise<VenueOpenOrder[]> {
    if (account.accountIndex == null) return [];
    const markets = await fetchLighterMarkets();
    let targetMkts = symbol ? [marketOf(markets, symbol)].filter((m): m is MarketRow => Boolean(m)) : [];
    const auth = await getLighterAuth(account);
    if (!symbol) {
      // Narrow scan cleanly: active position markets + top liquid markets, or short-circuit if account has 0 open orders.
      const accJson = await accountQuery(account).catch(() => null);
      const acc = accJson?.accounts?.[0];
      if (acc && acc.total_order_count === 0 && acc.pending_order_count === 0) return [];
      const posMktIds = new Set((acc?.positions ?? []).filter((p) => Number(p.position) !== 0).map((p) => Number(p.market_id)));
      const prioritized = [
        ...markets.filter((m) => posMktIds.has(m.marketIndex)),
        ...markets
          .filter((m) => !posMktIds.has(m.marketIndex) && (!m.status || m.status === "active"))
          .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
          .slice(0, 24),
      ];
      targetMkts = prioritized;
    }
    const perMkt = await mapPool(targetMkts, 6, async (mkt) => {
      const orders = await fetchActiveOrdersForMarket(account, mkt.marketIndex, auth);
      if (!orders) return [];
      const out: VenueOpenOrder[] = [];
      for (const o of orders) {
        if (o.reduce_only) continue;
        const idx = Number(o.order_index ?? o.orderIndex);
        if (!Number.isFinite(idx) || idx <= 0) continue;
        out.push({
          orderId: String(idx),
          symbol: mkt.symbol,
          side: o.is_ask === true ? "short" : o.is_ask === false ? "long" : undefined,
          price: o.price != null ? Number(o.price) : undefined,
          qty: o.remaining_base_amount != null ? Number(o.remaining_base_amount) : undefined,
          reduceOnly: Boolean(o.reduce_only),
        });
      }
      return out;
    });
    return perMkt.flat();
  },
  async updateStop(account, order: UpdateStopInput): Promise<PlaceOrderResult> {
    try {
      const markets = await fetchLighterMarkets();
      const mkt = marketOf(markets, order.symbol);
      if (!mkt) return { ok: false, message: `Lighter has no market for ${order.symbol}` };
      const qty = scaleLighterInt(order.qty, mkt.sizeDecimals);
      const sl = scaleLighterInt(order.sl, mkt.priceDecimals);
      const tp = scaleLighterInt(order.tp, mkt.priceDecimals);
      const isAsk = order.side === "long";
      const hash = await withSigner(account, async (client) => {
        const auth = await getLighterAuth(account, client);
        const existing = (await fetchActiveOrdersForMarket(account, mkt.marketIndex, auth)) ?? [];
        const oldReduceOnlyIndexes = existing
          .filter((o) => Boolean(o.reduce_only))
          .map((o) => Number(o.order_index ?? o.orderIndex))
          .filter((idx) => Number.isFinite(idx) && idx > 0);

        const oco = await client.createOcoOrder({
          orders: [
            {
              marketIndex: mkt.marketIndex,
              clientOrderIndex: Date.now() % 1_000_000_000,
              baseAmount: qty,
              price: sl,
              isAsk,
              orderType: 2,
              timeInForce: 0,
              reduceOnly: true,
              triggerPrice: sl,
            },
            {
              marketIndex: mkt.marketIndex,
              clientOrderIndex: (Date.now() + 1) % 1_000_000_000,
              baseAmount: qty,
              price: tp,
              isAsk,
              orderType: 4,
              timeInForce: 0,
              reduceOnly: true,
              triggerPrice: tp,
            },
          ],
        });
        if (oco.error) throw new Error(oco.error);
        if (!oco.hash) throw new Error("Lighter OCO did not confirm — existing SL/TP left in place");
        for (const orderIndex of oldReduceOnlyIndexes) {
          try {
            await client.cancelOrder({ marketIndex: mkt.marketIndex, orderIndex });
          } catch {
            /* new OCO is live; leftover old reduce-only is safer than a gap */
          }
        }
        return oco.hash;
      });
      return { ok: true, orderId: hash, message: "Lighter SL moved · TP placed" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Lighter update stop failed" };
    }
  },
  async closePosition(account, symbol) {
    try {
      const markets = await fetchLighterMarkets();
      const mkt = marketOf(markets, symbol);
      if (!mkt) return { ok: false, message: "no market" };
      const pos = (await this.fetchPositions(account)).find((p) => coinOf(p.symbol) === mkt.coin);
      if (!pos || !pos.qty) return { ok: true, message: "flat" };
      const qty = scaleLighterInt(pos.qty, mkt.sizeDecimals);
      const isAsk = pos.side === "long";
      const hash = await withSigner(account, async (client) => {
        const px = await getBestPriceScaled(mkt, isAsk, client);
        const [, h, err] = await client.createMarketOrder({
          marketIndex: mkt.marketIndex,
          clientOrderIndex: Date.now() % 1_000_000_000,
          baseAmount: qty,
          avgExecutionPrice: px || scaleLighterInt(pos.entry || mkt.lastPrice || 1, mkt.priceDecimals),
          isAsk,
          reduceOnly: true,
        });
        if (err) throw new Error(err);
        return h;
      });
      let left: { qty: number } | undefined;
      let readFailed = false;
      for (let i = 0; i < 3; i++) {
        try {
          left = (await this.fetchPositions(account)).find((p) => coinOf(p.symbol) === mkt.coin);
          readFailed = false;
          if (!left?.qty) break;
        } catch {
          readFailed = true;
        }
        if (i < 2) await new Promise((r) => setTimeout(r, 400));
      }
      if (readFailed) {
        return {
          ok: false,
          orderId: hash,
          message: "Lighter close unconfirmed — SL/TP left in place",
        };
      }
      if (left?.qty) {
        return {
          ok: false,
          orderId: hash,
          message: "Lighter close left a remainder — SL/TP left in place",
        };
      }
      const auth = await getLighterAuth(account);
      const leftoverOrders = (await fetchActiveOrdersForMarket(account, mkt.marketIndex, auth)) ?? [];
      const leftovers = leftoverOrders
        .filter((o) => Boolean(o.reduce_only))
        .map((o) => Number(o.order_index ?? o.orderIndex))
        .filter((idx) => Number.isFinite(idx) && idx > 0);
      if (leftovers.length) {
        try {
          await withSigner(account, async (client) => {
            for (const orderIndex of leftovers) {
              try {
                await client.cancelOrder({ marketIndex: mkt.marketIndex, orderIndex });
              } catch {
                /* leftover reduce-only is optional once flat */
              }
            }
          });
        } catch {
          /* optional once flat */
        }
      }
      return { ok: true, orderId: hash, message: "closed" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "close failed" };
    }
  },
  async fetchPositions(account) {
    const json = await accountQuery(account);
    if (!json) throw new Error("Lighter account query failed");
    const pos = json.accounts?.[0]?.positions ?? [];
    return pos
      .filter((p) => Number(p.position) !== 0)
      .map((p) => ({
        symbol: p.symbol,
        side: Number(p.position) > 0 ? ("long" as const) : ("short" as const),
        qty: Math.abs(Number(p.position)),
        entry: Number(p.avg_entry_price ?? 0),
        leverage: Number(p.leverage ?? 1),
        upl: Number(p.unrealized_pnl ?? 0),
      }));
  },
  async fetchTrades(account, opts): Promise<VenueTrade[]> {
    if (account.accountIndex == null) return [];
    const markets = await fetchLighterMarkets();
    const mkt = marketOf(markets, opts.symbol);
    if (!mkt) return [];
    let auth = await getLighterAuth(account);
    for (let attempt = 0; attempt < 2; attempt++) {
      const q = new URLSearchParams({
        account_index: String(account.accountIndex),
        market_id: String(mkt.marketIndex),
        sort_by: "timestamp",
        sort_dir: "desc",
        limit: "100",
      });
      if (auth) q.set("auth", auth);
      const res = await fetch(`${BASE}/api/v1/trades?${q}`, {
        headers: auth ? { Authorization: auth } : undefined,
        signal: AbortSignal.timeout(8_000),
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0 && account.privateKey) {
        invalidateLighterAuth(account);
        auth = await getLighterAuth(account);
        continue;
      }
      if (!res.ok) return [];
      const json = (await res.json()) as { trades?: RawLighterTrade[] } | RawLighterTrade[];
      const rows = Array.isArray(json) ? json : json.trades ?? [];
      const out: VenueTrade[] = [];
      for (const r of rows) {
        const mapped = parseLighterTrade(r, account.accountIndex);
        if (!mapped) continue;
        if (opts.startTime && mapped.time < opts.startTime - 15_000) continue;
        out.push(mapped);
      }
      return out;
    }
    return [];
  },
  async fetchProtection(account, input): Promise<ProtectionSnapshot> {
    const markets = await fetchLighterMarkets();
    const mkt = marketOf(markets, input.symbol);
    if (!mkt) return { onVenue: false, hasSl: false, hasTp: false, unknown: true };
    let onVenue = false;
    try {
      const pos = (await this.fetchPositions(account)).find((p) => coinOf(p.symbol) === mkt.coin);
      onVenue = Boolean(pos?.qty);
    } catch {
      return { onVenue: false, hasSl: false, hasTp: false, unknown: true };
    }
    const orders = await fetchActiveOrdersForMarket(account, mkt.marketIndex);
    if (orders == null) return { onVenue, hasSl: false, hasTp: false, unknown: true };
    const { hasSl, hasTp } = classifyLighterProtection(orders, input.sl, input.tp);
    return { onVenue, hasSl, hasTp, unknown: false };
  },
  async testConnection(account) {
    try {
      const bal = await this.fetchBalance(account);
      if (account.accountIndex == null && !account.apiKey) {
        return { ok: false, message: "Need L1 address or account index to read the account." };
      }
      if (bal == null) return { ok: false, message: "Account not found on Lighter mainnet." };
      if (!account.privateKey) {
        return {
          ok: false,
          message: `Account visible (${bal.toFixed(2)} USDC) but no API private key — cannot sign orders.`,
        };
      }
      const check = await withSigner(account, async (client) => client.checkClient(true));
      if (check) return { ok: false, message: check };
      return { ok: true, message: `Lighter signer ready · account ${account.accountIndex} · ${bal.toFixed(2)} USDC` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Lighter ping failed" };
    }
  },
};
