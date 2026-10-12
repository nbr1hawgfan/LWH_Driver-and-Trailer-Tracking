-- ============================================================
-- LWH Fleet View — tables for the fleet-live edge function
-- Run once in the LWH Companion project (SQL editor or `supabase db push`).
-- RLS is ON with no policies: only the edge function (service role) can
-- read or write these. The browser never touches them directly.
-- ============================================================

-- Sites: warehouses + customer locations, mapped to Samsara address IDs.
-- The edge function pulls each address's geofence (polygon or circle)
-- from Samsara and caches it, so you never enter coordinates by hand.
create table if not exists public.fleet_sites (
  id                   bigserial primary key,
  name                 text not null unique,
  samsara_address_ids  text[] not null default '{}',
  is_home              boolean not null default true,  -- shows in the "I'm at" picker
  sort_order           int not null default 100,
  active               boolean not null default true
);

-- Hidden assets: bad GPS, paid storage, test devices.
--   match_type 'id'            -> exact Samsara id
--   match_type 'name_contains' -> case-insensitive substring of the name
create table if not exists public.fleet_hidden (
  id          bigserial primary key,
  asset_type  text not null check (asset_type in ('vehicle','trailer','any')),
  match_type  text not null check (match_type in ('id','name_contains')),
  value       text not null,
  note        text,
  unique (asset_type, match_type, value)
);

-- Empty / Loaded status, set from the app with one tap.
create table if not exists public.fleet_trailer_load (
  trailer_id    text primary key,
  trailer_name  text,
  status        text not null check (status in ('empty','loaded')),
  updated_by    text,
  updated_at    timestamptz not null default now()
);

-- History of every status change (who/when), for when it matters.
create table if not exists public.fleet_trailer_load_log (
  id            bigserial primary key,
  trailer_id    text not null,
  trailer_name  text,
  status        text not null,   -- empty | loaded | cleared
  updated_by    text,
  updated_at    timestamptz not null default now()
);

alter table public.fleet_sites            enable row level security;
alter table public.fleet_hidden           enable row level security;
alter table public.fleet_trailer_load     enable row level security;
alter table public.fleet_trailer_load_log enable row level security;

-- ---------- Seed data (from the Pernod Dwell Tracker + Fleet Command) ----------

insert into public.fleet_sites (name, samsara_address_ids, is_home, sort_order) values
  ('Fresno St', array['20213654'],             true,  10),
  ('5th St',    array['20213428','27196470'],  true,  20),
  ('6th St',    array['20355339'],             true,  30),
  -- TODO: paste the Pernod address IDs from the Dwell Tracker's script
  -- property PERNOD_GEOFENCE_IDS (comma-separated there) into this array.
  ('Pernod Ricard', array[]::text[],           false, 90)
on conflict (name) do nothing;

insert into public.fleet_hidden (asset_type, match_type, value, note) values
  ('trailer','id','281474977725492','STILL GOOD - stale GPS (dispatch)'),
  ('trailer','id','281474977461857','G9R9-43F-FPF - stale GPS (dispatch)'),
  ('trailer','id','212014918337328','016-W - paid storage'),
  ('vehicle','name_contains','forklift test',     'Fleet Command exclusion'),
  ('vehicle','name_contains','not a good gateway','Fleet Command exclusion'),
  ('vehicle','name_contains','box truck',         'Fleet Command exclusion'),
  ('vehicle','name_contains','2- mike walker',    'Fleet Command exclusion'),
  ('vehicle','name_contains','bad',               'Fleet Command exclusion'),
  ('vehicle','name_contains','gf9y-dmd-tgt',      'Fleet Command exclusion'),
  ('vehicle','name_contains','1-vince grove',     'Fleet Command exclusion'),
  ('vehicle','name_contains','good gateway',      'Fleet Command exclusion'),
  ('vehicle','name_contains','editest',           'Fleet Command exclusion')
on conflict do nothing;
