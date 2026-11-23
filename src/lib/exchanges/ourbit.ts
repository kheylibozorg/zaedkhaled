import { rebaseStopsFromFill } from "@/lib/engine/paper";
import { roundToStep } from "./qty";
import { capLeverage } from "./lev-cap";
import { listedFromOurbitContracts, listedFromOurbitTickers } from "./ourbit-listed";
import {
  ourbitBarTimeMs,
  ourbitBody,
  ourbitCloseSide,
  ourbitOpenSide,
  ourbitQuery,
  ourbitSign,
  ourbitTradeSide,
} from "./ourbit-sign";
import { nativeSymbol } from "./meta";
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

const BASE = "https://futures.ourbit.com";
const UA = "Mozilla/5.0";

type Spec = {
  symbol: string;
  contractSize: number;
  minVol: number;
  volUnit: number;
  priceUnit: number;
  maxLeverage: number;
};

let specCache: { at: number; rows: Spec[] } | null = null;

function roundPrice(n: number, tick: number) {
  const s = tick > 0 ? tick : 0.1;
  return Number((Math.round(n / s) * s).toPrecision(12));
}

function sleep(ms: number) {
  return Promise.resolve().then(() => new Promise((r) => setTimeout(r, ms)));
}

function unwrap(json: unknown, path: string): unknown {
  if (json && typeof json === "object") {
    const o = json as { success?: boolean; code?: number; message?: string; msg?: string; data?: unknown };
    if (o.success === false || (o.code != null && o.code !== 0 && o.code !== 200)) {
      throw new Error(o.message || o.msg || `OURBIT ${path} failed`);
    }
    if ("data" in o) return o.data;
  }
  return json;
}

async function publicGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw */
  }
  if (!res.ok) {
    const msg =
      typeof json === "object" && json && "message" in json
        ? String((json as { message: string }).message)
        : text;
    throw new Error(msg || `OURBIT ${res.status}`);
  }
  return unwrap(json, path);
}

async function loadSpecs(): Promise<Spec[]> {
  const now = Date.now();
  if (specCache && now - specCache.at < 10 * 60_000) return specCache.rows;
  const raw = await publicGet("/api/v1/contract/detail");
  const rows = (Array.isArray(raw) ? raw : []) as Array<{
    symbol?: string;
    contractSize?: number | string;
    minVol?: number | string;
    volUnit?: number | string;
    priceUnit?: number | string;
    maxLeverage?: number | string;
  }>;
  const specs = rows
    .filter((r) => r.symbol)
    .map((r) => ({
      symbol: String(r.symbol),
      contractSize: Number(r.contractSize ?? 1) || 1,
      minVol: Number(r.minVol ?? 1) || 1,
      volUnit: Number(r.volUnit ?? 1) || 1,
      priceUnit: Number(r.priceUnit ?? 0) || 0,
      maxLeverage: capLeverage(Number(r.maxLeverage ?? 0) || 25),
    }));
  specCache = { at: now, rows: specs };
  return specs;
}

function specOf(rows: Spec[], symbol: string) {
  const want = symbol.toUpperCase();
  return rows.find((r) => r.symbol.toUpperCase() === want) ?? null;
}

function coinsOf(spec: Spec | null, contracts: number) {
  if (!spec) return contracts;
  return contracts * spec.contractSize;
}

function contractsOf(spec: Spec, qtyCoins: number) {
  return roundToStep(qtyCoins / spec.contractSize, spec.volUnit, spec.minVol);
}

async function signed(
  account: ExchangeAccount,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number | boolean | undefined> | unknown[],
) {
  if (!account.apiKey || !account.apiSecret) throw new Error("OURBIT API key and secret required");
  const ts = Date.now();
  let paramStr = "";
  let url = `${BASE}${path}`;
  let body: string | undefined;
  if (method === "GET") {
    const rec = (params && !Array.isArray(params) ? params : {}) as Record<string, string | number | undefined>;
    paramStr = ourbitQuery(rec);
    if (paramStr) url += `?${paramStr}`;
  } else {
    body = params === undefined ? "" : ourbitBody(params);
    paramStr = body;
  }
  const signature = ourbitSign(account.apiKey, account.apiSecret, ts, paramStr);
  const res = await fetch(url, {
    method,
    headers: {
      ApiKey: account.apiKey,
      "Request-Time": String(ts),
      Signature: signature,
      "Content-Type": "application/json",
      "Recv-Window": "20000",
      "User-Agent": UA,
    },
    body: method === "POST" ? body || undefined : undefined,
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw */
  }
  if (!res.ok) {
    const msg =
      typeof json === "object" && json && ("message" in json || "msg" in json)
        ? String((json as { message?: string; msg?: string }).message ?? (json as { msg?: string }).msg)
        : text;
    throw new Error(msg || `OURBIT ${res.status}`);
  }
  return unwrap(json, path);
}

type OurbitPos = {
  positionId?: number | string;
  symbol?: string;
  positionType?: number;
  openType?: number;
  holdVol?: number | string;
  frozenVol?: number | string;
  holdAvgPrice?: number | string;
  openAvgPrice?: number | string;
  leverage?: number | string;
  realised?: number | string;
  unrealized?: number | string;
  closeProfit?: number | string;
  stopLossPrice?: number | string;
  takeProfitPrice?: number | string;
};

function asRows(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.list)) return o.list;
  }
  return [];
}

function posLong(p: OurbitPos) {
  return Number(p.positionType) !== 2;
}

function pxClose(a: number, b: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return Math.abs(a - b) < 1e-8;
  return Math.abs(a - b) / Math.abs(b) < 0.015;
}

function sameOurbitSymbol(a: unknown, b: unknown) {
  return String(a ?? "").trim().toUpperCase() === String(b ?? "").trim().toUpperCase();
}

function extractOurbitOrderId(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const o = data as { orderId?: string | number; id?: string | number };
    if (o.orderId != null) return String(o.orderId);
    if (o.id != null) return String(o.id);
  } else if (data != null && (typeof data === "string" || typeof data === "number")) {
    return String(data);
  }
  return undefined;
}

async function readPositions(account: ExchangeAccount, symbol?: string): Promise<OurbitPos[]> {
  const raw = await signed(
    account,
    "GET",
    "/api/v1/private/position/open_positions",
    symbol ? { symbol } : undefined,
  );
  return asRows(raw) as OurbitPos[];
}

async function livePos(account: ExchangeAccount, symbol: string): Promise<OurbitPos | null> {
  try {
    const rows = await readPositions(account, symbol);
    return rows.find((p) => sameOurbitSymbol(p.symbol, symbol) && Number(p.holdVol ?? 0) > 0) ?? null;
  } catch {
    return null;
  }
}

async function ourbitHoldVol(account: ExchangeAccount, symbol: string): Promise<number | null> {
  try {
    const rows = await readPositions(account, symbol);
    const matching = rows.filter((p) => sameOurbitSymbol(p.symbol, symbol));
    const row = matching.find((p) => Number(p.holdVol ?? 0) > 0) ?? matching[0];
    if (!row) return 0;
    return Math.abs(Number(row.holdVol ?? 0)) || 0;
  } catch {
    return null;
  }
}

type Protection = { size: number; hasSl: boolean; hasTp: boolean; sideLong: boolean; unknown: boolean; fill: number };

async function listStops(account: ExchangeAccount, symbol: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const path of ["/api/v1/private/stoporder/list/orders", "/api/v1/private/planorder/list/orders"]) {
    try {
      const raw = await signed(account, "GET", path, { symbol, is_finished: 0, page_num: 1, page_size: 50 });
      for (const row of asRows(raw)) {
        if (row && typeof row === "object") out.push(row as Record<string, unknown>);
      }
    } catch {
      /* optional book */
    }
  }
  return out;
}

async function readProtection(account: ExchangeAccount, symbol: string, sl: number, tp: number): Promise<Protection> {
  const pos = await livePos(account, symbol);
  if (pos == null && (await ourbitHoldVol(account, symbol)) == null) {
    return { size: 0, hasSl: false, hasTp: false, sideLong: true, unknown: true, fill: 0 };
  }
  const size = Math.abs(Number(pos?.holdVol ?? 0));
  const sideLong = pos ? posLong(pos) : true;
  const fill = Number(pos?.holdAvgPrice ?? pos?.openAvgPrice ?? 0);
  let hasSl = pxClose(Number(pos?.stopLossPrice ?? 0), sl) || Number(pos?.stopLossPrice ?? 0) > 0;
  let hasTp = pxClose(Number(pos?.takeProfitPrice ?? 0), tp) || Number(pos?.takeProfitPrice ?? 0) > 0;
  if (!hasSl || !hasTp) {
    const opens = await listStops(account, symbol);
    for (const o of opens) {
      if (o.symbol && !sameOurbitSymbol(o.symbol, symbol)) continue;
      const stNum = Number(o.state ?? 1);
      if (Number.isFinite(stNum) && stNum !== 1 && stNum !== 0) continue;
      const blob = `${o.state ?? ""} ${o.triggerSide ?? ""} ${o.stopLossPrice ?? ""} ${o.takeProfitPrice ?? ""} ${o.triggerPrice ?? ""}`.toUpperCase();
      const px = Number(o.stopLossPrice ?? o.takeProfitPrice ?? o.triggerPrice ?? o.price ?? 0);
      if (blob.includes("LOSS") || pxClose(px, sl) || Number(o.stopLossPrice ?? 0) > 0) hasSl = true;
      if (blob.includes("PROFIT") || pxClose(px, tp) || Number(o.takeProfitPrice ?? 0) > 0) hasTp = true;
    }
  }
  return { size, hasSl, hasTp, sideLong, unknown: false, fill };
}

async function attachStops(
  account: ExchangeAccount,
  spec: Spec,
  pos: OurbitPos,
  sl: number,
  tp: number,
): Promise<{ slErr: string; tpErr: string }> {
  const symbol = String(pos.symbol ?? spec.symbol);
  const vol = Math.abs(Number(pos.holdVol ?? 0));
  const long = posLong(pos);
  const slPx = roundPrice(sl, spec.priceUnit);
  const tpPx = roundPrice(tp, spec.priceUnit);
  const tries: Array<() => Promise<unknown>> = [
    () =>
      signed(account, "POST", "/api/v1/private/position/change_stop_loss_take_profit", {
        positionId: pos.positionId,
        stopLossPrice: slPx,
        takeProfitPrice: tpPx,
        lossTrend: 2,
        profitTrend: 2,
      }),
    () =>
      signed(account, "POST", "/api/v1/private/stoporder/place", {
        symbol,
        vol,
        leverage: Number(pos.leverage ?? 1) || 1,
        side: long ? 1 : 3,
        openType: Number(pos.openType ?? 2) || 2,
        type: 5,
        stopLossPrice: slPx,
        takeProfitPrice: tpPx,
        lossTrend: 2,
        profitTrend: 2,
        positionId: pos.positionId,
      }),
    () =>
      signed(account, "POST", "/api/v1/private/stoporder/change_price", {
        orderId: pos.positionId,
        stopLossPrice: slPx,
        takeProfitPrice: tpPx,
      }),
  ];
  for (const run of tries) {
    try {
      await run();
      return { slErr: "", tpErr: "" };
    } catch {
      /* next shape */
    }
  }
  const closeSide = ourbitCloseSide(long);
  let slErr = "";
  let tpErr = "";
  try {
    await signed(account, "POST", "/api/v1/private/planorder/place", {
      symbol,
      price: 0,
      vol,
      leverage: Number(pos.leverage ?? 1) || 1,
      side: closeSide,
      openType: Number(pos.openType ?? 2) || 2,
      type: 5,
      orderType: 5,
      triggerPrice: slPx,
      triggerType: long ? 2 : 1,
      executeCycle: 1,
      trend: 2,
      reduceOnly: true,
    });
  } catch (err) {
    slErr = err instanceof Error ? err.message : "SL rejected";
  }
  try {
    await signed(account, "POST", "/api/v1/private/planorder/place", {
      symbol,
      price: 0,
      vol,
      leverage: Number(pos.leverage ?? 1) || 1,
      side: closeSide,
      openType: Number(pos.openType ?? 2) || 2,
      type: 5,
      orderType: 5,
      triggerPrice: tpPx,
      triggerType: long ? 1 : 2,
      executeCycle: 1,
      trend: 2,
      reduceOnly: true,
    });
  } catch (err) {
    tpErr = err instanceof Error ? err.message : "TP rejected";
  }
  return { slErr, tpErr };
}

async function cancelProtect(account: ExchangeAccount, symbol: string) {
  for (const path of ["/api/v1/private/stoporder/cancel_all", "/api/v1/private/planorder/cancel_all"]) {
    try {
      await signed(account, "POST", path, { symbol });
    } catch {
      /* leftover algos are optional once flat */
    }
  }
}

async function waitHold(account: ExchangeAccount, symbol: string): Promise<number | null> {
  let last: number | null = null;
  for (let i = 0; i < 4; i++) {
    last = await ourbitHoldVol(account, symbol);
    if (last != null && last !== 0) return last;
    if (i < 3) await sleep(300);
  }
  return last;
}

async function waitFlat(account: ExchangeAccount, symbol: string): Promise<"flat" | "open" | "unknown"> {
  let last: number | null = null;
  for (let i = 0; i < 4; i++) {
    last = await ourbitHoldVol(account, symbol);
    if (last === 0) return "flat";
    if (i < 3) await sleep(300);
  }
  if (last == null) return "unknown";
  return last === 0 ? "flat" : "open";
}

async function confirmAlreadyFlat(account: ExchangeAccount, symbol: string): Promise<"flat" | "open" | "unknown"> {
  let zeros = 0;
  for (let i = 0; i < 3; i++) {
    const amt = await ourbitHoldVol(account, symbol);
    if (amt == null) zeros = 0;
    else if (!amt) {
      zeros += 1;
      if (zeros >= 2) return "flat";
    } else return "open";
    if (i < 2) await sleep(300);
  }
  return "unknown";
}

async function marketClose(account: ExchangeAccount, symbol: string): Promise<PlaceOrderResult> {
  const pos = await livePos(account, symbol);
  const vol = pos ? Math.abs(Number(pos.holdVol ?? 0)) : await ourbitHoldVol(account, symbol);
  if (vol == null) return { ok: false, message: "OURBIT position read failed before close" };
  if (!vol) {
    const confirmed = await confirmAlreadyFlat(account, symbol);
    if (confirmed === "flat") return { ok: true, message: "flat" };
    if (confirmed !== "open") return { ok: false, message: "OURBIT close unconfirmed — SL/TP left in place" };
  }
  const row = pos ?? (await livePos(account, symbol));
  if (!row || !(Number(row.holdVol ?? 0) > 0)) {
    const confirmed = await confirmAlreadyFlat(account, symbol);
    if (confirmed === "flat") return { ok: true, message: "flat" };
    return { ok: false, message: "OURBIT close unconfirmed — SL/TP left in place" };
  }
  const long = posLong(row);
  await signed(account, "POST", "/api/v1/private/order/submit", {
    symbol,
    vol: Math.abs(Number(row.holdVol)),
    side: ourbitCloseSide(long),
    type: 5,
    openType: Number(row.openType ?? 2) || 2,
    positionId: row.positionId,
    reduceOnly: true,
  });
  const state = await waitFlat(account, symbol);
  if (state !== "flat") {
    return {
      ok: false,
      message:
        state === "unknown"
          ? "OURBIT close unconfirmed — SL/TP left in place"
          : "OURBIT close left a remainder — SL/TP left in place",
    };
  }
  await cancelProtect(account, symbol);
  return { ok: true, message: "closed" };
}

function flattenMessage(closed: PlaceOrderResult, why: string, orderId?: string): PlaceOrderResult {
  const flat = closed.ok || closed.message === "flat";
  if (flat) return { ok: false, message: `${why} — flattened, no unprotected position left` };
  return {
    ok: false,
    liveOpen: true,
    orderId,
    message: `${why} — flatten failed (${closed.message})`,
  };
}

async function flattenUnconfirmed(
  account: ExchangeAccount,
  symbol: string,
  why: string,
  orderId?: string,
): Promise<PlaceOrderResult> {
  try {
    const closed = await marketClose(account, symbol);
    return flattenMessage(closed, why, orderId);
  } catch (err) {
    return {
      ok: false,
      liveOpen: true,
      orderId,
      message: `${why} — flatten failed (${err instanceof Error ? err.message : "close threw"})`,
    };
  }
}

async function waitFill(
  account: ExchangeAccount,
  symbol: string,
  orderId?: string,
): Promise<{ px: number; qty: number }> {
  if (orderId) {
    try {
      const o = (await signed(account, "GET", `/api/v1/private/order/get/${orderId}`)) as {
        dealAvgPrice?: number | string;
        dealVol?: number | string;
      };
      const px = Number(o.dealAvgPrice ?? 0);
      const qty = Number(o.dealVol ?? 0);
      if (px > 0) return { px, qty };
    } catch {
      /* position fallback */
    }
  }
  let last = { px: 0, qty: 0 };
  for (let i = 0; i < 6; i++) {
    const pos = await livePos(account, symbol);
    const qty = Math.abs(Number(pos?.holdVol ?? 0));
    const px = Number(pos?.holdAvgPrice ?? pos?.openAvgPrice ?? 0);
    last = { px, qty };
    if (qty > 0 && px > 0) return last;
    if (i < 5) await sleep(350);
  }
  return last;
}

export const ourbitAdapter: ExchangeAdapter = {
  id: "ourbit",
  label: "OURBIT",
  kind: "cex",
  docs: "https://www.ourbit.com/support/articles/17827791513175",
  symbolOf: (base) => nativeSymbol("ourbit", base),
  async listMarkets(): Promise<ListedMarket[]> {
    const [detail, ticker] = await Promise.all([
      publicGet("/api/v1/contract/detail").catch(() => null),
      publicGet("/api/v1/contract/ticker").catch(() => null),
    ]);
    const vol = new Map<string, number>();
    const tickerRows = asRows(ticker) as Array<{ symbol?: string; amount24?: number | string }>;
    for (const t of tickerRows) {
      if (t.symbol) vol.set(t.symbol.toUpperCase(), Number(t.amount24 ?? 0) || 0);
    }
    let out = listedFromOurbitContracts(asRows(detail) as Parameters<typeof listedFromOurbitContracts>[0], vol);
    if (out.length < 8) out = listedFromOurbitTickers(tickerRows);
    return out;
  },
  async fetchMaxLeverage(symbol) {
    try {
      const rows = await loadSpecs();
      const spec = specOf(rows, symbol) ?? specOf(rows, nativeSymbol("ourbit", symbol));
      if (spec?.maxLeverage) return spec.maxLeverage;
    } catch {
      /* public book */
    }
    return 25;
  },
  async fetchWallet(account): Promise<WalletSnapshot | null> {
    const raw = await signed(account, "GET", "/api/v1/private/account/assets");
    const rows = asRows(raw) as Array<{
      currency?: string;
      availableBalance?: number | string;
      equity?: number | string;
      cashBalance?: number | string;
    }>;
    const usdt = rows.find((r) => String(r.currency ?? "").toUpperCase() === "USDT") ?? rows[0];
    if (!usdt) return null;
    const equity = Number(usdt.equity ?? usdt.cashBalance ?? usdt.availableBalance ?? 0);
    const available = Number(usdt.availableBalance ?? usdt.equity ?? usdt.cashBalance ?? 0);
    if (!Number.isFinite(available) && !Number.isFinite(equity)) return null;
    const a = Number.isFinite(available) ? Math.max(0, available) : 0;
    const e = Number.isFinite(equity) ? Math.max(0, equity) : a;
    return { equity: e, available: a };
  },
  async fetchBalance(account) {
    const w = this.fetchWallet ? await this.fetchWallet(account) : null;
    return w?.available ?? null;
  },
  async placeOrder(account, order: PlaceOrderInput): Promise<PlaceOrderResult> {
    if (!account.apiKey || !account.apiSecret) return { ok: false, message: "OURBIT API key and secret required" };
    let oid: string | undefined;
    try {
      const rows = await loadSpecs();
      const spec = specOf(rows, order.symbol) ?? specOf(rows, nativeSymbol("ourbit", order.symbol));
      if (!spec) return { ok: false, message: `OURBIT has no perp for ${order.symbol}` };
      const vol = contractsOf(spec, order.qty);
      if (!vol) {
        return {
          ok: false,
          message: `OURBIT size below min (${spec.minVol} contracts · ${spec.contractSize} ${order.symbol.split("_")[0]}/ct)`,
        };
      }
      const lev = capLeverage(Math.min(order.leverage, spec.maxLeverage || order.leverage));
      const long = order.side === "long";
      let acceptedOpenType = 2;
      try {
        await signed(account, "POST", "/api/v1/private/position/change_leverage", {
          symbol: spec.symbol,
          leverage: lev,
          openType: 2,
          positionType: long ? 1 : 2,
        });
      } catch {
        try {
          await signed(account, "POST", "/api/v1/private/position/change_leverage", {
            symbol: spec.symbol,
            leverage: lev,
            openType: 1,
            positionType: long ? 1 : 2,
          });
          acceptedOpenType = 1;
        } catch {
          /* leverage may already be set */
        }
      }
      const sendOrder = (openType: number) =>
        signed(account, "POST", "/api/v1/private/order/submit", {
          symbol: spec.symbol,
          vol,
          side: ourbitOpenSide(long),
          type: 5,
          openType,
          leverage: lev,
          externalOid: `apex-${Date.now()}`,
        });
      try {
        let data: unknown;
        try {
          data = await sendOrder(acceptedOpenType);
        } catch (firstErr) {
          const msg = firstErr instanceof Error ? firstErr.message : "";
          if (acceptedOpenType === 2 && /open\s?type|isolated|cross|margin\s?mode|position\s?mode/i.test(msg)) {
            data = await sendOrder(1);
          } else {
            throw firstErr;
          }
        }
        oid = extractOurbitOrderId(data);
      } catch (err) {
        const amt = await waitHold(account, spec.symbol);
        if (amt === 0) return { ok: false, message: err instanceof Error ? err.message : "OURBIT order failed" };
        if (amt == null) {
          return flattenUnconfirmed(
            account,
            spec.symbol,
            `OURBIT entry unconfirmed (${err instanceof Error ? err.message : "order failed"})`,
          );
        }
      }

      const live = await waitFill(account, spec.symbol, oid);
      const pos = await livePos(account, spec.symbol);
      if (!pos || !(Number(pos.holdVol) > 0)) {
        if (oid) return flattenUnconfirmed(account, spec.symbol, "OURBIT fill unconfirmed (position read failed)", oid);
        return { ok: false, message: "OURBIT market did not fill" };
      }
      const fillPx = live.px > 0 ? live.px : Number(pos.holdAvgPrice ?? pos.openAvgPrice ?? 0);
      const filledQty = coinsOf(spec, live.qty > 0 ? live.qty : Number(pos.holdVol ?? vol));
      const paperEntry = Number(order.entry ?? 0);
      const rebased = rebaseStopsFromFill({
        paperEntry: paperEntry || fillPx,
        fill: fillPx || paperEntry,
        sl: order.sl,
        tp: order.tp,
      });
      const sl = roundPrice(rebased.sl, spec.priceUnit);
      const tp = roundPrice(rebased.tp, spec.priceUnit);
      const placed = await attachStops(account, spec, pos, sl, tp);
      if (placed.slErr || placed.tpErr) {
        const missing = [placed.slErr && `SL: ${placed.slErr}`, placed.tpErr && `TP: ${placed.tpErr}`]
          .filter(Boolean)
          .join(" · ");
        return flattenUnconfirmed(account, spec.symbol, `OURBIT filled but ${missing}`, oid);
      }
      const prot = await readProtection(account, spec.symbol, sl, tp);
      if (prot.unknown ? false : prot.size > 0 && !(prot.hasSl && prot.hasTp)) {
        const retry = await attachStops(account, spec, pos, sl, tp);
        if (retry.slErr || retry.tpErr) {
          const missing = [!prot.hasSl && "SL", !prot.hasTp && "TP"].filter(Boolean).join("+");
          return flattenUnconfirmed(account, spec.symbol, `OURBIT filled but ${missing} missing`, oid);
        }
      }
      return {
        ok: true,
        orderId: oid,
        fillPrice: fillPx || undefined,
        filledQty: filledQty || undefined,
        sl,
        tp,
        message: `OURBIT market ${order.side} ${vol} ct · SL/TP on venue`,
      };
    } catch (err) {
      if (oid) {
        return flattenUnconfirmed(
          account,
          order.symbol,
          `OURBIT entry unconfirmed (${err instanceof Error ? err.message : "order failed"})`,
          oid,
        );
      }
      return { ok: false, message: err instanceof Error ? err.message : "OURBIT order failed" };
    }
  },
  async placeLimitOrder(account, order: PlaceLimitOrderInput): Promise<PlaceLimitOrderResult> {
    if (!account.apiKey || !account.apiSecret) return { ok: false, message: "OURBIT API key and secret required" };
    try {
      const rows = await loadSpecs();
      const spec = specOf(rows, order.symbol) ?? specOf(rows, nativeSymbol("ourbit", order.symbol));
      if (!spec) return { ok: false, message: `OURBIT has no perp for ${order.symbol}` };
      const vol = contractsOf(spec, order.qty);
      if (!vol) {
        return {
          ok: false,
          message: `OURBIT size below min (${spec.minVol} contracts · ${spec.contractSize} ${order.symbol.split("_")[0]}/ct)`,
        };
      }
      const lev = capLeverage(Math.min(order.leverage, spec.maxLeverage || order.leverage));
      const long = order.side === "long";
      const limitPx = roundPrice(order.entry, spec.priceUnit);
      const slPx = roundPrice(order.sl, spec.priceUnit);
      const tpPx = roundPrice(order.tp, spec.priceUnit);
      let acceptedOpenType = 2;
      try {
        await signed(account, "POST", "/api/v1/private/position/change_leverage", {
          symbol: spec.symbol,
          leverage: lev,
          openType: 2,
          positionType: long ? 1 : 2,
        });
      } catch {
        try {
          await signed(account, "POST", "/api/v1/private/position/change_leverage", {
            symbol: spec.symbol,
            leverage: lev,
            openType: 1,
            positionType: long ? 1 : 2,
          });
          acceptedOpenType = 1;
        } catch {
          /* leverage may already be set */
        }
      }
      const sendLimit = (openType: number) =>
        signed(account, "POST", "/api/v1/private/order/submit", {
          symbol: spec.symbol,
          price: limitPx,
          vol,
          side: ourbitOpenSide(long),
          type: 1,
          openType,
          leverage: lev,
          stopLossPrice: slPx,
          takeProfitPrice: tpPx,
          lossTrend: 2,
          profitTrend: 2,
          externalOid: `apex-lmt-${Date.now()}`,
        });
      let data: unknown;
      try {
        data = await sendLimit(acceptedOpenType);
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : "";
        if (acceptedOpenType === 2 && /open\s?type|isolated|cross|margin\s?mode|position\s?mode/i.test(msg)) {
          data = await sendLimit(1);
        } else {
          throw firstErr;
        }
      }
      const oid = extractOurbitOrderId(data);

      await sleep(250);
      const pos = await livePos(account, spec.symbol);
      if (pos && Number(pos.holdVol ?? 0) > 0) {
        const fillPx = Number(pos.holdAvgPrice ?? pos.openAvgPrice ?? limitPx);
        const filledQty = coinsOf(spec, Number(pos.holdVol ?? vol));
        const prot = await readProtection(account, spec.symbol, slPx, tpPx);
        if (!prot.unknown && !(prot.hasSl && prot.hasTp)) {
          const placed = await attachStops(account, spec, pos, slPx, tpPx);
          if (placed.slErr || placed.tpErr) {
            return flattenUnconfirmed(account, spec.symbol, "OURBIT limit filled without SL/TP", oid);
          }
        }
        return {
          ok: true,
          filled: true,
          resting: false,
          orderId: oid,
          fillPrice: fillPx,
          filledQty,
          sl: slPx,
          tp: tpPx,
          message: `OURBIT limit filled immediately · SL/TP on venue`,
        };
      }
      return {
        ok: true,
        resting: true,
        filled: false,
        orderId: oid,
        message: `OURBIT GTC limit ${order.side} ${vol} ct resting`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "OURBIT limit order failed" };
    }
  },
  async cancelOrder(account, input) {
    if (!account.apiKey || !account.apiSecret) return { ok: false, message: "OURBIT API key and secret required" };
    try {
      const id = Number(input.orderId);
      const payload = Number.isFinite(id) ? [id] : [input.orderId];
      try {
        await signed(account, "POST", "/api/v1/private/order/cancel", payload);
        return { ok: true, message: "cancelled" };
      } catch {
        const rows = await loadSpecs().catch(() => [] as Spec[]);
        const spec = specOf(rows, input.symbol) ?? specOf(rows, nativeSymbol("ourbit", input.symbol));
        await signed(account, "POST", "/api/v1/private/order/cancel", {
          symbol: spec?.symbol ?? nativeSymbol("ourbit", input.symbol),
          orderId: input.orderId,
        });
        return { ok: true, message: "cancelled" };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "OURBIT cancel failed";
      if (/not exist|cancelled|finished/i.test(msg)) return { ok: true, message: "already gone" };
      return { ok: false, message: msg };
    }
  },
  async fetchOpenOrders(account, symbol): Promise<VenueOpenOrder[]> {
    if (!account.apiKey || !account.apiSecret) return [];
    const specs = await loadSpecs().catch(() => [] as Spec[]);
    const spec = symbol ? specOf(specs, symbol) ?? specOf(specs, nativeSymbol("ourbit", symbol)) : null;
    const raw = await signed(
      account,
      "GET",
      "/api/v1/private/order/list/open_orders",
      spec?.symbol || symbol ? { symbol: spec?.symbol ?? symbol, page_num: 1, page_size: 100 } : { page_num: 1, page_size: 100 },
    );
    const rows = asRows(raw) as Array<{
      orderId?: string | number;
      symbol?: string;
      side?: number | string;
      price?: number | string;
      vol?: number | string;
      reduceOnly?: boolean;
      orderType?: number | string;
    }>;
    return rows
      .filter((r) => r.orderId != null && !r.reduceOnly && Number(r.side) !== 2 && Number(r.side) !== 4)
      .map((r) => {
        const sp = specOf(specs, String(r.symbol ?? ""));
        return {
          orderId: String(r.orderId),
          symbol: String(r.symbol ?? ""),
          side: Number(r.side) === 1 ? ("long" as const) : Number(r.side) === 3 ? ("short" as const) : undefined,
          price: Number(r.price ?? 0) || undefined,
          qty: coinsOf(sp, Number(r.vol ?? 0)) || undefined,
          reduceOnly: Boolean(r.reduceOnly),
        };
      });
  },
  async updateStop(account, order: UpdateStopInput): Promise<PlaceOrderResult> {
    if (!account.apiKey || !account.apiSecret) return { ok: false, message: "OURBIT API key and secret required" };
    try {
      const rows = await loadSpecs();
      const spec = specOf(rows, order.symbol) ?? specOf(rows, nativeSymbol("ourbit", order.symbol));
      if (!spec) return { ok: false, message: `OURBIT has no perp for ${order.symbol}` };
      const pos = await livePos(account, spec.symbol);
      if (!pos) return { ok: false, message: "OURBIT position gone before stop move" };
      const sl = roundPrice(order.sl, spec.priceUnit);
      const tp = roundPrice(order.tp, spec.priceUnit);
      await cancelProtect(account, spec.symbol);
      const placed = await attachStops(account, spec, pos, sl, tp);
      if (placed.slErr) return { ok: false, message: placed.slErr };
      return { ok: true, message: placed.tpErr ? "OURBIT SL moved to BE · TP kept" : "OURBIT SL/TP moved onto live fill" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "OURBIT update stop failed" };
    }
  },
  async closePosition(account, symbol) {
    try {
      return await marketClose(account, symbol);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "close failed" };
    }
  },
  async fetchPositions(account) {
    const specs = await loadSpecs().catch(() => [] as Spec[]);
    const rows = await readPositions(account);
    return rows
      .filter((r) => Number(r.holdVol ?? 0) !== 0)
      .map((r) => {
        const spec = specOf(specs, String(r.symbol ?? ""));
        const contracts = Math.abs(Number(r.holdVol ?? 0));
        return {
          symbol: String(r.symbol ?? ""),
          side: posLong(r) ? ("long" as const) : ("short" as const),
          qty: coinsOf(spec, contracts),
          entry: Number(r.holdAvgPrice ?? r.openAvgPrice ?? 0),
          leverage: Number(r.leverage ?? 1),
          upl: Number(r.unrealized ?? r.closeProfit ?? r.realised ?? 0),
        };
      });
  },
  async fetchTrades(account, opts): Promise<VenueTrade[]> {
    const specs = await loadSpecs().catch(() => [] as Spec[]);
    const spec = specOf(specs, opts.symbol) ?? specOf(specs, nativeSymbol("ourbit", opts.symbol));
    const raw = await signed(account, "GET", "/api/v1/private/order/list/order_deals", {
      symbol: spec?.symbol ?? opts.symbol,
      start_time: opts.startTime,
      page_num: 1,
      page_size: 100,
    });
    const rows = asRows(raw) as Array<{
      timestamp?: number;
      createTime?: number;
      side?: number | string;
      price?: number | string;
      dealPrice?: number | string;
      vol?: number | string;
      dealVol?: number | string;
      profit?: number | string;
      fee?: number | string;
      takerFee?: number | string;
      orderId?: number | string;
    }>;
    return rows.map((r) => {
      const contracts = Number(r.dealVol ?? r.vol ?? 0);
      return {
        time: ourbitBarTimeMs(Number(r.timestamp ?? r.createTime ?? 0)),
        side: ourbitTradeSide(r.side),
        price: Number(r.dealPrice ?? r.price ?? 0),
        qty: coinsOf(spec, contracts),
        realizedPnl: Number(r.profit ?? 0),
        commission: Number(r.fee ?? r.takerFee ?? 0),
        orderId: r.orderId != null ? String(r.orderId) : undefined,
      };
    });
  },
  async fetchProtection(account, input): Promise<ProtectionSnapshot> {
    if (!account.apiKey || !account.apiSecret) {
      return { onVenue: false, hasSl: false, hasTp: false, unknown: true };
    }
    const prot = await readProtection(account, input.symbol, input.sl, input.tp);
    if (prot.unknown) return { onVenue: false, hasSl: false, hasTp: false, unknown: true };
    return { onVenue: prot.size > 0, hasSl: prot.hasSl, hasTp: prot.hasTp, unknown: false };
  },
  async testConnection(account) {
    try {
      if (!account.apiKey || !account.apiSecret) return { ok: false, message: "OURBIT API key and secret required." };
      const bal = await this.fetchBalance(account);
      const pos = await this.fetchPositions(account);
      return { ok: true, message: `OURBIT live · ${(bal ?? 0).toFixed(2)} USDT · ${pos.length} open` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "OURBIT ping failed" };
    }
  },
};
