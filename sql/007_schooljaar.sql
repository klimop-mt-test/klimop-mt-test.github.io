-- MT · sql/007_schooljaar.sql · versie 0.9.0
-- Stap 4, deel a (hoofdstuk 74 van het ontwerpdocument): een schooljaar aanmaken en starten in
-- Instellingen. Het aanmaken en invullen doet de beheerder rechtstreeks in de tabel van de
-- schooljaren: de regels daarvoor staan sinds script 002 in de databank. Dit script wijzigt enkel het
-- starten zelf.
--
-- Zo voer je het uit: Supabase → project mt-test → SQL Editor → New query → dit hele bestand
-- plakken → Run. Onderaan verschijnt een kleine tabel: elke regel moet OK tonen.
--
-- Enkel toevoegend en herhaalbaar: opnieuw uitvoeren mag, zolang er geen later script uitgevoerd is.
-- Alles-of-niets: lukt een controle niet, dan wordt niets bewaard en toont de editor een fout die
-- begint met "MT 007" (17.12).
--
-- Opbouw:
--    1. de volgorde                              3. de controles
--    2. een schooljaar starten
--
-- Wat er wijzigt, en waarom:
--   - Start een beheerder een schooljaar, dan is wat de MT net in de uitstappentool las, van vóór die
--     start: toen viel elke uitstap van dat schooljaar nog "buiten". De laatste lezing geldt daarom
--     niet meer als recent: de volgende vraag leest meteen opnieuw, zonder de halve minuut rust van
--     script 006. Zo staan de uitstappen van het nieuwe schooljaar er meteen na de start.
--   - Een lezing die op dat moment nog bezig is, wordt afgebroken: haar volgende deel schrijft niets
--     meer (MT409). Ze begon vóór de start, dus zonder de klassen van het nieuwe schooljaar.
--   - Het starten wacht tot een deel van een lezing dat bezig is, klaar is, en omgekeerd: hetzelfde
--     slot als het bijwerken zelf. Zo verwerkt geen enkel deel uitstappen half vóór en half na de start.

begin;

-- ============================================================================================
-- 1. De volgorde
-- ============================================================================================

do $$
declare
  v_laatste integer;
begin
  if to_regclass('mt_intern.scripts') is null or to_regclass('mt_intern.lezingen') is null then
    raise exception 'MT 007: voer eerst sql/006_review2.sql uit';
  end if;
  select max(nummer) into v_laatste from mt_intern.scripts;
  if v_laatste is null or v_laatste < 6 then
    raise exception 'MT 007: voer eerst sql/006_review2.sql uit';
  end if;
  if v_laatste > 7 then
    raise exception 'MT 007: script % is al uitgevoerd. Voer 007 niet opnieuw uit.', v_laatste;
  end if;
end
$$;

-- ============================================================================================
-- 2. Een schooljaar starten
-- ============================================================================================
-- "Aanmaak nieuw schooljaar bevestigen" (B144, B169; vervangt de versie van 003): het schooljaar wordt
-- lopend, het vorige wordt "voorbij, maar nog open" (B132). Ten vroegste vanaf 1 juli. Met de
-- klassenlijst erbij staan de klassen van het nieuwe schooljaar er meteen; de pagina geeft ze niet mee:
-- de serverfunctie mt-uitstappen leest ze bij de eerste lezing na de start.
-- Nieuw: de lezingen van de uitstappentool (zie bovenaan). De volgorde van de sloten ligt vast: eerst
-- het slot van het schooljaar, dan dat van de lezingen, en pas daarna een rij. Elke andere functie neemt
-- het slot van de lezingen ook vóór ze een rij vergrendelt: zo wachten er nooit twee op elkaar.
create or replace function mt_intern.schooljaar_bevestigen(p_schooljaar text, p_klassen jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_jaar public.schooljaren;
  v_vorig text;
  v_open integer := 0;
  v_klassen jsonb;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  perform pg_advisory_xact_lock(hashtext('mt_schooljaar'));
  perform pg_advisory_xact_lock(hashtext('mt_uitstappen_bijwerken'));
  select * into v_jaar from public.schooljaren s where s.schooljaar = p_schooljaar for update;
  if not found or v_jaar.stand <> 'in_te_vullen' then
    raise exception 'MT: dit schooljaar staat niet (meer) op "in te vullen"' using errcode = 'MT409';
  end if;
  if v_jaar.plafond_kleuter_cent is null or v_jaar.plafond_lager_cent is null
     or v_jaar.marge_kleuter_cent is null or v_jaar.marge_lager_cent is null
     or (v_jaar.minder_scherp_opvolgen and v_jaar.plafond_minder_scherp_cent is null) then
    raise exception 'MT: vul eerst de plafonds en de marges in' using errcode = 'MT422';
  end if;
  if mt_intern.vandaag() < make_date(left(p_schooljaar, 4)::integer, 7, 1) then
    raise exception 'MT: een nieuw schooljaar bevestigen kan ten vroegste vanaf 1 juli (B169)' using errcode = 'MT422';
  end if;
  if exists (select 1 from public.schooljaren s where s.schooljaar > p_schooljaar and s.stand <> 'in_te_vullen') then
    raise exception 'MT: er is al een later schooljaar gestart' using errcode = 'MT422';
  end if;
  select s.schooljaar into v_vorig from public.schooljaren s where s.stand = 'lopend' for update;
  if v_vorig is not null then
    update public.schooljaren s set stand = 'voorbij' where s.schooljaar = v_vorig;
    select count(*) into v_open
      from public.klaslijsten l join public.activiteiten a on a.id = l.activiteit_id
     where l.schooljaar = v_vorig and l.stand = 'open' and not l.vervallen
       and (a.soort = 'beurt' or (a.bron_stand = 'actief' and a.bron_plan = 'bevestigd'));
  end if;
  update public.schooljaren s set stand = 'lopend' where s.schooljaar = p_schooljaar;
  if p_klassen is not null then
    v_klassen := mt_intern.klassen_toepassen(p_schooljaar, p_klassen);
  end if;
  -- Een lezing die nog bezig is, begon vóór de start: haar volgende deel schrijft niets meer.
  update mt_intern.lezingen l set stand = 'afgebroken', reden = 'een nieuw schooljaar is gestart' where l.stand = 'bezig';
  -- Wat de laatste lezing toonde, is van vóór de start: de volgende vraag leest meteen opnieuw.
  update mt_intern.lezingen l set verouderd = true where l.stand = 'klaar' and not l.verouderd;
  return jsonb_build_object('schooljaar', p_schooljaar, 'vorig', v_vorig, 'open_lijsten_vorig', v_open, 'klassen', v_klassen);
end
$$;
revoke all on function mt_intern.schooljaar_bevestigen(text, jsonb) from public;

insert into mt_intern.scripts (nummer, naam) values (7, '007_schooljaar')
on conflict (nummer) do update set laatst_op = now(), keren = mt_intern.scripts.keren + 1;

-- ============================================================================================
-- 3. De controles, in dezelfde transactie: lukt er één niet, dan wordt niets bewaard
-- ============================================================================================

do $$
declare
  v_fout text;
  v_n integer;
  v_tekst text;
begin
  v_fout := mt_intern.controleer_functies();
  if v_fout is not null then
    raise exception 'MT 007: %', v_fout;
  end if;

  -- Een schooljaar starten: enkel de pagina, via haar doorgeefluik. Niet de serverfunctie, niet anon.
  if not has_function_privilege('authenticated', 'public.mt_schooljaar_bevestigen(text, jsonb)', 'execute')
     or has_function_privilege('service_role', 'public.mt_schooljaar_bevestigen(text, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.mt_schooljaar_bevestigen(text, jsonb)', 'execute') then
    raise exception 'MT 007: een schooljaar starten heeft andere rechten dan bedoeld';
  end if;

  -- De start zet de lezingen opzij, onder het slot van de lezingen, en dat slot komt vóór de eerste rij.
  select p.prosrc into v_tekst from pg_proc p where p.oid = 'mt_intern.schooljaar_bevestigen(text, jsonb)'::regprocedure;
  if position('hashtext(''mt_uitstappen_bijwerken'')' in v_tekst) = 0
     or position('hashtext(''mt_uitstappen_bijwerken'')' in v_tekst) > position('for update' in v_tekst) then
    raise exception 'MT 007: een schooljaar starten neemt het slot van de lezingen niet, of te laat';
  end if;

  -- De serverfunctie, anon en "iedereen": nog altijd geen enkel recht op een tabel, een kolom of een reeks van de MT.
  select string_agg(distinct c.relname::text, ', ' order by c.relname::text) into v_fout
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'mt_intern') and c.relkind in ('r', 'p', 'S')
     and (exists (select 1 from aclexplode(c.relacl) a
                   where a.grantee in (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid)
                     and (n.nspname = 'mt_intern' or a.grantee <> 'authenticated'::regrole::oid))
          or exists (select 1 from pg_attribute k, aclexplode(k.attacl) a
                      where k.attrelid = c.oid and k.attnum > 0 and not k.attisdropped
                        and a.grantee in (0, 'anon'::regrole::oid, 'service_role'::regrole::oid)));
  if v_fout is not null then
    raise exception 'MT 007: een rol van de API heeft rechten op: %', v_fout;
  end if;

  -- Wat 002 vastlegde, geldt nog: authenticated schrijft enkel in de 22 beheertabellen.
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
          or has_any_column_privilege('authenticated', c.oid, 'insert, update'));
  if v_n <> 22 then
    raise exception 'MT 007: authenticated kan schrijven in % tabellen in plaats van 22', v_n;
  end if;
end
$$;

commit;

-- De Data API kent de functie meteen in haar nieuwe vorm.
notify pgrst, 'reload schema';

-- Het resultaat: elke regel moet OK tonen.
select c.controle, c.resultaat
from (values
  (1, 'Scripts 001 tot 007 geregistreerd',
      (select case when count(*) = 7 then 'OK' else 'FOUT' end from mt_intern.scripts where nummer in (1, 2, 3, 4, 5, 6, 7))),
  (2, 'Functies voor de pagina, elk met een doorgeefluik',
      (select case when count(*) = 26 then 'OK: 26 functies' else 'FOUT: ' || count(*) end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
          and has_function_privilege('authenticated', p.oid, 'execute'))),
  (3, 'Functies voor de serverfuncties',
      (select case when count(*) = 7 then 'OK: 7 functies' else 'FOUT: ' || count(*) end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
          and has_function_privilege('service_role', p.oid, 'execute'))),
  (4, 'Elke functie staat op de lijst en begint met haar toegangscontrole',
      coalesce('FOUT: ' || mt_intern.controleer_functies(), 'OK')),
  (5, 'Een schooljaar starten: enkel een beheerder, via de pagina',
      case when has_function_privilege('authenticated', 'public.mt_schooljaar_bevestigen(text, jsonb)', 'execute')
            and not has_function_privilege('service_role', 'public.mt_schooljaar_bevestigen(text, jsonb)', 'execute') then 'OK' else 'FOUT' end),
  (6, 'Na de start leest de MT de uitstappentool meteen opnieuw',
      (select case when p.prosrc like '%set verouderd = true%' and p.prosrc like '%set stand = ''afgebroken''%' then 'OK' else 'FOUT' end
         from pg_proc p where p.oid = 'mt_intern.schooljaar_bevestigen(text, jsonb)'::regprocedure)),
  (7, 'Rechtstreeks schrijven nog altijd enkel in de 22 beheertabellen',
      (select case when count(*) = 22 then 'OK' else 'FOUT: ' || count(*) end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
               or has_any_column_privilege('authenticated', c.oid, 'insert, update'))))
) as c(nr, controle, resultaat)
order by c.nr;
