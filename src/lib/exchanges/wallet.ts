import type { ExchangeAccount, ExchangeAdapter, WalletSnapshot } from "./types";

export function usedMarginUsd(
  open: Array<{ notional_usd?: number | string; leverage?: number | string; notional?: number | string }>,
) {
  return open.reduce((a, p) => {
    const notion = Number(p.notional_usd ?? p.notional) || 0;
    const lev = Math.max(1, Number(p.leverage) || 1);
    return a + notion / lev;
  }, 0);
}

/** Free pile a new fill may take. Live wallet `available` already excludes locked margin. */
export function freeCapitalUsd(opts: {
  equity: number;
  usedMargin?: number;
  available?: number | null;
}) {
  if (opts.available != null && Number.isFinite(opts.available)) return Math.max(0, opts.available);
  return Math.max(0, opts.equity - Math.max(0, opts.usedMargin ?? 0));
}

export function attachAvailable<
  T extends { mode: string; equityUsd: number; availableUsd?: number },
>(settings: T, open: Array<{ notional_usd?: number | string; leverage?: number | string }>): T {
  if (settings.mode === "live" && settings.availableUsd != null && Number.isFinite(settings.availableUsd)) {
    return { ...settings, availableUsd: Math.max(0, settings.availableUsd) };
  }
  return { ...settings, availableUsd: Math.max(0, settings.equityUsd - usedMarginUsd(open)) };
}

export async function readVenueWallet(
  adapter: ExchangeAdapter,
  acc: ExchangeAccount,
): Promise<WalletSnapshot | null> {
  try {
    if (adapter.fetchWallet) {
      const w = await adapter.fetchWallet(acc);
      if (w && Number.isFinite(w.available) && Number.isFinite(w.equity)) {
        return { equity: Math.max(0, w.equity), available: Math.max(0, w.available) };
      }
    }
  } catch {
    /* fall through to fetchBalance */
  }
  try {
    const bal = await adapter.fetchBalance(acc);
    if (bal != null && Number.isFinite(bal)) {
      const n = Math.max(0, bal);
      return { equity: n, available: n };
    }
  } catch {
    /* unread */
  }
  return null;
}
