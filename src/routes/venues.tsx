import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LockPanel } from "@/components/desk/lock-panel";
import { DeskShell } from "@/components/desk/shell";
import { LevSizeEditor } from "@/components/desk/lev-size-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/field";
import { VENUE_META } from "@/lib/exchanges/meta";
import { getDesk, saveDeskSettings, testTelegram, testVenue } from "@/lib/server/functions";
import { useLocale } from "@/lib/locale";
import type { VenueId } from "@/lib/engine/types";
import { millionsToUsd, usdToMillions } from "@/lib/utils";
import { DEFAULT_CAPITAL_PCT, DEFAULT_LEV_SIZE_TIERS, type CapitalBase } from "@/lib/engine/lev-size";
import { stringifyTelegramVenues, type TelegramVenueMap } from "@/lib/telegram";

export const Route = createFileRoute("/venues")({
  loader: () => getDesk(),
  component: Page,
});

function Page() {
  const data = Route.useLoaderData();
  const { t, locale } = useLocale();
  const router = useRouter();
  const s = data.settings;
  const unlocked = data.lock.unlocked;
  const [mode, setMode] = useState(s.mode);
  const [venue, setVenue] = useState(s.venue);
  const [capital, setCapital] = useState(String(s.capitalPct ?? DEFAULT_CAPITAL_PCT));
  const [capitalBase, setCapitalBase] = useState<CapitalBase>(s.capitalBase === "free" ? "free" : "total");
  const [maxLev, setMaxLev] = useState(String(s.maxLeverage ?? 200));
  const [stackCount, setStackCount] = useState(String(s.stackLevCount ?? 2));
  const [stackCap, setStackCap] = useState(String(s.stackLevCap ?? 75));
  const [tiers, setTiers] = useState(s.levSizeTiers ?? DEFAULT_LEV_SIZE_TIERS);
  const [maxPos, setMaxPos] = useState(String(s.maxPositions));
  const [htfMaxPos, setHtfMaxPos] = useState(String(s.htfMaxPositions ?? 4));
  const [equity, setEquity] = useState(String(s.equityUsd));
  const [batch, setBatch] = useState(String(s.scanBatch ?? 0));
  const [minCap, setMinCap] = useState(String(usdToMillions(s.minMarketCapUsd)));
  const [bot, setBot] = useState(s.botEnabled);
  const [live, setLive] = useState(s.liveEnabled);
  const [lighterKey, setLighterKey] = useState("");
  const [lighterPk, setLighterPk] = useState("");
  const [lighterIdx, setLighterIdx] = useState(s.lighterAccountIndex != null ? String(s.lighterAccountIndex) : "");
  const [lighterKeyIdx, setLighterKeyIdx] = useState(s.lighterKeyIndex != null ? String(s.lighterKeyIndex) : "2");
  const [asterKey, setAsterKey] = useState("");
  const [asterSec, setAsterSec] = useState("");
  const [ourbitKey, setOurbitKey] = useState("");
  const [ourbitSec, setOurbitSec] = useState("");
  const [hlPk, setHlPk] = useState("");
  const [hlAddr, setHlAddr] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState(s.telegramChatId ?? "");
  const [tgVenues, setTgVenues] = useState<TelegramVenueMap>(s.telegramVenues);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const fa = locale === "fa";

  useEffect(() => {
    setMode(s.mode);
    setVenue(s.venue);
    setCapital(String(s.capitalPct ?? DEFAULT_CAPITAL_PCT));
    setCapitalBase(s.capitalBase === "free" ? "free" : "total");
    setMaxLev(String(s.maxLeverage ?? 200));
    setStackCount(String(s.stackLevCount ?? 2));
    setStackCap(String(s.stackLevCap ?? 75));
    setTiers(s.levSizeTiers ?? DEFAULT_LEV_SIZE_TIERS);
    setMaxPos(String(s.maxPositions ?? 4));
    setHtfMaxPos(String(s.htfMaxPositions ?? 4));
    setEquity(String(s.equityUsd));
    setBatch(String(s.scanBatch ?? 0));
    setMinCap(String(usdToMillions(s.minMarketCapUsd)));
    setBot(s.botEnabled);
    setLive(s.liveEnabled);
    setTgChat(s.telegramChatId ?? "");
    setTgVenues(s.telegramVenues);
  }, [
    s.mode,
    s.venue,
    s.capitalPct,
    s.capitalBase,
    s.maxLeverage,
    s.stackLevCount,
    s.stackLevCap,
    s.levSizeTiers,
    s.maxPositions,
    s.htfMaxPositions,
    s.equityUsd,
    s.scanBatch,
    s.minMarketCapUsd,
    s.botEnabled,
    s.liveEnabled,
    s.telegramChatId,
    s.telegramVenues,
  ]);

  async function save() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const saved = await saveDeskSettings({
        data: {
          mode,
          venue: venue as VenueId,
          capital_pct: Math.min(100, Math.max(1, Number(capital) || DEFAULT_CAPITAL_PCT)),
          capital_base: capitalBase,
          max_leverage: Math.min(200, Math.max(1, Math.round(Number(maxLev) || 200))),
          stack_lev_count: Math.min(20, Math.max(0, Math.round(Number(stackCount) || 0))),
          stack_lev_cap: Math.min(200, Math.max(1, Math.round(Number(stackCap) || 75))),
          lev_size_tiers: tiers,
          max_positions: Math.min(20, Math.max(1, Math.round(Number(maxPos) || 4))),
          htf_max_positions: Math.min(20, Math.max(0, Math.round(Number(htfMaxPos) || 0))),
          equity_usd: Number(equity),
          scan_batch: Math.min(250, Math.max(0, Math.round(Number(batch) || 0))),
          min_market_cap_usd: millionsToUsd(Number(minCap) || 0),
          bot_enabled: bot ? 1 : 0,
          live_enabled: live ? 1 : 0,
          lighter_api_key: lighterKey || undefined,
          lighter_api_private_key: lighterPk || undefined,
          lighter_account_index: lighterIdx ? Number(lighterIdx) : undefined,
          lighter_api_key_index: lighterKeyIdx ? Number(lighterKeyIdx) : undefined,
          aster_api_key: asterKey || undefined,
          aster_api_secret: asterSec || undefined,
          ourbit_api_key: ourbitKey || undefined,
          ourbit_api_secret: ourbitSec || undefined,
          hyperliquid_private_key: hlPk || undefined,
          hyperliquid_wallet_address: hlAddr || undefined,
          telegram_bot_token: tgToken || undefined,
          telegram_chat_id: tgChat.trim(),
          telegram_venues: stringifyTelegramVenues(tgVenues),
        },
      });
      setCapital(String(saved.capitalPct ?? capital));
      setCapitalBase(saved.capitalBase === "free" ? "free" : "total");
      setMaxLev(String(saved.maxLeverage ?? maxLev));
      setStackCount(String(saved.stackLevCount ?? stackCount));
      setStackCap(String(saved.stackLevCap ?? stackCap));
      setTiers(saved.levSizeTiers ?? tiers);
      setMaxPos(String(saved.maxPositions ?? maxPos));
      setHtfMaxPos(String(saved.htfMaxPositions ?? htfMaxPos));
      setBatch(String(saved.scanBatch ?? batch));
      setMinCap(String(usdToMillions(saved.minMarketCapUsd)));
      setEquity(String(saved.equityUsd ?? equity));
      setMode(saved.mode);
      setVenue(saved.venue);
      setBot(saved.botEnabled);
      setLive(saved.liveEnabled);
      setLighterKey("");
      setLighterPk("");
      setAsterKey("");
      setAsterSec("");
      setOurbitKey("");
      setOurbitSec("");
      setHlPk("");
      setHlAddr("");
      setTgToken("");
      setTgChat(saved.telegramChatId ?? "");
      setTgVenues(saved.telegramVenues);
      setMsg(t.saved);
      await router.invalidate({ sync: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  async function ping(id: "hyperliquid" | "lighter" | "aster" | "ourbit") {
    setTesting(id);
    setErr(null);
    try {
      const payload: {
        venue: "hyperliquid" | "lighter" | "aster" | "ourbit";
        hyperliquid_private_key?: string;
        hyperliquid_wallet_address?: string;
        lighter_api_key?: string;
        lighter_api_private_key?: string;
        lighter_account_index?: number;
        lighter_api_key_index?: number;
        aster_api_key?: string;
        aster_api_secret?: string;
        ourbit_api_key?: string;
        ourbit_api_secret?: string;
      } = {
        venue: id,
      };
      if (id === "hyperliquid") {
        if (hlPk) payload.hyperliquid_private_key = hlPk;
        if (hlAddr) payload.hyperliquid_wallet_address = hlAddr;
      } else if (id === "lighter") {
        if (lighterKey) payload.lighter_api_key = lighterKey;
        if (lighterPk) payload.lighter_api_private_key = lighterPk;
        if (lighterIdx) payload.lighter_account_index = Number(lighterIdx);
        if (lighterKeyIdx) payload.lighter_api_key_index = Number(lighterKeyIdx);
      } else if (id === "aster") {
        if (asterKey) payload.aster_api_key = asterKey;
        if (asterSec) payload.aster_api_secret = asterSec;
      } else {
        if (ourbitKey) payload.ourbit_api_key = ourbitKey;
        if (ourbitSec) payload.ourbit_api_secret = ourbitSec;
      }
      await saveDeskSettings({ data: payload });
      setVenue(id);
      const res = await testVenue({ data: { venue: id } });
      setTestMsg((m) => ({ ...m, [id]: { ok: res.ok, text: res.message } }));
      if (res.ok) {
        setMsg(fa ? "وصل شد · زنده را جداگانه از چک‌باکس Live روشن کن" : "Connected · turn Live on separately, then Save");
        if (id === "hyperliquid") {
          setHlPk("");
          setHlAddr("");
        } else if (id === "lighter") {
          setLighterKey("");
          setLighterPk("");
        } else if (id === "aster") {
          setAsterKey("");
          setAsterSec("");
        } else {
          setOurbitKey("");
          setOurbitSec("");
        }
      }
      await router.invalidate({ sync: true });
    } catch (e) {
      setTestMsg((m) => ({
        ...m,
        [id]: { ok: false, text: e instanceof Error ? e.message : "test failed" },
      }));
    } finally {
      setTesting(null);
    }
  }

  async function pingTelegram(id: VenueId) {
    setTesting(`tg:${id}`);
    setErr(null);
    try {
      await saveDeskSettings({
        data: {
          telegram_bot_token: tgToken || undefined,
          telegram_chat_id: tgChat.trim(),
          telegram_venues: stringifyTelegramVenues(tgVenues),
        },
      });
      setTgToken("");
      const res = await testTelegram({ data: { venue: id } });
      setTestMsg((m) => ({ ...m, [`tg:${id}`]: { ok: res.ok, text: res.message } }));
      await router.invalidate({ sync: true });
    } catch (e) {
      setTestMsg((m) => ({
        ...m,
        [`tg:${id}`]: { ok: false, text: e instanceof Error ? e.message : "telegram failed" },
      }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <DeskShell>
      <h1 className="font-display text-3xl tracking-tight">{t.venues}</h1>

      <div className="mt-4 grid gap-3 rounded-lg border-2 border-accent bg-surface p-4">
        <div>
          <h2 className="text-base font-medium">{t.capitalBase}</h2>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:max-w-md">
            {(["total", "free"] as const).map((base) => (
              <button
                key={base}
                type="button"
                disabled={!unlocked}
                onClick={() => setCapitalBase(base)}
                className={`min-h-11 rounded-sm border px-3 text-sm ${
                  capitalBase === base ? "border-accent bg-surface-2 text-fg" : "border-border text-muted"
                } disabled:opacity-40`}
              >
                {base === "total" ? t.capitalBaseTotal : t.capitalBaseFree}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">{t.capitalBaseHint}</p>
        </div>
        <div className="grid gap-1.5 sm:max-w-xs">
          <Label>{t.htfMaxPos}</Label>
          <Input
            type="number"
            min={0}
            max={20}
            step={1}
            value={htfMaxPos}
            disabled={!unlocked}
            onChange={(e) => setHtfMaxPos(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            {[0, 2, 3, 4, 6].map((n) => (
              <button
                key={n}
                type="button"
                disabled={!unlocked}
                onClick={() => setHtfMaxPos(String(n))}
                className={`min-h-8 rounded-sm border px-2 text-xs ${
                  Number(htfMaxPos) === n ? "border-accent bg-surface-2 text-fg" : "border-border text-muted"
                } disabled:opacity-40`}
              >
                {n === 0 ? (fa ? "خاموش" : "off") : n}
              </button>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-muted">{t.htfMaxPosHint}</p>
        </div>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted">{t.keys}</p>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        {fa
          ? "بعد از Test سبز، ربات خودش تمام پرپچوال‌های لیست‌شدهٔ همان صرافی را می‌خواند و اسکن را روی چارت همان صرافی می‌زند — نه بایننس، نه کتاب صرافی قبلی."
          : "A green Test rebuilds the universe from that exchange's listed perps and scans that venue's own candles — not Binance, not the previous book."}
      </p>

      <div className="mt-6">
        <LockPanel hasPin={data.lock.hasPin} unlocked={unlocked} />
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {VENUE_META.map((v) => (
          <button
            key={v.id}
            type="button"
            disabled={!unlocked}
            onClick={() => {
              setVenue(v.id);
              if (v.id === "paper") {
                setMode("paper");
                setLive(false);
              } else {
                setMode("live");
                setLive(true);
                setBot(true);
              }
            }}
            className={`rounded-lg border p-4 text-start shadow-panel transition-colors ${
              venue === v.id ? "border-accent bg-surface" : "border-border bg-bg-elev hover:border-border-strong"
            } disabled:opacity-50`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{v.label}</span>
              <Badge tone={v.kind === "sim" ? "fg" : v.kind === "dex" ? "long" : "warn"}>{v.kind}</Badge>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">{fa ? v.blurbFa : v.blurbEn}</p>
          </button>
        ))}
      </div>

      {venue !== "paper" && mode === "live" ? (
        <p className="mt-4 rounded-lg border border-long/40 bg-long-dim/30 p-3 text-sm text-fg">
          {fa
            ? "زنده: ورود مارکت است. TP و SL روی خود صرافی. کلید را بچسبان و Test بزن. Test زنده را روشن نمی‌کند — Live و Save جدا هستند."
            : "Live: market entry. TP/SL on the venue. Paste keys and hit Test. Test does not arm live — turn Live on and Save."}
        </p>
      ) : null}

      <div className="mt-6 grid gap-4 rounded-lg border border-border bg-surface p-4 shadow-panel sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-1.5">
          <Label>Mode</Label>
          <Select
            value={mode}
            disabled={!unlocked}
            onChange={(e) => {
              const next = e.target.value as "paper" | "live";
              setMode(next);
              if (next === "live" && venue === "paper") setVenue("aster");
            }}
          >
            <option value="paper">{t.paper}</option>
            <option value="live">{t.live}</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>{t.autoLev}</Label>
          <Input
            id="venue-maxlev"
            type="number"
            min={1}
            max={200}
            step={1}
            value={maxLev}
            disabled={!unlocked}
            onChange={(e) => setMaxLev(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            {[5, 10, 20, 25, 50, 100, 200].map((n) => (
              <button
                key={n}
                type="button"
                disabled={!unlocked}
                onClick={() => setMaxLev(String(n))}
                className={`min-h-8 rounded-sm border px-2 text-xs ${
                  Number(maxLev) === n
                    ? "border-accent bg-surface-2 text-fg"
                    : "border-border text-muted hover:border-border-strong"
                } disabled:opacity-40`}
              >
                {n}x
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label>{t.stackLev}</Label>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Input
                type="number"
                min={0}
                max={20}
                step={1}
                value={stackCount}
                disabled={!unlocked}
                onChange={(e) => setStackCount(e.target.value)}
                aria-label={t.stackLevCount}
              />
              <p className="text-xs text-subtle">{t.stackLevCount}</p>
            </div>
            <div className="grid gap-1">
              <Input
                type="number"
                min={1}
                max={200}
                step={1}
                value={stackCap}
                disabled={!unlocked}
                onChange={(e) => setStackCap(e.target.value)}
                aria-label={t.stackLevCap}
              />
              <p className="text-xs text-subtle">{t.stackLevCap}</p>
            </div>
          </div>
          <p className="text-xs text-subtle">{t.stackLevHint}</p>
        </div>
        <LevSizeEditor
          capital={capital}
          onCapital={setCapital}
          capitalBase={capitalBase}
          onCapitalBase={setCapitalBase}
          tiers={tiers}
          onTiers={setTiers}
          disabled={!unlocked}
          equityUsd={capitalBase === "free" ? (s.availableUsd ?? s.equityUsd) : s.equityUsd}
          universe={data.universe}
        />
        <div className="grid gap-1.5">
          <Label>{t.maxPos}</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={maxPos}
            disabled={!unlocked}
            onChange={(e) => setMaxPos(e.target.value)}
          />
          <p className="text-xs text-subtle">{t.maxPosHint}</p>
        </div>
        <div className="grid gap-1.5">
          <Label>{t.htfMaxPos}</Label>
          <Input
            type="number"
            min={0}
            max={20}
            value={htfMaxPos}
            disabled={!unlocked}
            onChange={(e) => setHtfMaxPos(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            {[0, 2, 3, 4, 6].map((n) => (
              <button
                key={n}
                type="button"
                disabled={!unlocked}
                onClick={() => setHtfMaxPos(String(n))}
                className={`min-h-8 rounded-sm border px-2 text-xs ${
                  Number(htfMaxPos) === n
                    ? "border-accent bg-surface-2 text-fg"
                    : "border-border text-muted hover:border-border-strong"
                } disabled:opacity-40`}
              >
                {n === 0 ? (fa ? "خاموش" : "off") : n}
              </button>
            ))}
          </div>
          <p className="text-xs text-subtle">{t.htfMaxPosHint}</p>
        </div>
        <div className="grid gap-1.5">
          <Label>{locale === "fa" ? "ارز در هر تیک (۰ = همه)" : "Coins per tick (0 = all)"}</Label>
          <Input
            type="number"
            min={0}
            max={250}
            value={batch}
            disabled={!unlocked}
            onChange={(e) => setBatch(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>{t.minCap} · {locale === "fa" ? "میلیون دلار" : "USD millions"}</Label>
          <Input
            type="number"
            min={0}
            step={1}
            value={minCap}
            disabled={!unlocked}
            onChange={(e) => setMinCap(e.target.value)}
          />
          <div className="flex flex-wrap gap-1">
            {[
              { n: 0, label: t.minCapAll },
              { n: 100, label: "100" },
              { n: 300, label: "300" },
              { n: 800, label: "800" },
              { n: 1000, label: "1B" },
            ].map((p) => (
              <button
                key={p.n}
                type="button"
                disabled={!unlocked}
                onClick={() => setMinCap(String(p.n))}
                className={`min-h-8 rounded-sm border px-2 text-xs ${
                  Number(minCap) === p.n
                    ? "border-accent bg-surface-2 text-fg"
                    : "border-border text-muted hover:border-border-strong"
                } disabled:opacity-40`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-subtle">{t.minCapHint}</p>
        </div>
        <div className="grid gap-1.5">
          <Label>{t.equity} USD</Label>
          <Input type="number" value={equity} disabled={!unlocked} onChange={(e) => setEquity(e.target.value)} />
        </div>
        <label className="flex h-11 items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={bot} disabled={!unlocked} onChange={(e) => setBot(e.target.checked)} />
          {t.botOn}
        </label>
        <label className="flex h-11 items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={live} disabled={!unlocked} onChange={(e) => setLive(e.target.checked)} />
          {t.live} enabled
        </label>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <fieldset className="rounded-lg border border-border bg-surface p-4" disabled={!unlocked}>
          <legend className="px-1 text-sm font-medium">Hyperliquid</legend>
          <p className="mb-3 text-xs text-subtle">
            {s.hasHyperliquid ? s.hyperliquidKeyHint || "connected" : "not connected"}
            {s.hyperliquidAddrHint ? ` · ${s.hyperliquidAddrHint}` : ""}
          </p>
          <div className="grid gap-2">
            <Input
              placeholder="Agent / API wallet private key"
              type="password"
              value={hlPk}
              onChange={(e) => setHlPk(e.target.value)}
            />
            <Input
              placeholder="Master wallet 0x… (required — agent keys cannot be armed without it)"
              value={hlAddr}
              onChange={(e) => setHlAddr(e.target.value)}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" disabled={!unlocked || testing === "hyperliquid"} onClick={() => ping("hyperliquid")}>
              {testing === "hyperliquid" ? "…" : "Test"}
            </Button>
            {testMsg.hyperliquid ? (
              <span className={`text-xs ${testMsg.hyperliquid.ok ? "text-long" : "text-short"}`}>
                {testMsg.hyperliquid.text}
              </span>
            ) : null}
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-border bg-surface p-4" disabled={!unlocked}>
          <legend className="px-1 text-sm font-medium">Lighter</legend>
          <p className="mb-3 text-xs text-subtle">
            {s.lighterKeyHint || "not connected"} · account {s.lighterAccountIndex ?? "—"} · key {s.lighterKeyIndex ?? 2}
          </p>
          <div className="grid gap-2">
            <Input placeholder="L1 address" value={lighterKey} onChange={(e) => setLighterKey(e.target.value)} />
            <Input
              placeholder="API private key"
              type="password"
              value={lighterPk}
              onChange={(e) => setLighterPk(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Account index" value={lighterIdx} onChange={(e) => setLighterIdx(e.target.value)} />
              <Input placeholder="API key index (2)" value={lighterKeyIdx} onChange={(e) => setLighterKeyIdx(e.target.value)} />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" disabled={!unlocked || testing === "lighter"} onClick={() => ping("lighter")}>
              {testing === "lighter" ? "…" : "Test"}
            </Button>
            {testMsg.lighter ? (
              <span className={`text-xs ${testMsg.lighter.ok ? "text-long" : "text-short"}`}>{testMsg.lighter.text}</span>
            ) : null}
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-border bg-surface p-4" disabled={!unlocked}>
          <legend className="px-1 text-sm font-medium">Aster</legend>
          <p className="mb-3 text-xs text-subtle">
            {s.hasAster ? s.asterKeyHint || (fa ? "وصل است" : "connected") : fa ? "وصل نیست · asterdex.com/en/api-wallet" : "not connected · asterdex.com/en/api-wallet"}
          </p>
          <div className="grid gap-2">
            <Input
              placeholder="API wallet address 0x…"
              value={asterKey}
              onChange={(e) => setAsterKey(e.target.value)}
            />
            <Input
              placeholder="API wallet private key"
              type="password"
              value={asterSec}
              onChange={(e) => setAsterSec(e.target.value)}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" disabled={!unlocked || testing === "aster"} onClick={() => ping("aster")}>
              {testing === "aster" ? "…" : "Test"}
            </Button>
            {testMsg.aster ? (
              <span className={`text-xs ${testMsg.aster.ok ? "text-long" : "text-short"}`}>{testMsg.aster.text}</span>
            ) : null}
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-border bg-surface p-4" disabled={!unlocked}>
          <legend className="px-1 text-sm font-medium">OURBIT</legend>
          <p className="mb-3 text-xs text-subtle">{s.ourbitKeyHint || "not connected · ourbit.com/user/openapi"}</p>
          <div className="grid gap-2">
            <Input placeholder="API key" value={ourbitKey} onChange={(e) => setOurbitKey(e.target.value)} />
            <Input
              placeholder="API secret"
              type="password"
              value={ourbitSec}
              onChange={(e) => setOurbitSec(e.target.value)}
            />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button variant="outline" disabled={!unlocked || testing === "ourbit"} onClick={() => ping("ourbit")}>
              {testing === "ourbit" ? "…" : "Test"}
            </Button>
            {testMsg.ourbit ? (
              <span className={`text-xs ${testMsg.ourbit.ok ? "text-long" : "text-short"}`}>{testMsg.ourbit.text}</span>
            ) : null}
          </div>
        </fieldset>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface p-4 shadow-panel">
        <h2 className="text-base font-medium">{fa ? "تلگرام" : "Telegram"}</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
          {fa
            ? "برای هر صرافی که تیکش روشن باشد، سیگنال جدید همان صرافی به کانال می‌رود. چت خالی یعنی همان کانال بالا. سیگنال تکراری دوباره فرستاده نمی‌شود. اسکن، ورود و خروج دست نمی‌خورند."
            : "Each venue with the box on posts its new signals to Telegram. An empty chat uses the channel above. Duplicates are not sent again. Scan, entry and exit logic stay the same."}
        </p>
        <p className="mt-1 text-xs text-subtle">
          {s.hasTelegram
            ? fa
              ? `توکن ذخیره شده ${s.telegramTokenHint || ""}`.trim()
              : `Token saved ${s.telegramTokenHint || ""}`.trim()
            : fa
              ? "توکن هنوز ذخیره نشده"
              : "No bot token saved"}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Input
            placeholder={fa ? "توکن ربات از BotFather" : "Bot token from BotFather"}
            type="password"
            value={tgToken}
            disabled={!unlocked}
            onChange={(e) => setTgToken(e.target.value)}
            autoComplete="off"
          />
          <Input
            placeholder={fa ? "چت کانال: @channel یا -100…" : "Channel: @channel or -100…"}
            value={tgChat}
            disabled={!unlocked}
            onChange={(e) => setTgChat(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="mt-3 grid gap-2">
          {VENUE_META.map((v) => {
            const pref = tgVenues[v.id] ?? { on: false, chatId: "" };
            const pingKey = `tg:${v.id}`;
            return (
              <div key={v.id} className="grid items-center gap-2 rounded-sm border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={pref.on}
                    disabled={!unlocked}
                    onChange={(e) =>
                      setTgVenues((prev) => ({
                        ...prev,
                        [v.id]: { ...prev[v.id], on: e.target.checked },
                      }))
                    }
                  />
                  {v.label}
                  <span className="text-xs text-muted">{fa ? "ارسال سیگنال" : "send signals"}</span>
                </label>
                <Input
                  placeholder={fa ? "چت اختصاصی، اختیاری" : "Own chat, optional"}
                  value={pref.chatId}
                  disabled={!unlocked}
                  onChange={(e) =>
                    setTgVenues((prev) => ({
                      ...prev,
                      [v.id]: { ...prev[v.id], chatId: e.target.value },
                    }))
                  }
                />
                <Button variant="outline" disabled={!unlocked || testing === pingKey} onClick={() => pingTelegram(v.id)}>
                  {testing === pingKey ? "…" : fa ? "تست" : "Test"}
                </Button>
                {testMsg[pingKey] ? (
                  <span className={`text-xs sm:col-span-3 ${testMsg[pingKey].ok ? "text-long" : "text-short"}`}>
                    {testMsg[pingKey].text}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={save} disabled={busy || !unlocked}>
          {t.save}
        </Button>
        {msg ? <span className="text-sm text-long">{msg}</span> : null}
        {err ? <span className="text-sm text-short">{err}</span> : null}
      </div>
      <p className="mt-4 max-w-2xl text-xs text-subtle">
        {fa
          ? "حداکثر اهرم را خودت می‌گذاری (۱ تا ۲۰۰). ربات از سقف خود ارز روی صرافی بالاتر نمی‌رود. درصد سرمایه بر اساس اهرم همان ارز است. کلید را Save کن؛ زنده فقط با چک‌باکس Live روشن می‌شود."
          : "You set max leverage (1–200). The bot never exceeds that coin's venue max. Capital % follows that coin's leverage bucket. Save keys; live only turns on from the Live checkbox."}
      </p>
    </DeskShell>
  );
}
