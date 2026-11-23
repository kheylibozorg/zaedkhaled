-- One OPEN desk row per symbol. Three engines on FLORK cannot sit open together.
delete from positions a
using positions b
where a.id > b.id
  and a.status = 'open'
  and b.status = 'open'
  and a.symbol = b.symbol;

create unique index if not exists positions_one_open_symbol_idx
  on positions (symbol)
  where status = 'open';
