import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { privateKeyToAccount } from "viem/accounts";
import { defaultMaxLeverage } from "@/lib/market/binance";
import { coinOf, isTradeableBase, nativeSymbol } from "./meta";
import { capLeverage } from "./lev-cap";
import { rebaseStopsFromFill } from "@/lib/engine/paper";
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

const INFO_URL = "https://api.hyperliquid.xyz/info";

type MetaAsset = { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean };
type Meta = { universe: MetaAsset[] };

function normalizePk(raw: string): `0x${string}` {
  const s = raw.trim();
  return (s.startsWith("0x") ? s : `0x${s}`) as `0x${string}`;
}

function triggerExecPx(trigger: number, closeBuy: boolean, szDec: number) {
  const slip = closeBuy ? 1.02 : 0.98;
  return formatPrice(trigger * slip, szDec);
}

function masterWalletOk(account: ExchangeAccount) {
  const w = account.walletAddress?.trim() ?? "";
  return /^0x[0-9a-fA-F]{40}$/.test(w);
}

function masterAddress(account: ExchangeAccount): `0x${string}` | null {
  const w = account.walletAddress?.trim();
  if (w && /^0x[0-9a-fA-F]{40}$/.test(w)) return w.toLowerCase() as `0x${string}`;
  return null;
}

async function info<T>(body: unknown): Promise<T> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
  return res.json() as Promise<T>;
}

let metaCache: { at: number; meta: Meta; mids: Record<string, string> } | null = null;

async function loadMeta() {
  const now = Date.now();
  if (metaCache && now - metaCache.at < 60_000) return metaCache;
  const [meta, mids] = await Promise.all([
    info<Meta>({ type: "meta" }),
    info<Record<string, string>>({ type: "allMids" }),
  ]);
  metaCache = { at: now, meta, mids };
  return metaCache;
}

function assetOf(meta: Meta, symbol: string) {
  const coin = coinOf(symbol);
  const idx = meta.universe.findIndex((u) => u.name.toUpperCase() === coin);
  if (idx < 0) return null;
  return { idx, asset: meta.universe[idx]!, coin };
}

function walletOf(account: ExchangeAccount) {
  if (!account.privateKey) throw new Error("Hyperliquid private key missing");
  return privateKeyToAccount(normalizePk(account.privateKey));
}

function clients(account: ExchangeAccount) {
  const transport = new HttpTransport();
  const wallet = walletOf(account);
  const exchange = new ExchangeClient({ transport, wallet });
  return { exchange };
}

function statusesOf(result: unknown): unknown[] {
  const r = result as { response?: { data?: { statuses?: unknown[] } } };
  return Array.isArray(r.response?.data?.statuses) ? r.response.data.statuses : [];
}

function statusError(st: unknown): string | null {
  if (st && typeof st === "object" && "error" in st) return String((st as { error: unknown }).error);
  return null;
}

export function allOrderErrors(result: unknown): string | null {
  const r = result as { status?: string };
  if (r.status && r.status !== "ok") return r.status;
  const errs = statusesOf(result)
    .map(statusError)
    .filter((e): e is string => Boolean(e));
  return errs.length ? errs.join("; ") : null;
}

function statusOid(st: unknown): string | undefined {
  if (!st || typeof st !== "object") return undefined;
  const rec = st as Record<string, { oid?: number }>;
  const hit = rec.filled ?? rec.resting;
  if (hit && typeof hit === "object" && hit.oid != null) return String(hit.oid);
  return undefined;
}

export function parseOrderId(result: unknown): string | undefined {
  return statusOid(statusesOf(result)[0]);
}

function entryLive(result: unknown): boolean {
  return Boolean(parseOrderId(result));
}

export function protectionLanded(result: unknown, minLegs: number): boolean {
  if (allOrderErrors(result)) return false;
  const st = statusesOf(result);
  if (st.length < minLegs) return false;
  return st.every((s) => !statusError(s));
}

type HlOpenOrder = {
  coin?: string;
  oid?: number;
  limitPx?: string | number;
  isTrigger?: boolean;
  triggerPx?: string | number;
  tpsl?: string;
  sz?: string;
  side?: string;
  reduceOnly?: boolean;
};

async function listTriggers(account: ExchangeAccount, coin: string): Promise<HlOpenOrder[]> {
  const user = masterAddress(account);
  if (!user) return [];
  const opens = await info<HlOpenOrder[]>({ type: "frontendOpenOrders", user });
  return (Array.isArray(opens) ? opens : []).filter(
    (o) => o.coin?.toUpperCase() === coin && Boolean(o.isTrigger) && Number.isFinite(o.oid),
  );
}

async function cancelOids(account: ExchangeAccount, assetIdx: number, oids: number[]) {
  if (!oids.length) return;
  const { exchange } = clients(account);
  await exchange.cancel({ cancels: oids.map((o) => ({ a: assetIdx, o })) });
}

async function coinPositionSize(account: ExchangeAccount, coin: string): Promise<number> {
  const user = masterAddress(account);
  if (!user) return 0;
  const state = await info<{
    assetPositions?: Array<{ position?: { coin: string; szi: string } }>;
  }>({ type: "clearinghouseState", user });
  const pos = state.assetPositions?.find((p) => p.position?.coin?.toUpperCase() === coin);
  return Math.abs(Number(pos?.position?.szi ?? 0));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHlFlat(account: ExchangeAccount, coin: string): Promise<"flat" | "open" | "unknown"> {
  let last: number | null = null;
  for (let i = 0; i < 3; i++) {
    try {
      last = await coinPositionSize(account, coin);
      if (last === 0) return "flat";
    } catch {
      last = null;
    }
    if (i < 2) await sleep(300);
  }
  if (last == null) return "unknown";
  return last === 0 ? "flat" : "open";
}

/** Two successful zero reads. One zero can be API lag right after a fill. */
async function confirmHlAlreadyFlat(account: ExchangeAccount, coin: string): Promise<"flat" | "open" | "unknown"> {
  if (!masterAddress(account)) return "unknown";
  let zeros = 0;
  for (let i = 0; i < 3; i++) {
    try {
      const sz = await coinPositionSize(account, coin);
      if (sz === 0) {
        zeros += 1;
        if (zeros >= 2) return "flat";
      } else {
        return "open";
      }
    } catch {
      zeros = 0;
    }
    if (i < 2) await sleep(300);
  }
  return "unknown";
}

async function marketCloseHl(account: ExchangeAccount, symbol: string): Promise<PlaceOrderResult> {
  if (!account.privateKey) return { ok: false, message: "Hyperliquid private key missing" };
  const user = masterAddress(account);
  if (!user) return { ok: false, message: "Hyperliquid address missing" };
  const { meta, mids } = await loadMeta();
  const hit = assetOf(meta, symbol);
  if (!hit) return { ok: false, message: "no market" };
  const state = await info<{
    assetPositions?: Array<{ position?: { coin: string; szi: string; entryPx?: string } }>;
  }>({ type: "clearinghouseState", user });
  const pos = state.assetPositions?.find((p) => p.position?.coin?.toUpperCase() === hit.coin);
  const szi = Number(pos?.position?.szi ?? 0);
  if (!szi) return { ok: true, message: "flat" };
  const mid = Number(mids[hit.coin] ?? 0);
  const entryFallback = Number(pos?.position?.entryPx ?? 0);
  const basePx = mid > 0 ? mid : entryFallback;
  if (!(basePx > 0)) return { ok: false, message: `No Hyperliquid reference price to close ${hit.coin}` };
  const isBuy = szi < 0;
  const slip = isBuy ? 1.02 : 0.98;
  const px = formatPrice(basePx * slip, hit.asset.szDecimals);
  const sz = formatSize(Math.abs(szi), hit.asset.szDecimals);
  const { exchange } = clients(account);
  const result = await exchange.order({
    orders: [
      {
        a: hit.idx,
        b: isBuy,
        p: px,
        s: sz,
        r: true,
        t: { limit: { tif: "Ioc" } },
      },
    ],
    grouping: "na",
  });
  const err = allOrderErrors(result);
  if (err) return { ok: false, message: err };
  return { ok: true, orderId: parseOrderId(result), message: "closed" };
}

/** Close first. Only cancel leftover triggers after the position is actually flat. */
async function closeAndDisarm(account: ExchangeAccount, symbol: string): Promise<PlaceOrderResult> {
  const closed = await marketCloseHl(account, symbol);
  if (!closed.ok && closed.message !== "flat") return closed;
  const { meta } = await loadMeta();
  const hit = assetOf(meta, symbol);
  if (!hit) {
    return { ok: false, message: "Hyperliquid close unconfirmed — SL/TP left in place" };
  }
  if (closed.message === "flat") {
    const state = await confirmHlAlreadyFlat(account, hit.coin);
    if (state === "open") {
      const again = await marketCloseHl(account, symbol);
      if (!again.ok && again.message !== "flat") return again;
      if (again.message === "flat") {
        return { ok: false, message: "Hyperliquid close unconfirmed — SL/TP left in place" };
      }
      const after = await waitHlFlat(account, hit.coin);
      if (after !== "flat") {
        return {
          ok: false,
          message:
            after === "unknown"
              ? "Hyperliquid close unconfirmed — SL/TP left in place"
              : "Hyperliquid close left a remainder — SL/TP left in place",
        };
      }
      try {
        const leftover = await listTriggers(account, hit.coin);
        await cancelOids(
          account,
          hit.idx,
          leftover.map((o) => Number(o.oid)),
        );
      } catch {
        /* leftover triggers are optional once flat */
      }
      return { ok: true, orderId: again.orderId, message: "closed" };
    }
    if (state !== "flat") {
      return { ok: false, message: "Hyperliquid close unconfirmed — SL/TP left in place" };
    }
  } else {
    const state = await waitHlFlat(account, hit.coin);
    if (state !== "flat") {
      return {
        ok: false,
        message:
          state === "unknown"
            ? "Hyperliquid close unconfirmed — SL/TP left in place"
            : "Hyperliquid close left a remainder — SL/TP left in place",
      };
    }
  }
  try {
    const leftover = await listTriggers(account, hit.coin);
    await cancelOids(
      account,
      hit.idx,
      leftover.map((o) => Number(o.oid)),
    );
  } catch {
    /* leftover triggers are optional once flat */
  }
  return closed.message === "flat" ? closed : { ok: true, orderId: closed.orderId, message: "closed" };
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

function pxClose(a: number, b: number) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(Math.abs(b), Math.abs(a), 1e-9);
  return Math.abs(a - b) / scale < 0.002;
}

export function filledMetaOf(result: unknown): { fillPrice?: number; filledQty?: number } {
  const st = statusesOf(result)[0] as { filled?: { avgPx?: string; totalSz?: string } } | undefined;
  const px = Number(st?.filled?.avgPx ?? 0);
  const qty = Number(st?.filled?.totalSz ?? 0);
  return {
    fillPrice: Number.isFinite(px) && px > 0 ? px : undefined,
    filledQty: Number.isFinite(qty) && qty > 0 ? qty : undefined,
  };
}

async function setHlLeverage(
  exchange: ReturnType<typeof clients>["exchange"],
  assetIdx: number,
  leverage: number,
  isCross = true,
) {
  try {
    await exchange.updateLeverage({ asset: assetIdx, isCross, leverage });
    return;
  } catch {
    /* some markets / configs only support the other margin mode */
  }
  try {
    await exchange.updateLeverage({ asset: assetIdx, isCross: !isCross, leverage });
  } catch {
    /* already set on venue */
  }
}

export const hyperliquidAdapter: ExchangeAdapter = {
  id: "hyperliquid",
  label: "Hyperliquid",
  kind: "dex",
  docs: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api",
  symbolOf: (base) => base,
  async listMarkets(): Promise<ListedMarket[]> {
    const json = await info<[Meta, Array<{ dayNtlVlm?: string; markPx?: string }>]>({
      type: "metaAndAssetCtxs",
    });
    const universe = json[0]?.universe ?? [];
    const ctxs = json[1] ?? [];
    const out: ListedMarket[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < universe.length; i++) {
      const u = universe[i]!;
      if (!u.name || u.isDelisted) continue;
      const mark = Number(ctxs[i]?.markPx ?? 0);
      if (mark <= 0) continue;
      const base = isTradeableBase(u.name);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      out.push({
        base,
        symbol: `${base}USDT`,
        venueSymbol: nativeSymbol("hyperliquid", base),
        volume24hUsd: Number(ctxs[i]?.dayNtlVlm ?? 0) || 0,
        maxLeverage: capLeverage(Number(u.maxLeverage ?? 0) || 0),
      });
    }
    return out;
  },
  async fetchMaxLeverage(symbol) {
    try {
      const { meta } = await loadMeta();
      const hit = assetOf(meta, symbol);
      return capLeverage(hit?.asset.maxLeverage || defaultMaxLeverage(symbol));
    } catch {
      return defaultMaxLeverage(symbol);
    }
  },
  async fetchWallet(account): Promise<WalletSnapshot | null> {
    const user = masterAddress(account);
    if (!user) return null;
    const state = await info<{ withdrawable?: string; marginSummary?: { accountValue?: string } }>({
      type: "clearinghouseState",
      user,
    });
    const equity = Number(state.marginSummary?.accountValue ?? state.withdrawable ?? 0);
    const available = Number(state.withdrawable ?? state.marginSummary?.accountValue ?? 0);
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
    try {
      if (!account.privateKey) return { ok: false, message: "Hyperliquid private key missing" };
      if (!masterWalletOk(account)) {
        return { ok: false, message: "Master wallet 0x address required. Agent keys cannot be armed without it." };
      }
      const { meta, mids } = await loadMeta();
      const hit = assetOf(meta, order.symbol);
      if (!hit) return { ok: false, message: `Hyperliquid has no market for ${order.symbol}` };
      const market = hit;
      const szDec = market.asset.szDecimals;
      const mid = Number(mids[hit.coin] ?? mids[hit.asset.name] ?? 0);
      if (!mid) return { ok: false, message: `No Hyperliquid mid for ${hit.coin}` };
      const isBuy = order.side === "long";
      const slip = isBuy ? 1.015 : 0.985;
      const px = formatPrice(mid * slip, szDec);
      const sz = formatSize(order.qty, szDec);
      if (!(Number(sz) > 0)) {
        return { ok: false, message: `Hyperliquid size below min step for ${hit.coin}` };
      }
      if (Number(sz) * mid < 10) {
        return { ok: false, message: `Hyperliquid min notional is $10 (got ${(Number(sz) * mid).toFixed(2)})` };
      }
      const lev = capLeverage(Math.min(order.leverage, hit.asset.maxLeverage || order.leverage));
      const { exchange } = clients(account);
      await setHlLeverage(exchange, hit.idx, lev, order.marginMode !== "isolated");
      const slPx = formatPrice(order.sl, szDec);
      const tpPx = formatPrice(order.tp, szDec);
      const closeBuy = !isBuy;
      const slExec = triggerExecPx(order.sl, closeBuy, szDec);
      const tpExec = triggerExecPx(order.tp, closeBuy, szDec);
      const entry = {
        a: hit.idx,
        b: isBuy,
        p: px,
        s: sz,
        r: Boolean(order.reduceOnly),
        t: { limit: { tif: "Ioc" as const } },
      };
      const sl = {
        a: hit.idx,
        b: closeBuy,
        p: slExec,
        s: sz,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: slPx, tpsl: "sl" as const } },
      };
      const tp = {
        a: hit.idx,
        b: closeBuy,
        p: tpExec,
        s: sz,
        r: true,
        t: { trigger: { isMarket: true, triggerPx: tpPx, tpsl: "tp" as const } },
      };

      async function place(params: Parameters<typeof exchange.order>[0]): Promise<unknown> {
        try {
          return await exchange.order(params);
        } catch (err) {
          return {
            status: "err",
            response: {
              data: { statuses: [{ error: err instanceof Error ? err.message : "order threw" }] },
            },
          };
        }
      }

      async function protectOrFlatten(entryResult: unknown, why: string): Promise<PlaceOrderResult> {
        let filled = entryLive(entryResult);
        if (!filled) {
          try {
            filled = (await coinPositionSize(account, market.coin)) > 0;
          } catch {
            filled = false;
          }
        }
        if (!filled) {
          try {
            await closeAndDisarm(account, order.symbol);
          } catch {
            /* leftover triggers optional if never filled */
          }
          return { ok: false, message: why };
        }
        const protect = await place({ orders: [sl, tp], grouping: "positionTpsl" });
        if (protectionLanded(protect, 2)) {
          const metaFill = filledMetaOf(entryResult);
          return {
            ok: true,
            orderId: parseOrderId(entryResult) ?? parseOrderId(protect),
            fillPrice: metaFill.fillPrice,
            filledQty: metaFill.filledQty,
            sl: Number(slPx),
            tp: Number(tpPx),
            message: `Hyperliquid IOC ${order.side} ${market.coin} · SL/TP on venue`,
          };
        }
        const oid = parseOrderId(entryResult) ?? parseOrderId(protect);
        try {
          const closed = await closeAndDisarm(account, order.symbol);
          return flattenMessage(closed, why, oid);
        } catch (err) {
          return {
            ok: false,
            liveOpen: true,
            orderId: oid,
            message: `${why} — flatten failed (${err instanceof Error ? err.message : "close threw"})`,
          };
        }
      }

      const grouped = await place({ orders: [entry, sl, tp], grouping: "normalTpsl" });
      if (protectionLanded(grouped, 3) && entryLive(grouped)) {
        const metaFill = filledMetaOf(grouped);
        return {
          ok: true,
          orderId: parseOrderId(grouped),
          fillPrice: metaFill.fillPrice,
          filledQty: metaFill.filledQty,
          sl: Number(slPx),
          tp: Number(tpPx),
          message: `Hyperliquid IOC ${order.side} ${hit.coin} · SL/TP on venue`,
        };
      }

      return await protectOrFlatten(
        grouped,
        allOrderErrors(grouped) || "Hyperliquid entry unconfirmed — not sending a second fill",
      );
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Hyperliquid order failed" };
    }
  },
  async placeLimitOrder(account, order: PlaceLimitOrderInput): Promise<PlaceLimitOrderResult> {
    try {
      if (!account.privateKey) return { ok: false, message: "Hyperliquid private key missing" };
      if (!masterWalletOk(account)) {
        return { ok: false, message: "Master wallet 0x address required. Agent keys cannot be armed without it." };
      }
      const { meta } = await loadMeta();
      const hit = assetOf(meta, order.symbol);
      if (!hit) return { ok: false, message: `Hyperliquid has no market for ${order.symbol}` };
      const szDec = hit.asset.szDecimals;
      const isBuy = order.side === "long";
      const px = formatPrice(order.entry, szDec);
      const sz = formatSize(order.qty, szDec);
      if (!(Number(sz) > 0)) {
        return { ok: false, message: `Hyperliquid limit size below min step for ${hit.coin}` };
      }
      if (Number(sz) * Number(px) < 10) {
        return { ok: false, message: `Hyperliquid min notional is $10 (got ${(Number(sz) * Number(px)).toFixed(2)})` };
      }
      const lev = capLeverage(Math.min(order.leverage, hit.asset.maxLeverage || order.leverage));
      const { exchange } = clients(account);
      await setHlLeverage(exchange, hit.idx, lev, order.marginMode !== "isolated");
      const slPx = formatPrice(order.sl, szDec);
      const tpPx = formatPrice(order.tp, szDec);
      const closeBuy = !isBuy;
      const slExec = triggerExecPx(order.sl, closeBuy, szDec);
      const tpExec = triggerExecPx(order.tp, closeBuy, szDec);
      const result = await exchange.order({
        orders: [
          {
            a: hit.idx,
            b: isBuy,
            p: px,
            s: sz,
            r: false,
            t: { limit: { tif: "Gtc" as const } },
          },
          {
            a: hit.idx,
            b: closeBuy,
            p: slExec,
            s: sz,
            r: true,
            t: { trigger: { isMarket: true, triggerPx: slPx, tpsl: "sl" as const } },
          },
          {
            a: hit.idx,
            b: closeBuy,
            p: tpExec,
            s: sz,
            r: true,
            t: { trigger: { isMarket: true, triggerPx: tpPx, tpsl: "tp" as const } },
          },
        ],
        grouping: "normalTpsl",
      });
      const err = allOrderErrors(result);
      if (err) return { ok: false, message: err };
      const st = statusesOf(result)[0] as
        | { resting?: { oid?: number }; filled?: { oid?: number; avgPx?: string; totalSz?: string } }
        | undefined;
      if (st?.filled?.oid != null) {
        const fillPx = Number(st.filled.avgPx ?? 0) || order.entry;
        const filledQty = Number(st.filled.totalSz ?? 0) || Number(sz);
        const rebased = rebaseStopsFromFill({
          paperEntry: order.entry || fillPx,
          fill: fillPx,
          sl: Number(slPx),
          tp: Number(tpPx),
        });
        const finalSlPx = formatPrice(rebased.sl, szDec);
        const finalTpPx = formatPrice(rebased.tp, szDec);
        if (
          Math.abs(Number(finalSlPx) - Number(slPx)) / Math.max(1e-12, fillPx) > 1e-4 ||
          Math.abs(Number(finalTpPx) - Number(tpPx)) / Math.max(1e-12, fillPx) > 1e-4
        ) {
          await this.updateStop(account, {
            symbol: order.symbol,
            side: order.side,
            sl: Number(finalSlPx),
            tp: Number(finalTpPx),
            qty: filledQty,
          }).catch(() => undefined);
        }
        return {
          ok: true,
          filled: true,
          resting: false,
          orderId: String(st.filled.oid),
          fillPrice: fillPx,
          filledQty,
          sl: Number(finalSlPx),
          tp: Number(finalTpPx),
          message: `Hyperliquid GTC limit filled immediately · SL/TP on venue`,
        };
      }
      if (st?.resting?.oid != null) {
        return {
          ok: true,
          resting: true,
          filled: false,
          orderId: String(st.resting.oid),
          message: `Hyperliquid GTC limit ${order.side} ${hit.coin} resting`,
        };
      }
      return { ok: false, message: "Hyperliquid GTC limit did not return resting oid" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Hyperliquid limit failed" };
    }
  },
  async cancelOrder(account, input) {
    try {
      if (!account.privateKey) return { ok: false, message: "Hyperliquid private key missing" };
      const { meta } = await loadMeta();
      const hit = assetOf(meta, input.symbol);
      if (!hit) return { ok: false, message: `Hyperliquid has no market for ${input.symbol}` };
      const oid = Number(input.orderId);
      if (Number.isFinite(oid) && oid > 0) {
        await cancelOids(account, hit.idx, [oid]);
      }
      try {
        const posSz = await coinPositionSize(account, hit.coin);
        if (posSz === 0) {
          const triggers = await listTriggers(account, hit.coin);
          const oids = triggers.map((t) => Number(t.oid)).filter((n) => Number.isFinite(n) && n > 0);
          if (oids.length) await cancelOids(account, hit.idx, oids);
        }
      } catch {
        /* triggers auto-cancel with normalTpsl */
      }
      return { ok: true, message: "cancelled" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Hyperliquid cancel failed" };
    }
  },
  async fetchOpenOrders(account, symbol): Promise<VenueOpenOrder[]> {
    const user = masterAddress(account);
    if (!user) return [];
    const opens = await info<HlOpenOrder[]>({ type: "frontendOpenOrders", user });
    const wantCoin = symbol ? coinOf(symbol) : null;
    return (Array.isArray(opens) ? opens : [])
      .filter((o) => {
        if (o.isTrigger || o.reduceOnly) return false;
        if (!Number.isFinite(o.oid)) return false;
        if (wantCoin && o.coin?.toUpperCase() !== wantCoin) return false;
        return true;
      })
      .map((o) => ({
        orderId: String(o.oid),
        symbol: String(o.coin ?? ""),
        side: o.side === "B" ? ("long" as const) : o.side === "A" ? ("short" as const) : undefined,
        price: Number(o.limitPx ?? 0) || undefined,
        qty: Number(o.sz ?? 0) || undefined,
        reduceOnly: Boolean(o.reduceOnly),
      }));
  },
  async updateStop(account, order: UpdateStopInput): Promise<PlaceOrderResult> {
    try {
      if (!account.privateKey) return { ok: false, message: "Hyperliquid private key missing" };
      const { meta } = await loadMeta();
      const hit = assetOf(meta, order.symbol);
      if (!hit) return { ok: false, message: `Hyperliquid has no market for ${order.symbol}` };
      const user = masterAddress(account);
      if (!user) return { ok: false, message: "Hyperliquid address missing" };
      const { exchange } = clients(account);
      const coin = hit.coin;
      const existing = await listTriggers(account, coin);
      const slPx = formatPrice(order.sl, hit.asset.szDecimals);
      const tpPx = formatPrice(order.tp, hit.asset.szDecimals);
      const sz = formatSize(order.qty, hit.asset.szDecimals);
      const closeBuy = order.side === "short";
      const slExec = triggerExecPx(order.sl, closeBuy, hit.asset.szDecimals);
      const tpExec = triggerExecPx(order.tp, closeBuy, hit.asset.szDecimals);
      const fresh = [
        {
          a: hit.idx,
          b: closeBuy,
          p: slExec,
          s: sz,
          r: true,
          t: { trigger: { isMarket: true, triggerPx: slPx, tpsl: "sl" as const } },
        },
        {
          a: hit.idx,
          b: closeBuy,
          p: tpExec,
          s: sz,
          r: true,
          t: { trigger: { isMarket: true, triggerPx: tpPx, tpsl: "tp" as const } },
        },
      ];

      async function placeFresh(): Promise<unknown> {
        try {
          return await exchange.order({ orders: fresh, grouping: "positionTpsl" });
        } catch (err) {
          return {
            status: "err",
            response: {
              data: { statuses: [{ error: err instanceof Error ? err.message : "order threw" }] },
            },
          };
        }
      }

      const first = await placeFresh();
      async function venueHasNewPair() {
        const opens = await listTriggers(account, coin);
        const hasSl = opens.some((o) => o.tpsl === "sl" && pxClose(Number(o.triggerPx), order.sl));
        const hasTp = opens.some((o) => o.tpsl === "tp" && pxClose(Number(o.triggerPx), order.tp));
        return { opens, hasSl, hasTp };
      }

      let check = await venueHasNewPair();
      if (!check.hasSl || !check.hasTp) {
        await placeFresh();
        check = await venueHasNewPair();
      }
      if (check.hasSl && check.hasTp) {
        const keep = new Set(
          check.opens
            .filter(
              (o) =>
                (o.tpsl === "sl" && pxClose(Number(o.triggerPx), order.sl)) ||
                (o.tpsl === "tp" && pxClose(Number(o.triggerPx), order.tp)),
            )
            .map((o) => String(o.oid)),
        );
        const stale = existing.filter((o) => o.oid != null && !keep.has(String(o.oid)));
        if (stale.length) {
          try {
            await cancelOids(
              account,
              hit.idx,
              stale.map((o) => Number(o.oid)),
            );
          } catch {
            /* new pair is live */
          }
        }
        return { ok: true, message: "Hyperliquid SL/TP synced" };
      }
      return {
        ok: false,
        message:
          allOrderErrors(first) ||
          "Hyperliquid stop sync did not confirm — original SL kept",
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Hyperliquid update stop failed" };
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
    const user = masterAddress(account);
    if (!user) throw new Error("Hyperliquid address missing");
    const state = await info<{
      assetPositions?: Array<{
        position?: {
          coin: string;
          szi: string;
          entryPx: string;
          leverage?: { value?: number };
          unrealizedPnl?: string;
        };
      }>;
    }>({ type: "clearinghouseState", user });
    return (state.assetPositions ?? [])
      .filter((p) => Number(p.position?.szi) !== 0)
      .map((p) => {
        const szi = Number(p.position!.szi);
        return {
          symbol: p.position!.coin,
          side: szi > 0 ? ("long" as const) : ("short" as const),
          qty: Math.abs(szi),
          entry: Number(p.position!.entryPx ?? 0),
          leverage: Number(p.position!.leverage?.value ?? 1),
          upl: Number(p.position!.unrealizedPnl ?? 0),
        };
      });
  },
  async fetchTrades(account, opts): Promise<VenueTrade[]> {
    const user = masterAddress(account);
    if (!user) return [];
    const wantCoin = coinOf(opts.symbol);
    const startTime = opts.startTime && opts.startTime > 0 ? opts.startTime : Date.now() - 86_400_000;
    const fills = await info<
      Array<{
        coin?: string;
        side?: string;
        px?: string | number;
        sz?: string | number;
        time?: number;
        closedPnl?: string | number;
        fee?: string | number;
        oid?: number | string;
      }>
    >({
      type: "userFillsByTime",
      user,
      startTime,
    });
    return (Array.isArray(fills) ? fills : [])
      .filter((f) => String(f.coin ?? "").toUpperCase() === wantCoin)
      .map((f) => ({
        time: Number(f.time ?? 0),
        side: f.side === "B" ? "BUY" : f.side === "A" ? "SELL" : String(f.side ?? "").toUpperCase(),
        price: Number(f.px ?? 0),
        qty: Math.abs(Number(f.sz ?? 0)),
        realizedPnl: Number(f.closedPnl ?? 0),
        commission: Math.abs(Number(f.fee ?? 0)),
        orderId: f.oid != null ? String(f.oid) : undefined,
      }));
  },
  async fetchProtection(account, input): Promise<ProtectionSnapshot> {
    const user = masterAddress(account);
    if (!user) return { onVenue: false, hasSl: false, hasTp: false, unknown: true };
    const { meta } = await loadMeta();
    const hit = assetOf(meta, input.symbol);
    if (!hit) return { onVenue: false, hasSl: false, hasTp: false, unknown: true };
    let onVenue = false;
    try {
      onVenue = (await coinPositionSize(account, hit.coin)) > 0;
    } catch {
      return { onVenue: false, hasSl: false, hasTp: false, unknown: true };
    }
    try {
      const opens = await listTriggers(account, hit.coin);
      const slOrder = opens.find((o) => Boolean(o.isTrigger) && o.reduceOnly !== false && o.tpsl === "sl");
      const tpOrder = opens.find((o) => Boolean(o.isTrigger) && o.reduceOnly !== false && o.tpsl === "tp");
      const slPx = Number(slOrder?.triggerPx ?? 0);
      const tpPx = Number(tpOrder?.triggerPx ?? 0);
      const slOk = Boolean(slOrder) && (!(input.sl > 0) || pxClose(slPx, input.sl));
      const tpOk = Boolean(tpOrder) && (!(input.tp > 0) || pxClose(tpPx, input.tp));
      return {
        onVenue,
        hasSl: slOk,
        hasTp: tpOk,
        unknown: false,
        slPrice: slPx > 0 ? slPx : undefined,
        tpPrice: tpPx > 0 ? tpPx : undefined,
      };
    } catch {
      return { onVenue, hasSl: false, hasTp: false, unknown: true };
    }
  },
  async testConnection(account) {
    try {
      if (!account.privateKey) return { ok: false, message: "Paste the agent (or main) private key." };
      try {
        walletOf(account);
      } catch {
        return { ok: false, message: "Private key is not a valid hex key." };
      }
      if (!masterWalletOk(account)) {
        return {
          ok: false,
          message: "Master wallet 0x address required. Agent keys cannot be armed without it.",
        };
      }
      const user = masterAddress(account);
      if (!user) return { ok: false, message: "Could not derive address." };
      const bal = await this.fetchBalance(account);
      const pos = await this.fetchPositions(account);
      const agentNote = `master ${user.slice(0, 6)}…${user.slice(-4)}`;
      if (bal == null) return { ok: false, message: `Signed, but no clearinghouse state for ${agentNote}.` };
      return {
        ok: true,
        message: `Hyperliquid live · ${agentNote} · ${bal.toFixed(2)} USDC · ${pos.length} open`,
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Hyperliquid ping failed" };
    }
  },
};
