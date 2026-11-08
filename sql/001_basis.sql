-- MT · sql/001_basis.sql · versie 0.1.0
-- De basis van de databank (stap 0): het afgeschermde schema, de standaardrechten en de pingfunctie.
--
-- Zo voer je het uit: Supabase → project mt-test → SQL Editor → New query → dit hele bestand
-- plakken → Run. Onderaan verschijnt een kleine tabel: elke regel moet OK tonen.
--
-- Enkel toevoegend en herhaalbaar: opnieuw uitvoeren mag. Alles-of-niets: lukt een controle niet,
-- dan wordt niets bewaard en toont de editor een fout die begint met "MT 001" (17.12).

begin;

-- 1. Het afgeschermde schema (17.3, regel 5). Niet bereikbaar via de Data API, die enkel public
--    openstelt. De hulpfuncties van stap 1 komen hier.
create schema if not exists mt_intern;
revoke all on schema mt_intern from public, anon, authenticated;

-- 2. Standaardrechten voor alles wat onze scripts later maken (rol postgres).
--    Postgres maakt elke nieuwe functie standaard uitvoerbaar voor iedereen (public). Dat zetten we
--    uit voor het hele project: elke functie krijgt haar rechten voortaan uitdrukkelijk.
alter default privileges for role postgres revoke execute on functions from public;
--    Supabase geeft sinds 30 oktober 2026 zelf geen rechten meer op nieuwe tabellen en functies in
--    public. Voor de zekerheid leggen we dat hier ook vast, los van de instelling in het dashboard.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;

-- 3. De pingfunctie voor de keep-alive (17.9). Ze leest geen tabel en geeft enkel true terug.
--    stable, zodat cron-job.org en GitHub ze met een gewone GET kunnen oproepen.
--    anon mag enkel deze ene functie uitvoeren.
create or replace function public.mt_ping()
returns boolean
language sql
stable
set search_path = ''
as $$ select true $$;

revoke all on function public.mt_ping() from public;
grant execute on function public.mt_ping() to anon, authenticated;

-- 4. De controles, in dezelfde transactie: lukt er één niet, dan wordt niets bewaard.
do $$
begin
  if not has_function_privilege('anon', 'public.mt_ping()', 'execute') then
    raise exception 'MT 001: de pingfunctie is niet uitvoerbaar voor anon';
  end if;

  -- Een nieuwe functie is niet vanzelf uitvoerbaar voor anon of authenticated.
  create function public.mt_proef_rechten() returns integer language sql as $f$ select 1 $f$;
  if has_function_privilege('anon', 'public.mt_proef_rechten()', 'execute')
     or has_function_privilege('authenticated', 'public.mt_proef_rechten()', 'execute') then
    raise exception 'MT 001: nieuwe functies zijn nog vanzelf uitvoerbaar voor anon of authenticated';
  end if;
  drop function public.mt_proef_rechten();

  -- Een nieuwe tabel is niet vanzelf open voor anon of authenticated.
  create table public.mt_proef_rechten (id integer);
  if has_table_privilege('anon', 'public.mt_proef_rechten', 'select')
     or has_table_privilege('authenticated', 'public.mt_proef_rechten', 'select') then
    raise exception 'MT 001: nieuwe tabellen zijn nog vanzelf open voor anon of authenticated';
  end if;
  drop table public.mt_proef_rechten;
end
$$;

commit;

-- De Data API kent de pingfunctie meteen.
notify pgrst, 'reload schema';

-- 5. Het resultaat: elke regel moet OK tonen.
select controle, resultaat
from (values
  (1, 'Afgeschermd schema mt_intern',
      case when exists (select 1 from pg_namespace where nspname = 'mt_intern') then 'OK' else 'FOUT' end),
  (2, 'Pingfunctie uitvoerbaar voor anon',
      case when has_function_privilege('anon', 'public.mt_ping()', 'execute') then 'OK' else 'FOUT' end),
  (3, 'Pingfunctie geeft true',
      case when public.mt_ping() then 'OK' else 'FOUT' end),
  (4, 'Nieuwe functies en tabellen niet vanzelf open',
      'OK'),
  (5, 'Geen andere functies in public voor anon',
      coalesce('LET OP: ' || (
        select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname <> 'mt_ping'
          and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
          and has_function_privilege('anon', p.oid, 'execute')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      ), 'OK'))
) as c(nr, controle, resultaat)
order by nr;
