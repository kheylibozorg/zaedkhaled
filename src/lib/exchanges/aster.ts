import { rebaseStopsFromFill } from "@/lib/engine/paper";
import { privateKeyToAccount } from "viem/accounts";
import { signedQuery } from "./hmac";
import { roundToStep } from "./qty";
import { asterBracketRows, maxLeverageFromAsterTiers } from "./aster-brackets";
import { capLeverage } from "./lev-cap";
import { loadPublicLeverageMaps, venueMaxLeverage } from "./leverage";
import { isTradeableBase, nativeSymbol } from "./meta";
import {
  asterSignerPk,
  asterUserAddress,
  asterV3Path,
  formEncode,
  isAsterV3,
  nextAsterNonce,
  signAsterV3,
} from "./aster-sign";
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

const BASE = "https://fapi.asterdex.com";

type Spec = {
  symbol: string;
  minQty: number;
  stepSize: number;
  qtyPrecision: number;
  tickSize: number;
};

let specCache: { at: number; rows: Spec[] } | null = null;

function roundPrice(n: number, tick: number) {
  const s = tick > 0 ? tick : 0.1;
  return Number((Math.round(n / s) * s).toPrecision(12));
}

async function loadSpecs(): Promise<Spec[]> {
  const now = Date.now();
  if (specCache && now - specCache.at < 10 * 60_000) return specCache.rows;
  const res = await fetch(`${BASE}/fapi/v1/exchangeInfo`);
  if (!res.ok) throw new Error(`Aster exchangeInfo ${res.status}`);
  const info = (await res.json()) as {
    symbols?: Array<{
      symbol: string;
      quantityPrecision?: number;
      pricePrecision?: number;
      filters?: Array<{ filterType: string; minQty?: string; stepSize?: string; tickSize?: string }>;
    }>;
  };
  const rows = (info.symbols ?? []).map((s) => {
    const lot = s.filters?.find((f) => f.filterType === "LOT_SIZE") ?? s.filters?.find((f) => f.filterType === "MARKET_LOT_SIZE");
    const px = s.filters?.find((f) => f.filterType === "PRICE_FILTER");
    return {
      symbol: s.symbol,
      minQty: Number(lot?.minQty ?? 0),
      stepSize: Number(lot?.stepSize ?? 0) || 10 ** -(s.quantityPrecision ?? 3),
      qtyPrecision: s.quantityPrecision ?? 3,
      tickSize: Number(px?.tickSize ?? 0) || 10 ** -(s.pricePrecision ?? 1),
    };
  });
  specCache = { at: now, rows };
  return rows;
}

async function signed(
  account: ExchangeAccount,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | undefined>,
) {
  if (isAsterV3(account)) {
    const pk = asterSignerPk(account)!;
    const signer = privateKeyToAccount(pk).address;
    const user = asterUserAddress(account) || signer;
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      filtered[k] = String(v);
    }
    filtered.nonce = nextAsterNonce();
    filtered.user = user;
    filtered.signer = signer;
    const msg = formEncode(filtered);
    const signature = await signAsterV3(pk, msg);
    const body = `${msg}&signature=${signature}`;
    const v3 = asterV3Path(path);
    const useBody = method === "POST" || method === "DELETE";
    const url = useBody ? `${BASE}${v3}` : `${BASE}${v3}?${body}`;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: useBody ? body : undefined,
    });
    return parseAster(res, v3);
  }
  if (!account.apiKey || !account.apiSecret) {
    throw new Error("Aster API wallet private key required");
  }
  const p = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const { qs } = signedQuery(p, account.apiSecret);
  const url = method === "POST" ? `${BASE}${path}` : `${BASE}${path}?${qs}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": account.apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "POST" ? qs : undefined,
  });
  return parseAster(res, path);
}

async function parseAster(res: Response, path: string) {
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw */
  }
  if (!res.ok) {
    const msg = typeof json === "object" && json && "msg" in json ? String((json as { msg: string }).msg) : text;
    throw new Error(msg || `Aster ${res.status}`);
  }
  if (typeof json === "object" && json && "code" in json && Number((json as { code: unknown }).code) < 0) {
    const msg = "msg" in json ? String((json as { msg: string }).msg) : path;
    throw new Error(msg || `Aster ${path} failed`);
  }
  return json;
}

function isStopType(type: string, origType: string) {
  const typ = `${type} ${origType}`.toUpperCase();
  if (typ.includes("TAKE_PROFIT")) return false;
  return typ.includes("STOP");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function asterPositionAmt(account: ExchangeAccount, symbol: string): Promise<number | null> {
  try {
    const pos = (await signed(account, "GET", "/fapi/v2/positionRisk", { symbol })) as Array<{
      positionAmt: string;
      leverage?: string;
    }>;
    return Number(pos[0]?.positionAmt ?? 0);
  } catch {
    return null;
  }
}

async function asterSymbolLeverage(account: ExchangeAccount, symbol: string): Promise<number | null> {
  try {
    const pos = (await signed(account, "GET", "/fapi/v2/positionRisk", { symbol })) as Array<{
      leverage?: string;
    }>;
    const n = Number(pos[0]?.leverage);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function waitAsterFill(
  account: ExchangeAccount,
  symbol: string,
  orderId?: number,
): Promise<{ px: number; qty: number }> {
  if (orderId) {
    try {
      const o = (await signed(account, "GET", "/fapi/v1/order", { symbol, orderId })) as {
        avgPrice?: string;
        executedQty?: string;
      };
      const px = Number(o.avgPrice ?? 0);
      const qty = Number(o.executedQty ?? 0);
      if (px > 0) return { px, qty };
    } catch {
      /* fall through to position / trades */
    }
  }
  let last = { px: 0, qty: 0 };
  for (let i = 0; i < 6; i++) {
    try {
      const pos = (await signed(account, "GET", "/fapi/v2/positionRisk", { symbol })) as Array<{
        entryPrice?: string;
        positionAmt?: string;
      }>;
      const qty = Math.abs(Number(pos[0]?.positionAmt ?? 0));
      const px = Number(pos[0]?.entryPrice ?? 0);
      last = { px, qty };
      if (qty > 0 && px > 0) return last;
    } catch {
      /* retry */
    }
    if (orderId) {
      try {
        const trades = (await signed(account, "GET", "/fapi/v1/userTrades", {
          symbol,
          limit: 20,
        })) as Array<{ orderId?: number | string; price?: string; qty?: string }>;
        const mine = trades.filter((t) => String(t.orderId ?? "") === String(orderId));
        let notional = 0;
        let qty = 0;
        for (const t of mine) {
          const px = Number(t.price ?? 0);
          const q = Number(t.qty ?? 0);
          if (px > 0 && q > 0) {
            notional += px * q;
            qty += q;
          }
        }
        if (qty > 0 && notional > 0) {
          last = { px: notional / qty, qty };
          return last;
        }
      } catch {
        /* retry */
      }
    }
    if (i < 5) await sleep(350);
  }
  return last;
}

/** Wait until a fill shows up (or give up). 0 = confirmed flat, null = read failed. */
async function waitAsterAmt(account: ExchangeAccount, symbol: string): Promise<number | null> {
  let last: number | null = null;
  for (let i = 0; i < 3; i++) {
    last = await asterPositionAmt(account, symbol);
    if (last != null && last !== 0) return last;
    if (i < 2) await sleep(300);
  }
  return last;
}

/** Wait until the position is gone after a close. */
async function waitAsterFlat(account: ExchangeAccount, symbol: string): Promise<"flat" | "open" | "unknown"> {
  let last: number | null = null;
  for (let i = 0; i < 3; i++) {
    last = await asterPositionAmt(account, symbol);
    if (last === 0) return "flat";
    if (i < 2) await sleep(300);
  }
  if (last == null) return "unknown";
  return last === 0 ? "flat" : "open";
}

function triggerNow(msg: string) {
  return /trigger/i.test(msg);
}

async function asterProtectQty(account: ExchangeAccount, symbol: string, hinted?: number) {
  const specs = await loadSpecs();
  const spec = specs.find((s) => s.symbol === symbol);
  const amt = await asterPositionAmt(account, symbol);
  const raw = amt != null && amt !== 0 ? Math.abs(amt) : Number(hinted ?? 0);
  if (!(raw > 0)) return 0;
  return spec ? roundToStep(raw, spec.stepSize, spec.minQty) : Number(raw.toPrecision(8));
}

/**
 * Rest the paper exit on the book.
 * STOP / TAKE_PROFIT limit at that exact price, so a thin-book print cannot
 * fill the close back at entry. STOP_MARKET is only the fallback if the limit
 * type is rejected — never a flatten of a fresh fill.
 */
async function asterPlaceOneProtect(
  account: ExchangeAccount,
  symbol: string,
  closeSide: "BUY" | "SELL",
  kind: "sl" | "tp",
  price: number,
  qty: number,
): Promise<string> {
  const limitType = kind === "sl" ? "STOP" : "TAKE_PROFIT";
  const marketType = kind === "sl" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET";
  const tag = kind === "sl" ? "psl" : "ptp";
  const clientId = (salt: string) => `${tag}${salt}`.slice(0, 36);
  if (qty > 0) {
    try {
      await signed(account, "POST", "/fapi/v1/order", {
        symbol,
        side: closeSide,
        type: limitType,
        quantity: qty,
        price,
        stopPrice: price,
        timeInForce: "GTC",
        reduceOnly: "true",
        workingType: "CONTRACT_PRICE",
        newClientOrderId: clientId(`a${Date.now()}`),
      });
      return "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "rejected";
      if (triggerNow(msg)) {
        try {
          await signed(account, "POST", "/fapi/v1/order", {
            symbol,
            side: closeSide,
            type: "LIMIT",
            quantity: qty,
            price,
            timeInForce: "GTC",
            reduceOnly: "true",
            newClientOrderId: clientId(`b${Date.now()}`),
          });
          return "";
        } catch {
          /* market algo below still protects */
        }
      }
    }
  }
  try {
    await signed(account, "POST", "/fapi/v1/order", {
      symbol,
      side: closeSide,
      type: marketType,
      stopPrice: price,
      closePosition: "true",
      workingType: "CONTRACT_PRICE",
    });
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : "rejected";
  }
}

async function asterPlaceStops(
  account: ExchangeAccount,
  symbol: string,
  closeSide: "BUY" | "SELL",
  sl: number,
  tp: number,
  qtyHint?: number,
): Promise<{ slErr: string; tpErr: string }> {
  const qty = await asterProtectQty(account, symbol, qtyHint);
  const slErr = await asterPlaceOneProtect(account, symbol, closeSide, "sl", sl, qty);
  const tpErr = await asterPlaceOneProtect(account, symbol, closeSide, "tp", tp, qty);
  return { slErr, tpErr };
}

/** Place new SL/TP first, then drop the previous ones — no unprotected gap. */
async function asterReplaceStops(
  account: ExchangeAccount,
  symbol: string,
  closeSide: "BUY" | "SELL",
  sl: number,
  tp: number,
  qtyHint?: number,
): Promise<{ slErr: string; tpErr: string }> {
  let oldIds: number[] = [];
  try {
    const opens = (await signed(account, "GET", "/fapi/v1/openOrders", { symbol })) as Array<{
      orderId: number;
    }>;
    oldIds = opens.map((o) => o.orderId);
  } catch {
    /* still place the new pair */
  }
  const placed = await asterPlaceStops(account, symbol, closeSide, sl, tp, qtyHint);
  if (!placed.slErr && !placed.tpErr) {
    for (const orderId of oldIds) {
      try {
        await signed(account, "DELETE", "/fapi/v1/order", { symbol, orderId });
      } catch {
        /* new pair is live */
      }
    }
  }
  return placed;
}

async function asterMarketClose(account: ExchangeAccount, symbol: string): Promise<PlaceOrderResult> {
  const specs = await loadSpecs();
  const spec = specs.find((s) => s.symbol === symbol);
  const amt = await asterPositionAmt(account, symbol);
  if (amt == null) return { ok: false, message: "Aster position read failed before close" };
  if (!amt) return { ok: true, message: "flat" };
  const qty = spec ? roundToStep(Math.abs(amt), spec.stepSize, spec.minQty) : Math.abs(amt);
  if (!qty) return { ok: false, message: `Aster close size below min for ${symbol}` };
  const side = amt > 0 ? "SELL" : "BUY";
  await signed(account, "POST", "/fapi/v1/order", {
    symbol,
    side,
    type: "MARKET",
    quantity: qty,
    reduceOnly: "true",
  });
  return { ok: true, message: "closed" };
}

async function asterCancelOpen(account: ExchangeAccount, symbol: string) {
  try {
    await signed(account, "DELETE", "/fapi/v1/allOpenOrders", { symbol });
  } catch {
    /* leftover algo orders are optional once flat */
  }
}

/** Two successful zero reads. One zero can be API lag right after a fill. */
async function confirmAsterAlreadyFlat(account: ExchangeAccount, symbol: string): Promise<"flat" | "open" | "unknown"> {
  let zeros = 0;
  for (let i = 0; i < 3; i++) {
    const amt = await asterPositionAmt(account, symbol);
    if (amt == null) {
      zeros = 0;
    } else if (!amt) {
      zeros += 1;
      if (zeros >= 2) return "flat";
    } else {
      return "open";
    }
    if (i < 2) await sleep(300);
  }
  return "unknown";
}

/** Close first. Never cancel SL/TP unless the position is confirmed flat. */
async function closeAndDisarm(account: ExchangeAccount, symbol: string): Promise<PlaceOrderResult> {
  const closed = await asterMarketClose(account, symbol);
  if (!closed.ok && closed.message !== "flat") return closed;
  if (closed.message === "flat") {
    const state = await confirmAsterAlreadyFlat(account, symbol);
    if (state === "open") {
      const again = await asterMarketClose(account, symbol);
      if (!again.ok && again.message !== "flat") return again;
      if (again.message === "flat") {
        return { ok: false, message: "Aster close unconfirmed — SL/TP left in place" };
      }
      const after = await waitAsterFlat(account, symbol);
      if (after !== "flat") {
        return {
          ok: false,
          message:
            after === "unknown"
              ? "Aster close unconfirmed — SL/TP left in place"
              : "Aster close left a remainder — SL/TP left in place",
        };
      }
      await asterCancelOpen(account, symbol);
      return { ok: true, orderId: again.orderId, message: "closed" };
    }
    if (state !== "flat") {
      return { ok: false, message: "Aster close unconfirmed — SL/TP left in place" };
    }
    await asterCancelOpen(account, symbol);
    return closed;
  }
  const state = await waitAsterFlat(account, symbol);
  if (state !== "flat") {
    return {
      ok: false,
      message:
        state === "unknown"
          ? "Aster close unconfirmed — SL/TP left in place"
          : "Aster close left a remainder — SL/TP left in place",
    };
  }
  await asterCancelOpen(account, symbol);
  return closed;
}

function flattenMessage(closed: PlaceOrderResult, why: string, orderId?: string): PlaceOrderResult {
  const flat = closed.ok || closed.message === "flat";
  if (flat) {
    return { ok: false, message: `${why} — flattened, no unprotected position left` };
  }
  return {
    ok: false,
    liveOpen: true,
    orderId,
    message: `${why} — flatten failed (${closed.message})`,
  };
}

function numField(v: unknown) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Aster / Binance-style account payload → total equity + free capital. */
export function parseAsterWallet(data: unknown): WalletSnapshot | null {
  if (data == null) return null;
  if (Array.isArray(data)) {
    const rows = data as Array<Record<string, unknown>>;
    const usdt = rows.find((r) => String(r.asset ?? "").toUpperCase() === "USDT") ?? rows[0];
    if (!usdt) return null;
    const available = numField(usdt.availableBalance ?? usdt.maxWithdrawAmount ?? usdt.balance);
    const equity = numField(
      usdt.marginBalance ?? usdt.crossWalletBalance ?? usdt.walletBalance ?? usdt.balance ?? available,
    );
    if (!Number.isFinite(available) && !Number.isFinite(equity)) return null;
    const a = Number.isFinite(available) ? Math.max(0, available) : 0;
    const e = Number.isFinite(equity) ? Math.max(0, equity) : a;
    return { equity: e, available: a };
  }
  if (typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  const available = numField(rec.availableBalance ?? rec.maxWithdrawAmount);
  const equity = numField(rec.totalMarginBalance ?? rec.totalWalletBalance ?? rec.totalCrossWalletBalance ?? available);
  if (!Number.isFinite(available) && !Number.isFinite(equity)) return null;
  const a = Number.isFinite(available) ? Math.max(0, available) : 0;
  const e = Number.isFinite(equity) ? Math.max(0, equity) : a;
  return { equity: e, available: a };
}

export const asterAdapter: ExchangeAdapter = {
  id: "aster",
  label: "Aster",
  kind: "dex",
  docs: "https://www.asterdex.com/en/api-wallet",
  symbolOf: (base) => `${base}USDT`,
  async listMarkets(): Promise<ListedMarket[]> {
    const [infoRes, tickerRes, maps] = await Promise.all([
      fetch(`${BASE}/fapi/v1/exchangeInfo`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }),
      fetch(`${BASE}/fapi/v1/ticker/24hr`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) }).catch(() => null),
      loadPublicLeverageMaps().catch(() => null),
    ]);
    if (!infoRes.ok) throw new Error(`Aster exchangeInfo ${infoRes.status}`);
    const info = (await infoRes.json()) as {
      symbols?: Array<{
        symbol?: string;
        status?: string;
        contractType?: string;
        quoteAsset?: string;
      }>;
    };
    const vol = new Map<string, number>();
    if (tickerRes && tickerRes.ok) {
      try {
        const raw = (await tickerRes.json()) as Array<{ symbol?: string; quoteVolume?: string }> | { symbol?: string; quoteVolume?: string };
        const rows = Array.isArray(raw) ? raw : [raw];
        for (const t of rows) {
          if (t.symbol) vol.set(t.symbol.toUpperCase(), Number(t.quoteVolume ?? 0) || 0);
        }
      } catch {
        /* volume is optional */
      }
    }
    const out: ListedMarket[] = [];
    const seen = new Set<string>();
    for (const s of info.symbols ?? []) {
      if (!s.symbol) continue;
      if (s.status && s.status !== "TRADING") continue;
      if (s.contractType && s.contractType !== "PERPETUAL") continue;
      if (s.quoteAsset && s.quoteAsset !== "USDT") continue;
      const base = isTradeableBase(s.symbol);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      out.push({
        base,
        symbol: s.symbol,
        venueSymbol: nativeSymbol("aster", base),
        volume24hUsd: vol.get(s.symbol.toUpperCase()) ?? 0,
        maxLeverage: maps?.aster?.[base] ?? 0,
      });
    }
    return out;
  },
  async fetchMaxLeverage(symbol, account) {
    if (account && (isAsterV3(account) || (account.apiKey && account.apiSecret))) {
      try {
        const raw = await signed(account, "GET", "/fapi/v1/leverageBracket", { symbol });
        const max = Math.max(
          0,
          ...asterBracketRows(raw).map((r) => maxLeverageFromAsterTiers(r.riskBrackets ?? r.brackets)),
        );
        if (max) return capLeverage(max);
      } catch {
        /* public fallback */
      }
    }
    return venueMaxLeverage("aster", symbol);
  },
  async fetchWallet(account) {
    const data = await signed(account, "GET", "/fapi/v2/account", {});
    return parseAsterWallet(data);
  },
  async fetchBalance(account) {
    const w = this.fetchWallet ? await this.fetchWallet(account) : null;
    return w?.available ?? null;
  },
  async placeOrder(account, order: PlaceOrderInput): Promise<PlaceOrderResult> {
    try {
      const specs = await loadSpecs();
      const spec = specs.find((s) => s.symbol === order.symbol);
      const qty = spec
        ? roundToStep(order.qty, spec.stepSize, spec.minQty)
        : Number(order.qty.toPrecision(6));
      if (!qty) return { ok: false, message: `Aster size below min for ${order.symbol}` };
      const wantLev = capLeverage(order.leverage);
      try {
        await signed(account, "POST", "/fapi/v1/leverage", {
          symbol: order.symbol,
          leverage: wantLev,
        });
      } catch {
        /* read back below — never send size at a higher lev than asked */
      }
      const actualLev = await asterSymbolLeverage(account, order.symbol);
      if (actualLev != null && actualLev > wantLev) {
        return { ok: false, message: `Aster leverage ${actualLev}x over cap ${wantLev}x` };
      }
      const side = order.side === "long" ? "BUY" : "SELL";
      const closeSide = side === "BUY" ? "SELL" : "BUY";
      let data: { orderId?: number; avgPrice?: string; executedQty?: string } = {};
      try {
        data = (await signed(account, "POST", "/fapi/v1/order", {
          symbol: order.symbol,
          side,
          type: "MARKET",
          quantity: qty,
          newOrderRespType: "RESULT",
        })) as { orderId?: number; avgPrice?: string; executedQty?: string };
      } catch (err) {
        const why = err instanceof Error ? err.message : "Aster order failed";
        const amt = await waitAsterAmt(account, order.symbol);
        if (amt === 0) return { ok: false, message: why };
        if (amt == null) {
          try {
            const closed = await closeAndDisarm(account, order.symbol);
            return flattenMessage(closed, `Aster entry unconfirmed (${why})`);
          } catch (e) {
            return {
              ok: false,
              liveOpen: true,
              message: `Aster entry unconfirmed (${why}) — flatten failed (${e instanceof Error ? e.message : "close threw"})`,
            };
          }
        }
      }

      const fromResult = Number(data.avgPrice ?? 0);
      const filledFromResult = Number(data.executedQty ?? 0);
      let live = fromResult > 0
        ? { px: fromResult, qty: filledFromResult }
        : await waitAsterFill(account, order.symbol, data.orderId);
      let fillPx = live.px > 0 ? live.px : 0;
      let filledQty = live.qty > 0 ? live.qty : qty;
      const paperEntry = Number(order.entry ?? 0);
      const rebased = rebaseStopsFromFill({
        paperEntry: paperEntry || fillPx,
        fill: fillPx || paperEntry,
        sl: order.sl,
        tp: order.tp,
      });
      let sl = spec ? roundPrice(rebased.sl, spec.tickSize) : rebased.sl;
      let tp = spec ? roundPrice(rebased.tp, spec.tickSize) : rebased.tp;

      const { slErr, tpErr } = await asterPlaceStops(account, order.symbol, closeSide, sl, tp, filledQty);
      if (slErr || tpErr) {
        const missing = [slErr && `SL: ${slErr}`, tpErr && `TP: ${tpErr}`].filter(Boolean).join(" · ");
        const oid = data.orderId ? String(data.orderId) : undefined;
        try {
          const closed = await closeAndDisarm(account, order.symbol);
          return flattenMessage(closed, `Aster filled but ${missing}`, oid);
        } catch (err) {
          return {
            ok: false,
            liveOpen: true,
            orderId: oid,
            message: `Aster filled but ${missing} — flatten failed (${err instanceof Error ? err.message : "close threw"})`,
          };
        }
      }

      if (!(fillPx > 0)) {
        live = await waitAsterFill(account, order.symbol, data.orderId);
        if (live.px > 0) {
          fillPx = live.px;
          if (live.qty > 0) filledQty = live.qty;
          const later = rebaseStopsFromFill({
            paperEntry: paperEntry || fillPx,
            fill: fillPx,
            sl: order.sl,
            tp: order.tp,
          });
          const sl2 = spec ? roundPrice(later.sl, spec.tickSize) : later.sl;
          const tp2 = spec ? roundPrice(later.tp, spec.tickSize) : later.tp;
          if (Math.abs(sl2 - sl) > 1e-8 || Math.abs(tp2 - tp) > 1e-8) {
            const moved = await asterReplaceStops(account, order.symbol, closeSide, sl2, tp2, filledQty);
            if (!moved.slErr && !moved.tpErr) {
              sl = sl2;
              tp = tp2;
            }
          }
        }
      }

      return {
        ok: true,
        orderId: data.orderId ? String(data.orderId) : undefined,
        fillPrice: fillPx || undefined,
        filledQty: filledQty || undefined,
        sl,
        tp,
        message: "Aster market fill · SL/TP on venue",
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Aster order failed" };
    }
  },
  async placeLimitOrder(account, order: PlaceLimitOrderInput): Promise<PlaceLimitOrderResult> {
    try {
      const specs = await loadSpecs();
      const spec = specs.find((s) => s.symbol === order.symbol);
      const qty = spec
        ? roundToStep(order.qty, spec.stepSize, spec.minQty)
        : Number(order.qty.toPrecision(6));
      if (!qty) return { ok: false, message: `Aster size below min for ${order.symbol}` };
      const limitPx = spec ? roundPrice(order.entry, spec.tickSize) : Number(order.entry.toPrecision(8));
      if (!(limitPx > 0)) return { ok: false, message: `Invalid Aster limit price for ${order.symbol}` };
      const wantLev = capLeverage(order.leverage);
      try {
        await signed(account, "POST", "/fapi/v1/leverage", {
          symbol: order.symbol,
          leverage: wantLev,
        });
      } catch {
        /* checked below */
      }
      const actualLev = await asterSymbolLeverage(account, order.symbol);
      if (actualLev != null && actualLev > wantLev) {
        return { ok: false, message: `Aster leverage ${actualLev}x over cap ${wantLev}x` };
      }
      const side = order.side === "long" ? "BUY" : "SELL";
      const closeSide = side === "BUY" ? "SELL" : "BUY";
      const data = (await signed(account, "POST", "/fapi/v1/order", {
        symbol: order.symbol,
        side,
        type: "LIMIT",
        timeInForce: "GTC",
        price: limitPx,
        quantity: qty,
        newOrderRespType: "RESULT",
      })) as { orderId?: number; status?: string; avgPrice?: string; executedQty?: string };
      const oid = data.orderId ? String(data.orderId) : undefined;
      const status = String(data.status ?? "").toUpperCase();
      const execQty = Number(data.executedQty ?? 0);
      if (status === "FILLED" || execQty > 0) {
        const fillPx = Number(data.avgPrice ?? 0) || limitPx;
        const filledQty = execQty > 0 ? execQty : qty;
        const rebased = rebaseStopsFromFill({
          paperEntry: order.entry || fillPx,
          fill: fillPx,
          sl: order.sl,
          tp: order.tp,
        });
        const sl = spec ? roundPrice(rebased.sl, spec.tickSize) : rebased.sl;
        const tp = spec ? roundPrice(rebased.tp, spec.tickSize) : rebased.tp;
        const { slErr, tpErr } = await asterPlaceStops(account, order.symbol, closeSide, sl, tp, filledQty);
        if (slErr || tpErr) {
          const missing = [slErr && `SL: ${slErr}`, tpErr && `TP: ${tpErr}`].filter(Boolean).join(" · ");
          try {
            const closed = await closeAndDisarm(account, order.symbol);
            return flattenMessage(closed, `Aster limit filled but ${missing}`, oid);
          } catch (err) {
            return {
              ok: false,
              liveOpen: true,
              orderId: oid,
              message: `Aster limit filled but ${missing} — flatten failed (${err instanceof Error ? err.message : "close threw"})`,
            };
          }
        }
        return {
          ok: true,
          filled: true,
          resting: false,
          orderId: oid,
          fillPrice: fillPx,
          filledQty,
          sl,
          tp,
          message: "Aster limit filled immediately · SL/TP on venue",
        };
      }
      return {
        ok: true,
        resting: true,
        filled: false,
        orderId: oid,
        message: "Aster GTC limit resting",
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Aster limit order failed" };
    }
  },
  async cancelOrder(account, input) {
    try {
      await signed(account, "DELETE", "/fapi/v1/order", {
        symbol: input.symbol,
        orderId: input.orderId,
      });
      return { ok: true, message: "cancelled" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "cancel failed";
      if (/unknown order|does not exist|not found/i.test(msg)) {
        return { ok: true, message: "already gone" };
      }
      return { ok: false, message: msg };
    }
  },
  async fetchOpenOrders(account, symbol): Promise<VenueOpenOrder[]> {
    const raw = (await signed(
      account,
      "GET",
      "/fapi/v1/openOrders",
      symbol ? { symbol } : {},
    )) as Array<{
      orderId?: number | string;
      symbol?: string;
      side?: string;
      price?: string;
      origQty?: string;
      type?: string;
      origType?: string;
      reduceOnly?: boolean | string;
      clientOrderId?: string;
    }>;
    return (Array.isArray(raw) ? raw : [])
      .filter((o) => {
        const typ = `${o.type ?? ""} ${o.origType ?? ""}`.toUpperCase();
        if (typ.includes("STOP") || typ.includes("TAKE_PROFIT")) return false;
        if (o.reduceOnly === true || String(o.reduceOnly).toLowerCase() === "true") return false;
        return o.orderId != null;
      })
      .map((o) => ({
        orderId: String(o.orderId),
        symbol: String(o.symbol ?? ""),
        side: o.side === "BUY" ? ("long" as const) : o.side === "SELL" ? ("short" as const) : undefined,
        price: Number(o.price ?? 0) || undefined,
        qty: Number(o.origQty ?? 0) || undefined,
        reduceOnly: false,
        clientOrderId: o.clientOrderId,
      }));
  },
  async updateStop(account, order: UpdateStopInput): Promise<PlaceOrderResult> {
    try {
      const specs = await loadSpecs();
      const spec = specs.find((s) => s.symbol === order.symbol);
      const sl = spec ? roundPrice(order.sl, spec.tickSize) : order.sl;
      const tp = spec ? roundPrice(order.tp, spec.tickSize) : order.tp;
      const closeSide = order.side === "long" ? "SELL" : "BUY";
      const placed = await asterReplaceStops(account, order.symbol, closeSide, sl, tp, order.qty);
      if (placed.slErr || placed.tpErr) {
        const missing = [placed.slErr && `SL: ${placed.slErr}`, placed.tpErr && `TP: ${placed.tpErr}`]
          .filter(Boolean)
          .join(" · ");
        return { ok: false, message: missing || "Aster update stop failed" };
      }
      return { ok: true, message: "Aster SL/TP at paper price" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Aster update stop failed" };
    }
  },
  async closePosition(account, symbol) {
    try {
      return await closeAndDisarm(account, symbol);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "close failed" };
    }
  },
  async fetchPositions(account) {
    const raw = await signed(account, "GET", "/fapi/v2/positionRisk", {});
    const rows = (Array.isArray(raw) ? raw : []) as Array<{
      symbol: string;
      positionAmt: string;
      entryPrice: string;
      leverage: string;
      unRealizedProfit: string;
    }>;
    return rows
      .filter((r) => Number(r.positionAmt) !== 0)
      .map((r) => ({
        symbol: r.symbol,
        side: Number(r.positionAmt) > 0 ? ("long" as const) : ("short" as const),
        qty: Math.abs(Number(r.positionAmt)),
        entry: Number(r.entryPrice),
        leverage: Number(r.leverage),
        upl: Number(r.unRealizedProfit),
      }));
  },
  async fetchTrades(account, opts): Promise<VenueTrade[]> {
    const raw = await signed(account, "GET", "/fapi/v1/userTrades", {
      symbol: opts.symbol,
      startTime: opts.startTime,
      limit: 1000,
    });
    const rows = (Array.isArray(raw) ? raw : []) as Array<{
      time?: number;
      insertTime?: number;
      side?: string;
      price?: string;
      qty?: string;
      realizedPnl?: string;
      realizedProfit?: string;
      commission?: string;
      fee?: string;
      orderId?: number | string;
    }>;
    return rows.map((r) => ({
      time: Number(r.time ?? r.insertTime ?? 0),
      side: String(r.side ?? ""),
      price: Number(r.price ?? 0),
      qty: Number(r.qty ?? 0),
      realizedPnl: Number(r.realizedPnl ?? r.realizedProfit ?? 0),
      commission: Number(r.commission ?? r.fee ?? 0),
      orderId: r.orderId != null ? String(r.orderId) : undefined,
    }));
  },
  async fetchProtection(account, input): Promise<ProtectionSnapshot> {
    const amt = await asterPositionAmt(account, input.symbol);
    if (amt == null) return { onVenue: false, hasSl: false, hasTp: false, unknown: true };
    const onVenue = amt !== 0;
    try {
      const loadOpens = async () =>
        (await signed(account, "GET", "/fapi/v1/openOrders", { symbol: input.symbol })) as Array<{
          orderId?: number;
          type?: string;
          origType?: string;
          workingType?: string;
          clientOrderId?: string;
        }>;
      let opens = await loadOpens();
      const needsPaperLimit = opens.some((o) => {
        const typ = `${o.type ?? ""} ${o.origType ?? ""}`.toUpperCase();
        const algo = typ.includes("TAKE_PROFIT") || isStopType(o.type ?? "", o.origType ?? "");
        if (!algo) return false;
        // Mark trigger and market-stop both fill a thin book back at entry.
        return (
          String(o.workingType ?? "").toUpperCase() === "MARK_PRICE" ||
          typ.includes("STOP_MARKET") ||
          typ.includes("TAKE_PROFIT_MARKET")
        );
      });
      if (onVenue && needsPaperLimit && input.sl > 0 && input.tp > 0) {
        try {
          const closeSide = amt > 0 ? "SELL" : "BUY";
          await asterReplaceStops(account, input.symbol, closeSide, input.sl, input.tp);
          opens = await loadOpens();
        } catch {
          /* next tick retries; leave the existing stop in place */
        }
      }
      let hasSl = false;
      let hasTp = false;
      for (const o of opens) {
        const typ = `${o.type ?? ""} ${o.origType ?? ""}`.toUpperCase();
        const cid = String(o.clientOrderId ?? "").toLowerCase();
        if (typ.includes("TAKE_PROFIT") || cid.startsWith("ptp")) hasTp = true;
        else if (isStopType(o.type ?? "", o.origType ?? "") || cid.startsWith("psl")) hasSl = true;
      }
      return { onVenue, hasSl, hasTp, unknown: false };
    } catch {
      return { onVenue, hasSl: false, hasTp: false, unknown: true };
    }
  },
  async testConnection(account) {
    try {
      if (!isAsterV3(account) && (!account.apiKey || !account.apiSecret)) {
        return { ok: false, message: "Aster API wallet private key required." };
      }
      const bal = await this.fetchBalance(account);
      const pos = await this.fetchPositions(account);
      return { ok: true, message: `Aster live · ${(bal ?? 0).toFixed(2)} USDT · ${pos.length} open` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Aster ping failed" };
    }
  },
};
