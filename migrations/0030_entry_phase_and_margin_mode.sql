alter table desk_settings add column if not exists entry_phase_mode text not null default 'both';
alter table desk_settings add column if not exists margin_mode text not null default 'cross';
