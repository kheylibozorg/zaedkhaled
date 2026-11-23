import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ExchangeAccount } from "./types";

export const ASTER_V3_DOMAIN = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 1666,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

export const ASTER_V3_TYPES = {
  Message: [{ name: "msg", type: "string" }],
} as const;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const PK_RE = /^0x[0-9a-fA-F]{64}$/;

let lastNonceUs = 0;

export function nextAsterNonce(): string {
  const now = Date.now() * 1000;
  const n = now <= lastNonceUs ? lastNonceUs + 1 : now;
  lastNonceUs = n;
  return String(n);
}

export function asterV3Path(path: string): string {
  return path.replace(/^\/fapi\/v[12]\//, "/fapi/v3/");
}

export function formEncode(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join("&");
}

export function normalizeAsterPk(raw: string | undefined | null): `0x${string}` | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const pk = (s.startsWith("0x") ? s : `0x${s}`) as `0x${string}`;
  return PK_RE.test(pk) ? pk : null;
}

export function asterUserAddress(account: ExchangeAccount): string | null {
  const w = (account.walletAddress ?? account.apiKey ?? "").trim();
  if (!ADDR_RE.test(w)) return null;
  try {
    return getAddress(w);
  } catch {
    return w;
  }
}

export function asterSignerPk(account: ExchangeAccount): `0x${string}` | null {
  return normalizeAsterPk(account.privateKey ?? account.apiSecret ?? "");
}

export function isAsterV3(account: ExchangeAccount): boolean {
  return Boolean(asterSignerPk(account));
}

export async function signAsterV3(privateKey: `0x${string}`, msg: string): Promise<`0x${string}`> {
  const wallet = privateKeyToAccount(privateKey);
  return wallet.signTypedData({
    domain: ASTER_V3_DOMAIN,
    types: ASTER_V3_TYPES,
    primaryType: "Message",
    message: { msg },
  });
}
