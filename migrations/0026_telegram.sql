-- Per-venue Telegram signal fanout. Token is sealed like other desk secrets.
alter table desk_settings add column if not exists telegram_bot_token text;
alter table desk_settings add column if not exists telegram_chat_id text;
alter table desk_settings add column if not exists telegram_venues text not null default '{}';
