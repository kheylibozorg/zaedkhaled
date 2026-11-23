import { hmacSha256Hex } from "./hmac.ts";

/** Compact JSON — MEXC-style contract sign uses the exact POST body string. */
export function ourbitBody(payload: unknown): string {
  if (payload == null) return "";
  return JSON.stringify(payload);
}

/** Sorted query string (no URL-encoding) for GET signatures. */
export function ourbitQuery(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function ourbitSign(apiKey: string, secret: string, timestamp: number, paramString: string) {
  return hmacSha256Hex(secret, `${apiKey}${timestamp}${paramString}`);
}

export function ourbitKlineInterval(tf: string): string {
  if (tf === "5m") return "Min5";
  if (tf === "15m") return "Min15";
  if (tf === "1h") return "Min60";
  if (tf === "4h") return "Hour4";
  if (tf === "1d") return "Day1";
  if (tf === "1w") return "Week1";
  return "Min5";
}

export function ourbitBarTimeMs(raw: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

export function ourbitCloseSide(long: boolean): 2 | 4 {
  return long ? 4 : 2;
}

export function ourbitOpenSide(long: boolean): 1 | 3 {
  return long ? 1 : 3;
}

/** Map OURBIT contract side (1–4) onto BUY/SELL for the journal closer. */
export function ourbitTradeSide(side: number | string | undefined): string {
  const n = Number(side);
  if (n === 1 || n === 2) return "BUY";
  if (n === 3 || n === 4) return "SELL";
  const s = String(side ?? "").toUpperCase();
  if (s === "BUY" || s === "SELL") return s;
  return "";
}
