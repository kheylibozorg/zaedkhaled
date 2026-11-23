import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { LockPanel } from "@/components/desk/lock-panel";
import { DeskShell } from "@/components/desk/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ENGINE_FAMILIES,
  ENGINE_TFS,
  countArmed,
  countSidesArmed,
  isEngineOn,
  isSideOn,
  parseEngineGates,
  parseSideGates,
  serializeEngineGates,
  setAllEngines,
  setAllSides,
  setEngineCol,
  setEngineGate,
  setEngineRow,
  setSideGate,
  type EngineGates,
  type SideGates,
} from "@/lib/engine/engine-gates";
import { indicatorLabel, type IndicatorName, type Side, type Timeframe } from "@/lib/engine/types";
import { getDesk, saveDeskSettings } from "@/lib/server/functions";
import { useLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/engines")({
  loader: () => getDesk(),
  component: Page,
});

function Page() {
  const data = Route.useLoaderData();
  const { t, locale } = useLocale();
  const router = useRouter();
  const unlocked = data.lock.unlocked;
  const fa = locale === "fa";
  const raw = data.settings.engineGates;
  const storedGates = useMemo(() => parseEngineGates(raw), [raw]);
  const storedSides = useMemo(() => parseSideGates(raw), [raw]);
  const [gates, setGates] = useState<EngineGates>(storedGates);
  const [sides, setSides] = useState<SideGates>(storedSides);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setGates(storedGates);
    setSides(storedSides);
  }, [storedGates, storedSides]);

  const armed = countArmed(gates);
  const sideArmed = countSidesArmed(sides);
  const dirty = serializeEngineGates(gates, sides) !== serializeEngineGates(storedGates, storedSides);

  async function save() {
    if (!unlocked) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await saveDeskSettings({ data: { engine_gates: serializeEngineGates(gates, sides) } });
      setMsg(t.enginesSaved);
      await router.invalidate({ sync: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  function flip(name: IndicatorName, tf: Timeframe) {
    if (!unlocked) return;
    setGates((g) => setEngineGate(g, name, tf, !isEngineOn(g, name, tf)));
  }

  function flipSide(name: IndicatorName, side: Side) {
    if (!unlocked) return;
    setSides((s) => setSideGate(s, name, side, !isSideOn(s, name, side)));
  }

  function rowOn(name: IndicatorName, on: boolean) {
    if (!unlocked) return;
    setGates((g) => setEngineRow(g, name, on));
  }

  function colOn(tf: Timeframe, on: boolean) {
    if (!unlocked) return;
    setGates((g) => setEngineCol(g, tf, on));
  }

  function familyOn(names: IndicatorName[], on: boolean) {
    if (!unlocked) return;
    setGates((g) => names.reduce((acc, name) => setEngineRow(acc, name, on), g));
  }

  function allSide(side: Side, on: boolean) {
    if (!unlocked) return;
    setSides((s) => setAllSides(s, side, on));
  }

  const longAllOn = sideArmed.longOn === sideArmed.total;
  const shortAllOn = sideArmed.shortOn === sideArmed.total;

  return (
    <DeskShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">{t.engines}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted">{t.enginesHint}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={armed.on === armed.total ? "long" : armed.on === 0 ? "short" : "warn"}>
            {fa ? `${armed.on} از ${armed.total} ${t.enginesArmed}` : `${armed.on} / ${armed.total} ${t.enginesArmed}`}
          </Badge>
          <Badge tone={longAllOn ? "long" : sideArmed.longOn === 0 ? "short" : "warn"}>
            {fa
              ? `${sideArmed.longOn} از ${sideArmed.total} ${t.enginesLongArmed}`
              : `${sideArmed.longOn} / ${sideArmed.total} ${t.enginesLongArmed}`}
          </Badge>
          <Badge tone={shortAllOn ? "short" : sideArmed.shortOn === 0 ? "muted" : "warn"}>
            {fa
              ? `${sideArmed.shortOn} از ${sideArmed.total} ${t.enginesShortArmed}`
              : `${sideArmed.shortOn} / ${sideArmed.total} ${t.enginesShortArmed}`}
          </Badge>
          <Button type="button" variant="outline" disabled={!unlocked || busy} onClick={() => setGates(setAllEngines(true))}>
            {t.enginesAllOn}
          </Button>
          <Button type="button" variant="outline" disabled={!unlocked || busy} onClick={() => setGates(setAllEngines(false))}>
            {t.enginesAllOff}
          </Button>
          <Button type="button" variant="outline" disabled={!unlocked || busy} onClick={() => allSide("long", !longAllOn)}>
            {longAllOn ? t.enginesAllLongOff : t.enginesAllLongOn}
          </Button>
          <Button type="button" variant="outline" disabled={!unlocked || busy} onClick={() => allSide("short", !shortAllOn)}>
            {shortAllOn ? t.enginesAllShortOff : t.enginesAllShortOn}
          </Button>
          <Button type="button" disabled={!unlocked || busy || !dirty} onClick={save}>
            {busy ? t.running : t.save}
          </Button>
        </div>
      </div>

      <div className="mt-6">
        <LockPanel hasPin={data.lock.hasPin} unlocked={unlocked} />
      </div>

      {!unlocked ? <p className="mt-4 text-sm text-warn">{t.enginesLocked}</p> : null}
      {msg ? <p className="mt-3 text-sm text-long">{msg}</p> : null}
      {err ? <p className="mt-3 text-sm text-short">{err}</p> : null}

      <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface shadow-panel">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="text-xs text-subtle">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-start font-medium">{t.thInd}</th>
              {ENGINE_TFS.map((tf) => {
                const colOnCount = ENGINE_FAMILIES.flatMap((f) => f.names).filter((n) => isEngineOn(gates, n, tf)).length;
                const colTotal = ENGINE_FAMILIES.reduce((a, f) => a + f.names.length, 0);
                return (
                  <th key={tf} className="px-2 py-2 text-center font-medium">
                    <div className="grid gap-1">
                      <span dir="ltr">{tf}</span>
                      <button
                        type="button"
                        disabled={!unlocked}
                        onClick={() => colOn(tf, colOnCount < colTotal)}
                        className="mx-auto text-[10px] text-muted hover:text-fg disabled:opacity-40"
                      >
                        {t.enginesCol}
                      </button>
                    </div>
                  </th>
                );
              })}
              <th className="px-2 py-2 text-center font-medium">
                <div className="grid gap-1">
                  <span>{t.long}</span>
                  <button
                    type="button"
                    disabled={!unlocked}
                    onClick={() => allSide("long", !longAllOn)}
                    className="mx-auto text-[10px] text-muted hover:text-fg disabled:opacity-40"
                  >
                    {t.enginesCol}
                  </button>
                </div>
              </th>
              <th className="px-2 py-2 text-center font-medium">
                <div className="grid gap-1">
                  <span>{t.short}</span>
                  <button
                    type="button"
                    disabled={!unlocked}
                    onClick={() => allSide("short", !shortAllOn)}
                    className="mx-auto text-[10px] text-muted hover:text-fg disabled:opacity-40"
                  >
                    {t.enginesCol}
                  </button>
                </div>
              </th>
              <th className="px-2 py-2 text-center font-medium">{t.enginesRow}</th>
            </tr>
          </thead>
          <tbody>
            {ENGINE_FAMILIES.map((family) => (
              <FamilyBlock
                key={family.id}
                family={family}
                gates={gates}
                sides={sides}
                unlocked={unlocked}
                fa={fa}
                rowOn={t.enginesOn}
                rowOff={t.enginesOff}
                rowLabel={t.enginesRow}
                familyLabel={t.enginesFamily}
                onFlip={flip}
                onFlipSide={flipSide}
                onRow={rowOn}
                onFamily={familyOn}
              />
            ))}
          </tbody>
        </table>
      </div>
    </DeskShell>
  );
}

function FamilyBlock({
  family,
  gates,
  sides,
  unlocked,
  fa,
  rowOn,
  rowOff,
  rowLabel,
  familyLabel,
  onFlip,
  onFlipSide,
  onRow,
  onFamily,
}: {
  family: (typeof ENGINE_FAMILIES)[number];
  gates: EngineGates;
  sides: SideGates;
  unlocked: boolean;
  fa: boolean;
  rowOn: string;
  rowOff: string;
  rowLabel: string;
  familyLabel: string;
  onFlip: (name: IndicatorName, tf: Timeframe) => void;
  onFlipSide: (name: IndicatorName, side: Side) => void;
  onRow: (name: IndicatorName, on: boolean) => void;
  onFamily: (names: IndicatorName[], on: boolean) => void;
}) {
  const familyOnCount = family.names.reduce(
    (n, name) => n + ENGINE_TFS.filter((tf) => isEngineOn(gates, name, tf)).length,
    0,
  );
  const familyTotal = family.names.length * ENGINE_TFS.length;
  return (
    <>
      <tr className="border-t border-border bg-bg-elev">
        <td className="px-3 py-2 font-medium" colSpan={1}>
          {family.label}
        </td>
        <td className="px-2 py-2 text-center text-xs text-subtle" colSpan={ENGINE_TFS.length + 2}>
          {fa ? `${familyOnCount} از ${familyTotal}` : `${familyOnCount} / ${familyTotal}`}
        </td>
        <td className="px-2 py-2 text-center">
          <button
            type="button"
            disabled={!unlocked}
            onClick={() => onFamily(family.names, familyOnCount < familyTotal)}
            className="text-[10px] text-muted hover:text-fg disabled:opacity-40"
          >
            {familyLabel}
          </button>
        </td>
      </tr>
      {family.names.map((name) => {
        const rowCount = ENGINE_TFS.filter((tf) => isEngineOn(gates, name, tf)).length;
        const longOn = isSideOn(sides, name, "long");
        const shortOn = isSideOn(sides, name, "short");
        return (
          <tr key={name} className="border-t border-border/60">
            <td className="px-3 py-2.5">
              <div className="font-medium">{indicatorLabel(name)}</div>
              <div className="font-mono text-[10px] text-subtle" dir="ltr">
                {name}
              </div>
            </td>
            {ENGINE_TFS.map((tf) => {
              const on = isEngineOn(gates, name, tf);
              return (
                <td key={tf} className="px-2 py-2 text-center">
                  <button
                    type="button"
                    disabled={!unlocked}
                    onClick={() => onFlip(name, tf)}
                    className={cn(
                      "inline-flex h-11 min-w-16 items-center justify-center rounded-sm border px-3 text-xs font-medium transition-colors disabled:opacity-40",
                      on
                        ? "border-long/40 bg-long-dim text-long"
                        : "border-border bg-surface-2 text-muted",
                    )}
                  >
                    {on ? rowOn : rowOff}
                  </button>
                </td>
              );
            })}
            <td className="px-2 py-2 text-center">
              <button
                type="button"
                disabled={!unlocked}
                onClick={() => onFlipSide(name, "long")}
                className={cn(
                  "inline-flex h-11 min-w-16 items-center justify-center rounded-sm border px-3 text-xs font-medium transition-colors disabled:opacity-40",
                  longOn ? "border-long/40 bg-long-dim text-long" : "border-border bg-surface-2 text-muted",
                )}
              >
                {longOn ? rowOn : rowOff}
              </button>
            </td>
            <td className="px-2 py-2 text-center">
              <button
                type="button"
                disabled={!unlocked}
                onClick={() => onFlipSide(name, "short")}
                className={cn(
                  "inline-flex h-11 min-w-16 items-center justify-center rounded-sm border px-3 text-xs font-medium transition-colors disabled:opacity-40",
                  shortOn ? "border-short/40 bg-short-dim text-short" : "border-border bg-surface-2 text-muted",
                )}
              >
                {shortOn ? rowOn : rowOff}
              </button>
            </td>
            <td className="px-2 py-2 text-center">
              <button
                type="button"
                disabled={!unlocked}
                onClick={() => onRow(name, rowCount < ENGINE_TFS.length)}
                className="text-[10px] text-muted hover:text-fg disabled:opacity-40"
              >
                {rowLabel}
              </button>
            </td>
          </tr>
        );
      })}
    </>
  );
}
