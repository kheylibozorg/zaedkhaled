import { Badge } from "@/components/ui/badge";
import { indicatorLabel } from "@/lib/engine/types";
import { useLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { fmtBarOpen, fmtPx, fmtR, fmtUsd, timeAgo } from "@/lib/utils";

function closedPnlUsd(r: { pnl_usd?: number | null; pnl_r?: number | null; risk_usd?: number | null }) {
  const usd = Number(r.pnl_usd);
  if (r.pnl_usd != null && Number.isFinite(usd)) return usd;
  const mult = Number(r.pnl_r);
  const risk = Number(r.risk_usd);
  if (Number.isFinite(mult) && Number.isFinite(risk) && risk > 0) return mult * risk;
  return null;
}

export function SideBadge({ side }: { side: string }) {
  const { t } = useLocale();
  const long = side === "long";
  return <Badge tone={long ? "long" : "short"}>{long ? t.long : t.short}</Badge>;
}

export function PositionsTable({
  rows,
  empty,
  onPick,
  pickedId,
}: {
  rows: Array<{
    id: number;
    symbol: string;
    timeframe: string;
    indicator: string;
    side: string;
    entry: number;
    sl: number;
    tp: number;
    leverage: number;
    opened_at: string;
    status: string;
    pnl_r?: number | null;
    pnl_usd?: number | null;
    risk_usd?: number | null;
    exit_reason?: string | null;
  }>;
  empty: string;
  onPick?: (id: number) => void;
  pickedId?: number | null;
}) {
  const { locale } = useLocale();
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[640px] text-start text-sm">
        <thead className="text-xs text-subtle">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-medium">Symbol</th>
            <th className="px-3 py-2 font-medium">TF</th>
            <th className="px-3 py-2 font-medium">Ind</th>
            <th className="px-3 py-2 font-medium">Side</th>
            <th className="px-3 py-2 font-medium">Entry</th>
            <th className="px-3 py-2 font-medium">SL</th>
            <th className="px-3 py-2 font-medium">TP</th>
            <th className="px-3 py-2 font-medium">Lev</th>
            <th className="px-3 py-2 font-medium">R</th>
            <th className="px-3 py-2 font-medium">{locale === "fa" ? "سود خالص" : "Net $"}</th>
            <th className="px-3 py-2 font-medium">{locale === "fa" ? "خروج" : "Out"}</th>
            <th className="px-3 py-2 font-medium">When</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular">
          {!rows.length ? (
            <tr>
              <td colSpan={12} className="px-3 py-8 text-sm text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const usd = closedPnlUsd(r);
              const win = r.status !== "closed" || (usd != null ? usd >= 0 : Number(r.pnl_r) >= 0);
              const active = pickedId === r.id;
              return (
                <tr
                  key={r.id}
                  className={cn(
                    "border-b border-border/60 transition-colors",
                    onPick ? "cursor-pointer hover:bg-surface-2" : "",
                    active ? "bg-surface-2" : "",
                  )}
                  onClick={onPick ? () => onPick(r.id) : undefined}
                >
                  <td className="px-3 py-2.5 text-fg">{r.symbol.replace("USDT", "")}</td>
                  <td className="px-3 py-2.5 text-muted">{r.timeframe}</td>
                  <td className="px-3 py-2.5 text-muted">{indicatorLabel(r.indicator)}</td>
                  <td className="px-3 py-2.5">
                    <SideBadge side={r.side} />
                  </td>
                  <td className="px-3 py-2.5">{fmtPx(Number(r.entry))}</td>
                  <td className="px-3 py-2.5 text-short">{fmtPx(Number(r.sl))}</td>
                  <td className="px-3 py-2.5 text-long">{fmtPx(Number(r.tp))}</td>
                  <td className="px-3 py-2.5">{r.leverage}x</td>
                  <td className={win ? "px-3 py-2.5 text-long" : "px-3 py-2.5 text-short"}>
                    {r.status === "closed" ? fmtR(Number(r.pnl_r)) : "—"}
                  </td>
                  <td className={win ? "px-3 py-2.5 text-long" : "px-3 py-2.5 text-short"}>
                    {r.status === "closed" && usd != null ? fmtUsd(usd) : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {r.status === "closed"
                      ? r.exit_reason === "excess trim"
                        ? locale === "fa"
                          ? "بستن مازاد"
                          : "excess trim"
                        : r.exit_reason || "—"
                      : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-subtle">{timeAgo(r.opened_at, locale)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function skipLabel(reason: string | null, fa: boolean) {
  const r = (reason ?? "").trim();
  if (!r) return fa ? "رد" : "skip";
  if (r === "stale bar") return fa ? "کندل قدیمی" : "old bar";
  if (r === "already in symbol") return fa ? "همین ارز باز است" : "already in symbol";
  if (r === "max positions") return fa ? "سقف پوزیشن" : "max positions";
  if (r === "htf cap") return fa ? "سقف ۱س و ۴س" : "1h/4h cap";
  if (r === "already filled") return fa ? "قبلاً گرفته شد" : "already filled";
  if (r === "already on venue") return fa ? "روی صرافی باز است" : "already on venue";
  if (r === "leverage over cap") return fa ? "اهرم بالاتر از سقف" : "leverage over cap";
  if (r === "margin over cap") return fa ? "مارجین بالاتر از سقف" : "margin over cap";
  if (r === "size failed") return fa ? "سایز نشد" : "size failed";
  if (r === "side muted") return fa ? "این سمت خاموش است" : "side muted";
  return r;
}

export function SignalsTable({
  rows,
  empty,
}: {
  rows: Array<{
    id: number;
    ts: string;
    bar_time?: number | string | null;
    symbol: string;
    timeframe: string;
    indicator: string;
    side: string;
    entry: number;
    sl: number;
    tp: number;
    rr: number;
    taken: number;
    skip_reason: string | null;
  }>;
  empty: string;
}) {
  const { locale } = useLocale();
  if (!rows.length) return <p className="px-1 py-8 text-sm text-muted">{empty}</p>;
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[640px] text-start text-sm">
        <thead className="text-xs text-subtle">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-medium">Symbol</th>
            <th className="px-3 py-2 font-medium">TF</th>
            <th className="px-3 py-2 font-medium">Ind</th>
            <th className="px-3 py-2 font-medium">Side</th>
            <th className="px-3 py-2 font-medium">Entry</th>
            <th className="px-3 py-2 font-medium">R:R</th>
            <th className="px-3 py-2 font-medium">Fill</th>
            <th className="px-3 py-2 font-medium">{locale === "fa" ? "کندل (UTC)" : "Candle UTC"}</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular">
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-border/60">
              <td className="px-3 py-2.5">{r.symbol.replace("USDT", "")}</td>
              <td className="px-3 py-2.5 text-muted">{r.timeframe}</td>
              <td className="px-3 py-2.5 text-muted">{indicatorLabel(r.indicator)}</td>
              <td className="px-3 py-2.5">
                <SideBadge side={r.side} />
              </td>
              <td className="px-3 py-2.5">{fmtPx(Number(r.entry))}</td>
              <td className="px-3 py-2.5">{Number(r.rr).toFixed(1)}</td>
              <td className="px-3 py-2.5">
                {r.taken ? (
                  <Badge tone="long">{locale === "fa" ? "گرفته شد" : "taken"}</Badge>
                ) : (
                  <span className="text-xs text-subtle">{skipLabel(r.skip_reason, locale === "fa")}</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-subtle">{fmtBarOpen(r.bar_time ?? r.ts)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function limitCancelLabel(reason: string | null | undefined, fa: boolean) {
  const r = (reason ?? "").trim();
  if (!r) return fa ? "لغو شد" : "cancelled";
  if (r === "max positions reached") return fa ? "سقف پوزیشن پر شد" : "max positions reached";
  if (r === "htf cap reached") return fa ? "سقف ۱س/۴س پر شد" : "1h/4h cap reached";
  if (r === "sl engulfed") return fa ? "اینگالف استاپ/منشا" : "SL engulfed";
  if (r === "target reached without RTP") return fa ? "تارگت بدون برگشت" : "TP hit without RTP";
  if (r === "pattern failed") return fa ? "فیل شدن الگو" : "pattern failed";
  if (r === "queue expired") return fa ? "انقضای صف انتظار" : "queue expired";
  if (r === "gate muted") return fa ? "موتور خاموش شد" : "gate muted";
  if (r === "duplicate symbol") return fa ? "تکرار نماد" : "duplicate symbol";
  if (r === "venue cancelled") return fa ? "لغو در صرافی" : "venue cancelled";
  if (r === "operator cancelled") return fa ? "لغو دستی" : "operator cancelled";
  if (r === "replaced by faster setup") return fa ? "جایگزین با فرصت سریع‌تر" : "replaced by faster setup";
  return r;
}

export function LimitOrdersTable({
  rows,
  empty,
  onCancel,
  cancellingId,
  unlocked = true,
}: {
  rows: Array<{
    id: number;
    symbol: string;
    timeframe: string;
    indicator: string;
    side: string;
    entry: number;
    sl: number;
    tp: number;
    rr: number;
    leverage: number;
    max_wait_bars: number;
    status: string;
    cancel_reason?: string | null;
    reason?: string | null;
    distance_atr?: number | null;
    created_at: string;
  }>;
  empty: string;
  onCancel?: (id: number) => void;
  cancellingId?: number | null;
  unlocked?: boolean;
}) {
  const { t, locale } = useLocale();
  const fa = locale === "fa";
  if (!rows.length) return <p className="px-1 py-6 text-sm text-muted">{empty}</p>;
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[740px] text-start text-sm">
        <thead className="text-xs text-subtle">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-medium">Symbol</th>
            <th className="px-3 py-2 font-medium">TF</th>
            <th className="px-3 py-2 font-medium">Ind</th>
            <th className="px-3 py-2 font-medium">Side</th>
            <th className="px-3 py-2 font-medium">{fa ? "لیمیت ورود" : "Limit"}</th>
            <th className="px-3 py-2 font-medium">SL</th>
            <th className="px-3 py-2 font-medium">TP</th>
            <th className="px-3 py-2 font-medium">{fa ? "فاصله" : "Dist"}</th>
            <th className="px-3 py-2 font-medium">TTL</th>
            <th className="px-3 py-2 font-medium">{fa ? "وضعیت" : "Status"}</th>
            <th className="px-3 py-2 font-medium">When</th>
            {onCancel ? <th className="px-3 py-2 font-medium"></th> : null}
          </tr>
        </thead>
        <tbody className="font-mono tabular">
          {rows.map((r) => {
            const isPending = r.status === "pending";
            const isWatch = r.status === "watch";
            const isFilled = r.status === "filled";
            const isPreArm = typeof r.reason === "string" && /pre-arm/i.test(r.reason);
            const dist = r.distance_atr != null && Number.isFinite(Number(r.distance_atr)) ? Number(r.distance_atr) : null;
            return (
              <tr key={r.id} className="border-b border-border/60">
                <td className="px-3 py-2.5 text-fg">{r.symbol.replace("USDT", "")}</td>
                <td className="px-3 py-2.5 text-muted">{r.timeframe}</td>
                <td className="px-3 py-2.5 text-muted">
                  <span>{indicatorLabel(r.indicator)}</span>
                  {isPreArm ? (
                    <span className="ms-1.5 text-[10px] font-sans uppercase tracking-wider text-accent">
                      {fa ? "پیش‌لیمیت" : "pre-arm"}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5">
                  <SideBadge side={r.side} />
                </td>
                <td className="px-3 py-2.5">{fmtPx(Number(r.entry))}</td>
                <td className="px-3 py-2.5 text-short">{fmtPx(Number(r.sl))}</td>
                <td className="px-3 py-2.5 text-long">{fmtPx(Number(r.tp))}</td>
                <td className="px-3 py-2.5 text-muted">{dist != null ? `${dist.toFixed(2)} ATR` : "—"}</td>
                <td className="px-3 py-2.5 text-muted">{r.max_wait_bars}b</td>
                <td className="px-3 py-2.5">
                  {isPending ? (
                    <Badge tone="warn">{t.limitStatusPending}</Badge>
                  ) : isWatch ? (
                    <Badge tone="fg">{t.limitStatusWatch}</Badge>
                  ) : isFilled ? (
                    <Badge tone="long">{t.limitStatusFilled}</Badge>
                  ) : (
                    <span className="text-xs text-subtle">{limitCancelLabel(r.cancel_reason, fa)}</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-subtle">{timeAgo(r.created_at, locale)}</td>
                {onCancel ? (
                  <td className="px-3 py-2.5 text-end">
                    {isPending || isWatch ? (
                      <button
                        type="button"
                        disabled={!unlocked || cancellingId === r.id}
                        onClick={() => onCancel(r.id)}
                        className="rounded-sm border border-border px-2 py-1 text-xs text-muted hover:border-border-strong hover:text-fg disabled:opacity-40"
                      >
                        {cancellingId === r.id ? "…" : t.cancelOrder}
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "long" | "short" | "fg";
}) {
  const color = tone === "long" ? "text-long" : tone === "short" ? "text-short" : "text-fg";
  const bar = tone === "long" ? "bg-long" : tone === "short" ? "bg-short" : "bg-border-strong";
  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-surface p-4 shadow-panel">
      <span className={`absolute inset-y-0 start-0 w-0.5 ${bar}`} />
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-2 font-mono text-2xl tabular tracking-tight ${color}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-subtle">{hint}</div> : null}
    </div>
  );
}

export { fmtUsd };
