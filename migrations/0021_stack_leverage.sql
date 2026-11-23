-- If N concurrent opens already sit above this cap, new fills use this cap.
alter table desk_settings add column if not exists stack_lev_count integer not null default 2;
alter table desk_settings add column if not exists stack_lev_cap integer not null default 75;
