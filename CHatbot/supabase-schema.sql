-- Pnchy petitions schema
-- Run this once in the Supabase SQL editor on a fresh project.

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

create table if not exists petitions (
  id uuid primary key default gen_random_uuid(),
  place_key text unique not null,       -- slug of business name + address
  business_name text not null,
  business_address text default '',
  signature_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists petition_signatures (
  id uuid primary key default gen_random_uuid(),
  petition_id uuid not null references petitions(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  unique (petition_id, email)           -- one signature per person per business
);

-- Keeps signature_count accurate without ever exposing raw emails
-- publicly. security definer lets this run with elevated privilege
-- so the anon insert role doesn't itself need UPDATE on petitions.
create or replace function increment_petition_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update petitions set signature_count = signature_count + 1 where id = new.petition_id;
  return new;
end;
$$;

drop trigger if exists on_petition_signature_insert on petition_signatures;
create trigger on_petition_signature_insert
after insert on petition_signatures
for each row execute function increment_petition_count();

alter table petitions enable row level security;
alter table petition_signatures enable row level security;

-- petitions: public can read (to show name/count on the widget), create
-- a new row the first time a business is searched, and update one on a
-- repeat search (the widget upserts on place_key, so searching an
-- already-petitioned business again is technically an UPDATE).
create policy "public read petitions" on petitions
  for select using (true);
create policy "public create petitions" on petitions
  for insert with check (true);
create policy "public update petitions" on petitions
  for update using (true) with check (true);

-- RLS's row-level "using/check (true)" above only controls WHICH ROWS
-- can be touched, not WHICH COLUMNS — Postgres column privileges are a
-- separate, independent check. Without this, anon's default full-table
-- UPDATE grant means anyone holding the public anon key could directly
-- set signature_count to anything via `supabase.from('petitions')
-- .update({signature_count: 999})`, bypassing the security-definer
-- trigger above entirely. Scoping the grant to only the columns the
-- app's own upsert touches closes that off without needing a narrower
-- RPC. (place_key is included because Supabase's upsert re-sends it in
-- the ON CONFLICT DO UPDATE SET list even though its value doesn't change.)
revoke update on petitions from anon;
grant update (place_key, business_name, business_address) on petitions to anon;

-- petition_signatures: public can INSERT (sign) only. There is
-- deliberately no SELECT policy on this table at all, so raw emails
-- are never queryable from the browser via the anon key — only the
-- aggregated signature_count on petitions is ever public.
create policy "public can sign" on petition_signatures
  for insert with check (true);
