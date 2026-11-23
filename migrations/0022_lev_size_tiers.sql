-- Per-leverage capital % buckets. Default 3% of equity as margin;
-- 5x coins 15%, 10x coins 12%, 25x coins 6%. All editable in settings.
alter table desk_settings add column if not exists lev_size_tiers text not null
  default '[{"leverage":5,"capitalPct":15},{"leverage":10,"capitalPct":12},{"leverage":25,"capitalPct":6}]';

alter table desk_settings alter column capital_pct set default 3;
alter table desk_settings alter column venue set default 'aster';

-- Fresh desks still sit on the old 10% default from 0006. Move them to 3%.
update desk_settings
  set capital_pct = 3
  where id = 1 and capital_pct = 10;

-- Original default venue was Lighter. This desk is meant to run on Aster.
update desk_settings
  set venue = 'aster'
  where id = 1 and venue = 'lighter';
