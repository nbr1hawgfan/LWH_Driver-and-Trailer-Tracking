-- ============================================================
-- LWH Fleet View — v2 additions (already applied to LWH Companion)
-- ============================================================

-- Shared caches so every manager's refresh reuses one Samsara pull
alter table public.fleet_sites
  add column if not exists geofence_cache jsonb,
  add column if not exists geofence_cached_at timestamptz;

create table if not exists public.fleet_live_cache (
  id        int primary key default 1 check (id = 1),
  body      jsonb not null,
  built_at  timestamptz not null default now()
);
alter table public.fleet_live_cache enable row level security;

-- Sites that aren't a Samsara address can be a simple circle instead
alter table public.fleet_sites
  add column if not exists center_lat double precision,
  add column if not exists center_lng double precision,
  add column if not exists radius_m   double precision;

-- The truck lot at 714-750 S Fresno St — same 0.3 mi circle Fleet Command used as "Company Yard".
-- Sorted after the warehouses so their building outlines still win where they overlap.
insert into public.fleet_sites (name, samsara_address_ids, is_home, sort_order, center_lat, center_lng, radius_m)
values ('Truck Yard', '{}', true, 40, 35.35153, -94.42776, 483)
on conflict (name) do nothing;

-- Test / leftover devices that showed up as trailers
insert into public.fleet_hidden (asset_type, match_type, value, note) values
  ('trailer','id','212014918337108','good gateway iii - test device'),
  ('trailer','id','281475002779527','Deactivated gateway record, not a trailer')
on conflict do nothing;

-- 7-day MPG per truck from Samsara's fuel & energy report, refreshed a few times a day
create table if not exists public.fleet_mpg_cache (
  id        int primary key default 1 check (id = 1),
  body      jsonb not null,
  built_at  timestamptz not null default now()
);
alter table public.fleet_mpg_cache enable row level security;
