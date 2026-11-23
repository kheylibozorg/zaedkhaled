import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import {
  DEFAULT_CAPITAL_PCT,
  DEFAULT_LEV_SIZE_TIERS,
  capitalPctForLeverage,
  clampCapitalPct,
  notionalPctOfEquity,
  type CapitalBase,
  type LevSizeTier,
} from "@/lib/engine/lev-size";
import { useLocale } from "@/lib/locale";

type Coin = { base?: string; max_leverage?: number };

export function LevSizeEditor({
  capital,
  onCapital,
  capitalBase,
  onCapitalBase,
  tiers,
  onTiers,
  disabled,
  equityUsd,
  universe,
}: {
  capital: string;
  onCapital: (v: string) => void;
  capitalBase: CapitalBase;
  onCapitalBase: (v: CapitalBase) => void;
  tiers: LevSizeTier[];
  onTiers: (v: LevSizeTier[]) => void;
  disabled?: boolean;
  equityUsd?: number;
  universe?: Coin[];
}) {
  const { locale, t } = useLocale();
  const fa = locale === "fa";
  const defaultPct = clampCapitalPct(Number(capital) || DEFAULT_CAPITAL_PCT);

  function setRow(i: number, patch: Partial<LevSizeTier>) {
    onTiers(tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  const groups = groupUniverse(universe ?? [], defaultPct, tiers, fa ? "بقیه" : "other");

  return (
    <div className="grid gap-3 rounded-lg border border-accent/50 bg-surface-2 p-3 sm:col-span-2 lg:col-span-3">
      <div>
        <h3 className="text-sm font-medium">{fa ? "سایز بر اساس اهرم ارز" : "Size by coin leverage"}</h3>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
          {fa
            ? "اگر سقف اهرم همان ارز دقیقاً با یک ردیف یکی باشد، درصد همان ردیف می‌رود تو معامله. حجم اسمی = درصد مارجین × اهرم."
            : "If that coin's max leverage matches a row exactly, that row's % is the margin. Notional = margin % × leverage."}
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label>{t.capitalBase}</Label>
        <div className="grid grid-cols-2 gap-2 sm:max-w-md">
          {(["total", "free"] as const).map((base) => (
            <button
              key={base}
              type="button"
              disabled={disabled}
              onClick={() => onCapitalBase(base)}
              className={`min-h-11 rounded-sm border px-3 text-sm ${
                capitalBase === base
                  ? "border-accent bg-surface text-fg"
                  : "border-border text-muted hover:border-border-strong"
              } disabled:opacity-40`}
            >
              {base === "total" ? t.capitalBaseTotal : t.capitalBaseFree}
            </button>
          ))}
        </div>
        <p className="max-w-2xl text-xs leading-relaxed text-subtle">{t.capitalBaseHint}</p>
      </div>

      <div className="grid gap-1.5 sm:max-w-xs">
        <Label htmlFor="lev-size-default">{fa ? "درصد پیش‌فرض (بقیه ارزها)" : "Default capital % (everything else)"}</Label>
        <Input
          id="lev-size-default"
          type="number"
          min={1}
          max={100}
          step={1}
          value={capital}
          disabled={disabled}
          onChange={(e) => onCapital(e.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {[3, 5, 6, 10, 12, 15, 20].map((n) => (
            <button
              key={n}
              type="button"
              disabled={disabled}
              onClick={() => onCapital(String(n))}
              className={`min-h-11 rounded-sm border px-2.5 text-xs ${
                Number(capital) === n
                  ? "border-accent bg-surface text-fg"
                  : "border-border text-muted hover:border-border-strong"
              } disabled:opacity-40`}
            >
              {n}%
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full min-w-[28rem] text-sm">
          <thead className="text-xs text-subtle">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-start font-medium">{fa ? "اهرم ارز" : "Coin leverage"}</th>
              <th className="px-3 py-2 text-start font-medium">{fa ? "درصد سرمایه" : "Capital %"}</th>
              <th className="px-3 py-2 text-start font-medium">{fa ? "حجم اسمی" : "Notional"}</th>
              <th className="px-3 py-2 text-end font-medium" />
            </tr>
          </thead>
          <tbody>
            {tiers.map((row, i) => {
              const notion = notionalPctOfEquity(row.capitalPct, row.leverage);
              return (
                <tr key={`${row.leverage}-${i}`} className="border-b border-border/60">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={1}
                        max={200}
                        step={1}
                        value={String(row.leverage)}
                        disabled={disabled}
                        aria-label={fa ? "اهرم" : "leverage"}
                        onChange={(e) =>
                          setRow(i, { leverage: Math.min(200, Math.max(1, Math.round(Number(e.target.value) || 1))) })
                        }
                      />
                      <span className="text-xs text-subtle">x</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={String(row.capitalPct)}
                        disabled={disabled}
                        aria-label={fa ? "درصد سرمایه" : "capital percent"}
                        onChange={(e) =>
                          setRow(i, { capitalPct: clampCapitalPct(Number(e.target.value) || 1) })
                        }
                      />
                      <span className="text-xs text-subtle">%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs tabular text-muted">
                    {notion}%
                    {equityUsd ? (
                      <span className="ms-1 text-subtle">
                        · {Math.round((equityUsd * notion) / 100).toLocaleString()}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-end">
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={fa ? "حذف ردیف" : "Remove row"}
                      onClick={() => onTiers(tiers.filter((_, j) => j !== i))}
                      className="inline-flex size-11 items-center justify-center rounded-sm text-muted hover:bg-surface-2 hover:text-short disabled:opacity-40"
                    >
                      <Trash2 className="size-4" strokeWidth={1.75} />
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr>
              <td className="px-3 py-2 font-mono text-xs text-subtle">{fa ? "بقیه" : "other"}</td>
              <td className="px-3 py-2 font-mono text-xs tabular">{defaultPct}%</td>
              <td className="px-3 py-2 font-mono text-xs text-subtle">
                {fa ? `${defaultPct}% × اهرم همان ارز` : `${defaultPct}% × that coin's lev`}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => onTiers([...tiers, nextBlankTier(tiers)])}
        >
          <Plus className="size-4" strokeWidth={1.75} />
          {fa ? "افزودن ردیف" : "Add row"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            onCapital(String(DEFAULT_CAPITAL_PCT));
            onTiers(DEFAULT_LEV_SIZE_TIERS.map((t) => ({ ...t })));
          }}
        >
          {fa ? "برگشت به پیش‌فرض" : "Reset defaults"}
        </Button>
      </div>

      {groups.length ? (
        <div className="grid gap-2">
          <p className="text-xs text-subtle">{fa ? "روی جهان ارز فعلی" : "On the current universe"}</p>
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => (
              <span
                key={g.key}
                className="rounded-sm border border-border bg-bg-elev px-2.5 py-1.5 font-mono text-xs tabular"
              >
                <span className="text-fg">{g.label}</span>
                <span className="text-subtle"> · {g.count}</span>
                <span className="text-muted"> · {g.pct}% → {g.notional}%</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function nextBlankTier(tiers: LevSizeTier[]): LevSizeTier {
  const used = new Set(tiers.map((t) => t.leverage));
  for (const n of [5, 10, 20, 25, 50, 75, 100, 125, 150, 200]) {
    if (!used.has(n)) return { leverage: n, capitalPct: DEFAULT_CAPITAL_PCT };
  }
  let n = 1;
  while (used.has(n) && n < 200) n += 1;
  return { leverage: n, capitalPct: DEFAULT_CAPITAL_PCT };
}

function groupUniverse(universe: Coin[], defaultPct: number, tiers: LevSizeTier[], otherLabel = "other") {
  const map = new Map<number, number>();
  let other = 0;
  for (const a of universe) {
    const lev = Math.round(Number(a.max_leverage) || 0);
    if (!(lev > 0)) continue;
    const matched = tiers.some((t) => t.leverage === lev);
    if (matched) map.set(lev, (map.get(lev) ?? 0) + 1);
    else other += 1;
  }
  const rows = [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lev, count]) => {
      const pct = capitalPctForLeverage(lev, defaultPct, tiers);
      return {
        key: String(lev),
        label: `${lev}x`,
        count,
        pct,
        notional: notionalPctOfEquity(pct, lev),
      };
    });
  if (other) {
    rows.push({
      key: "other",
      label: otherLabel,
      count: other,
      pct: defaultPct,
      notional: defaultPct,
    });
  }
  return rows;
}
