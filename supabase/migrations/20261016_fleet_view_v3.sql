-- Fleet View v1.12: shared results for the trailer sitting-time and DVIR background jobs.
-- One row per job ('dwell', 'dvir'). Only the fleet-live function (service role) reads/writes it.
create table if not exists public.fleet_job_cache (
  key       text primary key,
  body      jsonb not null default '{}'::jsonb,
  built_at  timestamptz not null default now()
);
alter table public.fleet_job_cache enable row level security;
