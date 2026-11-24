alter table desk_settings add column if not exists max_limit_queue integer not null default 8;
alter table desk_settings add column if not exists auto_trim_excess integer not null default 0;
alter table limit_orders add column if not exists distance_atr double precision;
create index if not exists limit_orders_watch_idx on limit_orders (status, distance_atr asc, updated_at desc);
