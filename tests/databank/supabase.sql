-- MT · tests/databank/supabase.sql
-- Bootst na wat de scripts van de MT van Supabase nodig hebben, op een lege Postgres: de rollen,
-- het auth-schema en de standaardrechten. Enkel voor de databanktest (17.12); dit script gaat nooit
-- naar een project van Supabase.
--
-- Getrouw aan de bronnen van Supabase (supabase/postgres en supabase/auth), voor wat de MT raakt:
--   - de rol postgres is geen superuser: createdb, createrole, replication en bypassrls
--     (demote-postgres), en lid van anon, authenticated en service_role;
--   - de tabellen van auth zijn van supabase_auth_admin, met RLS aan en zonder regels; postgres leest
--     ze, en mag naar auth.users verwijzen. Op het echte project mag postgres er vandaag ook in
--     schrijven (nagekeken op 12 november 2026). Hier bewust niet: de MT schrijft nooit in de tabellen
--     van Supabase Auth, en de scripts moeten bewijzen dat ze er niet van afhangen;
--   - auth.uid() en auth.jwt() lezen de claims van het verzoek, zoals PostgREST ze zet.
-- Strenger dan nodig waar het kan: de oude standaardrechten van Supabase staan hier nog aan, zodat de
-- scripts moeten bewijzen dat ze er niet van afhangen.
--
-- Uit te voeren als de superuser van de cluster, die hier supabase_admin heet.

create role postgres login createdb createrole replication bypassrls;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_auth_admin login noinherit createrole;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;
grant all on database postgres to postgres;

-- De tijdslimieten van het echte project (nagekeken op 12 november 2026): een vraag van anon stopt na
-- 3 seconden, een vraag via de API na 8 seconden, en wachten op een slot ook na 8 seconden.
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';
alter role authenticator set statement_timeout = '8s';
alter role authenticator set lock_timeout = '8s';

-- public: postgres bouwt er, de API-rollen mogen erin kijken
grant usage, create on schema public to postgres;
grant usage on schema public to anon, authenticated, service_role;

-- De oude standaardrechten van Supabase: alles wat postgres in public maakt, staat vanzelf open.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

-- extensions
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant all on schema extensions to postgres;
alter role postgres set search_path to "$user", public, extensions;

-- auth
create schema auth;
grant all on schema auth to supabase_auth_admin;
grant usage on schema auth to postgres, anon, authenticated, service_role;

create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
create type auth.factor_status as enum ('unverified', 'verified');

create table auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz default now()
);
-- Een sessie draagt haar niveau (aal) en de app waarmee de code gegeven werd (factor_id): add_mfa_schema.
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz,
  factor_id uuid,
  aal auth.aal_level,
  not_after timestamptz
);
create table auth.mfa_factors (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  friendly_name text,
  factor_type auth.factor_type not null,
  status auth.factor_status not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- De stappen van een aanmelding, per sessie: het wachtwoord, de code uit de app. updated_at is het
-- laatste moment waarop die stap lukte; het toegangsbewijs neemt dat over als "amr".
create table auth.mfa_amr_claims (
  session_id uuid not null references auth.sessions (id) on delete cascade,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  authentication_method text not null,
  id uuid not null default gen_random_uuid() primary key,
  unique (session_id, authentication_method)
);
alter table auth.users owner to supabase_auth_admin;
alter table auth.sessions owner to supabase_auth_admin;
alter table auth.mfa_factors owner to supabase_auth_admin;
alter table auth.mfa_amr_claims owner to supabase_auth_admin;
alter table auth.users enable row level security;
alter table auth.sessions enable row level security;
alter table auth.mfa_factors enable row level security;
alter table auth.mfa_amr_claims enable row level security;

-- demote-postgres gaf alles op de tabellen van toen (users); de latere tabellen enkel lezen.
grant all on table auth.users to postgres;
grant select on table auth.users, auth.sessions, auth.mfa_factors, auth.mfa_amr_claims to postgres with grant option;

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
alter function auth.uid() owner to supabase_auth_admin;
alter function auth.role() owner to supabase_auth_admin;
alter function auth.jwt() owner to supabase_auth_admin;

-- Realtime: een lege publicatie, zoals in elk project
create publication supabase_realtime;
