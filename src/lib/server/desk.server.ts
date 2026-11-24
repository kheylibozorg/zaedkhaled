import { getDbSource, getSql, isServerlessRuntime } from "@/lib/db";
import { DEMO_JOURNAL } from "@/lib/engine/demo-journal";
import { DEFAULT_CAPITAL_PCT, parseCapitalBase, parseLevSizeTiers } from "@/lib/engine/lev-size";
import { clampLimitTtlBars, parseEntryMode } from "@/lib/engine/limit-queue";
import { clampMaxLimitQueue } from "@/lib/engine/smart-queue";
import { bookVenue } from "@/lib/exchanges/meta";
import { parseTelegramVenues } from "@/lib/telegram";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { persistSecret, SECRET_SETTING_KEYS, isSealedSecret, openSecret } from "./secrets";

export type SettingsRow = {
  id: number;
  mode: string;
  venue: string;
  risk_pct: number;
  capital_pct: number;
  min_leverage?: number | null;
  max_leverage?: number | null;
  stack_lev_count?: number | null;
  stack_lev_cap?: number | null;
  max_positions: number;
  htf_max_positions?: number | null;
  min_market_cap_usd: number;
  equity_usd: number;
  starting_equity_usd: number;
  live_enabled: number;
  bot_enabled: number;
  paper_24h: number;
  tick_token: string;
  scan_cursor: number;
  scan_batch: number;
  last_tick_at: string | null;
  last_tick_source?: string | null;
  scan_epoch_ms?: number | null;
  scan_done_5m?: number | null;
  scan_done_15m?: number | null;
  scan_done_1h?: number | null;
  scan_done_4h?: number | null;
  scan_cursors?: string | null;
  orphan_fills?: string | null;
  tick_lock_id?: string | null;
  lighter_api_key: string | null;
  lighter_api_private_key: string | null;
  lighter_account_index: number | null;
  lighter_api_key_index: number | null;
  aster_api_key: string | null;
  aster_api_secret: string | null;
  ourbit_api_key: string | null;
  ourbit_api_secret: string | null;
  hyperliquid_private_key: string | null;
  hyperliquid_wallet_address: string | null;
  operator_pin_hash: string | null;
  operator_pin_salt: string | null;
  operator_session: string | null;
  journal_seeded?: number | null;
  universe_venue?: string | null;
  engine_gates?: string | null;
  lev_size_tiers?: string | null;
  capital_base?: string | null;
  telegram_bot_token?: string | null;
  telegram_chat_id?: string | null;
  telegram_venues?: string | null;
  entry_mode?: string | null;
  safe_limit_mode?: number | null;
  limit_ttl_bars?: number | null;
  max_limit_queue?: number | null;
  auto_trim_excess?: number | null;
  updated_at: string;
};

function num(v: unknown, d = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

const TOKEN_DIR = join(process.cwd(), ".data");
const TOKEN_FILE = join(TOKEN_DIR, "desk-token");

function isPlaceholderToken(token: string | null | undefined) {
  const t = (token ?? "").trim();
  return !t || t === "change-me";
}

function readPinnedToken(): string | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (isPlaceholderToken(t)) return null;
    if (!/^[a-f0-9]{16,128}$/i.test(t)) return null;
    return t;
  } catch {
    return null;
  }
}

function pinToken(token: string) {
  if (isPlaceholderToken(token)) return;
  try {
    mkdirSync(TOKEN_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* Vercel is read-only — Neon holds the token */
  }
}

export function publicSettings(row: SettingsRow, opts?: { unlocked?: boolean }) {
  const unlocked = Boolean(opts?.unlocked);
  return {
    mode: row.mode as "paper" | "live",
    venue: bookVenue(row.venue) as "paper" | "hyperliquid" | "lighter" | "aster" | "ourbit",
    riskPct: num(row.risk_pct, 1),
    capitalPct: num(row.capital_pct, DEFAULT_CAPITAL_PCT),
    minLeverage: Math.min(
      Math.min(200, Math.max(1, Math.round(num(row.max_leverage, 200)))),
      Math.max(1, Math.round(num(row.min_leverage, 1))),
    ),
    maxLeverage: Math.min(200, Math.max(1, Math.round(num(row.max_leverage, 200)))),
    stackLevCount: Math.min(20, Math.max(0, Math.round(num(row.stack_lev_count, 2)))),
    stackLevCap: Math.min(200, Math.max(1, Math.round(num(row.stack_lev_cap, 75)))),
    levSizeTiers: parseLevSizeTiers(row.lev_size_tiers),
    capitalBase: parseCapitalBase(row.capital_base),
    maxPositions: num(row.max_positions, 4),
    htfMaxPositions: Math.min(20, Math.max(0, Math.round(num(row.htf_max_positions, 4)))),
    minMarketCapUsd: num(row.min_market_cap_usd, 0),
    equityUsd: num(row.equity_usd, 10000),
    availableUsd: num(row.equity_usd, 10000),
    startingEquityUsd: num(row.starting_equity_usd, 10000),
    liveEnabled: Boolean(num(row.live_enabled)),
    botEnabled: Boolean(num(row.bot_enabled, 1)),
    paper24h: Boolean(num(row.paper_24h, 1)),
    tickToken: unlocked ? row.tick_token : "",
    tokenIsDefault: isPlaceholderToken(row.tick_token),
    scanCursor: num(row.scan_cursor),
    scanBatch: num(row.scan_batch, 0),
    lastTickAt: row.last_tick_at,
    lastTickSource: row.last_tick_source ?? null,
    dbSource: getDbSource(),
    durable: getDbSource() === "neon",
    serverless: isServerlessRuntime(),
    hasLighter: Boolean(row.lighter_api_private_key || row.lighter_api_key),
    hasAster: (() => {
      const pk = (row.aster_api_secret ?? "").trim();
      if (/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) return true;
      return Boolean(row.aster_api_key && row.aster_api_secret);
    })(),
    hasOurbit: Boolean(row.ourbit_api_key && row.ourbit_api_secret),
    hasHyperliquid: Boolean(row.hyperliquid_private_key),
    lighterAccountIndex: unlocked ? row.lighter_account_index : null,
    lighterKeyIndex: unlocked ? row.lighter_api_key_index : null,
    lighterKeyHint: unlocked && row.lighter_api_key ? mask(row.lighter_api_key) : "",
    asterKeyHint: unlocked && row.aster_api_key ? mask(row.aster_api_key) : "",
    ourbitKeyHint: unlocked && row.ourbit_api_key ? mask(row.ourbit_api_key) : "",
    hyperliquidAddrHint: unlocked && row.hyperliquid_wallet_address ? mask(row.hyperliquid_wallet_address) : "",
    hyperliquidKeyHint: unlocked && row.hyperliquid_private_key ? mask(row.hyperliquid_private_key) : "",
    hasPin: Boolean(row.operator_pin_hash),
    unlocked,
    universeVenue: bookVenue(row.universe_venue),
    engineGates: row.engine_gates ?? "{}",
    hasTelegram: Boolean((row.telegram_bot_token ?? "").trim()),
    telegramTokenHint: unlocked && row.telegram_bot_token ? mask(row.telegram_bot_token) : "",
    telegramChatId: row.telegram_chat_id ?? "",
    telegramVenues: parseTelegramVenues(row.telegram_venues),
    entryMode: parseEntryMode(row.entry_mode),
    safeLimitMode: row.safe_limit_mode == null ? true : Boolean(num(row.safe_limit_mode, 1)),
    limitTtlBars: clampLimitTtlBars(row.limit_ttl_bars),
    maxLimitQueue: row.max_limit_queue == null ? 8 : clampMaxLimitQueue(row.max_limit_queue),
    autoTrimExcess: Boolean(num(row.auto_trim_excess, 0)),
  };
}

function mask(s: string) {
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

async function revealSecrets(row: SettingsRow): Promise<SettingsRow> {
  const sql = await getSql();
  const next = { ...row };
  for (const key of SECRET_SETTING_KEYS) {
    const raw = row[key];
    if (typeof raw !== "string" || !raw.trim()) {
      next[key] = null;
      continue;
    }
    if (!isSealedSecret(raw)) {
      try {
        await sql.query(`update desk_settings set ${key} = $1, updated_at = now() where id = 1`, [
          persistSecret(raw),
        ]);
      } catch {
        /* next read retries the seal */
      }
      next[key] = raw.trim();
      continue;
    }
    try {
      next[key] = openSecret(raw);
    } catch {
      next[key] = null;
    }
  }
  return next;
}

async function ensureTickHardeningColumns(sql: Awaited<ReturnType<typeof getSql>>) {
  const stmts = [
    "alter table desk_settings add column if not exists scan_cursors text not null default '{}'",
    "alter table desk_settings add column if not exists orphan_fills text not null default '[]'",
    "alter table desk_settings add column if not exists tick_lock_id text",
    "alter table desk_settings add column if not exists tick_lock_at timestamptz",
    "alter table desk_settings add column if not exists engine_gates text not null default '{}'",
    "alter table desk_settings add column if not exists ourbit_api_key text",
    "alter table desk_settings add column if not exists ourbit_api_secret text",
    "alter table desk_settings add column if not exists stack_lev_count integer not null default 2",
    "alter table desk_settings add column if not exists stack_lev_cap integer not null default 75",
    "alter table desk_settings add column if not exists lev_size_tiers text not null default '[{\"leverage\":5,\"capitalPct\":15},{\"leverage\":10,\"capitalPct\":12},{\"leverage\":25,\"capitalPct\":6}]'",
    "alter table desk_settings add column if not exists capital_base text not null default 'total'",
    "alter table desk_settings add column if not exists htf_max_positions integer not null default 4",
    "alter table desk_settings add column if not exists telegram_bot_token text",
    "alter table desk_settings add column if not exists telegram_chat_id text",
    "alter table desk_settings add column if not exists telegram_venues text not null default '{}'",
    "alter table desk_settings add column if not exists entry_mode text not null default 'limit'",
    "alter table desk_settings add column if not exists safe_limit_mode integer not null default 1",
    "alter table desk_settings add column if not exists limit_ttl_bars integer not null default 0",
    "alter table desk_settings add column if not exists max_limit_queue integer not null default 8",
    "alter table desk_settings add column if not exists auto_trim_excess integer not null default 0",
    "alter table desk_settings add column if not exists min_leverage integer not null default 1",
    "create table if not exists limit_orders (id serial primary key, mode text not null default 'paper', venue text not null default 'paper', symbol text not null, timeframe text not null, indicator text not null, side text not null, entry double precision not null, sl double precision not null, tp double precision not null, rr double precision not null, atr double precision, be_at_r double precision, qty double precision not null, leverage integer not null default 1, notional_usd double precision not null default 0, risk_usd double precision not null default 0, margin_usd double precision not null default 0, armed_bar_time bigint not null, ftc_wait integer not null default 8, max_wait_bars integer not null default 8, reason text, exchange_order_id text, status text not null default 'pending', cancel_reason text, distance_atr double precision, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), closed_at timestamptz)",
    "alter table limit_orders add column if not exists distance_atr double precision",
    "create unique index if not exists limit_orders_dedupe_idx on limit_orders (symbol, timeframe, indicator, armed_bar_time)",
    "create index if not exists limit_orders_status_idx on limit_orders (status, created_at desc)",
    "create index if not exists limit_orders_watch_idx on limit_orders (status, distance_atr asc, updated_at desc)",
    "alter table desk_settings alter column capital_pct set default 3",
    "alter table desk_settings alter column venue set default 'aster'",
  ];
  for (const ddl of stmts) {
    try {
      await sql.query(ddl);
    } catch {
      /* already present or migrate 0018 applies it */
    }
  }
  try {
    await sql.query(`update desk_settings set venue = 'ourbit' where venue = 'toobit'`);
    await sql.query(`update desk_settings set universe_venue = 'ourbit' where universe_venue = 'toobit'`);
  } catch {
    /* no row yet / already mapped */
  }
}

export async function getSettings(): Promise<SettingsRow> {
  const sql = await getSql();
  const rows = await sql<SettingsRow>`select * from desk_settings where id = 1`;
  let row = rows[0];
  if (!row) {
    await sql`insert into desk_settings (id) values (1) on conflict (id) do nothing`;
    const again = await sql<SettingsRow>`select * from desk_settings where id = 1`;
    row = again[0]!;
  }
  if (row.max_leverage == null) {
    try {
      await sql.query(
        "alter table desk_settings add column if not exists max_leverage integer not null default 200",
      );
      const again = await sql<SettingsRow>`select * from desk_settings where id = 1`;
      if (again[0]) row = again[0];
    } catch {
      /* migrate 0017 applies this; ignore if already present */
    }
  }
  await ensureTickHardeningColumns(sql);
  if (!("telegram_venues" in row) || !("entry_mode" in row) || !("max_limit_queue" in row) || !("auto_trim_excess" in row) || !("min_leverage" in row)) {
    const again = await sql<SettingsRow>`select * from desk_settings where id = 1`;
    if (again[0]) row = again[0];
  }
  // DESK_TOKEN never auto-rotates. The only writer of a new random token is
  // rotateTickToken() — the Always-on "Rotate token" button.
  const pinned = readPinnedToken();
  if (!isPlaceholderToken(row.tick_token)) {
    if (pinned !== row.tick_token) pinToken(row.tick_token);
    return revealSecrets(row);
  }
  if (pinned) {
    await sql`
      update desk_settings
      set tick_token = ${pinned}, updated_at = now()
      where id = 1 and (tick_token = 'change-me' or tick_token is null or tick_token = '')
    `;
    const again = await sql<SettingsRow>`select * from desk_settings where id = 1`;
    row = again[0]!;
  }
  return revealSecrets(row);
}

export async function rotateTickToken() {
  const sql = await getSql();
  await getSettings();
  const token = randomBytes(16).toString("hex");
  pinToken(token);
  await sql`update desk_settings set tick_token = ${token}, updated_at = now() where id = 1`;
  return getSettings();
}

export type SettingsPatch = Partial<{
  mode: string;
  venue: string;
  risk_pct: number;
  capital_pct: number;
  min_leverage: number;
  max_leverage: number;
  stack_lev_count: number;
  stack_lev_cap: number;
  lev_size_tiers: string;
  capital_base: string;
  max_positions: number;
  htf_max_positions: number;
  min_market_cap_usd: number;
  equity_usd: number;
  starting_equity_usd: number;
  live_enabled: number;
  bot_enabled: number;
  paper_24h: number;
  scan_batch: number;
  lighter_api_key: string | null;
  lighter_api_private_key: string | null;
  lighter_account_index: number | null;
  lighter_api_key_index: number | null;
  aster_api_key: string | null;
  aster_api_secret: string | null;
  ourbit_api_key: string | null;
  ourbit_api_secret: string | null;
  hyperliquid_private_key: string | null;
  hyperliquid_wallet_address: string | null;
  engine_gates: string;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  telegram_venues: string;
  entry_mode: string;
  safe_limit_mode: number;
  limit_ttl_bars: number;
  max_limit_queue: number;
  auto_trim_excess: number;
}>;

export async function patchSettings(patch: SettingsPatch) {
  const sql = await getSql();
  await getSettings();
  const allowed = new Set<keyof SettingsPatch>([
    "mode",
    "venue",
    "risk_pct",
    "capital_pct",
    "min_leverage",
    "max_leverage",
    "stack_lev_count",
    "stack_lev_cap",
    "lev_size_tiers",
    "capital_base",
    "max_positions",
    "htf_max_positions",
    "min_market_cap_usd",
    "equity_usd",
    "starting_equity_usd",
    "live_enabled",
    "bot_enabled",
    "paper_24h",
    "scan_batch",
    "lighter_api_key",
    "lighter_api_private_key",
    "lighter_account_index",
    "lighter_api_key_index",
    "aster_api_key",
    "aster_api_secret",
    "ourbit_api_key",
    "ourbit_api_secret",
    "hyperliquid_private_key",
    "hyperliquid_wallet_address",
    "engine_gates",
    "telegram_bot_token",
    "telegram_chat_id",
    "telegram_venues",
    "entry_mode",
    "safe_limit_mode",
    "limit_ttl_bars",
    "max_limit_queue",
    "auto_trim_excess",
  ]);
  const flags = new Set(["live_enabled", "bot_enabled", "paper_24h", "safe_limit_mode", "auto_trim_excess"]);
  const secretKeys = new Set<string>(SECRET_SETTING_KEYS);
  const entries = Object.entries(patch).filter(
    ([k, v]) => v !== undefined && allowed.has(k as keyof SettingsPatch),
  );
  if (!entries.length) return getSettings();
  for (const [k, raw] of entries) {
    const v = secretKeys.has(k)
      ? persistSecret(raw)
      : flags.has(k)
        ? raw
          ? 1
          : 0
        : raw;
    try {
      await sql.query(`update desk_settings set ${k} = $1, updated_at = now() where id = 1`, [v]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (flags.has(k) && /boolean|type/i.test(msg)) {
        await sql.query(`update desk_settings set ${k} = $1, updated_at = now() where id = 1`, [Boolean(v)]);
        continue;
      }
      if (/does not exist/i.test(msg)) continue;
      throw err;
    }
  }
  return getSettings();
}

export type PositionRow = {
  id: number;
  mode: string;
  venue: string;
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  qty: number;
  leverage: number;
  notional_usd: number;
  risk_usd: number;
  opened_at: string;
  closed_at: string | null;
  exit_px: number | null;
  exit_reason: string | null;
  pnl_usd: number | null;
  pnl_r: number | null;
  fees_usd: number;
  status: string;
  exchange_order_id: string | null;
  bar_time?: number | null;
  orig_sl?: number | null;
  mae_r?: number | null;
  mfe_r?: number | null;
  bars_held?: number | null;
  hold_ms?: number | null;
  signal_reason?: string | null;
  atr_at_entry?: number | null;
  be_moved?: number | null;
  equity_at_open?: number | null;
  rr_planned?: number | null;
  margin_usd?: number | null;
  notes?: string | null;
};

export type SignalRow = {
  id: number;
  ts: string;
  bar_time: number;
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  atr: number | null;
  reason: string | null;
  taken: number;
  skip_reason: string | null;
};

export async function listOpenPositions() {
  const sql = await getSql();
  const rows = await sql<PositionRow & { size?: number }>`
    select * from positions where status = 'open' order by opened_at desc
  `;
  return rows.map((r) => ({
    ...r,
    qty: Number(r.qty ?? r.size ?? 0),
  }));
}

export async function listBarFills(sinceBarTime: number) {
  const sql = await getSql();
  try {
    return await sql<{ symbol: string; timeframe: string; bar_time: number }>`
      select symbol, timeframe, bar_time from positions
      where bar_time is not null and bar_time <> 0 and bar_time >= ${sinceBarTime}
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/bar_time|does not exist/i.test(msg)) return [];
    throw err;
  }
}

export async function listClosedPositions(limit = 80) {
  const sql = await getSql();
  const rows = await sql<PositionRow & { size?: number }>`
    select * from positions where status = 'closed' order by closed_at desc limit ${limit}
  `;
  return rows.map((r) => ({
    ...r,
    qty: Number(r.qty ?? r.size ?? 0),
  }));
}

export async function listSignals(limit = 80) {
  const sql = await getSql();
  return sql<SignalRow>`select * from signals order by ts desc limit ${limit}`;
}

export async function listEquity(limit = 120) {
  const sql = await getSql();
  return sql<{ ts: string; equity_usd: number; open_count: number; mode: string }>`
    select ts, equity_usd, open_count, mode from equity_snapshots order by ts desc limit ${limit}
  `;
}

export async function listScanLog(limit = 20) {
  const sql = await getSql();
  return sql<{
    ts: string;
    scanned: number;
    signals: number;
    opened: number;
    closed: number;
    duration_ms: number;
    note: string | null;
    source: string | null;
  }>`
    select ts, scanned, signals, opened, closed, duration_ms, note, source from scan_log order by ts desc limit ${limit}
  `;
}

export async function listUniverse() {
  const sql = await getSql();
  try {
    return await sql<{
      symbol: string;
      base: string;
      name: string;
      market_cap_usd: number;
      volume_24h_usd: number;
      max_leverage: number;
      venue_symbol: string | null;
    }>`select symbol, base, name, market_cap_usd, volume_24h_usd, max_leverage, venue_symbol from universe_assets order by market_cap_usd desc`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/venue_symbol|does not exist/i.test(msg)) throw err;
    const rows = await sql<{
      symbol: string;
      base: string;
      name: string;
      market_cap_usd: number;
      volume_24h_usd: number;
      max_leverage: number;
    }>`select symbol, base, name, market_cap_usd, volume_24h_usd, max_leverage from universe_assets order by market_cap_usd desc`;
    return rows.map((r) => ({ ...r, venue_symbol: null as string | null }));
  }
}

export async function setUniverseVenue(venue: string) {
  const sql = await getSql();
  try {
    await sql.query(`update desk_settings set universe_venue = $1, updated_at = now() where id = 1`, [venue || null]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not exist/i.test(msg)) return;
    throw err;
  }
}

export async function clearUniverse() {
  const sql = await getSql();
  await sql.query(`delete from universe_assets`);
}

export async function replaceUniverse(
  rows: Array<{
    symbol: string;
    base: string;
    name: string;
    marketCapUsd: number;
    volume24hUsd: number;
    maxLeverage: number;
    venueSymbol?: string;
  }>,
) {
  if (!rows.length) return;
  const sql = await getSql();
  const CHUNK = 80;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((r, idx) => {
      const lev = Math.max(1, Math.round(Number(r.maxLeverage) || 1));
      const base = idx * 7;
      values.push(r.symbol, r.base, r.name, r.marketCapUsd, r.volume24hUsd, lev, r.venueSymbol ?? r.symbol);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    });
    await sql.query(
      `insert into universe_assets (symbol, base, name, market_cap_usd, volume_24h_usd, max_leverage, venue_symbol)
       values ${tuples.join(", ")}
       on conflict (symbol) do update set
         base = excluded.base,
         name = excluded.name,
         market_cap_usd = excluded.market_cap_usd,
         volume_24h_usd = excluded.volume_24h_usd,
         max_leverage = excluded.max_leverage,
         venue_symbol = excluded.venue_symbol,
         updated_at = now()`,
      values,
    );
  }
  const keep = rows.map((r) => r.symbol);
  const placeholders = keep.map((_, i) => `$${i + 1}`).join(", ");
  await sql.query(`delete from universe_assets where symbol not in (${placeholders})`, keep);
}

export async function insertSignal(s: {
  barTime: number;
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  atr: number;
  reason: string;
  taken: boolean;
  skipReason?: string;
}) {
  const sql = await getSql();
  const existing = await sql<{ id: number }>`
    select id from signals
    where symbol = ${s.symbol}
      and timeframe = ${s.timeframe}
      and indicator = ${s.indicator}
      and bar_time = ${s.barTime}
    limit 1
  `;
  if (existing[0]) return { id: existing[0].id, created: false };
  try {
    const rows = await sql<{ id: number }>`
      insert into signals (bar_time, symbol, timeframe, indicator, side, entry, sl, tp, rr, atr, reason, taken, skip_reason)
      values (${s.barTime}, ${s.symbol}, ${s.timeframe}, ${s.indicator}, ${s.side}, ${s.entry}, ${s.sl}, ${s.tp}, ${s.rr}, ${s.atr}, ${s.reason}, ${s.taken ? 1 : 0}, ${s.skipReason ?? null})
      returning id
    `;
    return { id: rows[0]?.id ?? 0, created: Boolean(rows[0]) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique constraint|signals_dedupe/i.test(msg)) {
      const again = await sql<{ id: number }>`
        select id from signals
        where symbol = ${s.symbol}
          and timeframe = ${s.timeframe}
          and indicator = ${s.indicator}
          and bar_time = ${s.barTime}
        limit 1
      `;
      return { id: again[0]?.id ?? 0, created: false };
    }
    throw err;
  }
}

export async function alreadyFilled(opts: {
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  barTime: number;
}) {
  const sql = await getSql();
  try {
    const byBar = await sql<{ id: number }>`
      select id from positions
      where symbol = ${opts.symbol}
        and timeframe = ${opts.timeframe}
        and bar_time = ${opts.barTime}
      limit 1
    `;
    if (byBar[0]) return true;
    const byEntry = await sql<{ id: number }>`
      select id from positions
      where symbol = ${opts.symbol}
        and timeframe = ${opts.timeframe}
        and indicator = ${opts.indicator}
        and side = ${opts.side}
        and (bar_time is null or bar_time = 0)
        and abs(entry - ${opts.entry}) < ${Math.max(1e-10, Math.abs(opts.entry) * 1e-8)}
      limit 1
    `;
    return Boolean(byEntry[0]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/bar_time|does not exist/i.test(msg)) return false;
    throw err;
  }
}

export function tickLockStaleMs() {
  // Must outlive a still-running tick (heartbeat miss) but expire before the next minute cron.
  if (process.env.VERCEL) return 20_000;
  return 55_000;
}

export async function acquireTickLock() {
  const sql = await getSql();
  await ensureTickHardeningColumns(sql);
  const token = randomBytes(12).toString("hex");
  const staleMs = tickLockStaleMs();
  try {
    const rows = await sql<{ id: number }>`
      update desk_settings
      set tick_lock_at = now(), tick_lock_id = ${token}
      where id = 1
        and (
          tick_lock_id is null
          or tick_lock_at is null
          or tick_lock_at < now() - (${staleMs}::int * interval '1 millisecond')
        )
      returning id
    `;
    if (rows[0]) return token;
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/tick_lock_id|tick_lock_at|does not exist/i.test(msg)) return null;
    throw err;
  }
}

export async function heartbeatTickLock(token: string) {
  if (!token) return false;
  const sql = await getSql();
  try {
    const rows = await sql<{ id: number }>`
      update desk_settings
      set tick_lock_at = now()
      where id = 1 and tick_lock_id = ${token}
      returning id
    `;
    return Boolean(rows[0]);
  } catch {
    return false;
  }
}

export async function releaseTickLock(token: string) {
  if (!token) return;
  const sql = await getSql();
  try {
    await sql`
      update desk_settings
      set tick_lock_at = null, tick_lock_id = null
      where id = 1 and tick_lock_id = ${token}
    `;
  } catch {
    /* never clear another tick's lock */
  }
}

export async function insertPosition(p: {
  mode: string;
  venue: string;
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  qty: number;
  leverage: number;
  notional: number;
  risk: number;
  fees: number;
  orderId?: string;
  barTime?: number;
  openedAt?: string;
  origSl?: number;
  signalReason?: string;
  atr?: number;
  equityAtOpen?: number;
  rrPlanned?: number;
  margin?: number;
}) {
  const sql = await getSql();
  const barTime = p.barTime && p.barTime > 0 ? p.barTime : null;
  const openedAt = p.openedAt ?? null;
  let id = 0;
  try {
    const rows = openedAt
      ? await sql<{ id: number }>`
          insert into positions (mode, venue, symbol, timeframe, indicator, side, entry, sl, tp, qty, size, leverage, notional_usd, risk_usd, fees_usd, exchange_order_id, status, bar_time, opened_at)
          values (${p.mode}, ${p.venue}, ${p.symbol}, ${p.timeframe}, ${p.indicator}, ${p.side}, ${p.entry}, ${p.sl}, ${p.tp}, ${p.qty}, ${p.qty}, ${p.leverage}, ${p.notional}, ${p.risk}, ${p.fees}, ${p.orderId ?? null}, 'open', ${barTime}, ${openedAt}::timestamptz)
          returning id
        `
      : await sql<{ id: number }>`
          insert into positions (mode, venue, symbol, timeframe, indicator, side, entry, sl, tp, qty, size, leverage, notional_usd, risk_usd, fees_usd, exchange_order_id, status, bar_time)
          values (${p.mode}, ${p.venue}, ${p.symbol}, ${p.timeframe}, ${p.indicator}, ${p.side}, ${p.entry}, ${p.sl}, ${p.tp}, ${p.qty}, ${p.qty}, ${p.leverage}, ${p.notional}, ${p.risk}, ${p.fees}, ${p.orderId ?? null}, 'open', ${barTime})
          returning id
        `;
    id = rows[0]?.id ?? 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique constraint|positions_dedupe/i.test(msg)) return 0;
    if (!/column "size"|column "bar_time"/i.test(msg)) throw err;
    try {
      const rows = openedAt
        ? await sql<{ id: number }>`
            insert into positions (mode, venue, symbol, timeframe, indicator, side, entry, sl, tp, qty, leverage, notional_usd, risk_usd, fees_usd, exchange_order_id, status, bar_time, opened_at)
            values (${p.mode}, ${p.venue}, ${p.symbol}, ${p.timeframe}, ${p.indicator}, ${p.side}, ${p.entry}, ${p.sl}, ${p.tp}, ${p.qty}, ${p.leverage}, ${p.notional}, ${p.risk}, ${p.fees}, ${p.orderId ?? null}, 'open', ${barTime}, ${openedAt}::timestamptz)
            returning id
          `
        : await sql<{ id: number }>`
            insert into positions (mode, venue, symbol, timeframe, indicator, side, entry, sl, tp, qty, leverage, notional_usd, risk_usd, fees_usd, exchange_order_id, status, bar_time)
            values (${p.mode}, ${p.venue}, ${p.symbol}, ${p.timeframe}, ${p.indicator}, ${p.side}, ${p.entry}, ${p.sl}, ${p.tp}, ${p.qty}, ${p.leverage}, ${p.notional}, ${p.risk}, ${p.fees}, ${p.orderId ?? null}, 'open', ${barTime})
            returning id
          `;
      id = rows[0]?.id ?? 0;
    } catch (err2) {
      const msg2 = err2 instanceof Error ? err2.message : String(err2);
      if (/duplicate key|unique constraint|positions_dedupe/i.test(msg2)) return 0;
      if (!/column "bar_time"/i.test(msg2)) throw err2;
      const rows = await sql<{ id: number }>`
        insert into positions (mode, venue, symbol, timeframe, indicator, side, entry, sl, tp, qty, leverage, notional_usd, risk_usd, fees_usd, exchange_order_id, status)
        values (${p.mode}, ${p.venue}, ${p.symbol}, ${p.timeframe}, ${p.indicator}, ${p.side}, ${p.entry}, ${p.sl}, ${p.tp}, ${p.qty}, ${p.leverage}, ${p.notional}, ${p.risk}, ${p.fees}, ${p.orderId ?? null}, 'open')
        returning id
      `;
      id = rows[0]?.id ?? 0;
    }
  }
  if (id) await stampPositionMeta(id, p);
  return id;
}

async function stampPositionMeta(
  id: number,
  p: {
    sl: number;
    origSl?: number;
    signalReason?: string;
    atr?: number;
    equityAtOpen?: number;
    rrPlanned?: number;
    margin?: number;
  },
) {
  const sql = await getSql();
  try {
    await sql`
      update positions
      set orig_sl = ${p.origSl ?? p.sl},
          signal_reason = ${p.signalReason ?? null},
          atr_at_entry = ${p.atr ?? null},
          equity_at_open = ${p.equityAtOpen ?? null},
          rr_planned = ${p.rrPlanned ?? null},
          margin_usd = ${p.margin ?? null}
      where id = ${id}
    `;
  } catch {
    /* journal columns may be missing until migrate */
  }
}

export async function closePosition(
  id: number,
  exit: number,
  reason: string,
  pnl: number,
  pnlR: number,
  extra?: {
    maeR?: number | null;
    mfeR?: number | null;
    barsHeld?: number | null;
    holdMs?: number | null;
    beMoved?: boolean;
    feesUsd?: number | null;
  },
) {
  const sql = await getSql();
  await sql`
    update positions
    set status = 'closed', closed_at = now(), exit_px = ${exit}, exit_reason = ${reason}, pnl_usd = ${pnl}, pnl_r = ${pnlR}
    where id = ${id} and status = 'open'
  `;
  if (extra?.feesUsd != null && Number.isFinite(extra.feesUsd)) {
    try {
      await sql`update positions set fees_usd = ${extra.feesUsd} where id = ${id}`;
    } catch {
      /* fees column always exists; ignore if the row already closed */
    }
  }
  if (!extra) return;
  try {
    await sql`
      update positions
      set mae_r = ${extra.maeR ?? null},
          mfe_r = ${extra.mfeR ?? null},
          bars_held = ${extra.barsHeld ?? null},
          hold_ms = ${extra.holdMs ?? null},
          be_moved = ${extra.beMoved ? 1 : 0}
      where id = ${id}
    `;
  } catch {
    /* journal columns may be missing until migrate */
  }
}

export type LimitOrderRow = {
  id: number;
  mode: string;
  venue: string;
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  atr: number | null;
  be_at_r: number | null;
  qty: number;
  leverage: number;
  notional_usd: number;
  risk_usd: number;
  margin_usd: number;
  armed_bar_time: number;
  ftc_wait: number;
  max_wait_bars: number;
  reason: string | null;
  exchange_order_id: string | null;
  status: string;
  cancel_reason: string | null;
  distance_atr?: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export async function listPendingLimitOrders(): Promise<LimitOrderRow[]> {
  const sql = await getSql();
  await ensureTickHardeningColumns(sql);
  try {
    return await sql<LimitOrderRow>`
      select * from limit_orders where status = 'pending' order by coalesce(distance_atr, 999) asc, created_at asc, id asc
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/limit_orders|does not exist/i.test(msg)) return [];
    throw err;
  }
}

export async function listWatchLimitOrders(): Promise<LimitOrderRow[]> {
  const sql = await getSql();
  await ensureTickHardeningColumns(sql);
  try {
    return await sql<LimitOrderRow>`
      select * from limit_orders where status = 'watch' order by coalesce(distance_atr, 999) asc, updated_at desc, id asc
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/limit_orders|does not exist/i.test(msg)) return [];
    throw err;
  }
}

export async function listRecentLimitOrders(limit = 60): Promise<LimitOrderRow[]> {
  const sql = await getSql();
  await ensureTickHardeningColumns(sql);
  try {
    return await sql<LimitOrderRow>`
      select * from limit_orders
      order by
        case when status = 'pending' then 0 when status = 'watch' then 1 else 2 end asc,
        case when status in ('pending', 'watch') then coalesce(distance_atr, 999) else 0 end asc,
        updated_at desc,
        id desc
      limit ${limit}
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/limit_orders|does not exist/i.test(msg)) return [];
    throw err;
  }
}

export async function getLimitOrderById(id: number): Promise<LimitOrderRow | null> {
  const sql = await getSql();
  await ensureTickHardeningColumns(sql);
  const rows = await sql<LimitOrderRow>`select * from limit_orders where id = ${id} limit 1`;
  return rows[0] ?? null;
}

export async function insertLimitOrder(o: {
  mode: string;
  venue: string;
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  atr: number;
  beAtR?: number | null;
  qty: number;
  leverage: number;
  notionalUsd: number;
  riskUsd: number;
  marginUsd: number;
  armedBarTime: number;
  ftcWait: number;
  maxWaitBars: number;
  reason: string;
  exchangeOrderId?: string | null;
  distanceAtr?: number | null;
}): Promise<{ id: number; created: boolean }> {
  const sql = await getSql();
  await ensureTickHardeningColumns(sql);
  try {
    // Clean any internal bot watch rows for the same symbol so pending supersedes watch cleanly.
    await sql`delete from limit_orders where symbol = ${o.symbol} and status = 'watch'`;
    const rows = await sql<{ id: number }>`
      insert into limit_orders (
        mode, venue, symbol, timeframe, indicator, side, entry, sl, tp, rr, atr, be_at_r,
        qty, leverage, notional_usd, risk_usd, margin_usd, armed_bar_time, ftc_wait, max_wait_bars,
        reason, exchange_order_id, distance_atr, status
      )
      values (
        ${o.mode}, ${o.venue}, ${o.symbol}, ${o.timeframe}, ${o.indicator}, ${o.side},
        ${o.entry}, ${o.sl}, ${o.tp}, ${o.rr}, ${o.atr}, ${o.beAtR ?? null},
        ${o.qty}, ${o.leverage}, ${o.notionalUsd}, ${o.riskUsd}, ${o.marginUsd},
        ${o.armedBarTime}, ${o.ftcWait}, ${o.maxWaitBars},
        ${o.reason}, ${o.exchangeOrderId ?? null}, ${o.distanceAtr ?? null}, 'pending'
      )
      on conflict (symbol, timeframe, indicator, armed_bar_time) do nothing
      returning id
    `;
    if (rows[0]?.id) return { id: rows[0].id, created: true };
    const existing = await sql<{ id: number }>`
      select id from limit_orders
      where symbol = ${o.symbol}
        and timeframe = ${o.timeframe}
        and indicator = ${o.indicator}
        and armed_bar_time = ${o.armedBarTime}
      limit 1
    `;
    return { id: existing[0]?.id ?? 0, created: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique constraint|limit_orders_dedupe/i.test(msg)) {
      return { id: 0, created: false };
    }
    throw err;
  }
}

export async function upsertWatchLimitOrder(o: {
  mode: string;
  venue: string;
  symbol: string;
  timeframe: string;
  indicator: string;
  side: string;
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  atr: number;
  beAtR?: number | null;
  qty: number;
  leverage: number;
  notionalUsd: number;
  riskUsd: number;
  marginUsd: number;
  armedBarTime: number;
  ftcWait: number;
  maxWaitBars: number;
  reason: string;
  distanceAtr?: number | null;
}): Promise<{ id: number; saved: boolean }> {
  const sql = await getSql();
  await ensureTickHardeningColumns(sql);
  try {
    await sql`
      delete from limit_orders
      where symbol = ${o.symbol}
        and status = 'watch'
        and (timeframe <> ${o.timeframe} or indicator <> ${o.indicator} or armed_bar_time <> ${o.armedBarTime})
    `;
    const rows = await sql<{ id: number }>`
      insert into limit_orders (
        mode, venue, symbol, timeframe, indicator, side, entry, sl, tp, rr, atr, be_at_r,
        qty, leverage, notional_usd, risk_usd, margin_usd, armed_bar_time, ftc_wait, max_wait_bars,
        reason, distance_atr, status
      )
      values (
        ${o.mode}, ${o.venue}, ${o.symbol}, ${o.timeframe}, ${o.indicator}, ${o.side},
        ${o.entry}, ${o.sl}, ${o.tp}, ${o.rr}, ${o.atr}, ${o.beAtR ?? null},
        ${o.qty}, ${o.leverage}, ${o.notionalUsd}, ${o.riskUsd}, ${o.marginUsd},
        ${o.armedBarTime}, ${o.ftcWait}, ${o.maxWaitBars},
        ${o.reason}, ${o.distanceAtr ?? null}, 'watch'
      )
      on conflict (symbol, timeframe, indicator, armed_bar_time) do update set
        mode = excluded.mode,
        venue = excluded.venue,
        side = excluded.side,
        entry = excluded.entry,
        sl = excluded.sl,
        tp = excluded.tp,
        rr = excluded.rr,
        atr = excluded.atr,
        be_at_r = excluded.be_at_r,
        qty = excluded.qty,
        leverage = excluded.leverage,
        notional_usd = excluded.notional_usd,
        risk_usd = excluded.risk_usd,
        margin_usd = excluded.margin_usd,
        ftc_wait = excluded.ftc_wait,
        max_wait_bars = excluded.max_wait_bars,
        reason = excluded.reason,
        distance_atr = excluded.distance_atr,
        updated_at = now()
      where limit_orders.status = 'watch'
      returning id
    `;
    return { id: rows[0]?.id ?? 0, saved: Boolean(rows[0]?.id) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|unique constraint|limit_orders_dedupe/i.test(msg)) {
      return { id: 0, saved: false };
    }
    throw err;
  }
}

export async function promoteWatchLimitOrder(
  id: number,
  u: {
    entry: number;
    sl: number;
    tp: number;
    rr: number;
    atr: number;
    qty: number;
    leverage: number;
    notionalUsd: number;
    riskUsd: number;
    marginUsd: number;
    maxWaitBars: number;
    reason: string;
    distanceAtr?: number | null;
    exchangeOrderId?: string | null;
  },
): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql<{ id: number }>`
    update limit_orders
    set status = 'pending',
        entry = ${u.entry},
        sl = ${u.sl},
        tp = ${u.tp},
        rr = ${u.rr},
        atr = ${u.atr},
        qty = ${u.qty},
        leverage = ${u.leverage},
        notional_usd = ${u.notionalUsd},
        risk_usd = ${u.riskUsd},
        margin_usd = ${u.marginUsd},
        max_wait_bars = ${u.maxWaitBars},
        reason = ${u.reason},
        distance_atr = ${u.distanceAtr ?? null},
        exchange_order_id = ${u.exchangeOrderId ?? null},
        updated_at = now()
    where id = ${id} and status = 'watch'
    returning id
  `;
  return Boolean(rows[0]?.id);
}

export async function demoteLimitOrderToWatch(id: number, distanceAtr?: number | null): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql<{ id: number }>`
    update limit_orders
    set status = 'watch',
        exchange_order_id = null,
        distance_atr = coalesce(${distanceAtr ?? null}, distance_atr),
        updated_at = now()
    where id = ${id} and status = 'pending'
    returning id
  `;
  return Boolean(rows[0]?.id);
}

export async function updateLimitOrderDistance(id: number, distanceAtr: number) {
  const sql = await getSql();
  await sql`
    update limit_orders
    set distance_atr = ${distanceAtr}, updated_at = now()
    where id = ${id} and status in ('pending', 'watch')
  `;
}

export async function trimWatchQueueExcess(maxKeep = 40) {
  const sql = await getSql();
  const rows = await sql<{ id: number }>`
    select id from limit_orders
    where status = 'watch'
    order by coalesce(distance_atr, 999) asc, updated_at desc, id asc
    offset ${maxKeep}
  `;
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  await sql.query(`delete from limit_orders where status = 'watch' and id in (${placeholders})`, ids);
}

export async function markLimitOrderFilled(id: number, extra?: { exchangeOrderId?: string | null }) {
  const sql = await getSql();
  await sql`
    update limit_orders
    set status = 'filled',
        cancel_reason = null,
        exchange_order_id = coalesce(${extra?.exchangeOrderId ?? null}, exchange_order_id),
        updated_at = now(),
        closed_at = now()
    where id = ${id} and status in ('pending', 'watch')
  `;
}

export async function cancelLimitOrder(id: number, reason: string) {
  const sql = await getSql();
  await sql`
    update limit_orders
    set status = 'cancelled',
        cancel_reason = ${reason},
        updated_at = now(),
        closed_at = now()
    where id = ${id} and status in ('pending', 'watch')
  `;
}

export async function cancelAllPendingLimitOrders(reason: string, scope?: { mode?: string }) {
  const sql = await getSql();
  if (scope?.mode) {
    await sql`
      update limit_orders
      set status = 'cancelled',
          cancel_reason = ${reason},
          updated_at = now(),
          closed_at = now()
      where status = 'pending' and mode = ${scope.mode}
    `;
    return;
  }
  await sql`
    update limit_orders
    set status = 'cancelled',
        cancel_reason = ${reason},
        updated_at = now(),
        closed_at = now()
    where status = 'pending'
  `;
}

export async function resetJournal(scope: "closed" | "paper") {
  const sql = await getSql();
  if (scope === "paper") {
    await sql`delete from positions where mode = 'paper' or venue = 'paper'`;
    try {
      await sql`delete from limit_orders where mode = 'paper' or venue = 'paper'`;
    } catch {
      /* table may not exist in an old schema */
    }
  } else {
    await sql`delete from positions where status = 'closed'`;
  }
  await sql`delete from signals`;
  await sql`delete from scan_log`;
  await sql`delete from equity_snapshots`;
  await sql`delete from backtests`;
  const row = await getSettings();
  const start = num(row.starting_equity_usd, 10000);
  try {
    await sql`
      update desk_settings
      set equity_usd = ${start}, scan_cursor = 0, journal_seeded = 1, updated_at = now()
      where id = 1
    `;
  } catch {
    await sql`
      update desk_settings
      set equity_usd = ${start}, scan_cursor = 0, updated_at = now()
      where id = 1
    `;
  }
  const open = await sql<{ n: number }>`select count(*)::int as n from positions where status = 'open'`;
  await sql`
    insert into equity_snapshots (equity_usd, open_count, mode)
    values (${start}, ${num(open[0]?.n)}, 'paper')
  `;
  return { ok: true as const, equity: start, open: num(open[0]?.n), scope };
}

export async function saveTradeNote(id: number, notes: string) {
  const sql = await getSql();
  const text = notes.slice(0, 2000);
  await sql`update positions set notes = ${text || null} where id = ${id}`;
  return { ok: true as const, id };
}

export async function maybeSeedJournal() {
  const sql = await getSql();
  const n = await sql<{ n: number }>`select count(*)::int as n from positions`;
  if (num(n[0]?.n) > 0) return { ok: true as const, seeded: 0, skipped: true as const };
  const row = await getSettings();
  if (num(row.journal_seeded) > 0) return { ok: true as const, seeded: 0, skipped: true as const };
  return seedDemoJournal();
}

export async function seedDemoJournal() {
  const sql = await getSql();
  const existing = await sql<{ n: number }>`select count(*)::int as n from positions`;
  if (num(existing[0]?.n) > 0) return { ok: true as const, seeded: 0, skipped: true as const };

  const start = num((await getSettings()).starting_equity_usd, 10000);
  const t0 = Date.now();
  let equity = start;
  let seeded = 0;
  try {
    await sql`delete from equity_snapshots`;
  } catch {
    /* ignore */
  }
  await sql`
    insert into equity_snapshots (ts, equity_usd, open_count, mode)
    values (${new Date(t0 - 20 * 3600_000).toISOString()}, ${start}, 0, 'paper')
  `;

  for (const t of DEMO_JOURNAL) {
    const opened = new Date(t0 - t.openedOffsetH * 3600_000).toISOString();
    const closed = t.status === "closed" ? new Date(t0 - (t.openedOffsetH - t.holdH) * 3600_000).toISOString() : null;
    const id = await insertPosition({
      mode: "paper",
      venue: "paper",
      symbol: t.symbol,
      timeframe: t.timeframe,
      indicator: t.indicator,
      side: t.side,
      entry: t.entry,
      sl: t.sl,
      tp: t.tp,
      qty: t.qty,
      leverage: t.leverage,
      notional: t.notional,
      risk: t.risk,
      fees: t.fees,
      barTime: Date.parse(opened),
      origSl: t.sl,
      signalReason: t.reason,
      atr: t.atr,
      equityAtOpen: equity,
      rrPlanned: t.rr,
      margin: t.notional / Math.max(1, t.leverage),
    });
    if (!id) continue;
    if (t.status === "closed" && t.exit != null && t.exitReason && t.pnl != null && t.pnlR != null) {
      await closePosition(id, t.exit, t.exitReason, t.pnl, t.pnlR, {
        maeR: t.maeR,
        mfeR: t.mfeR,
        barsHeld: t.barsHeld,
        holdMs: Math.round(t.holdH * 3600_000),
        beMoved: Boolean(t.beMoved),
      });
      equity += t.pnl;
      try {
        await sql`
          update positions
          set opened_at = ${opened}, closed_at = ${closed}, notes = ${t.notes ?? null}
          where id = ${id}
        `;
      } catch {
        await sql`update positions set opened_at = ${opened}, closed_at = ${closed} where id = ${id}`;
      }
      await sql`
        insert into equity_snapshots (ts, equity_usd, open_count, mode)
        values (${closed}, ${equity}, 0, 'paper')
      `;
    } else {
      try {
        await sql`update positions set opened_at = ${opened}, notes = ${t.notes ?? null} where id = ${id}`;
      } catch {
        await sql`update positions set opened_at = ${opened} where id = ${id}`;
      }
    }
    seeded += 1;
  }

  try {
    await sql`
      update desk_settings
      set equity_usd = ${equity}, journal_seeded = 1, updated_at = now()
      where id = 1
    `;
  } catch {
    await sql`update desk_settings set equity_usd = ${equity}, updated_at = now() where id = 1`;
  }
  return { ok: true as const, seeded, skipped: false as const, equity };
}

export async function updatePositionSl(id: number, sl: number) {
  const sql = await getSql();
  await sql`update positions set sl = ${sl} where id = ${id} and status = 'open'`;
}

export async function bumpEquity(delta: number) {
  const sql = await getSql();
  await sql`update desk_settings set equity_usd = equity_usd + ${delta}, updated_at = now() where id = 1`;
}

export async function setEquity(equity: number) {
  if (!Number.isFinite(equity)) return;
  const sql = await getSql();
  await sql`update desk_settings set equity_usd = ${equity}, updated_at = now() where id = 1`;
}

export async function snapshotEquity(equity: number, openCount: number, mode: string) {
  const sql = await getSql();
  await sql`insert into equity_snapshots (equity_usd, open_count, mode) values (${equity}, ${openCount}, ${mode})`;
}

export async function touchTick(source: string) {
  const sql = await getSql();
  await sql`update desk_settings set last_tick_at = now(), last_tick_source = ${source} where id = 1`;
}

export async function logScan(
  scanned: number,
  signals: number,
  opened: number,
  closed: number,
  ms: number,
  note: string,
  source = "manual",
  opts?: { touch?: boolean },
) {
  const sql = await getSql();
  await sql`
    insert into scan_log (scanned, signals, opened, closed, duration_ms, note, source)
    values (${scanned}, ${signals}, ${opened}, ${closed}, ${ms}, ${note}, ${source})
  `;
  if (opts?.touch !== false) {
    await sql`update desk_settings set last_tick_at = now(), last_tick_source = ${source} where id = 1`;
  }
}

export async function setScanCursor(n: number) {
  const sql = await getSql();
  await sql`update desk_settings set scan_cursor = ${n} where id = 1`;
  try {
    await sql`update desk_settings set scan_cursors = '{}' where id = 1`;
  } catch {
    /* column may be missing until migrate */
  }
}

export type OrphanFill = {
  venue: string;
  symbol: string;
  side: string;
  qty: number;
  entry: number;
  sl: number;
  tp: number;
  leverage: number;
  notional: number;
  risk: number;
  fees: number;
  timeframe: string;
  indicator: string;
  barTime?: number;
  orderId?: string;
  origSl?: number;
  reason?: string;
  at: number;
};

function parseOrphans(raw: unknown): OrphanFill[] {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(obj)) return [];
  return obj.filter((x): x is OrphanFill => Boolean(x) && typeof x === "object" && typeof (x as OrphanFill).symbol === "string");
}

export async function listOrphanFills(): Promise<OrphanFill[]> {
  const sql = await getSql();
  await ensureTickHardeningColumns(sql);
  try {
    const rows = await sql<{ orphan_fills: string | null }>`select orphan_fills from desk_settings where id = 1`;
    return parseOrphans(rows[0]?.orphan_fills);
  } catch {
    return [];
  }
}

export async function rememberOrphanFill(fill: Omit<OrphanFill, "at"> & { at?: number }) {
  const sql = await getSql();
  await ensureTickHardeningColumns(sql);
  const next: OrphanFill = { ...fill, at: fill.at ?? Date.now() };
  const cur = await listOrphanFills();
  const rest = cur.filter((x) => x.symbol !== next.symbol);
  rest.push(next);
  const clipped = rest.slice(-20);
  await sql`update desk_settings set orphan_fills = ${JSON.stringify(clipped)} where id = 1`;
}

export async function dropOrphanFill(symbol: string) {
  const sql = await getSql();
  const cur = await listOrphanFills();
  const next = cur.filter((x) => x.symbol !== symbol);
  if (next.length === cur.length) return;
  try {
    await sql`update desk_settings set orphan_fills = ${JSON.stringify(next)} where id = 1`;
  } catch {
    /* ignore */
  }
}

export async function markScanProgress(opts: {
  cursor: number;
  epochMs: number;
  cursors?: Record<string, { c: number; e: number }>;
  done?: { "5m"?: number; "15m"?: number; "1h"?: number; "4h"?: number };
}) {
  const sql = await getSql();
  await sql`update desk_settings set scan_cursor = ${opts.cursor}, scan_epoch_ms = ${opts.epochMs} where id = 1`;
  if (opts.cursors) {
    try {
      await sql`update desk_settings set scan_cursors = ${JSON.stringify(opts.cursors)} where id = 1`;
    } catch {
      /* column may be missing until migrate */
    }
  }
  const d = opts.done;
  if (!d) return;
  if (d["5m"] != null) await sql`update desk_settings set scan_done_5m = ${d["5m"]} where id = 1`;
  if (d["15m"] != null) await sql`update desk_settings set scan_done_15m = ${d["15m"]} where id = 1`;
  if (d["1h"] != null) await sql`update desk_settings set scan_done_1h = ${d["1h"]} where id = 1`;
  if (d["4h"] != null) await sql`update desk_settings set scan_done_4h = ${d["4h"]} where id = 1`;
}

export async function saveBacktest(b: {
  symbol: string;
  timeframe: string;
  indicator: string;
  bars: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectR: number;
  netR: number;
  maxDdR: number;
  resultJson: string;
}) {
  const sql = await getSql();
  const rows = await sql<{ id: number }>`
    insert into backtests (symbol, timeframe, indicator, bars, trades, wins, losses, win_rate, profit_factor, expect_r, net_r, max_dd_r, result_json)
    values (${b.symbol}, ${b.timeframe}, ${b.indicator}, ${b.bars}, ${b.trades}, ${b.wins}, ${b.losses}, ${b.winRate}, ${b.profitFactor}, ${b.expectR}, ${b.netR}, ${b.maxDdR}, ${b.resultJson})
    returning id
  `;
  return rows[0]?.id ?? 0;
}

export async function listBacktests(limit = 12) {
  const sql = await getSql();
  return sql<{
    id: number;
    created_at: string;
    symbol: string;
    timeframe: string;
    indicator: string;
    bars: number;
    trades: number;
    wins: number;
    losses: number;
    win_rate: number;
    profit_factor: number;
    expect_r: number;
    net_r: number;
    max_dd_r: number;
  }>`
    select id, created_at, symbol, timeframe, indicator, bars, trades, wins, losses, win_rate, profit_factor, expect_r, net_r, max_dd_r
    from backtests order by created_at desc limit ${limit}
  `;
}

export async function stats() {
  const sql = await getSql();
  const closed = await sql<{
    n: number;
    wins: number;
    pnl: number;
    r: number;
  }>`
    select
      count(*)::int as n,
      coalesce(sum(case when pnl_usd > 0 then 1 else 0 end), 0)::int as wins,
      coalesce(sum(pnl_usd), 0) as pnl,
      coalesce(sum(pnl_r), 0) as r
    from positions where status = 'closed'
  `;
  const open = await sql<{ n: number }>`select count(*)::int as n from positions where status = 'open'`;
  const c = closed[0] ?? { n: 0, wins: 0, pnl: 0, r: 0 };
  return {
    closed: num(c.n),
    wins: num(c.wins),
    pnl: num(c.pnl),
    r: num(c.r),
    open: num(open[0]?.n),
    winRate: num(c.n) ? (100 * num(c.wins)) / num(c.n) : 0,
  };
}
