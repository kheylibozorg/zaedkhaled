-- Cap concurrent 1h+4h fills so they cannot occupy every slot.
alter table desk_settings add column if not exists htf_max_positions integer not null default 4;
