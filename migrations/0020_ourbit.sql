-- Replace Toobit with OURBIT. Keep old toobit_* columns so existing Neon rows stay intact.
alter table desk_settings add column if not exists ourbit_api_key text;
alter table desk_settings add column if not exists ourbit_api_secret text;

update desk_settings set venue = 'ourbit' where venue = 'toobit';
update desk_settings set universe_venue = 'ourbit' where universe_venue = 'toobit';
