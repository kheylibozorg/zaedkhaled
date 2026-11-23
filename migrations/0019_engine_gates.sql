-- Per-engine × timeframe mute switches. Empty JSON = every engine stays on.
alter table desk_settings add column if not exists engine_gates text not null default '{}';
