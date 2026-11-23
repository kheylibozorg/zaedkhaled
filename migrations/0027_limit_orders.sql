-- FTC Limit entry mode, Safe Limit Cap, Queue TTL, and pending/recent limit orders table.
alter table desk_settings add column if not exists entry_mode text not null default 'limit';
alter table desk_settings add column if not exists safe_limit_mode integer not null default 1;
alter table desk_settings add column if not exists limit_ttl_bars integer not null default 0;

create table if not exists limit_orders (
  id serial primary key,
  mode text not null default 'paper',
  venue text not null default 'paper',
  symbol text not null,
  timeframe text not null,
  indicator text not null,
  side text not null,
  entry double precision not null,
  sl double precision not null,
  tp double precision not null,
  rr double precision not null,
  atr double precision,
  be_at_r double precision,
  qty double precision not null,
  leverage integer not null default 1,
  notional_usd double precision not null default 0,
  risk_usd double precision not null default 0,
  margin_usd double precision not null default 0,
  armed_bar_time bigint not null,
  ftc_wait integer not null default 8,
  max_wait_bars integer not null default 8,
  reason text,
  exchange_order_id text,
  status text not null default 'pending',
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index if not exists limit_orders_dedupe_idx
  on limit_orders (symbol, timeframe, indicator, armed_bar_time);

create index if not exists limit_orders_status_idx
  on limit_orders (status, created_at desc);
