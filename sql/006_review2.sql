-- MT · sql/006_review2.sql · versie 0.8.0
-- De correcties uit review 2 (hoofdstuk 73 van het ontwerpdocument): wat Astra en Opus 5.5 vonden in
-- het bijwerken van de uitstappen, vóór stap 4 een schooljaar aanmaakt.
--
-- Zo voer je het uit: Supabase → project mt-test → SQL Editor → New query → dit hele bestand
-- plakken → Run. Onderaan verschijnt een kleine tabel: elke regel moet OK tonen.
--
-- Enkel toevoegend en herhaalbaar: opnieuw uitvoeren mag, zolang er geen later script uitgevoerd is.
-- Alles-of-niets: lukt een controle niet, dan wordt niets bewaard en toont de editor een fout die
-- begint met "MT 006" (17.12).
--
-- Opbouw:
--    1. de volgorde                              4. de rem, bevestigd door de beheerder
--    2. de lezingen                              5. de doorgeefluiken, de rechten en de controle
--    3. de uitstappen bijwerken                  6. de controles
--
-- Wat er wijzigt, en waarom:
--   - Elke lezing van de uitstappentool krijgt een volgnummer, vóór de serverfunctie leest (R03,
--     R2-08). De databank aanvaardt enkel de lezing met het hoogste nummer: een lezing die ingehaald
--     is, schrijft niets meer. Zo komt er nooit nog een oudere stand na een nieuwere.
--   - De volgorde hangt daarmee aan de lezing, niet meer aan het tijdstip in de uitstappentool (R04).
--     De vergelijking "ouder dan wat de MT al verwerkte" vervalt: wat de nieuwste lezing zegt, geldt.
--     De versie bij een activiteit is de versie die de MT toepaste; bij een datum die wacht, blijft
--     ze die van toen (B20, B67).
--   - Eén lezing tegelijk, en hoogstens één per dertig seconden, voor de hele MT (R09, R2-10). Wie
--     intussen vraagt, krijgt de uitkomst van de laatste lezing. De databank noteert wie een lezing
--     startte: de id van de gebruiker, zonder naam.
--   - De taak "niet gevonden" draagt het nummer van de lezing: verdwijnt een uitstap een tweede
--     keer, dan komt er opnieuw een taak (R2-07).
--   - Een rem (B225, R2-05): verdwijnen er in één lezing meer dan vijf uitstappen die de MT nog
--     meetelde, dan neemt de MT dat niet over. Er komt één taak; de beheerder bevestigt.
--   - Het slot bij het bijwerken houdt het ingeven bij dezelfde activiteit niet meer tegen (R2-11).

begin;

-- ============================================================================================
-- 1. De volgorde
-- ============================================================================================

do $$
declare
  v_laatste integer;
begin
  if to_regclass('mt_intern.scripts') is null then
    raise exception 'MT 006: voer eerst sql/005_review1.sql uit';
  end if;
  select max(nummer) into v_laatste from mt_intern.scripts;
  if v_laatste is null or v_laatste < 5 then
    raise exception 'MT 006: voer eerst sql/005_review1.sql uit';
  end if;
  if v_laatste > 6 then
    raise exception 'MT 006: script % is al uitgevoerd. Voer 006 niet opnieuw uit.', v_laatste;
  end if;
end
$$;

-- ============================================================================================
-- 2. De lezingen
-- ============================================================================================
-- Eén rij per lezing van de uitstappentool. Geen gegevens van leerlingen: enkel het verloop van het
-- bijwerken, en wat de serverfunctie aan de pagina teruggeeft. Niemand bereikt de tabel via de Data
-- API: enkel de functies hieronder lezen en schrijven ze.
create table if not exists mt_intern.lezingen (
  nummer bigint generated always as identity primary key,
  begonnen_op timestamptz not null default now(),
  -- wie de lezing startte: de id van de gebruiker, zonder naam of e-mailadres
  door uuid,
  stand text not null default 'bezig' check (stand in ('bezig', 'klaar', 'afgebroken')),
  klaar_op timestamptz,
  -- wat de delen van deze lezing samen deden
  tellingen jsonb not null default '{}'::jsonb,
  -- wat de pagina te zien krijgt, zodra de lezing klaar is
  uitkomst jsonb,
  -- de uitkomst klopt niet meer, bv. na "Ze zijn echt weg": de volgende vraag leest opnieuw
  verouderd boolean not null default false,
  reden text check (reden is null or char_length(reden) <= 200),
  constraint lezingen_klaar check ((stand = 'klaar') = (klaar_op is not null))
);
alter table mt_intern.lezingen enable row level security;
revoke all on table mt_intern.lezingen from public, anon, authenticated, service_role;
-- Er is nooit meer dan één lezing bezig: de databank weigert zelf een tweede.
create unique index if not exists lezingen_een_bezig on mt_intern.lezingen ((true)) where stand = 'bezig';

-- De toegangscontrole van een functie voor een serverfunctie (vervangt de versie van 004): enkel de
-- tekst van de melding wijzigt, want er zijn nu twee serverfuncties (R2-13).
create or replace function mt_intern.eis_server() returns void
language plpgsql stable set search_path = '' as $$
begin
  if current_setting('role', true) is distinct from 'service_role' then
    raise exception 'MT: enkel voor een serverfunctie van de MT' using errcode = '42501';
  end if;
end
$$;
revoke all on function mt_intern.eis_server() from public;

-- Hoeveel uitstappen in één lezing mogen verdwijnen zonder vraag (B225). Op één plaats.
create or replace function mt_intern.max_verdwijnen() returns integer
language sql immutable set search_path = '' as $$ select 5 $$;
revoke all on function mt_intern.max_verdwijnen() from public;

-- Een lezing starten: de serverfunctie vraagt een volgnummer vóór ze de uitstappentool leest. Zo is
-- wat een hoger nummer las, altijd nieuwer dan wat een lager nummer las.
--   - loopt er een lezing die minder dan een minuut bezig is: "bezig", met de laatste uitkomst;
--   - is de laatste volledige lezing minder dan dertig seconden oud: "recent", met haar uitkomst;
--   - anders: "nieuw", met het nummer. Een lezing die langer dan een minuut bezig bleef, is afgebroken:
--     de serverfunctie stopt zelf na 24 seconden.
create or replace function mt_intern.lezing_start(p_door uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_bezig mt_intern.lezingen;
  v_klaar mt_intern.lezingen;
  v_nummer bigint;
begin
  perform mt_intern.eis_server();
  -- hetzelfde slot als het bijwerken zelf: een start wacht tot een deel dat bezig is, klaar is
  perform pg_advisory_xact_lock(hashtext('mt_uitstappen_bijwerken'));
  select * into v_klaar from mt_intern.lezingen l where l.stand = 'klaar' order by l.nummer desc limit 1;
  select * into v_bezig from mt_intern.lezingen l where l.stand = 'bezig' order by l.nummer desc limit 1;
  if v_bezig.nummer is not null and v_bezig.begonnen_op > now() - interval '60 seconds' then
    return jsonb_build_object('wat', 'bezig', 'sinds', v_bezig.begonnen_op, 'uitkomst', v_klaar.uitkomst);
  end if;
  update mt_intern.lezingen l set stand = 'afgebroken', reden = 'geen einde binnen de tijd' where l.stand = 'bezig';
  if v_klaar.nummer is not null and not v_klaar.verouderd and v_klaar.klaar_op > now() - interval '30 seconds' then
    return jsonb_build_object('wat', 'recent', 'uitkomst', v_klaar.uitkomst);
  end if;
  -- opruimen: wat ouder is dan dertig dagen, behalve de laatste volledige lezing
  delete from mt_intern.lezingen l
   where l.begonnen_op < now() - interval '30 days' and l.nummer is distinct from v_klaar.nummer;
  insert into mt_intern.lezingen (door) values (p_door) returning nummer into v_nummer;
  return jsonb_build_object('wat', 'nieuw', 'lezing', v_nummer);
end
$$;
revoke all on function mt_intern.lezing_start(uuid) from public;

-- Een lezing die niet afgewerkt raakt, bv. omdat de uitstappentool niet antwoordt: de serverfunctie
-- meldt het, zodat de volgende vraag niet een minuut moet wachten.
create or replace function mt_intern.lezing_stop(p_lezing bigint, p_reden text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer;
begin
  perform mt_intern.eis_server();
  perform pg_advisory_xact_lock(hashtext('mt_uitstappen_bijwerken'));
  update mt_intern.lezingen l set stand = 'afgebroken', reden = left(coalesce(p_reden, ''), 200)
   where l.nummer = p_lezing and l.stand = 'bezig';
  get diagnostics v_n = row_count;
  return jsonb_build_object('afgebroken', v_n = 1);
end
$$;
revoke all on function mt_intern.lezing_stop(bigint, text) from public;

-- ============================================================================================
-- 3. De uitstappen bijwerken
-- ============================================================================================

-- Eén uitstap verwerken (vervangt de versie van 005). Wat wijzigt:
--   - de vergelijking "ouder dan wat de MT al verwerkte" is weg: de volgorde hangt aan de lezing, en
--     een ingehaalde lezing komt hier niet meer (zie mt_intern.uitstappen_bijwerken);
--   - dezelfde verwijderde stand in een nieuwere versie: de MT onthoudt de versie die ze las;
--   - het slot op de activiteit houdt het ingeven niet meer tegen;
--   - een uitstap met meer dan vijftig klassen is ongeldig.
-- Bij een andere datum verschuift of wist de MT nooit afwezigheden. Zijn er al afwezigheden ingegeven,
-- dan wacht de datum, met een taak voor de beheerder: hij neemt de datum bewust over ("Datum
-- overnemen", stap 5). Tot dan houdt de MT de datum en de versie van toen.
create or replace function mt_intern.uitstap_bijwerken(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id text := p ->> 'id';
  v_plan text := p ->> 'planStatus';
  v_gewijzigd timestamptz;
  v_start date;
  v_eind date;
  v_meerdaags boolean;
  v_weg text;
  v_namen text[];
  v_act public.activiteiten;
  v_jaar text;
  v_stand text;
  v_stempel text;
  v_gegevens boolean;
  v_wacht boolean := false;
  v_wat text := 'ongewijzigd';
  v_onbekend text[] := '{}';
  v_voor text;
begin
  begin
    v_gewijzigd := (p ->> 'gewijzigd')::timestamptz;
    v_start := (p ->> 'datumStart')::date;
    v_meerdaags := coalesce(p ->> 'type', 'dag') = 'meerdaags';
    v_eind := case when v_meerdaags then coalesce((p ->> 'datumEind')::date, v_start) else v_start end;
    v_weg := case when coalesce(p ->> 'categorie', 'uitstap') = 'nascholing' then 'nascholing'
                  when coalesce((p ->> 'verwijderd')::boolean, false) then 'verwijderd' end;
    select coalesce(array_agg(distinct btrim(x.naam)) filter (where btrim(x.naam) <> ''), '{}') into v_namen
      from jsonb_array_elements_text(case when jsonb_typeof(p -> 'klassen') = 'array' then p -> 'klassen' else '[]'::jsonb end) as x(naam);
  exception when others then
    return jsonb_build_object('wat', 'ongeldig', 'uitstap', v_id);
  end;
  if v_id is null or char_length(v_id) not between 1 and 60 or v_gewijzigd is null or v_start is null or v_eind < v_start
     or v_plan is null or v_plan not in ('aangevraagd', 'bevestigd', 'geannuleerd')
     or v_gewijzigd > now() + interval '5 minutes' or cardinality(v_namen) > 50 then
    return jsonb_build_object('wat', 'ongeldig', 'uitstap', v_id);
  end if;
  v_jaar := mt_intern.schooljaar_van(v_start);
  v_stempel := to_char(v_gewijzigd at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS');

  -- Een slot dat het ingeven bij deze activiteit niet tegenhoudt (review 2: R2-11).
  select * into v_act from public.activiteiten a where a.uitstap_id = v_id for no key update;

  -- Een uitstap die de MT nog niet kent.
  if not found then
    if v_weg is not null then
      return jsonb_build_object('wat', 'geen', 'uitstap', v_id);
    end if;
    select s.stand into v_stand from public.schooljaren s where s.schooljaar = v_jaar;
    if v_stand is null or v_stand not in ('lopend', 'voorbij') then
      return jsonb_build_object('wat', 'buiten', 'uitstap', v_id);
    end if;
    insert into public.activiteiten (schooljaar, soort, uitstap_id, bron_gewijzigd_op, bron_stand, bron_plan,
                                     datum_start, datum_eind, meerdaags, prijs_per_kind_afwezigen)
    select v_jaar, 'uitstap', v_id, v_gewijzigd, 'actief', v_plan, v_start, v_eind, v_meerdaags, s.prijs_per_kind_afwezigen
      from public.schooljaren s where s.schooljaar = v_jaar
    returning * into v_act;
    v_onbekend := mt_intern.lijsten_bijwerken(v_act.id, v_namen, v_stempel);
    return jsonb_build_object('wat', 'nieuw', 'uitstap', v_id, 'onbekend', to_jsonb(v_onbekend), 'schooljaar', v_jaar);
  end if;

  select s.stand into v_stand from public.schooljaren s where s.schooljaar = v_act.schooljaar;
  if v_stand = 'afgesloten' then
    return jsonb_build_object('wat', 'gesloten', 'uitstap', v_id);
  end if;
  v_gegevens := mt_intern.heeft_gegevens(v_act.id);

  -- Verwijderd, of omgezet naar een nascholing: telt niet meer mee (B14, V21).
  if v_weg is not null then
    if v_act.bron_stand is not distinct from v_weg then
      -- Dezelfde stand, misschien in een nieuwere versie: de MT onthoudt de versie die ze las (review 2: R04).
      update public.activiteiten a set bron_gewijzigd_op = v_gewijzigd
       where a.id = v_act.id and a.bron_gewijzigd_op is distinct from v_gewijzigd;
      return jsonb_build_object('wat', 'ongewijzigd', 'uitstap', v_id);
    end if;
    update public.activiteiten a set bron_stand = v_weg, bron_gewijzigd_op = v_gewijzigd where a.id = v_act.id;
    if v_gegevens then
      perform mt_intern.taak_maken(v_act.schooljaar, 'uitstap_weg', 'uitstap_weg:' || v_act.id || ':' || v_weg || ':' || v_stempel,
                                   v_act.id, null, null, jsonb_build_object('reden', v_weg));
    end if;
    return jsonb_build_object('wat', 'weg', 'uitstap', v_id);
  end if;

  -- Terug actief, bv. teruggezet uit de prullenbak.
  if v_act.bron_stand is distinct from 'actief' then
    update public.activiteiten a set bron_stand = 'actief' where a.id = v_act.id;
    update public.taken t
       set stand = 'afgehandeld', afgehandeld_op = now(), afgehandeld_door = auth.uid(), afhandeling = 'hersteld'
     where t.stand = 'open' and t.soort = 'uitstap_weg' and t.activiteit_id = v_act.id
       and t.gegevens ->> 'reden' in ('verwijderd', 'nascholing', 'niet_gevonden');
    v_wat := 'gewijzigd';
  end if;

  -- De stand van de planning.
  if v_act.bron_plan is distinct from v_plan then
    update public.activiteiten a set bron_plan = v_plan where a.id = v_act.id;
    if v_plan = 'geannuleerd' and v_gegevens then
      perform mt_intern.taak_maken(v_act.schooljaar, 'uitstap_weg', 'uitstap_weg:' || v_act.id || ':geannuleerd:' || v_stempel,
                                   v_act.id, null, null, jsonb_build_object('reden', 'geannuleerd'));
    elsif v_act.bron_plan = 'geannuleerd' then
      update public.taken t
         set stand = 'afgehandeld', afgehandeld_op = now(), afgehandeld_door = auth.uid(), afhandeling = 'hersteld'
       where t.stand = 'open' and t.soort = 'uitstap_weg' and t.activiteit_id = v_act.id and t.gegevens ->> 'reden' = 'geannuleerd';
    end if;
    v_wat := 'gewijzigd';
  end if;

  -- De datum.
  if v_act.datum_start <> v_start or v_act.datum_eind <> v_eind or v_act.meerdaags <> v_meerdaags then
    if mt_intern.ligt_vast(v_act.id) then
      v_wacht := true;
    elsif v_jaar <> v_act.schooljaar then
      -- naar een ander schooljaar: enkel als er nog niets aan hangt, en nooit naar een schooljaar dat niet open is
      select s.stand into v_stand from public.schooljaren s where s.schooljaar = v_jaar;
      if v_gegevens or v_stand is null or v_stand not in ('lopend', 'voorbij') then
        v_wacht := true;
      else
        delete from public.klaslijsten l where l.activiteit_id = v_act.id;
        update public.activiteiten a
           set schooljaar = v_jaar, datum_start = v_start, datum_eind = v_eind, meerdaags = v_meerdaags
         where a.id = v_act.id;
        v_wat := 'gewijzigd';
      end if;
    elsif exists (select 1 from public.afwezigheden af where af.activiteit_id = v_act.id) then
      -- Er zijn al afwezigheden per dag ingegeven. De MT verschuift of wist ze nooit zelf: de datum
      -- wacht tot de beheerder ze bewust overneemt. De taak zegt van welke datum naar welke.
      v_wacht := true;
      perform mt_intern.taak_maken(v_act.schooljaar, 'datum_gewijzigd', 'datum_gewijzigd:' || v_act.id || ':' || v_stempel,
                                   v_act.id, null, null,
                                   jsonb_build_object('van', v_act.datum_start, 'naar', v_start, 'tot', v_eind, 'wacht', true));
    else
      -- Binnen het schooljaar, nog niets bevestigd en nog geen afwezigheden: de MT volgt.
      update public.activiteiten a set datum_start = v_start, datum_eind = v_eind, meerdaags = v_meerdaags where a.id = v_act.id;
      update public.klaslijsten l set revisie = l.revisie + 1, gewijzigd_op = now() where l.activiteit_id = v_act.id;
      v_wat := 'gewijzigd';
    end if;
  end if;

  if v_wacht then
    -- De versie blijft die van toen: zo kan niets bevestigd worden op een datum die de MT niet volgt.
    return jsonb_build_object('wat', v_wat, 'uitstap', v_id, 'wacht', true);
  end if;

  -- De klassen.
  select coalesce(string_agg(l.klas_id::text || l.vervallen::text, ',' order by l.klas_id), '') into v_voor
    from public.klaslijsten l where l.activiteit_id = v_act.id;
  v_onbekend := mt_intern.lijsten_bijwerken(v_act.id, v_namen, v_stempel);
  if v_voor is distinct from (select coalesce(string_agg(l.klas_id::text || l.vervallen::text, ',' order by l.klas_id), '')
                                from public.klaslijsten l where l.activiteit_id = v_act.id) then
    v_wat := 'gewijzigd';
  end if;
  update public.activiteiten a set bron_gewijzigd_op = v_gewijzigd
   where a.id = v_act.id and a.bron_gewijzigd_op is distinct from v_gewijzigd;
  if found then
    v_wat := 'gewijzigd';
  end if;
  -- Het schooljaar waarin de uitstap nu staat: dat kan hierboven gewijzigd zijn.
  return jsonb_build_object('wat', v_wat, 'uitstap', v_id, 'onbekend', to_jsonb(v_onbekend),
                            'schooljaar', (select a.schooljaar from public.activiteiten a where a.id = v_act.id));
end
$$;
revoke all on function mt_intern.uitstap_bijwerken(jsonb) from public;

-- De uitstappen bijwerken (vervangt de versie van 005): enkel de serverfunctie, per lezing.
--   p_lezing      het nummer van mt_lezing_start. Enkel de lezing met het hoogste nummer, die nog bezig
--                 is, wijzigt iets: elke andere is ingehaald of afgesloten (MT409).
--   p_uitstappen  een deel van de uitstappen
--   p_alle_ids    bij het laatste deel: de volledige lijst van id's in de uitstappentool. Wat daar
--                 niet meer in staat, is "niet gevonden". Dat sluit de lezing af.
--   p_uitkomst    bij het laatste deel: wat de serverfunctie zelf weet (wat ze las, het overzicht). De
--                 databank voegt er de tellingen van alle delen bij, en bewaart het geheel.
-- Een lege lijst terwijl de MT uitstappen kent, is een fout, geen resultaat (17.3). Zouden er meer dan
-- mt_intern.max_verdwijnen() uitstappen verdwijnen die de MT nog meetelt, dan wordt er geen enkele
-- "niet gevonden": er komt één taak, en de beheerder bevestigt (B225).
drop function if exists public.mt_uitstappen_bijwerken(jsonb, text[]);
drop function if exists mt_intern.uitstappen_bijwerken(jsonb, text[]);
create or replace function mt_intern.uitstappen_bijwerken(p_lezing bigint, p_uitstappen jsonb, p_alle_ids text[] default null,
                                                          p_uitkomst jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_r jsonb;
  v_tel jsonb := jsonb_build_object('nieuw', 0, 'gewijzigd', 0, 'weg', 0, 'ongewijzigd', 0, 'ongeldig', 0, 'buiten', 0, 'geen', 0,
                                    'gesloten', 0);
  v_onbekend jsonb := '[]'::jsonb;
  v_wacht jsonb := '[]'::jsonb;
  v_weg integer := 0;
  v_tegengehouden integer := 0;
  v_lezing mt_intern.lezingen;
  v_verdwenen text[];
  v_lijst jsonb := '[]'::jsonb;
  v_taak uuid;
  v_jaar text;
  v_samen jsonb;
  v_uit jsonb;
  u record;
  r record;
begin
  perform mt_intern.eis_server();
  if p_lezing is null or p_uitstappen is null or jsonb_typeof(p_uitstappen) <> 'array' or jsonb_array_length(p_uitstappen) > 5000
     or (p_uitkomst is not null and (jsonb_typeof(p_uitkomst) <> 'object' or p_alle_ids is null or char_length(p_uitkomst::text) > 500000)) then
    raise exception 'MT: de lijst van uitstappen klopt niet' using errcode = '22023';
  end if;
  -- één deel tegelijk: twee lezingen die elkaar kruisen, maken een uitstap maar één keer aan
  perform pg_advisory_xact_lock(hashtext('mt_uitstappen_bijwerken'));

  -- Enkel de lezing die bezig is (R03, R2-08). Dat is altijd de nieuwste: een start breekt elke oudere af,
  -- en de databank laat er nooit twee tegelijk bezig zijn.
  select * into v_lezing from mt_intern.lezingen l where l.nummer = p_lezing;
  if v_lezing.nummer is null or v_lezing.stand <> 'bezig' then
    raise exception 'MT: deze lezing is ingehaald door een nieuwere, of al afgesloten. Er is niets gewijzigd.' using errcode = 'MT409';
  end if;

  for u in select e.rij from jsonb_array_elements(p_uitstappen) as e(rij)
  loop
    v_r := mt_intern.uitstap_bijwerken(u.rij);
    v_tel := jsonb_set(v_tel, array[v_r ->> 'wat'], to_jsonb((v_tel ->> (v_r ->> 'wat'))::integer + 1));
    if jsonb_array_length(coalesce(v_r -> 'onbekend', '[]'::jsonb)) > 0 then
      v_onbekend := v_onbekend || jsonb_build_object('uitstap', v_r ->> 'uitstap', 'schooljaar', v_r ->> 'schooljaar', 'klassen', v_r -> 'onbekend');
    end if;
    if coalesce((v_r ->> 'wacht')::boolean, false) then
      v_wacht := v_wacht || (v_r -> 'uitstap');
    end if;
  end loop;

  -- Wat de delen van deze lezing samen deden.
  v_samen := jsonb_build_object(
    'uitstappen', (select jsonb_object_agg(k.naam, coalesce((v_lezing.tellingen -> 'uitstappen' ->> k.naam)::integer, 0) + (v_tel ->> k.naam)::integer)
                     from jsonb_object_keys(v_tel) as k(naam)),
    'onbekende_klassen', coalesce(v_lezing.tellingen -> 'onbekende_klassen', '[]'::jsonb) || v_onbekend,
    'wacht', coalesce(v_lezing.tellingen -> 'wacht', '[]'::jsonb) || v_wacht);

  if p_alle_ids is null then
    update mt_intern.lezingen l set tellingen = v_samen where l.nummer = p_lezing;
    return v_tel || jsonb_build_object('niet_gevonden', 0, 'tegengehouden', 0, 'onbekende_klassen', v_onbekend, 'wacht', v_wacht);
  end if;

  -- Het laatste deel: wat staat er niet meer in de uitstappentool?
  if cardinality(p_alle_ids) = 0 and exists (
       select 1 from public.activiteiten a join public.schooljaren s on s.schooljaar = a.schooljaar
        where a.soort = 'uitstap' and s.stand in ('lopend', 'voorbij') and a.bron_stand = 'actief') then
    raise exception 'MT: de uitstappentool gaf geen enkele uitstap terug. Dat is een fout, geen resultaat; er is niets gewijzigd.'
      using errcode = 'MT422';
  end if;

  -- De rem (B225): de uitstappen die de MT nog meetelt en die uit de lijst verdwenen.
  select coalesce(array_agg(a.uitstap_id order by a.uitstap_id), '{}'::text[]), max(a.schooljaar) into v_verdwenen, v_jaar
    from public.activiteiten a join public.schooljaren s on s.schooljaar = a.schooljaar
   where a.soort = 'uitstap' and s.stand in ('lopend', 'voorbij') and a.bron_stand = 'actief' and a.uitstap_id <> all (p_alle_ids);
  if cardinality(v_verdwenen) > mt_intern.max_verdwijnen() then
    -- Ongewoon veel tegelijk: de MT neemt het niet over. Eén open taak, met de lijst van nu.
    v_tegengehouden := cardinality(v_verdwenen);
    select t.id into v_taak from public.taken t where t.soort = 'veel_verdwenen' and t.stand = 'open' order by t.aangemaakt_op limit 1 for update;
    if v_taak is null then
      perform mt_intern.taak_maken(v_jaar, 'veel_verdwenen', 'veel_verdwenen:' || p_lezing, null, null, null,
                                   jsonb_build_object('uitstappen', to_jsonb(v_verdwenen), 'lezing', p_lezing));
      select t.id into v_taak from public.taken t where t.sleutel = 'veel_verdwenen:' || p_lezing;
    else
      update public.taken t set gegevens = jsonb_build_object('uitstappen', to_jsonb(v_verdwenen), 'lezing', p_lezing) where t.id = v_taak;
    end if;
    -- Welke het zijn, voor wie ze nakijkt: de datum en de klassen. De titel kent de MT niet. Hoogstens vijftig:
    -- het aantal staat in "tegengehouden".
    select coalesce(jsonb_agg(jsonb_build_object('uitstap', x.uitstap_id, 'van', x.datum_start, 'tot', x.datum_eind, 'klassen', x.klassen)
                              order by x.datum_start, x.uitstap_id), '[]'::jsonb) into v_lijst
      from (select a.uitstap_id, a.datum_start, a.datum_eind,
                   (select coalesce(jsonb_agg(k.naam order by k.naam), '[]'::jsonb)
                      from public.klaslijsten l join public.klassen k on k.id = l.klas_id
                     where l.activiteit_id = a.id and not l.vervallen) as klassen
              from public.activiteiten a
             where a.soort = 'uitstap' and a.uitstap_id = any (v_verdwenen)
             order by a.datum_start, a.uitstap_id limit 50) x;
  else
    -- Staat er nog een taak open van een vorige lezing, dan is ze opgelost: de uitstappen zijn terug.
    update public.taken t
       set stand = 'afgehandeld', afgehandeld_op = now(), afgehandeld_door = auth.uid(), afhandeling = 'hersteld'
     where t.soort = 'veel_verdwenen' and t.stand = 'open';
    for r in select a.id, a.schooljaar from public.activiteiten a join public.schooljaren s on s.schooljaar = a.schooljaar
              where a.soort = 'uitstap' and s.stand in ('lopend', 'voorbij')
                and a.bron_stand is distinct from 'niet_gevonden' and a.uitstap_id <> all (p_alle_ids)
              order by a.id for no key update of a
    loop
      update public.activiteiten a set bron_stand = 'niet_gevonden' where a.id = r.id;
      if mt_intern.heeft_gegevens(r.id) then
        -- het nummer van de lezing in de sleutel: verdwijnt de uitstap later opnieuw, dan komt er opnieuw een taak (R2-07)
        perform mt_intern.taak_maken(r.schooljaar, 'uitstap_weg', 'uitstap_weg:' || r.id || ':niet_gevonden:' || p_lezing,
                                     r.id, null, null, jsonb_build_object('reden', 'niet_gevonden'));
      end if;
      v_weg := v_weg + 1;
    end loop;
  end if;

  -- De lezing afsluiten: wat de pagina te zien krijgt, nu en bij wie binnen de dertig seconden vraagt.
  v_uit := coalesce(p_uitkomst, '{}'::jsonb) || jsonb_build_object(
    'lezing', p_lezing,
    'klaar_op', now(),
    'duur_ms', round(extract(epoch from clock_timestamp() - v_lezing.begonnen_op) * 1000)::integer,
    'uitstappen', (v_samen -> 'uitstappen') || jsonb_build_object('niet_gevonden', v_weg, 'tegengehouden', v_tegengehouden),
    'verdwenen_taak', v_taak,
    'verdwenen', v_lijst,
    'onbekende_klassen', v_samen -> 'onbekende_klassen',
    'wacht', v_samen -> 'wacht');
  update mt_intern.lezingen l set stand = 'klaar', klaar_op = now(), tellingen = v_samen, uitkomst = v_uit where l.nummer = p_lezing;
  return v_tel || jsonb_build_object('niet_gevonden', v_weg, 'tegengehouden', v_tegengehouden, 'onbekende_klassen', v_onbekend,
                                     'wacht', v_wacht, 'uitkomst', v_uit);
end
$$;
revoke all on function mt_intern.uitstappen_bijwerken(bigint, jsonb, text[], jsonb) from public;

-- ============================================================================================
-- 4. De rem, bevestigd door de beheerder (B225)
-- ============================================================================================
-- "Ze zijn echt weg": de beheerder keek de uitstappentool na. De uitstappen van de taak worden "niet
-- gevonden", met een taak per uitstap waar al iets aan hing. p_aantal is het aantal dat het scherm
-- toonde: wijzigde de lijst intussen, dan gebeurt er niets (MT409). Komt een uitstap toch terug, dan
-- zet de volgende lezing haar weer actief.
create or replace function mt_intern.verdwenen_bevestigen(p_taak uuid, p_aantal integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_taak public.taken;
  v_ids text[];
  v_n integer := 0;
  r record;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  perform pg_advisory_xact_lock(hashtext('mt_uitstappen_bijwerken'));
  select * into v_taak from public.taken t where t.id = p_taak for update;
  if v_taak.id is null or v_taak.soort <> 'veel_verdwenen' then
    raise exception 'MT: deze taak bestaat niet' using errcode = 'MT422';
  end if;
  if v_taak.stand <> 'open' then
    raise exception 'MT: deze taak is al afgehandeld' using errcode = 'MT409';
  end if;
  select coalesce(array_agg(x.id), '{}'::text[]) into v_ids
    from jsonb_array_elements_text(case when jsonb_typeof(v_taak.gegevens -> 'uitstappen') = 'array' then v_taak.gegevens -> 'uitstappen' else '[]'::jsonb end) as x(id);
  if p_aantal is null or p_aantal <> cardinality(v_ids) then
    raise exception 'MT: de lijst wijzigde intussen. Lees opnieuw; er is niets gewijzigd.' using errcode = 'MT409';
  end if;
  for r in select a.id, a.schooljaar from public.activiteiten a join public.schooljaren s on s.schooljaar = a.schooljaar
            where a.soort = 'uitstap' and s.stand in ('lopend', 'voorbij') and a.bron_stand = 'actief' and a.uitstap_id = any (v_ids)
            order by a.id for no key update of a
  loop
    update public.activiteiten a set bron_stand = 'niet_gevonden' where a.id = r.id;
    if mt_intern.heeft_gegevens(r.id) then
      perform mt_intern.taak_maken(r.schooljaar, 'uitstap_weg', 'uitstap_weg:' || r.id || ':niet_gevonden:bevestigd:' || p_taak,
                                   r.id, null, null, jsonb_build_object('reden', 'niet_gevonden'));
    end if;
    v_n := v_n + 1;
  end loop;
  update public.taken t
     set stand = 'afgehandeld', afgehandeld_op = now(), afgehandeld_door = auth.uid(), afhandeling = 'bevestigd',
         afhandeling_gegevens = jsonb_build_object('niet_gevonden', v_n)
   where t.id = p_taak;
  -- wat de laatste lezing toonde, klopt niet meer: de volgende vraag leest meteen opnieuw
  update mt_intern.lezingen l set verouderd = true where l.stand = 'klaar' and not l.verouderd;
  return jsonb_build_object('niet_gevonden', v_n);
end
$$;
revoke all on function mt_intern.verdwenen_bevestigen(uuid, integer) from public;

-- ============================================================================================
-- 5. De doorgeefluiken, de rechten en de controle op de functies
-- ============================================================================================
-- Zoals in 003, 004 en 005. Erbij: twee functies voor de serverfunctie (een lezing starten en
-- stoppen) en één voor de pagina (de rem bevestigen). Samen: 26 voor de pagina, 7 voor de serverfuncties.

do $$
declare
  r record;
  v_door text;
  v_voor text;
begin
  for r in
    select p.proname, p.provolatile, p.pronargs,
           pg_get_function_arguments(p.oid) as invoer,
           pg_get_function_identity_arguments(p.oid) as soorten,
           pg_get_function_result(p.oid) as uitvoer
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'mt_intern'
       and p.proname = any (array['uitstappen_bijwerken', 'lezing_start', 'lezing_stop', 'verdwenen_bevestigen'])
  loop
    v_voor := case when r.proname = 'verdwenen_bevestigen' then 'authenticated' else 'service_role' end;
    select coalesce(string_agg('$' || i, ', ' order by i), '') into v_door from generate_series(1, r.pronargs) as i;
    execute format('create or replace function public.%I(%s) returns %s language sql %s set search_path = '''' as $w$ select mt_intern.%I(%s) $w$',
                   'mt_' || r.proname, r.invoer, r.uitvoer, case r.provolatile when 's' then 'stable' else 'volatile' end, r.proname, v_door);
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated, service_role', 'mt_' || r.proname, r.soorten);
    execute format('grant execute on function public.%I(%s) to %I', 'mt_' || r.proname, r.soorten, v_voor);
    execute format('revoke all on function mt_intern.%I(%s) from public, anon, authenticated, service_role', r.proname, r.soorten);
    execute format('grant execute on function mt_intern.%I(%s) to %I', r.proname, r.soorten, v_voor);
  end loop;
end
$$;

-- De controle op de functies (vervangt de versie van 005): dezelfde regels, met de drie nieuwe
-- functies op de lijsten.
create or replace function mt_intern.controleer_functies() returns text
language sql stable set search_path = '' as $$
  with pagina(naam) as (values
         ('status_bewaren'), ('deelname_bewaren'), ('opmerking_bewaren'), ('bevestigen'), ('heropenen'),
         ('wijziging_aanvragen'), ('aanvraag_intrekken'), ('aanvraag_behandelen'), ('was_hij_mee'), ('taak_afhandelen'),
         ('klassen_bijwerken'), ('schooljaar_bevestigen'), ('leerlingen_doorvoeren'), ('lopende_activiteiten_aanmaken'),
         ('lopende_activiteit_behandelen'), ('beurten_plannen'), ('beurt_ging_niet_door'), ('lijst_totalen'),
         ('gebruikers_namen'), ('voorkeuren_bewaren'),
         ('account_start'), ('gebruiker_wijzigen'), ('klassen_toewijzen'), ('mijn_account'), ('account_afwijkingen'),
         ('verdwenen_bevestigen')),
       server(naam) as (values
         ('account_stand'), ('account_eigen_start'), ('account_klaar'), ('account_afgerond'), ('uitstappen_bijwerken'),
         ('lezing_start'), ('lezing_stop')),
       toegang(naam) as (values
         ('mt_mfa_ok'), ('mt_rol'), ('mt_is_beheerder'), ('mt_leest_alles'), ('mt_mijn_klassen'), ('mt_mijn_leerlingen'),
         ('mt_mijn_leerlingen_nu'), ('mt_mag_klas'), ('mt_mag_lijst'), ('mt_mag_bevestiging'), ('mt_mag_aanvraag'),
         ('mt_mag_correctie'), ('vandaag')),
       f as (
         select p.oid, n.nspname::text as schema, p.proname::text as naam, p.prosecdef, p.prosrc, p.proconfig,
                case when n.nspname = 'public' and p.proname like 'mt\_%' then substr(p.proname, 4) else p.proname::text end as kort,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as gebruiker,
                has_function_privilege('service_role', p.oid, 'execute') as dienst
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'mt_intern') and p.prorettype <> 'trigger'::regtype
            and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'))
  select string_agg(x.fout, '; ' order by x.fout)
    from (
      select f.oid::regprocedure::text || ' staat in public, maar niet op de lijst' as fout
        from f
       where f.schema = 'public' and (f.anon or f.gebruiker or f.dienst) and f.naam <> 'mt_ping'
         and not (f.naam like 'mt\_%' and f.kort in (select naam from pagina union all select naam from server))
      union all
      select 'mt_' || l.naam || ': er hoort precies één doorgeefluik en één functie te zijn'
        from (select naam from pagina union all select naam from server) l
       where (select count(*) from f where f.schema = 'public' and f.naam = 'mt_' || l.naam) <> 1
          or (select count(*) from f where f.schema = 'mt_intern' and f.naam = l.naam) <> 1
      union all
      select f.oid::regprocedure::text || ' in public is geen doorgeefluik'
        from f
       where f.schema = 'public' and f.naam like 'mt\_%' and f.naam <> 'mt_ping'
         and (f.prosecdef
              or f.prosrc !~ ('^\s*select mt_intern\.' || f.kort || '\((\$[0-9]+(, \$[0-9]+)*)?\)\s*$'))
      union all
      select f.oid::regprocedure::text || ' is uitvoerbaar voor anon'
        from f
       where f.anon and not (f.schema = 'public' and f.naam = 'mt_ping')
      union all
      select f.oid::regprocedure::text || ' is voor de pagina, maar heeft andere rechten'
        from f
       where f.kort in (select naam from pagina) and (f.schema = 'mt_intern' or f.naam like 'mt\_%')
         and (not f.gebruiker or f.dienst)
      union all
      select f.oid::regprocedure::text || ' is voor de serverfunctie, maar heeft andere rechten'
        from f
       where f.kort in (select naam from server) and (f.schema = 'mt_intern' or f.naam like 'mt\_%')
         and (not f.dienst or f.gebruiker)
      union all
      select f.oid::regprocedure::text || ' in mt_intern is uitvoerbaar via de API, maar staat op geen lijst'
        from f
       where f.schema = 'mt_intern' and (f.gebruiker or f.dienst)
         and f.naam not in (select naam from pagina union all select naam from server union all select naam from toegang)
      union all
      select f.oid::regprocedure::text || ' is een hulpfunctie van de toegang, maar uitvoerbaar voor de serverfunctie'
        from f
       where f.schema = 'mt_intern' and f.dienst and f.naam in (select naam from toegang)
      union all
      select f.oid::regprocedure::text || ' begint niet met de toegangscontrole'
        from f
       where f.schema = 'mt_intern' and f.naam in (select naam from pagina)
         and (not f.prosecdef
              or coalesce(substring(f.prosrc from '\mbegin\M(.*)$'), '') !~ '^\s+(v_rol\s*:=\s*|perform\s+)mt_intern\.eis_rol\(')
      union all
      select f.oid::regprocedure::text || ' begint niet met de controle op de serverfunctie'
        from f
       where f.schema = 'mt_intern' and f.naam in (select naam from server)
         and (not f.prosecdef
              or coalesce(substring(f.prosrc from '\mbegin\M(.*)$'), '') !~ '^\s+perform\s+mt_intern\.eis_server\(\)')
      union all
      select f.oid::regprocedure::text || ' omzeilt RLS zonder lege search_path'
        from f
       where f.prosecdef and not (coalesce(f.proconfig, '{}'::text[]) @> array['search_path=""'])
      union all
      select f.oid::regprocedure::text || ' leest al iets vóór de toegangscontrole'
        from f
       where f.schema = 'mt_intern' and f.naam in (select naam from pagina union all select naam from server)
         and coalesce(substring(f.prosrc from '^(.*?)\mbegin\M'), '') ~* '\m(select|from|perform)\M'
      union all
      select f.oid::regprocedure::text || ' vangt een geweigerde toegang op'
        from f
       where f.schema = 'mt_intern' and f.naam in (select naam from pagina union all select naam from server)
         and f.prosrc ~* '\mwhen\s+(others|insufficient_privilege|sqlstate\s+''42501'')'
      union all
      select 'de view public.' || c.relname || ' hoort niet in public'
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('v', 'm')
    ) x
$$;
revoke all on function mt_intern.controleer_functies() from public;

insert into mt_intern.scripts (nummer, naam) values (6, '006_review2')
on conflict (nummer) do update set laatst_op = now(), keren = mt_intern.scripts.keren + 1;

-- ============================================================================================
-- 6. De controles, in dezelfde transactie: lukt er één niet, dan wordt niets bewaard
-- ============================================================================================

do $$
declare
  v_fout text;
  v_n integer;
begin
  v_fout := mt_intern.controleer_functies();
  if v_fout is not null then
    raise exception 'MT 006: %', v_fout;
  end if;

  -- De serverfunctie, anon en "iedereen": geen enkel recht op een tabel, een kolom of een reeks van de MT.
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
    raise exception 'MT 006: een rol van de API heeft rechten op: %', v_fout;
  end if;

  -- De lezingen: enkel via de functies.
  if not (select c.relrowsecurity from pg_class c where c.oid = 'mt_intern.lezingen'::regclass) then
    raise exception 'MT 006: de tabel van de lezingen staat open';
  end if;

  -- De oude vorm van het bijwerken bestaat niet meer: zonder nummer van een lezing wijzigt niets.
  if to_regprocedure('public.mt_uitstappen_bijwerken(jsonb, text[])') is not null
     or to_regprocedure('mt_intern.uitstappen_bijwerken(jsonb, text[])') is not null then
    raise exception 'MT 006: de uitstappen bijwerken kan nog zonder lezing';
  end if;

  -- Een lezing starten, stoppen en bijwerken: enkel de serverfunctie. De rem bevestigen: enkel de pagina.
  if has_function_privilege('authenticated', 'public.mt_uitstappen_bijwerken(bigint, jsonb, text[], jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.mt_lezing_start(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.mt_lezing_stop(bigint, text)', 'execute')
     or has_function_privilege('service_role', 'public.mt_verdwenen_bevestigen(uuid, integer)', 'execute') then
    raise exception 'MT 006: een functie van de lezingen heeft andere rechten dan bedoeld';
  end if;

  -- Wat 002 vastlegde, geldt nog: authenticated schrijft enkel in de 22 beheertabellen.
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
          or has_any_column_privilege('authenticated', c.oid, 'insert, update'));
  if v_n <> 22 then
    raise exception 'MT 006: authenticated kan schrijven in % tabellen in plaats van 22', v_n;
  end if;
end
$$;

commit;

-- De Data API kent de nieuwe functies meteen.
notify pgrst, 'reload schema';

-- Het resultaat: elke regel moet OK tonen.
select c.controle, c.resultaat
from (values
  (1, 'Scripts 001 tot 006 geregistreerd',
      (select case when count(*) = 6 then 'OK' else 'FOUT' end from mt_intern.scripts where nummer in (1, 2, 3, 4, 5, 6))),
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
  (5, 'De uitstappen bijwerken: enkel per lezing, met een volgnummer',
      case when to_regprocedure('public.mt_uitstappen_bijwerken(jsonb, text[])') is null
            and to_regprocedure('public.mt_uitstappen_bijwerken(bigint, jsonb, text[], jsonb)') is not null then 'OK' else 'FOUT' end),
  (6, 'De lezingen: enkel bereikbaar via de functies',
      (select case when c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'select')
                        and not has_table_privilege('service_role', c.oid, 'select') then 'OK' else 'FOUT' end
         from pg_class c where c.oid = 'mt_intern.lezingen'::regclass)),
  (7, 'De rem: hoogstens vijf uitstappen verdwijnen zonder vraag',
      case when mt_intern.max_verdwijnen() = 5 then 'OK' else 'FOUT' end),
  (8, 'Rechtstreeks schrijven nog altijd enkel in de 22 beheertabellen',
      (select case when count(*) = 22 then 'OK' else 'FOUT: ' || count(*) end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
               or has_any_column_privilege('authenticated', c.oid, 'insert, update'))))
) as c(nr, controle, resultaat)
order by c.nr;
