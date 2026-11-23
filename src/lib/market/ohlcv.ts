import { TF_MS, type Bar, type KlineTf } from "../engine/types.ts";

export function klineWindow(tf: KlineTf, limit: number, now = Date.now()) {
  const ms = TF_MS[tf];
  const count = Math.max(1, Math.min(5000, Math.round(limit) || 1));
  return { start: now - ms * count, end: now, count, ms };
}

export function barFromBinanceRow(k: Array<number | string> | null | undefined): Bar | null {
  if (!k || k.length < 6) return null;
  const time = Number(k[0]);
  const open = Number(k[1]);
  const high = Number(k[2]);
  const low = Number(k[3]);
  const close = Number(k[4]);
  const volume = Number(k[5]);
  if (![time, open, high, low, close].every(Number.isFinite)) return null;
  return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

export function barFromHlCandle(row: {
  t?: number;
  o?: string | number;
  h?: string | number;
  l?: string | number;
  c?: string | number;
  v?: string | number;
}): Bar | null {
  const time = Number(row.t);
  const open = Number(row.o);
  const high = Number(row.h);
  const low = Number(row.l);
  const close = Number(row.c);
  const volume = Number(row.v);
  if (![time, open, high, low, close].every(Number.isFinite)) return null;
  return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

export function barFromLighterCandle(row: {
  t?: number;
  o?: number | string;
  h?: number | string;
  l?: number | string;
  c?: number | string;
  v?: number | string;
}): Bar | null {
  return barFromHlCandle(row);
}

export function sortBars(bars: Bar[], limit: number) {
  const uniq = new Map<number, Bar>();
  for (const b of bars) {
    if (b.time > 0) uniq.set(b.time, b);
  }
  return [...uniq.values()].sort((a, b) => a.time - b.time).slice(-limit);
}

export function barsFromOurbitKline(
  data: {
    time?: number[];
    open?: number[];
    high?: number[];
    low?: number[];
    close?: number[];
    vol?: number[];
  } | null | undefined,
  limit: number,
): Bar[] {
  if (!data?.time?.length) return [];
  const bars: Bar[] = [];
  for (let i = 0; i < data.time.length; i++) {
    let time = Number(data.time[i]);
    if (Number.isFinite(time) && time > 0 && time < 1e12) time *= 1000;
    const open = Number(data.open?.[i]);
    const high = Number(data.high?.[i]);
    const low = Number(data.low?.[i]);
    const close = Number(data.close?.[i]);
    const volume = Number(data.vol?.[i]);
    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    bars.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return sortBars(bars, limit);
}
