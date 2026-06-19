-- ════════════════════════════════════════════════════════════════════
-- Offrd — search limit setup
-- Run this once in Supabase: Dashboard → SQL Editor → New query → Run
-- ════════════════════════════════════════════════════════════════════

-- 1. Table to hold the lifetime search count per user.
--    One row per auth user, created on first search.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  search_count integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 2. Row Level Security — locked down. The Worker reads/writes this
--    table using the service_role key, which bypasses RLS entirely.
--    These policies just make sure no one can read or edit counts
--    directly from the browser using the anon/public key.
alter table public.profiles enable row level security;

drop policy if exists "no client access" on public.profiles;
create policy "no client access" on public.profiles
  for all
  using (false)
  with check (false);

-- 3. Atomic increment function — called by the Worker via
--    POST /rest/v1/rpc/increment_search_count  { "uid": "<user id>" }
--    Using a single UPSERT here avoids a race condition between two
--    requests landing for the same user at the same time.
create or replace function public.increment_search_count(uid uuid)
returns void
language sql
security definer
as $$
  insert into public.profiles (id, search_count, updated_at)
  values (uid, 1, now())
  on conflict (id)
  do update set
    search_count = public.profiles.search_count + 1,
    updated_at = now();
$$;

-- Done. Verify with:
--   select * from public.profiles;
