-- Percent of total equity vs free equity. Always capped at free cash on fill.
alter table desk_settings add column if not exists capital_base text not null default 'total';
