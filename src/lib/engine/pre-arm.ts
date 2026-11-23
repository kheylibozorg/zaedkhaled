import { atr, customAtr, dmi, ema, htfAt, resample, sma, trueRange } from "./math.ts";
import { coilProfile, lockCoil, type CoilProfile } from "./coil.ts";
import { ketexProfile, type KetexProfile } from "./ketex.ts";
import { shetexProfile, type ShetexProfile } from "./shetex.ts";
import { trexBeAtR, trexProfile, type TrexProfile } from "./trex.ts";
import {
  HTF2_OF,
  HTF_OF,
  SCAN_RULE,
  TF_MS,
  WARMUP,
  apexProfile,
  isApexName,
  isHalcyonName,
  isKetexName,
  isShetexName,
  isTrexName,
  type ArmedSetup,
  type Bar,
  type HalcyonName,
  type IndicatorName,
  type Profile,
  type Side,
  type Timeframe,
  type TrexName,
} from "./types.ts";

const EPS = 1e-10;
const LOG14 = Math.log10(14);
/** Max distance (in ATR multiples) from current close to resting pre-arm level. */
const MAX_APPROACH_ATR = 3.5;

export type PreArmedSetup = ArmedSetup & {
  phase: "pre-arm";
  /** Pivot or coil-lock bar time for traceability (armedBarTime is current closed bar for queue TTL). */
  levelBarTime: number;
  /** Maximum price drift tolerated when confirming an active pre-arm order still tracks the same level. */
  matchTolerance: number;
};

export function isPreArmReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && /pre-arm/i.test(reason);
}

export function preArmMatchesOrder(orderEntry: number, pre: Pick<PreArmedSetup, "entry" | "matchTolerance">): boolean {
  if (!Number.isFinite(orderEntry) || !Number.isFinite(pre.entry)) return false;
  const tol = Math.max(pre.matchTolerance, Math.abs(orderEntry) * 0.002);
  return Math.abs(orderEntry - pre.entry) <= tol;
}

function cType(rng: number, catr: number): number {
  const r = rng / Math.max(catr, EPS);
  if (r < 0.8) return 0;
  if (r <= 1.2) return 1;
  if (r <= 2.5) return 2;
  return 3;
}

function lastThird(bearish: boolean, close: number, high: number, low: number) {
  const rng = Math.max(high - low, EPS);
  const third = rng / 3;
  return bearish ? close <= low + third : close >= high - third;
}

function threeMasters(
  fromOff: number,
  toOff: number,
  wantHigh: boolean,
  i: number,
  bars: Bar[],
  catr: number[],
): boolean {
  let run = 0;
  let lastExt = wantHigh ? -1e20 : 1e20;
  for (let off = fromOff; off <= toOff; off++) {
    const idx = i - off;
    if (idx < 0) continue;
    const bar = bars[idx]!;
    const rng = Math.max(bar.high - bar.low, EPS);
    const body = Math.abs(bar.close - bar.open);
    const upSh = bar.high - Math.max(bar.close, bar.open);
    const dnSh = Math.min(bar.close, bar.open) - bar.low;
    const masterish =
      cType(rng, catr[idx]!) === 1 && (body / rng >= 0.8 || Math.max(upSh, dnSh) / rng >= 0.8);
    const dirOk = wantHigh ? bar.close > bar.open : bar.close < bar.open;
    if (masterish && dirOk) {
      const ext = wantHigh ? bar.high : bar.low;
      if (wantHigh) {
        if (ext > lastExt) {
          run += 1;
          lastExt = ext;
        } else {
          run = 1;
          lastExt = Math.max(lastExt, ext);
        }
      } else if (ext < lastExt) {
        run += 1;
        lastExt = ext;
      } else {
        run = 1;
        lastExt = Math.min(lastExt, ext);
      }
      if (run >= 3) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

function originLowOff(eOff: number, look: number, i: number, bars: Bar[]) {
  let mn = bars[i - eOff]!.low;
  let idx = eOff;
  const maxOff = Math.min(eOff + look, i);
  for (let off = eOff; off <= maxOff; off++) {
    const v = bars[i - off]!.low;
    if (v < mn) {
      mn = v;
      idx = off;
    }
  }
  return idx;
}

function originHighOff(eOff: number, look: number, i: number, bars: Bar[]) {
  let mx = bars[i - eOff]!.high;
  let idx = eOff;
  const maxOff = Math.min(eOff + look, i);
  for (let off = eOff; off <= maxOff; off++) {
    const v = bars[i - off]!.high;
    if (v > mx) {
      mx = v;
      idx = off;
    }
  }
  return idx;
}

type CoverProfile = {
  legLookback: number;
  minLegAtr: number;
  useLongbar: boolean;
  needThird: boolean;
};

function moveOkUp(eOff: number, i: number, bars: Bar[], catr: number[], p: CoverProfile) {
  const orig = originLowOff(eOff, p.legLookback, i, bars);
  const e = i - eOff;
  const o = i - orig;
  const dist = bars[e]!.high - bars[o]!.low;
  return dist >= p.minLegAtr * catr[e]! || threeMasters(orig, eOff, true, i, bars, catr);
}

function moveOkDn(eOff: number, i: number, bars: Bar[], catr: number[], p: CoverProfile) {
  const orig = originHighOff(eOff, p.legLookback, i, bars);
  const e = i - eOff;
  const o = i - orig;
  const dist = bars[o]!.high - bars[e]!.low;
  return dist >= p.minLegAtr * catr[e]! || threeMasters(orig, eOff, false, i, bars, catr);
}

function coverHighAt(
  eOff: number,
  i: number,
  bars: Bar[],
  catr: number[],
  p: CoverProfile,
): { ok: boolean; extreme: number; inner: number } {
  const e = i - eOff;
  const cur = bars[i]!;
  const bar = bars[e]!;
  const extreme = bar.high;
  const inner = Math.min(bar.open, bar.close);
  const rngE = Math.max(bar.high - bar.low, EPS);
  const bodyR = Math.abs(bar.close - bar.open) / rngE;
  const upSh = (bar.high - Math.max(bar.close, bar.open)) / rngE;
  const dnSh = (Math.min(bar.close, bar.open) - bar.low) / rngE;
  const master =
    cType(rngE, catr[e]!) === 1 &&
    bar.close > bar.open &&
    (bodyR >= 0.8 || upSh >= 0.8 || dnSh >= 0.8);
  const longish = p.useLongbar && cType(rngE, catr[e]!) >= 2;
  const line = master ? bar.low : longish ? bar.high - catr[e]! : NaN;
  let ok = false;
  if (Number.isFinite(line) && (master || longish) && moveOkUp(eOff, i, bars, catr, p)) {
    if (cur.close < line && (!p.needThird || lastThird(true, cur.close, cur.high, cur.low))) {
      ok = true;
    }
  }
  return { ok, extreme, inner };
}

function coverLowAt(
  eOff: number,
  i: number,
  bars: Bar[],
  catr: number[],
  p: CoverProfile,
): { ok: boolean; extreme: number; inner: number } {
  const e = i - eOff;
  const cur = bars[i]!;
  const bar = bars[e]!;
  const extreme = bar.low;
  const inner = Math.max(bar.open, bar.close);
  const rngE = Math.max(bar.high - bar.low, EPS);
  const bodyR = Math.abs(bar.close - bar.open) / rngE;
  const upSh = (bar.high - Math.max(bar.close, bar.open)) / rngE;
  const dnSh = (Math.min(bar.close, bar.open) - bar.low) / rngE;
  const master =
    cType(rngE, catr[e]!) === 1 &&
    bar.close < bar.open &&
    (bodyR >= 0.8 || upSh >= 0.8 || dnSh >= 0.8);
  const longish = p.useLongbar && cType(rngE, catr[e]!) >= 2;
  const line = master ? bar.high : longish ? bar.low + catr[e]! : NaN;
  let ok = false;
  if (Number.isFinite(line) && (master || longish) && moveOkDn(eOff, i, bars, catr, p)) {
    if (cur.close > line && (!p.needThird || lastThird(false, cur.close, cur.high, cur.low))) {
      ok = true;
    }
  }
  return { ok, extreme, inner };
}

function lowestSince(i: number, len: number, bars: Bar[]) {
  let mn = bars[i]!.low;
  const n = Math.max(0, len);
  for (let k = 0; k <= n; k++) {
    const idx = i - k;
    if (idx < 0) break;
    mn = Math.min(mn, bars[idx]!.low);
  }
  return mn;
}

function highestSince(i: number, len: number, bars: Bar[]) {
  let mx = bars[i]!.high;
  const n = Math.max(0, len);
  for (let k = 0; k <= n; k++) {
    const idx = i - k;
    if (idx < 0) break;
    mx = Math.max(mx, bars[idx]!.high);
  }
  return mx;
}

function highestCloseSince(i: number, len: number, bars: Bar[]) {
  let mx = bars[i]!.close;
  const n = Math.max(0, len);
  for (let k = 0; k <= n; k++) {
    const idx = i - k;
    if (idx < 0) break;
    mx = Math.max(mx, bars[idx]!.close);
  }
  return mx;
}

function lowestCloseSince(i: number, len: number, bars: Bar[]) {
  let mn = bars[i]!.close;
  const n = Math.max(0, len);
  for (let k = 0; k <= n; k++) {
    const idx = i - k;
    if (idx < 0) break;
    mn = Math.min(mn, bars[idx]!.close);
  }
  return mn;
}

function roomR(dir: 1 | -1, extreme: number, slDist: number, resPx: number[], supPx: number[]) {
  if (slDist <= 0) return 0;
  if (dir === 1) {
    let best = 1e20;
    for (const px of resPx) {
      if (px > extreme && px < best) best = px;
    }
    if (best < 1e20) return (best - extreme) / slDist;
    return 99;
  }
  let best = -1e20;
  for (const px of supPx) {
    if (px < extreme && px > best) best = px;
  }
  if (best > -1e20) return (extreme - best) / slDist;
  return 99;
}

function buildPreArmCandidate(opts: {
  indicator: IndicatorName;
  dir: 1 | -1;
  px: number;
  pa: number;
  pivotBar: number;
  i: number;
  bars: Bar[];
  a: number;
  rr: number;
  slAtrMult: number;
  ftcWait: number;
  minRoomR: number;
  minAwayAtr: number;
  bandAtr: number;
  resPx: number[];
  resAtr: number[];
  resBar: number[];
  supPx: number[];
  supAtr: number[];
  supBar: number[];
  minTests?: number;
  minStopPct?: number;
  widenStop?: boolean;
  minTpPct?: number;
  beAtR?: number | null;
  reasonTag: string;
}): PreArmedSetup | null {
  const { dir, px, pa, pivotBar, i, bars, a } = opts;
  const age = i - pivotBar;
  if (age < 3 || age > 300) return null;
  if (!Number.isFinite(px) || !(px > 0) || !Number.isFinite(pa) || !(pa > 0)) return null;

  const bar = bars[i]!;
  const maxDist = MAX_APPROACH_ATR * Math.max(a, pa);

  // Resting limit must sit strictly beyond current bar high/low & close so we place an anticipatory maker order
  // ahead of the touch (never chasing after a bar already pierced the level).
  if (dir === -1) {
    if (!(bar.close < px && bar.high < px)) return null;
    if (px - bar.close > maxDist) return null;
  } else {
    if (!(bar.close > px && bar.low > px)) return null;
    if (bar.close - px > maxDist) return null;
  }

  const look = Math.min(300, age);
  if (dir === -1) {
    const away = px - lowestSince(i, look, bars);
    const broken = highestCloseSince(i, look, bars) > px + 0.2 * pa;
    if (broken || away < opts.minAwayAtr * pa) return null;
  } else {
    const away = highestSince(i, look, bars) - px;
    const broken = lowestCloseSince(i, look, bars) < px - 0.2 * pa;
    if (broken || away < opts.minAwayAtr * pa) return null;
  }

  if (opts.minTests && opts.minTests > 1) {
    const arrPx = dir === -1 ? opts.resPx : opts.supPx;
    const arrAtr = dir === -1 ? opts.resAtr : opts.supAtr;
    const arrBar = dir === -1 ? opts.resBar : opts.supBar;
    let matches = 0;
    for (let m = arrPx.length - 1; m >= 0; m--) {
      const mAge = i - arrBar[m]!;
      const band = opts.bandAtr * Math.max(a, arrAtr[m]!);
      if (mAge >= 3 && Math.abs(px - arrPx[m]!) <= band) matches += 1;
    }
    if (matches < opts.minTests) return null;
  }

  let slDist = 0.2 * pa + opts.slAtrMult * a;
  const minStopPct = opts.minStopPct ?? 0;
  if (minStopPct > 0) {
    const minDist = px * minStopPct * 0.01;
    if (slDist < minDist) {
      if (opts.widenStop) slDist = minDist;
      else return null;
    }
  }
  const minTpPct = opts.minTpPct ?? 0;
  if (minTpPct > 0) {
    const tpPctNow = ((slDist * opts.rr) / Math.max(px, EPS)) * 100;
    if (tpPctNow < minTpPct) return null;
  }
  if (!(slDist > 0)) return null;

  const rm = roomR(dir, px, slDist, opts.resPx, opts.supPx);
  if (rm < opts.minRoomR) return null;

  const sl = dir === 1 ? px - slDist : px + slDist;
  const tp = dir === 1 ? px + opts.rr * slDist : px - opts.rr * slDist;
  const side: Side = dir === 1 ? "long" : "short";
  const matchTolerance = Math.max(opts.bandAtr * Math.max(a, pa), px * 0.002);

  return {
    indicator: opts.indicator,
    side,
    entry: px,
    sl,
    tp,
    rr: opts.rr,
    atr: a,
    ...(opts.beAtR != null ? { beAtR: opts.beAtR } : {}),
    armAge: 0,
    ftcWait: opts.ftcWait,
    armedBarIndex: i,
    armedBarTime: bar.time,
    levelBarTime: bars[pivotBar]!.time,
    matchTolerance,
    phase: "pre-arm",
    reason: opts.reasonTag,
  };
}

function findApexPreArm(
  bars: Bar[],
  tf: Timeframe,
  profile: Profile,
  htfBars?: Bar[],
  htf2Bars?: Bar[],
): PreArmedSetup | null {
  const n = bars.length;
  if (n <= WARMUP) return null;

  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  const vol = bars.map((b) => b.volume);
  const catr = customAtr(high, low, close);
  const ema21 = ema(close, 21);
  const ema84 = ema(close, 84);
  const ema200 = ema(close, 200);
  const { pdi, mdi } = dmi(high, low, close, 14, 14);
  const volSma = sma(vol, 20);

  const barMs = TF_MS[tf];
  const htfMs = TF_MS[HTF_OF[tf]];
  const htf2Ms = TF_MS[HTF2_OF[tf]];
  const htf = htfBars && htfBars.length > 10 ? htfBars : resample(bars, htfMs);
  const htf2 = htf2Bars && htf2Bars.length > 10 ? htf2Bars : resample(bars, htf2Ms);
  const htfTimes = htf.map((b) => b.time);
  const htfClose = htf.map((b) => b.close);
  const htfEma = ema(htfClose, 21);
  const htf2Times = htf2.map((b) => b.time);
  const htf2Close = htf2.map((b) => b.close);
  const htf2Ema = ema(htf2Close, 21);

  const resPx: number[] = [];
  const resAtr: number[] = [];
  const resBar: number[] = [];
  const supPx: number[] = [];
  const supAtr: number[] = [];
  const supBar: number[] = [];

  let armFtc = NaN;
  let armSl = NaN;
  let armDir = 0;
  let armAge = 0;
  let armCover = 0;
  let lastFill = -9999;

  for (let i = 2; i < n; i++) {
    const bar = bars[i]!;
    const a = catr[i]!;
    const atrOk = Number.isFinite(a) && a > 0;

    let newHighPivot = false;
    let newLowPivot = false;
    let highExt = NaN;
    let highIn = NaN;
    let lowExt = NaN;
    let lowIn = NaN;
    let highOff = 1;
    let lowOff = 1;

    if (atrOk) {
      const cH1 = coverHighAt(1, i, bars, catr, profile);
      const cH2 = coverHighAt(2, i, bars, catr, profile);
      const cL1 = coverLowAt(1, i, bars, catr, profile);
      const cL2 = coverLowAt(2, i, bars, catr, profile);

      newHighPivot = cH1.ok || (profile.coverMax >= 2 && cH2.ok && !cH1.ok);
      newLowPivot = cL1.ok || (profile.coverMax >= 2 && cL2.ok && !cL1.ok);
      highExt = cH1.ok ? cH1.extreme : cH2.extreme;
      highIn = cH1.ok ? cH1.inner : cH2.inner;
      lowExt = cL1.ok ? cL1.extreme : cL2.extreme;
      lowIn = cL1.ok ? cL1.inner : cL2.inner;
      highOff = cH1.ok ? 1 : 2;
      lowOff = cL1.ok ? 1 : 2;

      if (newHighPivot && newLowPivot) {
        if (highExt - highIn >= lowIn - lowExt) newLowPivot = false;
        else newHighPivot = false;
      }
    }

    let isReversalHigh = false;
    let isReversalLow = false;

    if (newHighPivot) {
      let highMatches = 0;
      let firstAway = 0;
      let firstBroken = true;
      let firstA = 0;
      let got = false;
      for (let k = resPx.length - 1; k >= 0; k--) {
        const px = resPx[k]!;
        const pa = resAtr[k]!;
        const b = resBar[k]!;
        const band = profile.bandAtr * Math.max(a, pa);
        const age = i - b;
        if (Math.abs(highExt - px) <= band && age >= 4) {
          highMatches += 1;
          if (!got) {
            const look = Math.min(300, age);
            firstAway = px - lowestSince(i, look, bars);
            firstBroken = highestCloseSince(i, look, bars) > px + 0.2 * pa;
            firstA = pa;
            got = true;
          }
        }
      }
      if (got && firstAway >= profile.minAwayAtr * firstA && !firstBroken && highMatches >= profile.minTests) {
        isReversalHigh = true;
      }
      resPx.push(highExt);
      resAtr.push(a);
      resBar.push(i);
      if (resPx.length > 40) {
        resPx.shift();
        resAtr.shift();
        resBar.shift();
      }
    }

    if (newLowPivot) {
      let lowMatches = 0;
      let firstAway = 0;
      let firstBroken = true;
      let firstA = 0;
      let got = false;
      for (let k = supPx.length - 1; k >= 0; k--) {
        const px = supPx[k]!;
        const pa = supAtr[k]!;
        const b = supBar[k]!;
        const band = profile.bandAtr * Math.max(a, pa);
        const age = i - b;
        if (Math.abs(lowExt - px) <= band && age >= 4) {
          lowMatches += 1;
          if (!got) {
            const look = Math.min(300, age);
            firstAway = highestSince(i, look, bars) - px;
            firstBroken = lowestCloseSince(i, look, bars) < px - 0.2 * pa;
            firstA = pa;
            got = true;
          }
        }
      }
      if (got && firstAway >= profile.minAwayAtr * firstA && !firstBroken && lowMatches >= profile.minTests) {
        isReversalLow = true;
      }
      supPx.push(lowExt);
      supAtr.push(a);
      supBar.push(i);
      if (supPx.length > 40) {
        supPx.shift();
        supAtr.shift();
        supBar.shift();
      }
    }

    const ltfClose = bar.time + barMs;
    const htfC = htfAt(htfTimes, htfClose, ltfClose, htfMs);
    const htfE = htfAt(htfTimes, htfEma, ltfClose, htfMs);
    const htf2C = htfAt(htf2Times, htf2Close, ltfClose, htf2Ms);
    const htf2E = htfAt(htf2Times, htf2Ema, ltfClose, htf2Ms);
    const htfLongOk = !profile.useHtf || !Number.isFinite(htfE) || htfC >= htfE * 0.997;
    const htfShortOk = !profile.useHtf || !Number.isFinite(htfE) || htfC <= htfE * 1.003;
    const htf2LongOk = !profile.useHtf2 || !Number.isFinite(htf2E) || htf2C >= htf2E;
    const htf2ShortOk = !profile.useHtf2 || !Number.isFinite(htf2E) || htf2C <= htf2E;

    if (atrOk) {
      const arm = (dir: 1 | -1, extreme: number, inner: number) => {
        const slBuf = profile.slAtrMult * a;
        let sl = dir === 1 ? extreme - slBuf : extreme + slBuf;
        let ftc = (extreme + inner) * 0.5;
        ftc = dir === 1 ? Math.max(ftc, extreme + 0.2 * a) : Math.min(ftc, extreme - 0.2 * a);
        let slDist = Math.abs(ftc - sl);
        const minDist = ftc * profile.minStopPct * 0.01;
        let sizeOk = true;
        if (slDist < minDist) {
          if (profile.widenStop) {
            slDist = minDist;
            sl = dir === 1 ? ftc - slDist : ftc + slDist;
          } else {
            sizeOk = false;
          }
        }
        const rm = roomR(dir, extreme, slDist, resPx, supPx);
        const ok = sizeOk && rm >= profile.minRoomR && i - lastFill >= profile.cooldownBars;
        return { ok, ftc, sl };
      };

      if (isReversalHigh && htfShortOk && htf2ShortOk) {
        const r = arm(-1, highExt, highIn);
        if (r.ok) {
          armFtc = r.ftc;
          armSl = r.sl;
          armDir = -1;
          armAge = 0;
          armCover = highOff;
        }
      }
      if (isReversalLow && htfLongOk && htf2LongOk) {
        const r = arm(1, lowExt, lowIn);
        if (r.ok) {
          armFtc = r.ftc;
          armSl = r.sl;
          armDir = 1;
          armAge = 0;
          armCover = lowOff;
        }
      }
    }

    const rng = Math.max(bar.high - bar.low, EPS);
    const body = Math.abs(bar.close - bar.open);
    const br = body / rng;
    const e21 = ema21[i]!;
    const e84 = ema84[i]!;
    const e200 = ema200[i]!;
    const regimeLong = !profile.useEma84 || !Number.isFinite(e84) || bar.close >= e84;
    const regimeShort = !profile.useEma84 || !Number.isFinite(e84) || bar.close <= e84;
    const stackUp = !profile.emaStack || (e21 > e84 && bar.close > e84 && bar.close > e200);
    const stackDown = !profile.emaStack || (e21 < e84 && bar.close < e84 && bar.close < e200);
    const diLong = !profile.requireDI || (Number.isFinite(pdi[i]!) && Number.isFinite(mdi[i]!) && pdi[i]! > mdi[i]!);
    const diShort = !profile.requireDI || (Number.isFinite(pdi[i]!) && Number.isFinite(mdi[i]!) && mdi[i]! > pdi[i]!);
    const bodyOk = br >= profile.minBr;
    const coverOk = !profile.requireCover1 || armCover === 1;
    const vs = volSma[i]!;
    const volOk =
      profile.minVol <= 0 || !Number.isFinite(vs) || vs <= 0 || bar.volume >= profile.minVol * vs;

    if (Number.isFinite(armFtc)) {
      armAge += 1;
      const invalidated = armDir === 1 ? bar.low <= armSl : bar.high >= armSl;
      const tagged = armDir === 1 ? bar.low <= armFtc : bar.high >= armFtc;
      if (invalidated) {
        armFtc = NaN;
        armDir = 0;
      } else if (tagged) {
        const confL = !profile.confirmCl || bar.close > armFtc;
        const confS = !profile.confirmCl || bar.close < armFtc;
        let filled = false;
        if (i >= WARMUP) {
          if (
            armDir === 1 &&
            confL &&
            bodyOk &&
            coverOk &&
            volOk &&
            regimeLong &&
            stackUp &&
            diLong &&
            profile.sides !== "Short"
          ) {
            filled = true;
          }
          if (
            armDir === -1 &&
            confS &&
            bodyOk &&
            coverOk &&
            volOk &&
            regimeShort &&
            stackDown &&
            diShort &&
            profile.sides !== "Long"
          ) {
            filled = true;
          }
        }
        if (filled) lastFill = i;
        armFtc = NaN;
        armDir = 0;
      } else if (armAge >= profile.ftcWait) {
        armFtc = NaN;
        armDir = 0;
      }
    }

    if (i === n - 1 && i >= WARMUP && atrOk && !Number.isFinite(armFtc) && i - lastFill >= profile.cooldownBars) {
      let bestLong: PreArmedSetup | null = null;
      let bestShort: PreArmedSetup | null = null;

      if (profile.sides !== "Short" && regimeLong && stackUp && diLong && htfLongOk && htf2LongOk) {
        for (let k = supPx.length - 1; k >= 0; k--) {
          const cand = buildPreArmCandidate({
            indicator: profile.name,
            dir: 1,
            px: supPx[k]!,
            pa: supAtr[k]!,
            pivotBar: supBar[k]!,
            i,
            bars,
            a,
            rr: profile.rr,
            slAtrMult: profile.slAtrMult,
            ftcWait: profile.ftcWait,
            minRoomR: profile.minRoomR,
            minAwayAtr: profile.minAwayAtr,
            bandAtr: profile.bandAtr,
            resPx,
            resAtr,
            resBar,
            supPx,
            supAtr,
            supBar,
            minTests: profile.minTests,
            minStopPct: profile.minStopPct,
            widenStop: profile.widenStop,
            reasonTag: `APEX ${profile.rr}R second-test support · Pre-arm FTC limit`,
          });
          if (cand && (!bestLong || Math.abs(cand.entry - bar.close) < Math.abs(bestLong.entry - bar.close))) {
            bestLong = cand;
          }
        }
      }

      if (profile.sides !== "Long" && regimeShort && stackDown && diShort && htfShortOk && htf2ShortOk) {
        for (let k = resPx.length - 1; k >= 0; k--) {
          const cand = buildPreArmCandidate({
            indicator: profile.name,
            dir: -1,
            px: resPx[k]!,
            pa: resAtr[k]!,
            pivotBar: resBar[k]!,
            i,
            bars,
            a,
            rr: profile.rr,
            slAtrMult: profile.slAtrMult,
            ftcWait: profile.ftcWait,
            minRoomR: profile.minRoomR,
            minAwayAtr: profile.minAwayAtr,
            bandAtr: profile.bandAtr,
            resPx,
            resAtr,
            resBar,
            supPx,
            supAtr,
            supBar,
            minTests: profile.minTests,
            minStopPct: profile.minStopPct,
            widenStop: profile.widenStop,
            reasonTag: `APEX ${profile.rr}R second-test resistance · Pre-arm FTC limit`,
          });
          if (cand && (!bestShort || Math.abs(cand.entry - bar.close) < Math.abs(bestShort.entry - bar.close))) {
            bestShort = cand;
          }
        }
      }

      if (bestLong && bestShort) {
        return Math.abs(bestLong.entry - bar.close) <= Math.abs(bestShort.entry - bar.close) ? bestLong : bestShort;
      }
      return bestLong ?? bestShort;
    }
  }

  return null;
}

function findTrexPreArm(
  bars: Bar[],
  tf: Timeframe,
  name: TrexName,
  htfBars?: Bar[],
): PreArmedSetup | null {
  const n = bars.length;
  if (n <= WARMUP) return null;
  const p: TrexProfile = trexProfile(name);
  const BAND_ATR = 0.7;
  const MIN_AWAY_ATR = 1.0;
  const FTC_MIN_ATR = 0.2;

  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  const catr = customAtr(high, low, close);

  const htfMs = TF_MS[HTF_OF[tf]];
  const barMs = TF_MS[tf];
  const htf = htfBars && htfBars.length > 10 ? htfBars : resample(bars, htfMs);
  const htfTimes = htf.map((b) => b.time);
  const htfClose = htf.map((b) => b.close);
  const htfEma50 = ema(htfClose, 50);

  const resPx: number[] = [];
  const resAtr: number[] = [];
  const resBar: number[] = [];
  const supPx: number[] = [];
  const supAtr: number[] = [];
  const supBar: number[] = [];

  let armFtc = NaN;
  let armSl = NaN;
  let armDir = 0;
  let armAge = 0;
  let lastFill = -9999;

  for (let i = 2; i < n; i++) {
    const bar = bars[i]!;
    const a = catr[i]!;
    const atrOk = Number.isFinite(a) && a > 0;

    let newHighPivot = false;
    let newLowPivot = false;
    let highExt = NaN;
    let highIn = NaN;
    let lowExt = NaN;
    let lowIn = NaN;

    if (atrOk) {
      const cH1 = coverHighAt(1, i, bars, catr, p);
      const cH2 = coverHighAt(2, i, bars, catr, p);
      const cL1 = coverLowAt(1, i, bars, catr, p);
      const cL2 = coverLowAt(2, i, bars, catr, p);

      newHighPivot = cH1.ok || (p.coverMax >= 2 && cH2.ok && !cH1.ok);
      newLowPivot = cL1.ok || (p.coverMax >= 2 && cL2.ok && !cL1.ok);
      highExt = cH1.ok ? cH1.extreme : cH2.extreme;
      highIn = cH1.ok ? cH1.inner : cH2.inner;
      lowExt = cL1.ok ? cL1.extreme : cL2.extreme;
      lowIn = cL1.ok ? cL1.inner : cL2.inner;

      if (newHighPivot && newLowPivot) {
        if (highExt - highIn >= lowIn - lowExt) newLowPivot = false;
        else newHighPivot = false;
      }
    }

    let isReversalHigh = false;
    let isReversalLow = false;

    if (newHighPivot) {
      for (let k = resPx.length - 1; k >= 0; k--) {
        const px = resPx[k]!;
        const pa = resAtr[k]!;
        const b = resBar[k]!;
        const band = BAND_ATR * Math.max(a, pa);
        const age = i - b;
        if (Math.abs(highExt - px) <= band && age >= 4) {
          const look = Math.min(300, age);
          const away = px - lowestSince(i, look, bars);
          const broken = highestCloseSince(i, look, bars) > px + 0.2 * pa;
          if (away >= MIN_AWAY_ATR * pa && !broken) isReversalHigh = true;
          break;
        }
      }
      resPx.push(highExt);
      resAtr.push(a);
      resBar.push(i);
      if (resPx.length > 40) {
        resPx.shift();
        resAtr.shift();
        resBar.shift();
      }
    }

    if (newLowPivot) {
      for (let k = supPx.length - 1; k >= 0; k--) {
        const px = supPx[k]!;
        const pa = supAtr[k]!;
        const b = supBar[k]!;
        const band = BAND_ATR * Math.max(a, pa);
        const age = i - b;
        if (Math.abs(lowExt - px) <= band && age >= 4) {
          const look = Math.min(300, age);
          const away = highestSince(i, look, bars) - px;
          const broken = lowestCloseSince(i, look, bars) < px - 0.2 * pa;
          if (away >= MIN_AWAY_ATR * pa && !broken) isReversalLow = true;
          break;
        }
      }
      supPx.push(lowExt);
      supAtr.push(a);
      supBar.push(i);
      if (supPx.length > 40) {
        supPx.shift();
        supAtr.shift();
        supBar.shift();
      }
    }

    const ltfClose = bar.time + barMs;
    const htfC = htfAt(htfTimes, htfClose, ltfClose, htfMs);
    const htfE = htfAt(htfTimes, htfEma50, ltfClose, htfMs);
    const htfLongOk = !p.useHtfEma || !Number.isFinite(htfE) || htfC >= htfE * 0.997;
    const htfShortOk = !p.useHtfEma || !Number.isFinite(htfE) || htfC <= htfE * 1.003;

    if (atrOk) {
      const arm = (dir: 1 | -1, extreme: number, inner: number) => {
        const slBuf = p.slAtrMult * a;
        const sl = dir === 1 ? extreme - slBuf : extreme + slBuf;
        let ftc = (extreme + inner) * 0.5;
        ftc = dir === 1 ? Math.max(ftc, extreme + FTC_MIN_ATR * a) : Math.min(ftc, extreme - FTC_MIN_ATR * a);
        const slDist = Math.abs(ftc - sl);
        const rm = roomR(dir, extreme, slDist, resPx, supPx);
        const stopPctNow = (slDist / Math.max(ftc, EPS)) * 100;
        const tpPctNow = ((slDist * p.rr) / Math.max(ftc, EPS)) * 100;
        const ok =
          rm >= p.minRoomR &&
          i - lastFill >= p.cooldownBars &&
          stopPctNow >= p.minStopPct &&
          tpPctNow >= p.minTpPct;
        return { ok, ftc, sl };
      };

      if (isReversalHigh && htfShortOk) {
        const r = arm(-1, highExt, highIn);
        if (r.ok) {
          armFtc = r.ftc;
          armSl = r.sl;
          armDir = -1;
          armAge = 0;
        }
      }
      if (isReversalLow && htfLongOk) {
        const r = arm(1, lowExt, lowIn);
        if (r.ok) {
          armFtc = r.ftc;
          armSl = r.sl;
          armDir = 1;
          armAge = 0;
        }
      }
    }

    if (Number.isFinite(armFtc)) {
      armAge += 1;
      const invalidated = armDir === 1 ? bar.low <= armSl : bar.high >= armSl;
      const tagged = armDir === 1 ? bar.low <= armFtc : bar.high >= armFtc;
      if (invalidated) {
        armFtc = NaN;
        armDir = 0;
      } else if (tagged) {
        lastFill = i;
        armFtc = NaN;
        armDir = 0;
      } else if (armAge >= p.ftcWait) {
        armFtc = NaN;
        armDir = 0;
      }
    }

    if (i === n - 1 && i >= WARMUP && atrOk && !Number.isFinite(armFtc) && i - lastFill >= p.cooldownBars) {
      let bestLong: PreArmedSetup | null = null;
      let bestShort: PreArmedSetup | null = null;

      if (htfLongOk) {
        for (let k = supPx.length - 1; k >= 0; k--) {
          const cand = buildPreArmCandidate({
            indicator: p.name,
            dir: 1,
            px: supPx[k]!,
            pa: supAtr[k]!,
            pivotBar: supBar[k]!,
            i,
            bars,
            a,
            rr: p.rr,
            slAtrMult: p.slAtrMult,
            ftcWait: p.ftcWait,
            minRoomR: p.minRoomR,
            minAwayAtr: MIN_AWAY_ATR,
            bandAtr: BAND_ATR,
            resPx,
            resAtr,
            resBar,
            supPx,
            supAtr,
            supBar,
            minStopPct: p.minStopPct,
            minTpPct: p.minTpPct,
            beAtR: p.beAtR,
            reasonTag: `TREX ${p.rr}R second-test support · Pre-arm FTC limit · BE@${p.beAtR}R`,
          });
          if (cand && (!bestLong || Math.abs(cand.entry - bar.close) < Math.abs(bestLong.entry - bar.close))) {
            bestLong = cand;
          }
        }
      }

      if (htfShortOk) {
        for (let k = resPx.length - 1; k >= 0; k--) {
          const cand = buildPreArmCandidate({
            indicator: p.name,
            dir: -1,
            px: resPx[k]!,
            pa: resAtr[k]!,
            pivotBar: resBar[k]!,
            i,
            bars,
            a,
            rr: p.rr,
            slAtrMult: p.slAtrMult,
            ftcWait: p.ftcWait,
            minRoomR: p.minRoomR,
            minAwayAtr: MIN_AWAY_ATR,
            bandAtr: BAND_ATR,
            resPx,
            resAtr,
            resBar,
            supPx,
            supAtr,
            supBar,
            minStopPct: p.minStopPct,
            minTpPct: p.minTpPct,
            beAtR: p.beAtR,
            reasonTag: `TREX ${p.rr}R second-test resistance · Pre-arm FTC limit · BE@${p.beAtR}R`,
          });
          if (cand && (!bestShort || Math.abs(cand.entry - bar.close) < Math.abs(bestShort.entry - bar.close))) {
            bestShort = cand;
          }
        }
      }

      if (bestLong && bestShort) {
        return Math.abs(bestLong.entry - bar.close) <= Math.abs(bestShort.entry - bar.close) ? bestLong : bestShort;
      }
      return bestLong ?? bestShort;
    }
  }

  return null;
}

function findKetexPreArm(bars: Bar[], tf: Timeframe, htfBars?: Bar[]): PreArmedSetup | null {
  const n = bars.length;
  if (n <= WARMUP) return null;
  const p: KetexProfile = ketexProfile();

  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  const catr = customAtr(high, low, close);
  const ema84 = ema(close, 84);

  const htfMs = TF_MS[HTF_OF[tf]];
  const barMs = TF_MS[tf];
  const htf = htfBars && htfBars.length > 10 ? htfBars : resample(bars, htfMs);
  const htfTimes = htf.map((b) => b.time);
  const htfClose = htf.map((b) => b.close);
  const htfEma = ema(htfClose, 21);

  const resPx: number[] = [];
  const resAtr: number[] = [];
  const resBar: number[] = [];
  const supPx: number[] = [];
  const supAtr: number[] = [];
  const supBar: number[] = [];

  let armFtc = NaN;
  let armSl = NaN;
  let armDir = 0;
  let armAge = 0;
  let lastFill = -9999;

  for (let i = 2; i < n; i++) {
    const bar = bars[i]!;
    const a = catr[i]!;
    const atrOk = Number.isFinite(a) && a > 0;

    let newHighPivot = false;
    let newLowPivot = false;
    let highExt = NaN;
    let highIn = NaN;
    let lowExt = NaN;
    let lowIn = NaN;

    if (atrOk) {
      const cH1 = coverHighAt(1, i, bars, catr, p);
      const cH2 = coverHighAt(2, i, bars, catr, p);
      const cL1 = coverLowAt(1, i, bars, catr, p);
      const cL2 = coverLowAt(2, i, bars, catr, p);

      newHighPivot = cH1.ok || (p.coverMax >= 2 && cH2.ok && !cH1.ok);
      newLowPivot = cL1.ok || (p.coverMax >= 2 && cL2.ok && !cL1.ok);
      highExt = cH1.ok ? cH1.extreme : cH2.extreme;
      highIn = cH1.ok ? cH1.inner : cH2.inner;
      lowExt = cL1.ok ? cL1.extreme : cL2.extreme;
      lowIn = cL1.ok ? cL1.inner : cL2.inner;

      if (newHighPivot && newLowPivot) {
        if (highExt - highIn >= lowIn - lowExt) newLowPivot = false;
        else newHighPivot = false;
      }
    }

    let isReversalHigh = false;
    let isReversalLow = false;

    if (newHighPivot) {
      for (let k = resPx.length - 1; k >= 0; k--) {
        const px = resPx[k]!;
        const pa = resAtr[k]!;
        const b = resBar[k]!;
        const band = p.bandAtr * Math.max(a, pa);
        const age = i - b;
        if (Math.abs(highExt - px) <= band && age >= 4) {
          const look = Math.min(300, age);
          const away = px - lowestSince(i, look, bars);
          const broken = highestCloseSince(i, look, bars) > px + 0.2 * pa;
          if (away >= p.minAwayAtr * pa && !broken) isReversalHigh = true;
          break;
        }
      }
      resPx.push(highExt);
      resAtr.push(a);
      resBar.push(i);
      if (resPx.length > 40) {
        resPx.shift();
        resAtr.shift();
        resBar.shift();
      }
    }

    if (newLowPivot) {
      for (let k = supPx.length - 1; k >= 0; k--) {
        const px = supPx[k]!;
        const pa = supAtr[k]!;
        const b = supBar[k]!;
        const band = p.bandAtr * Math.max(a, pa);
        const age = i - b;
        if (Math.abs(lowExt - px) <= band && age >= 4) {
          const look = Math.min(300, age);
          const away = highestSince(i, look, bars) - px;
          const broken = lowestCloseSince(i, look, bars) < px - 0.2 * pa;
          if (away >= p.minAwayAtr * pa && !broken) isReversalLow = true;
          break;
        }
      }
      supPx.push(lowExt);
      supAtr.push(a);
      supBar.push(i);
      if (supPx.length > 40) {
        supPx.shift();
        supAtr.shift();
        supBar.shift();
      }
    }

    const ltfClose = bar.time + barMs;
    const htfC = htfAt(htfTimes, htfClose, ltfClose, htfMs);
    const htfE = htfAt(htfTimes, htfEma, ltfClose, htfMs);
    const htfLongOk = !p.useHtf || !Number.isFinite(htfE) || htfC >= htfE * 0.997;
    const htfShortOk = !p.useHtf || !Number.isFinite(htfE) || htfC <= htfE * 1.003;

    if (atrOk) {
      const arm = (dir: 1 | -1, extreme: number, inner: number) => {
        const slBuf = p.slAtrMult * a;
        const sl = dir === 1 ? extreme - slBuf : extreme + slBuf;
        let ftc = (extreme + inner) * 0.5;
        ftc = dir === 1 ? Math.max(ftc, extreme + 0.2 * a) : Math.min(ftc, extreme - 0.2 * a);
        const slDist = Math.abs(ftc - sl);
        const rm = roomR(dir, extreme, slDist, resPx, supPx);
        const ok = rm >= p.minRoomR && i - lastFill >= p.cooldownBars;
        return { ok, ftc, sl };
      };

      if (isReversalHigh && htfShortOk) {
        const r = arm(-1, highExt, highIn);
        if (r.ok) {
          armFtc = r.ftc;
          armSl = r.sl;
          armDir = -1;
          armAge = 0;
        }
      }
      if (isReversalLow && htfLongOk) {
        const r = arm(1, lowExt, lowIn);
        if (r.ok) {
          armFtc = r.ftc;
          armSl = r.sl;
          armDir = 1;
          armAge = 0;
        }
      }
    }

    const e84 = ema84[i]!;
    const regimeLong = !p.useEma84 || !Number.isFinite(e84) || bar.close >= e84;
    const regimeShort = !p.useEma84 || !Number.isFinite(e84) || bar.close <= e84;

    if (Number.isFinite(armFtc)) {
      armAge += 1;
      const invalidated = armDir === 1 ? bar.low <= armSl : bar.high >= armSl;
      const tagged = armDir === 1 ? bar.low <= armFtc : bar.high >= armFtc;
      if (invalidated) {
        armFtc = NaN;
        armDir = 0;
      } else if (tagged) {
        const confL = !p.confirmCl || bar.close > armFtc;
        const confS = !p.confirmCl || bar.close < armFtc;
        let filled = false;
        if (i >= WARMUP) {
          if (armDir === 1 && confL && regimeLong && p.sides !== "Short") filled = true;
          if (armDir === -1 && confS && regimeShort && p.sides !== "Long") filled = true;
        }
        if (filled) lastFill = i;
        armFtc = NaN;
        armDir = 0;
      } else if (armAge >= p.ftcWait) {
        armFtc = NaN;
        armDir = 0;
      }
    }

    if (i === n - 1 && i >= WARMUP && atrOk && !Number.isFinite(armFtc) && i - lastFill >= p.cooldownBars) {
      let bestLong: PreArmedSetup | null = null;
      let bestShort: PreArmedSetup | null = null;

      if (p.sides !== "Short" && regimeLong && htfLongOk) {
        for (let k = supPx.length - 1; k >= 0; k--) {
          const cand = buildPreArmCandidate({
            indicator: p.name,
            dir: 1,
            px: supPx[k]!,
            pa: supAtr[k]!,
            pivotBar: supBar[k]!,
            i,
            bars,
            a,
            rr: p.rr,
            slAtrMult: p.slAtrMult,
            ftcWait: p.ftcWait,
            minRoomR: p.minRoomR,
            minAwayAtr: p.minAwayAtr,
            bandAtr: p.bandAtr,
            resPx,
            resAtr,
            resBar,
            supPx,
            supAtr,
            supBar,
            reasonTag: "KETEX 2.2R second-test support · NEXUS close · Pre-arm FTC limit",
          });
          if (cand && (!bestLong || Math.abs(cand.entry - bar.close) < Math.abs(bestLong.entry - bar.close))) {
            bestLong = cand;
          }
        }
      }

      if (p.sides !== "Long" && regimeShort && htfShortOk) {
        for (let k = resPx.length - 1; k >= 0; k--) {
          const cand = buildPreArmCandidate({
            indicator: p.name,
            dir: -1,
            px: resPx[k]!,
            pa: resAtr[k]!,
            pivotBar: resBar[k]!,
            i,
            bars,
            a,
            rr: p.rr,
            slAtrMult: p.slAtrMult,
            ftcWait: p.ftcWait,
            minRoomR: p.minRoomR,
            minAwayAtr: p.minAwayAtr,
            bandAtr: p.bandAtr,
            resPx,
            resAtr,
            resBar,
            supPx,
            supAtr,
            supBar,
            reasonTag: "KETEX 2.2R second-test resistance · NEXUS close · Pre-arm FTC limit",
          });
          if (cand && (!bestShort || Math.abs(cand.entry - bar.close) < Math.abs(bestShort.entry - bar.close))) {
            bestShort = cand;
          }
        }
      }

      if (bestLong && bestShort) {
        return Math.abs(bestLong.entry - bar.close) <= Math.abs(bestShort.entry - bar.close) ? bestLong : bestShort;
      }
      return bestLong ?? bestShort;
    }
  }

  return null;
}

function findShetexPreArm(bars: Bar[], tf: Timeframe, htfBars?: Bar[]): PreArmedSetup | null {
  const n = bars.length;
  if (n <= WARMUP) return null;
  const p: ShetexProfile = shetexProfile();

  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  const catr = customAtr(high, low, close);

  const htfMs = TF_MS[HTF_OF[tf]];
  const barMs = TF_MS[tf];
  const htf = htfBars && htfBars.length > 10 ? htfBars : resample(bars, htfMs);
  const htfTimes = htf.map((b) => b.time);
  const htfClose = htf.map((b) => b.close);
  const htfEma50 = ema(htfClose, 50);

  const resPx: number[] = [];
  const resAtr: number[] = [];
  const resBar: number[] = [];
  const supPx: number[] = [];
  const supAtr: number[] = [];
  const supBar: number[] = [];

  let armFtc = NaN;
  let armSl = NaN;
  let armDir = 0;
  let armAge = 0;
  let lastFill = -9999;

  for (let i = 2; i < n; i++) {
    const bar = bars[i]!;
    const a = catr[i]!;
    const atrOk = Number.isFinite(a) && a > 0;

    let newHighPivot = false;
    let newLowPivot = false;
    let highExt = NaN;
    let highIn = NaN;
    let lowExt = NaN;
    let lowIn = NaN;

    if (atrOk) {
      const cH1 = coverHighAt(1, i, bars, catr, p);
      const cH2 = coverHighAt(2, i, bars, catr, p);
      const cL1 = coverLowAt(1, i, bars, catr, p);
      const cL2 = coverLowAt(2, i, bars, catr, p);

      newHighPivot = cH1.ok || (p.coverMax >= 2 && cH2.ok && !cH1.ok);
      newLowPivot = cL1.ok || (p.coverMax >= 2 && cL2.ok && !cL1.ok);
      highExt = cH1.ok ? cH1.extreme : cH2.extreme;
      highIn = cH1.ok ? cH1.inner : cH2.inner;
      lowExt = cL1.ok ? cL1.extreme : cL2.extreme;
      lowIn = cL1.ok ? cL1.inner : cL2.inner;

      if (newHighPivot && newLowPivot) {
        if (highExt - highIn >= lowIn - lowExt) newLowPivot = false;
        else newHighPivot = false;
      }
    }

    let isReversalHigh = false;
    let isReversalLow = false;

    if (newHighPivot) {
      for (let k = resPx.length - 1; k >= 0; k--) {
        const px = resPx[k]!;
        const pa = resAtr[k]!;
        const b = resBar[k]!;
        const band = p.bandAtr * Math.max(a, pa);
        const age = i - b;
        if (Math.abs(highExt - px) <= band && age >= 4) {
          const look = Math.min(300, age);
          const away = px - lowestSince(i, look, bars);
          const broken = highestCloseSince(i, look, bars) > px + 0.2 * pa;
          if (away >= p.minAwayAtr * pa && !broken) isReversalHigh = true;
          break;
        }
      }
      resPx.push(highExt);
      resAtr.push(a);
      resBar.push(i);
      if (resPx.length > 40) {
        resPx.shift();
        resAtr.shift();
        resBar.shift();
      }
    }

    if (newLowPivot) {
      for (let k = supPx.length - 1; k >= 0; k--) {
        const px = supPx[k]!;
        const pa = supAtr[k]!;
        const b = supBar[k]!;
        const band = p.bandAtr * Math.max(a, pa);
        const age = i - b;
        if (Math.abs(lowExt - px) <= band && age >= 4) {
          const look = Math.min(300, age);
          const away = highestSince(i, look, bars) - px;
          const broken = lowestCloseSince(i, look, bars) < px - 0.2 * pa;
          if (away >= p.minAwayAtr * pa && !broken) isReversalLow = true;
          break;
        }
      }
      supPx.push(lowExt);
      supAtr.push(a);
      supBar.push(i);
      if (supPx.length > 40) {
        supPx.shift();
        supAtr.shift();
        supBar.shift();
      }
    }

    const ltfClose = bar.time + barMs;
    const htfC = htfAt(htfTimes, htfClose, ltfClose, htfMs);
    const htfE = htfAt(htfTimes, htfEma50, ltfClose, htfMs);
    const htfLongOk = !p.useHtfEma || !Number.isFinite(htfE) || htfC >= htfE * 0.997;
    const htfShortOk = !p.useHtfEma || !Number.isFinite(htfE) || htfC <= htfE * 1.003;

    if (atrOk) {
      const arm = (dir: 1 | -1, extreme: number, inner: number) => {
        const slBuf = p.slAtrMult * a;
        const sl = dir === 1 ? extreme - slBuf : extreme + slBuf;
        let ftc = (extreme + inner) * 0.5;
        ftc = dir === 1 ? Math.max(ftc, extreme + 0.2 * a) : Math.min(ftc, extreme - 0.2 * a);
        const slDist = Math.abs(ftc - sl);
        const rm = roomR(dir, extreme, slDist, resPx, supPx);
        const ok = rm >= p.minRoomR && i - lastFill >= p.cooldownBars;
        return { ok, ftc, sl };
      };

      if (isReversalHigh && htfShortOk) {
        const r = arm(-1, highExt, highIn);
        if (r.ok) {
          armFtc = r.ftc;
          armSl = r.sl;
          armDir = -1;
          armAge = 0;
        }
      }
      if (isReversalLow && htfLongOk) {
        const r = arm(1, lowExt, lowIn);
        if (r.ok) {
          armFtc = r.ftc;
          armSl = r.sl;
          armDir = 1;
          armAge = 0;
        }
      }
    }

    if (Number.isFinite(armFtc)) {
      armAge += 1;
      const invalidated = armDir === 1 ? bar.low <= armSl : bar.high >= armSl;
      const tagged = armDir === 1 ? bar.low <= armFtc : bar.high >= armFtc;
      if (invalidated) {
        armFtc = NaN;
        armDir = 0;
      } else if (tagged) {
        lastFill = i;
        armFtc = NaN;
        armDir = 0;
      } else if (armAge >= p.ftcWait) {
        armFtc = NaN;
        armDir = 0;
      }
    }

    if (i === n - 1 && i >= WARMUP && atrOk && !Number.isFinite(armFtc) && i - lastFill >= p.cooldownBars) {
      let bestLong: PreArmedSetup | null = null;
      let bestShort: PreArmedSetup | null = null;

      if (htfLongOk) {
        for (let k = supPx.length - 1; k >= 0; k--) {
          const cand = buildPreArmCandidate({
            indicator: p.name,
            dir: 1,
            px: supPx[k]!,
            pa: supAtr[k]!,
            pivotBar: supBar[k]!,
            i,
            bars,
            a,
            rr: p.rr,
            slAtrMult: p.slAtrMult,
            ftcWait: p.ftcWait,
            minRoomR: p.minRoomR,
            minAwayAtr: p.minAwayAtr,
            bandAtr: p.bandAtr,
            resPx,
            resAtr,
            resBar,
            supPx,
            supAtr,
            supBar,
            reasonTag: "SHETEX 1.8R second-test support · Pre-arm FTC limit",
          });
          if (cand && (!bestLong || Math.abs(cand.entry - bar.close) < Math.abs(bestLong.entry - bar.close))) {
            bestLong = cand;
          }
        }
      }

      if (htfShortOk) {
        for (let k = resPx.length - 1; k >= 0; k--) {
          const cand = buildPreArmCandidate({
            indicator: p.name,
            dir: -1,
            px: resPx[k]!,
            pa: resAtr[k]!,
            pivotBar: resBar[k]!,
            i,
            bars,
            a,
            rr: p.rr,
            slAtrMult: p.slAtrMult,
            ftcWait: p.ftcWait,
            minRoomR: p.minRoomR,
            minAwayAtr: p.minAwayAtr,
            bandAtr: p.bandAtr,
            resPx,
            resAtr,
            resBar,
            supPx,
            supAtr,
            supBar,
            reasonTag: "SHETEX 1.8R second-test resistance · Pre-arm FTC limit",
          });
          if (cand && (!bestShort || Math.abs(cand.entry - bar.close) < Math.abs(bestShort.entry - bar.close))) {
            bestShort = cand;
          }
        }
      }

      if (bestLong && bestShort) {
        return Math.abs(bestLong.entry - bar.close) <= Math.abs(bestShort.entry - bar.close) ? bestLong : bestShort;
      }
      return bestLong ?? bestShort;
    }
  }

  return null;
}

function coilIndicators(bars: Bar[]) {
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  const vol = bars.map((b) => b.volume);
  const catr = customAtr(high, low, close);
  const atr14 = atr(high, low, close, 14);
  const atr100 = atr(high, low, close, 100);
  const atrRatio = atr14.map((a, i) => a / Math.max(atr100[i]!, 1e-12));
  const ema21 = ema(close, 21);
  const ema84 = ema(close, 84);
  const { adx } = dmi(high, low, close, 14, 14);
  const tr = trueRange(high, low, close);
  const chop = new Array<number>(bars.length).fill(NaN);
  let trSum = 0;
  for (let i = 0; i < bars.length; i++) {
    trSum += Number.isFinite(tr[i]!) ? tr[i]! : 0;
    if (i >= 14) trSum -= Number.isFinite(tr[i - 14]!) ? tr[i - 14]! : 0;
    if (i < 13) continue;
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = 0; k < 14; k++) {
      const b = bars[i - k]!;
      if (b.high > hh) hh = b.high;
      if (b.low < ll) ll = b.low;
    }
    const den = Math.max(hh - ll, 1e-10);
    chop[i] = (100 * Math.log10(Math.max(trSum, 1e-10) / den)) / LOG14;
  }
  return { catr, atrRatio, ema21, ema84, adx, chop, volSma: sma(vol, 20) };
}

function mapHtfLock(
  ltf: Bar[],
  ltfMs: number,
  htf: Bar[],
  htfMs: number,
  locked: boolean[],
  hi: number[],
  lo: number[],
) {
  const times = htf.map((b) => b.time);
  const lockN = locked.map((v) => (v ? 1 : 0));
  const outL = new Array<boolean>(ltf.length).fill(false);
  const outH = new Array<number>(ltf.length).fill(NaN);
  const outLo = new Array<number>(ltf.length).fill(NaN);
  for (let i = 0; i < ltf.length; i++) {
    const closeTime = ltf[i]!.time + ltfMs;
    outL[i] = htfAt(times, lockN, closeTime, htfMs) > 0.5;
    outH[i] = htfAt(times, hi, closeTime, htfMs);
    outLo[i] = htfAt(times, lo, closeTime, htfMs);
  }
  return { locked: outL, lockHi: outH, lockLo: outLo };
}

function buildCoilPreArmCandidate(opts: {
  p: CoilProfile;
  armSide: 1 | -1;
  hi: number;
  lo: number;
  catr: number;
  chop: number;
  bar: Bar;
  barIndex: number;
  lockBarTime: number;
}): PreArmedSetup | null {
  const { p, armSide, hi, lo, catr, chop, bar, barIndex, lockBarTime } = opts;
  const height = hi - lo;
  if (!(height > 0) || !Number.isFinite(catr) || !(catr > 0)) return null;
  if (p.sides === (armSide === 1 ? "Short" : "Long")) return null;

  const ftc = armSide === 1 ? lo : hi;
  // Resting limit strictly below current bar low/close (for long) or above current bar high/close (for short)
  if (armSide === 1) {
    if (!(bar.close > ftc && bar.low > ftc && bar.close <= hi)) return null;
  } else {
    if (!(bar.close < ftc && bar.high < ftc && bar.close >= lo)) return null;
  }

  const fillChopOk = !Number.isFinite(chop) || chop >= p.fillChopMin;
  if (!fillChopOk) return null;

  const minSl = p.minStopPct * ftc;
  let slDist = Math.max(p.slAtrMult * catr, minSl);
  if (p.qualityFill && p.minTpPct > 0) slDist = Math.max(slDist, (p.minTpPct * ftc) / p.rr);
  const room = armSide === 1 ? hi - p.bufferFrac * height - ftc : ftc - (lo + p.bufferFrac * height);
  if (!(room > 0)) return null;
  const maxForRr = room / p.rr;
  if (slDist > maxForRr) slDist = maxForRr;

  const slOk = slDist >= minSl && slDist <= p.maxSlFrac * height;
  const tpDist = p.rr * slDist;
  const tpOk = !p.qualityFill || tpDist / ftc + 1e-12 >= p.minTpPct;
  const tpBoxOk = !p.qualityFill || tpDist / height <= p.maxTpBoxFrac + 1e-12;
  const boxPctOk = !p.qualityFill || height / ftc >= p.minBoxPct;
  if (!slOk || !tpOk || !tpBoxOk || !boxPctOk || !(slDist > 0)) return null;

  const label =
    p.name === "HAEG" ? "Aegis" : p.name === "HVES" ? "Vesper" : p.name === "HORI" ? "Orion" : "Coil";
  const side: Side = armSide === 1 ? "long" : "short";
  const edge = side === "long" ? "support" : "resistance";
  const sl = armSide === 1 ? ftc - slDist : ftc + slDist;
  const tp = armSide === 1 ? ftc + tpDist : ftc - tpDist;
  const matchTolerance = Math.max(0.25 * height, 0.35 * catr, ftc * 0.002);

  return {
    indicator: p.name,
    side,
    entry: ftc,
    sl,
    tp,
    rr: p.rr,
    atr: catr,
    armAge: 0,
    ftcWait: p.ftcWait,
    armedBarIndex: barIndex,
    armedBarTime: bar.time,
    levelBarTime: lockBarTime,
    matchTolerance,
    phase: "pre-arm",
    reason: `HALCYON ${label} ${p.rr}R coil ${edge} · Pre-arm FTC limit`,
  };
}

function findCoilPreArm(
  bars: Bar[],
  tf: Timeframe,
  name: HalcyonName,
  htfBars?: Bar[],
): PreArmedSetup | null {
  const n = bars.length;
  if (n <= WARMUP) return null;
  const p = coilProfile(name, tf);
  const native = coilIndicators(bars);
  let locked: boolean[];
  let lockHi: number[];
  let lockLo: number[];
  if (p.useHtfLock) {
    const htfMs = TF_MS["15m"];
    const htf = htfBars && htfBars.length > 10 ? htfBars : resample(bars, htfMs);
    const htfInd = coilIndicators(htf);
    const raw = lockCoil(htf, htfInd, {
      boxLen: 16,
      minCompress: 3,
      minAge: 1,
      unlockBars: 10,
      adxMax: 30,
      squeeze: 1.05,
      chopMin: 38,
      emaSepMax: 1.8,
      minRangeAtr: 0.9,
      maxRangeAtr: 5.5,
      breakAtr: 0.1,
      adxKill: 32,
      useSqueeze: true,
    });
    const mapped = mapHtfLock(bars, TF_MS[tf], htf, htfMs, raw.locked, raw.lockHi, raw.lockLo);
    locked = mapped.locked;
    lockHi = mapped.lockHi;
    lockLo = mapped.lockLo;
  } else {
    const raw = lockCoil(bars, native, {
      boxLen: p.boxLen,
      minCompress: p.minCompress,
      minAge: p.minAge,
      unlockBars: p.unlockBars,
      adxMax: p.adxMax,
      squeeze: p.squeeze,
      chopMin: p.chopMin,
      emaSepMax: p.emaSepMax,
      minRangeAtr: p.minRangeAtr,
      maxRangeAtr: p.maxRangeAtr,
      breakAtr: p.breakAtr,
      adxKill: p.adxKill,
      useSqueeze: p.useSqueeze,
    });
    locked = raw.locked;
    lockHi = raw.lockHi;
    lockLo = raw.lockLo;
  }

  let prevLocked = false;
  let lockBarTime = bars[0]!.time;
  let loTouches = 0;
  let hiTouches = 0;
  let leftLo = false;
  let leftHi = false;
  let lastFill = -9999;
  let armFtc = NaN;
  let armSl = NaN;
  let armDir = 0;
  let armAge = 0;

  for (let i = 0; i < n; i++) {
    const bar = bars[i]!;
    const coilOn = locked[i] === true && Number.isFinite(lockHi[i]) && Number.isFinite(lockLo[i]);
    const justLocked = coilOn && !prevLocked;
    prevLocked = coilOn;

    if (justLocked) {
      lockBarTime = bar.time;
      loTouches = 1;
      hiTouches = 1;
      const ht0 = lockHi[i]! - lockLo[i]!;
      leftLo = bar.close >= lockLo[i]! + p.awayPct * ht0;
      leftHi = bar.close <= lockHi[i]! - p.awayPct * ht0;
      armFtc = NaN;
      armDir = 0;
    }
    if (!coilOn) {
      armFtc = NaN;
      armDir = 0;
      loTouches = 0;
      hiTouches = 0;
      leftLo = false;
      leftHi = false;
      continue;
    }

    const height = lockHi[i]! - lockLo[i]!;
    const rng = Math.max(bar.high - bar.low, EPS);
    const closeLocL = (bar.close - bar.low) / rng;
    const closeLocS = (bar.high - bar.close) / rng;
    const body = Math.abs(bar.close - bar.open) / rng;
    const vs = native.volSma[i]!;
    const volOk = p.volMax >= 8.5 || !Number.isFinite(vs) || vs <= 0 || bar.volume <= p.volMax * vs;
    const catr = native.catr[i]!;
    const chop = native.chop[i]!;

    if (!justLocked && Number.isFinite(armFtc) && armDir !== 0) {
      armAge += 1;
      const tagged = armDir === 1 ? bar.low <= armFtc : bar.high >= armFtc;
      const conf = armDir === 1 ? bar.close > armFtc : bar.close < armFtc;
      const loc = armDir === 1 ? closeLocL : closeLocS;
      const locOk = loc >= p.fillCloseLoc;
      const invalidated = armDir === 1 ? bar.close < armSl : bar.close > armSl;
      const inside = p.requireInside ? bar.close >= lockLo[i]! && bar.close <= lockHi[i]! : true;
      const fillSlOk = p.qualityFill ? (armDir === 1 ? bar.low > armSl : bar.high < armSl) : true;
      const fillPoke = armDir === 1 ? bar.low < lockLo[i]! : bar.high > lockHi[i]!;
      const fillBodyOk = !Number.isFinite(body) || body >= p.fillMinBody;
      const fillPokeOk = !p.fillRequirePoke || fillPoke;
      const fillChopOk = !Number.isFinite(chop) || chop >= p.fillChopMin;
      const sideBlocked = p.sides === (armSideDir(armDir) === 1 ? "Short" : "Long");
      if (armAge > p.ftcWait) {
        armFtc = NaN;
        armDir = 0;
      } else if (tagged) {
        if (
          conf &&
          locOk &&
          inside &&
          fillSlOk &&
          fillBodyOk &&
          fillPokeOk &&
          fillChopOk &&
          !sideBlocked &&
          i >= WARMUP
        ) {
          const risk = Math.abs(armFtc - armSl);
          const tp = armDir === 1 ? armFtc + p.rr * risk : armFtc - p.rr * risk;
          const fit =
            armDir === 1
              ? tp <= lockHi[i]! - p.bufferFrac * height
              : tp >= lockLo[i]! + p.bufferFrac * height;
          const near =
            armDir === 1
              ? armFtc - lockLo[i]! <= p.entryMaxPct * height
              : lockHi[i]! - armFtc <= p.entryMaxPct * height;
          const tpPct = Math.abs(tp - armFtc) / armFtc;
          const tpBox = Math.abs(tp - armFtc) / height;
          const tpPctOk = !p.qualityFill || tpPct + 1e-12 >= p.minTpPct;
          const tpBoxOk = !p.qualityFill || tpBox <= p.maxTpBoxFrac + 1e-12;
          if (fit && near && risk > 0 && tpPctOk && tpBoxOk && i - lastFill >= p.cooldownBars) {
            lastFill = i;
            if (armDir === 1) leftLo = false;
            else leftHi = false;
          }
        }
        armFtc = NaN;
        armDir = 0;
      } else if (invalidated) {
        armFtc = NaN;
        armDir = 0;
      }
    }

    if (
      !justLocked &&
      !Number.isFinite(armFtc) &&
      i - lastFill >= p.cooldownBars &&
      Number.isFinite(catr) &&
      catr > 0 &&
      height > 0
    ) {
      const nearLo = bar.low <= lockLo[i]! + p.edgePct * height;
      const nearHi = bar.high >= lockHi[i]! - p.edgePct * height;
      const pokeLo = bar.low < lockLo[i]!;
      const pokeHi = bar.high > lockHi[i]!;
      const pokeOkLo = pokeLo ? lockLo[i]! - bar.low <= p.maxPokeAtr * catr : true;
      const pokeOkHi = pokeHi ? bar.high - lockHi[i]! <= p.maxPokeAtr * catr : true;
      if (nearLo) loTouches += 1;
      else if (bar.close >= lockLo[i]! + p.awayPct * height) leftLo = true;
      if (nearHi) hiTouches += 1;
      else if (bar.close <= lockHi[i]! - p.awayPct * height) leftHi = true;

      let goL =
        leftLo &&
        nearLo &&
        pokeOkLo &&
        volOk &&
        loTouches >= 2 &&
        bar.close >= lockLo[i]! &&
        bar.close - lockLo[i]! <= p.entryMaxPct * height &&
        closeLocL >= 0.45;
      let goS =
        leftHi &&
        nearHi &&
        pokeOkHi &&
        volOk &&
        hiTouches >= 2 &&
        bar.close <= lockHi[i]! &&
        lockHi[i]! - bar.close <= p.entryMaxPct * height &&
        closeLocS >= 0.45;
      if (goL && goS) {
        if (bar.close - lockLo[i]! <= lockHi[i]! - bar.close) goS = false;
        else goL = false;
      }
      const armSide = goL ? 1 : goS ? -1 : 0;
      if (armSide !== 0 && p.sides !== (armSide === 1 ? "Short" : "Long")) {
        const ftc = armSide === 1 ? Math.min(bar.low, lockLo[i]!) : Math.max(bar.high, lockHi[i]!);
        const minSl = p.minStopPct * ftc;
        let slDist = Math.max(p.slAtrMult * catr, minSl);
        if (p.qualityFill && p.minTpPct > 0) slDist = Math.max(slDist, (p.minTpPct * ftc) / p.rr);
        const room =
          armSide === 1
            ? lockHi[i]! - p.bufferFrac * height - ftc
            : ftc - (lockLo[i]! + p.bufferFrac * height);
        if (room > 0) {
          const maxForRr = room / p.rr;
          if (slDist > maxForRr) slDist = maxForRr;
          const slOk = slDist >= minSl && slDist <= p.maxSlFrac * height;
          const tpDist = p.rr * slDist;
          const tpOk = !p.qualityFill || tpDist / ftc + 1e-12 >= p.minTpPct;
          const tpBoxOk = !p.qualityFill || tpDist / height <= p.maxTpBoxFrac + 1e-12;
          const boxPctOk = !p.qualityFill || height / ftc >= p.minBoxPct;
          if (slOk && tpOk && tpBoxOk && boxPctOk) {
            armFtc = ftc;
            armSl = armSide === 1 ? ftc - slDist : ftc + slDist;
            armDir = armSide;
            armAge = 0;
          }
        }
      }
    }

    if (
      i === n - 1 &&
      i >= WARMUP &&
      coilOn &&
      !justLocked &&
      !Number.isFinite(armFtc) &&
      i - lastFill >= p.cooldownBars
    ) {
      const hi = lockHi[i]!;
      const lo = lockLo[i]!;
      const candL = leftLo
        ? buildCoilPreArmCandidate({
            p,
            armSide: 1,
            hi,
            lo,
            catr,
            chop,
            bar,
            barIndex: i,
            lockBarTime,
          })
        : null;
      const candS = leftHi
        ? buildCoilPreArmCandidate({
            p,
            armSide: -1,
            hi,
            lo,
            catr,
            chop,
            bar,
            barIndex: i,
            lockBarTime,
          })
        : null;
      if (candL && candS) {
        return bar.close - lo <= hi - bar.close ? candL : candS;
      }
      return candL ?? candS;
    }
  }

  return null;
}

function armSideDir(dir: number): 1 | -1 {
  return dir === 1 ? 1 : -1;
}

/**
 * Finds an anticipatory Pre-Arm limit setup for any of the 11 engines without
 * changing indicator math, signal rules, or existing armed setups.
 * Returns null if the indicator is already armed or if no valid unbroken pattern exists.
 */
export function findPreArmedSetup(
  bars: Bar[],
  tf: Timeframe,
  name: IndicatorName,
  htfBars?: Bar[],
  htf2Bars?: Bar[],
): PreArmedSetup | null {
  if (!bars.length) return null;
  if (isApexName(name)) return findApexPreArm(bars, tf, apexProfile(name, tf), htfBars, htf2Bars);
  if (isTrexName(name)) return findTrexPreArm(bars, tf, name, htfBars);
  if (isKetexName(name)) return findKetexPreArm(bars, tf, htfBars);
  if (isShetexName(name)) return findShetexPreArm(bars, tf, htfBars);
  if (isHalcyonName(name)) return findCoilPreArm(bars, tf, name, htfBars);
  return null;
}

function keepFamilyGeneric<T extends { side: string }>(arr: T[]): T[] {
  const longs = arr.filter((s) => s.side === "long");
  const shorts = arr.filter((s) => s.side === "short");
  if (longs.length && shorts.length) return [];
  return arr;
}

export function scanPreArmedClosed(
  bars: Bar[],
  tf: Timeframe,
  htfBars?: Bar[],
  htf2Bars?: Bar[],
  names?: readonly IndicatorName[],
): PreArmedSetup[] {
  const list = names === undefined ? SCAN_RULE[tf] : names;
  if (!bars.length || !list.length) return [];
  const found: PreArmedSetup[] = [];
  for (const name of list) {
    const pre = findPreArmedSetup(bars, tf, name, htfBars, htf2Bars);
    if (pre) found.push(pre);
  }
  return [
    ...keepFamilyGeneric(found.filter((s) => isApexName(s.indicator))),
    ...keepFamilyGeneric(found.filter((s) => isHalcyonName(s.indicator))),
    ...keepFamilyGeneric(found.filter((s) => isTrexName(s.indicator))),
    ...keepFamilyGeneric(found.filter((s) => isKetexName(s.indicator))),
    ...keepFamilyGeneric(found.filter((s) => isShetexName(s.indicator))),
  ];
}

export { trexBeAtR };
