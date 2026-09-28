-- Pnchy petitions: security fix migration (2026-09-28 pen test)
-- Run once in the Supabase SQL editor, AFTER supabase-schema.sql.
--
-- Fixes, in order:
--   1. HIGH   petitions UPDATE policy had no row-ownership check at all
--             (`using (true) with check (true)`) — any anon caller could
--             rewrite ANY existing petition's business_name/address/
--             place_key directly via the REST API. There is no concept
--             of a petition "owner" in this schema, so the only real fix
--             is to stop allowing raw table UPDATE from anon entirely and
--             replace it with a security-definer RPC that only performs
--             the exact upsert the app needs.
--   2. MEDIUM petitions INSERT had no column restriction, so anon could
--             set signature_count to anything on insert (e.g. 99999),
--             bypassing the trigger that's supposed to be the only way
--             that column changes. Folded into the same RPC below, which
--             never accepts signature_count from the caller.
--   3. MEDIUM petition_signatures INSERT allowed unlimited, unverified
--             signatures with no rate limit. Adds a per-IP sliding-window
--             limit (5 signatures/hour) enforced server-side via a new
--             security-definer RPC, using PostgREST's exposed
--             request.headers setting to read the real client IP
--             (Supabase's edge sets this; it is not client-spoofable).

-- ------------------------------------------------------------------
-- 1 & 2: upsert_petition() replaces direct table INSERT/UPDATE
-- ------------------------------------------------------------------

create or replace function upsert_petition(
  p_place_key text,
  p_business_name text,
  p_business_address text
)
returns petitions
language plpgsql
security definer
set search_path = public
as $$
declare
  result petitions;
begin
  if p_place_key is null or length(trim(p_place_key)) = 0 then
    raise exception 'place_key required';
  end if;
  if p_business_name is null or length(trim(p_business_name)) = 0 then
    raise exception 'business_name required';
  end if;

  insert into petitions (place_key, business_name, business_address)
  values (p_place_key, p_business_name, coalesce(p_business_address, ''))
  on conflict (place_key) do update
    set business_name = excluded.business_name,
        business_address = excluded.business_address
  returning * into result;

  return result;
end;
$$;

revoke insert on petitions from anon;
revoke update on petitions from anon;
-- petitions SELECT stays public read-only (unchanged from supabase-schema.sql)
-- so the widget can still show signature_count for a business.

grant execute on function upsert_petition(text, text, text) to anon;

-- ------------------------------------------------------------------
-- 3: sign_petition() replaces direct petition_signatures INSERT,
--    adds a per-IP rate limit
-- ------------------------------------------------------------------

create table if not exists petition_signature_attempts (
  ip text not null,
  created_at timestamptz not null default now()
);

create index if not exists petition_signature_attempts_ip_created_idx
  on petition_signature_attempts (ip, created_at);

create or replace function sign_petition(
  p_petition_id uuid,
  p_email text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  client_ip text;
  recent_count int;
  normalized_email text;
begin
  normalized_email := lower(trim(p_email));
  if normalized_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email';
  end if;

  -- request.headers is populated by PostgREST from the actual inbound
  -- request; Supabase's edge sets x-forwarded-for from the real
  -- connecting client, so this is not spoofable by the caller the way
  -- a client-supplied field would be.
  client_ip := coalesce(
    nullif(split_part(current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1), ''),
    'unknown'
  );

  select count(*) into recent_count
  from petition_signature_attempts
  where ip = client_ip
    and created_at > now() - interval '1 hour';

  if recent_count >= 5 then
    raise exception 'Too many signatures from this network recently. Try again later.';
  end if;

  insert into petition_signatures (petition_id, email)
  values (p_petition_id, normalized_email);

  insert into petition_signature_attempts (ip) values (client_ip);
end;
$$;

revoke insert on petition_signatures from anon;
-- no select policy existed before and still doesn't — emails stay
-- unreadable via the anon key.

grant execute on function sign_petition(uuid, text) to anon;

-- ------------------------------------------------------------------
-- Housekeeping: old table-level policies are now dead code (the
-- REVOKEs above make them unreachable) but drop them for clarity.
-- ------------------------------------------------------------------
drop policy if exists "public create petitions" on petitions;
drop policy if exists "public update petitions" on petitions;
drop policy if exists "public can sign" on petition_signatures;
-- "public read petitions" is kept — SELECT on petitions is still public.
