-- MT · sql/003_functies.sql · versie 0.3.0
-- Stap 1b van fase 1 (63.8 en hoofdstuk 64 van het ontwerpdocument): de databankfuncties van fase 1.
-- Alles wat een leerkracht schrijft, en elk beslismoment van de beheerder, loopt via deze functies.
--
-- Zo voer je het uit: Supabase → project mt-test → SQL Editor → New query → dit hele bestand
-- plakken → Run. Onderaan verschijnt een kleine tabel: elke regel moet OK tonen.
--
-- Enkel toevoegend en herhaalbaar: opnieuw uitvoeren mag, zolang er geen later script uitgevoerd is.
-- Alles-of-niets: lukt een controle niet, dan wordt niets bewaard en toont de editor een fout die
-- begint met "MT 003" (17.12).
--
-- Opbouw:
--    1. de volgorde                              7. schooljaar, klassen en leerlingen
--    2. twee kolommen erbij                      8. lopende activiteiten
--    3. hulpfuncties                             9. lezen: totalen, namen en voorkeuren
--    4. aanwezigheden                           10. de doorgeefluiken en de rechten
--    5. taken en "Was hij mee?"                 11. de controles
--    6. uitstappen uit de uitstappentool
--
-- Hoe een functie bereikbaar is (regel 5 van 17.1):
--   - de functie zelf staat in het afgeschermde schema mt_intern, met security definer en een vaste
--     search_path, en begint met de toegangscontrole (eis_rol): zonder geldige tweestapsverificatie
--     of met de verkeerde rol gebeurt er niets;
--   - de pagina roept ze op via een doorgeefluik in public (mt_…), dat zelf niets mag en niets doet
--     dan doorgeven. Deel 10 maakt die doorgeefluiken uit één lijst.
--
-- De foutcodes, zodat de pagina weet wat er scheelt zonder de tekst te lezen:
--   42501  geen rechten;
--   MT409  de stand wijzigde intussen: herlaad en kijk opnieuw na, er is niets overschreven;
--   MT422  het kan niet, om een reden die de tekst uitlegt;
--   22023  een oproep die niet klopt (een fout in de pagina, niet van de gebruiker).

begin;

-- ============================================================================================
-- 1. De volgorde
-- ============================================================================================

do $$
begin
  if to_regclass('mt_intern.scripts') is null then
    raise exception 'MT 003: voer eerst sql/002_databank.sql uit';
  end if;
end
$$;

do $$
declare
  v_laatste integer;
begin
  select max(nummer) into v_laatste from mt_intern.scripts;
  if v_laatste is null or v_laatste < 2 then
    raise exception 'MT 003: voer eerst sql/002_databank.sql uit';
  end if;
  if v_laatste > 3 then
    raise exception 'MT 003: script % is al uitgevoerd. Voer 003 niet opnieuw uit.', v_laatste;
  end if;
end
$$;

-- ============================================================================================
-- 2. Twee kolommen erbij
-- ============================================================================================

-- De stand van de planning zoals ze laatst waargenomen werd in de uitstappentool: aangevraagd,
-- bevestigd of geannuleerd. Zo kan de databank zelf weigeren om een klas te bevestigen van een
-- uitstap die nog niet bevestigd is (B20), en weet ze welke lijsten nog te doen zijn (B171).
alter table public.activiteiten add column if not exists bron_plan text;

-- Een klas die in de uitstappentool niet meer bij de uitstap staat, terwijl er al aanwezigheden of
-- een bevestiging waren: de lijst blijft bewaard, maar telt niet meer mee (B14, B67).
alter table public.klaslijsten add column if not exists vervallen boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'activiteiten_bron_plan') then
    alter table public.activiteiten add constraint activiteiten_bron_plan
      check ((bron_plan is null or bron_plan in ('aangevraagd', 'bevestigd', 'geannuleerd'))
             and (soort = 'uitstap' or bron_plan is null));
  end if;
end
$$;

-- ============================================================================================
-- 3. Hulpfuncties
-- ============================================================================================
-- Geen enkele hulpfunctie krijgt rechten: enkel de functies van dit script roepen ze op.

-- De toegangscontrole: de eerste regel van elke functie die een gebruiker kan oproepen. Geeft de rol
-- terug; zonder geldige tweestapsverificatie of met een andere rol stopt alles hier.
create or replace function mt_intern.eis_rol(variadic p_rollen text[]) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_rol text := mt_intern.mt_rol();
begin
  if v_rol is null or not (v_rol = any (p_rollen)) then
    raise exception 'MT: geen rechten voor deze handeling' using errcode = '42501';
  end if;
  return v_rol;
end
$$;
revoke all on function mt_intern.eis_rol(text[]) from public;

-- Het schooljaar van een dag: van 1 september tot 31 augustus, zoals in de uitstappentool.
create or replace function mt_intern.schooljaar_van(p_dag date) returns text
language sql immutable set search_path = '' as $$
  select case when extract(month from p_dag) >= 9
              then extract(year from p_dag)::integer || '-' || (extract(year from p_dag)::integer + 1)
              else (extract(year from p_dag)::integer - 1) || '-' || extract(year from p_dag)::integer end
$$;
revoke all on function mt_intern.schooljaar_van(date) from public;

-- Neemt het slot op een lijst, en kijkt de rechten na terwijl het slot er ligt. Zo is er geen
-- wedloop tussen een tik en een bevestiging (T2). Bestaat de lijst niet, of mag het niet: dezelfde fout.
create or replace function mt_intern.lijst_slot(p_activiteit uuid, p_klas uuid) returns public.klaslijsten
language plpgsql set search_path = '' as $$
declare
  v_lijst public.klaslijsten;
begin
  select * into v_lijst from public.klaslijsten l
   where l.activiteit_id = p_activiteit and l.klas_id = p_klas for update;
  if not found or not mt_intern.mt_mag_lijst(p_activiteit, p_klas) then
    raise exception 'MT: geen rechten voor deze lijst' using errcode = '42501';
  end if;
  return v_lijst;
end
$$;
revoke all on function mt_intern.lijst_slot(uuid, uuid) from public;

-- Een lijst die niet meer meetelt, wijzigt niet meer: de klas staat niet meer bij de uitstap, of de
-- uitstap is verwijderd, omgezet naar een nascholing of geannuleerd (B14).
create or replace function mt_intern.eis_lijst_actief(p_lijst public.klaslijsten, p_act public.activiteiten) returns void
language plpgsql set search_path = '' as $$
begin
  if p_lijst.vervallen then
    raise exception 'MT: deze klas staat in de uitstappentool niet meer bij de uitstap' using errcode = 'MT422';
  end if;
  if p_act.soort = 'uitstap' and (p_act.bron_stand is distinct from 'actief' or p_act.bron_plan = 'geannuleerd') then
    raise exception 'MT: deze uitstap is in de uitstappentool geannuleerd of verwijderd' using errcode = 'MT422';
  end if;
end
$$;
revoke all on function mt_intern.eis_lijst_actief(public.klaslijsten, public.activiteiten) from public;

-- Gaat de leerling voor deze activiteit al mee met zijn eigen klas van die dag?
create or replace function mt_intern.gaat_mee_met_klas(p_activiteit uuid, p_leerling uuid, p_dag date) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.klaslijsten l
      join public.klasindelingen ki on ki.klas_id = l.klas_id
     where l.activiteit_id = p_activiteit and not l.vervallen
       and ki.leerling_id = p_leerling and ki.van <= p_dag and p_dag < ki.einde)
$$;
revoke all on function mt_intern.gaat_mee_met_klas(uuid, uuid, date) from public;

-- Wie op een lijst staat (V7, B67, B143):
--   - bevestigd: het bewijs van toen, met wie later toegevoegd werd;
--   - open, een gewone klas: wie op de (eerste) dag van de activiteit in de klas zat;
--   - open, een klas uit de groep Andere: de deelnemerslijst, zonder wie al met zijn eigen klas meegaat.
create or replace function mt_intern.lijst_leerlingen(p_activiteit uuid, p_klas uuid)
returns table (leerling_id uuid, klasnummer integer)
language sql stable set search_path = '' as $$
  select bl.leerling_id, bl.klasnummer
    from public.klaslijsten l
    join public.bevestiging_leerlingen bl on bl.bevestiging_id = l.bevestiging_id
   where l.activiteit_id = p_activiteit and l.klas_id = p_klas and l.stand = 'bevestigd'
  union all
  select ki.leerling_id, ki.klasnummer
    from public.klaslijsten l
    join public.activiteiten a on a.id = l.activiteit_id
    join public.klassen k on k.id = l.klas_id and k.groep <> 'Andere'
    join public.klasindelingen ki on ki.klas_id = l.klas_id and ki.van <= a.datum_start and a.datum_start < ki.einde
   where l.activiteit_id = p_activiteit and l.klas_id = p_klas and l.stand = 'open'
  union all
  select d.leerling_id, 0
    from public.klaslijsten l
    join public.activiteiten a on a.id = l.activiteit_id
    join public.klassen k on k.id = l.klas_id and k.groep = 'Andere'
    join public.deelnemers d on d.activiteit_id = l.activiteit_id and d.klas_id = l.klas_id
   where l.activiteit_id = p_activiteit and l.klas_id = p_klas and l.stand = 'open'
     and not mt_intern.gaat_mee_met_klas(l.activiteit_id, d.leerling_id, a.datum_start)
$$;
revoke all on function mt_intern.lijst_leerlingen(uuid, uuid) from public;

-- De revisie van een lijst gaat omhoog bij elke wijziging (T2).
create or replace function mt_intern.revisie_omhoog(p_activiteit uuid, p_klas uuid) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_revisie bigint;
begin
  update public.klaslijsten l set revisie = l.revisie + 1, gewijzigd_op = now()
   where l.activiteit_id = p_activiteit and l.klas_id = p_klas
  returning l.revisie into v_revisie;
  return v_revisie;
end
$$;
revoke all on function mt_intern.revisie_omhoog(uuid, uuid) from public;

-- Hangt er al iets aan een activiteit, of aan één van haar lijsten?
create or replace function mt_intern.heeft_gegevens(p_activiteit uuid, p_klas uuid default null) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.afwezigheden x where x.activiteit_id = p_activiteit and (p_klas is null or x.klas_id = p_klas))
      or exists (select 1 from public.deelname x where x.activiteit_id = p_activiteit and (p_klas is null or x.klas_id = p_klas))
      or exists (select 1 from public.opmerkingen x where x.activiteit_id = p_activiteit and (p_klas is null or x.klas_id = p_klas))
      or exists (select 1 from public.deelnemers x where x.activiteit_id = p_activiteit and (p_klas is null or x.klas_id = p_klas))
      or exists (select 1 from public.bevestigingen x where x.activiteit_id = p_activiteit and (p_klas is null or x.klas_id = p_klas))
      or (p_klas is null and (
            exists (select 1 from public.tussenkomsten x where x.activiteit_id = p_activiteit)
         or exists (select 1 from public.annulering_betalers x where x.activiteit_id = p_activiteit)
         or exists (select 1 from public.correcties x where x.activiteit_id = p_activiteit)
         or exists (select 1 from public.facturatieregels x where x.activiteit_id = p_activiteit)
         or exists (select 1 from public.afwijkingen x where x.activiteit_id = p_activiteit)))
$$;
revoke all on function mt_intern.heeft_gegevens(uuid, uuid) from public;

-- Ligt er al een beslismoment vast: een bevestigde klas of een facturatie (B67)?
create or replace function mt_intern.ligt_vast(p_activiteit uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.klaslijsten l where l.activiteit_id = p_activiteit and l.stand = 'bevestigd' and not l.vervallen)
      or exists (select 1 from public.facturatieregels r where r.activiteit_id = p_activiteit)
$$;
revoke all on function mt_intern.ligt_vast(uuid) from public;

-- Een taak voor de beheerder. De sleutel maakt ze uniek: dezelfde aanleiding geeft nooit twee taken.
create or replace function mt_intern.taak_maken(p_schooljaar text, p_soort text, p_sleutel text, p_activiteit uuid,
                                                p_klas uuid, p_leerling uuid, p_gegevens jsonb) returns boolean
language plpgsql set search_path = '' as $$
begin
  insert into public.taken (schooljaar, soort, sleutel, activiteit_id, klas_id, leerling_id, gegevens, aangemaakt_door)
  values (p_schooljaar, p_soort, p_sleutel, p_activiteit, p_klas, p_leerling, coalesce(p_gegevens, '{}'::jsonb), auth.uid())
  on conflict (sleutel) do nothing;
  return found;
end
$$;
revoke all on function mt_intern.taak_maken(text, text, text, uuid, uuid, uuid, jsonb) from public;

-- De klassen waarvoor een leerkracht nu mag werken (vervangt de versie van 002, strenger). Een
-- schooljaar dat voorbij is, telt enkel nog zolang er voor haar klas een lijst te doen is: open, niet
-- vervallen, en van een beurt of van een uitstap die bevestigd is in de uitstappentool. Een open
-- lijst van een geannuleerde of verwijderde uitstap houdt het vorige schooljaar dus niet open (B171).
create or replace function mt_intern.mt_mijn_klassen() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(t.klas_id), '{}'::uuid[])
    from public.klastoewijzingen t
    join public.schooljaren s on s.schooljaar = t.schooljaar
   where t.gebruiker_id = auth.uid()
     and (select mt_intern.mt_rol()) = 'leerkracht'
     and (s.stand = 'lopend'
          or (s.stand = 'voorbij'
              and exists (select 1 from public.klaslijsten l
                            join public.activiteiten a on a.id = l.activiteit_id
                           where l.klas_id = t.klas_id and l.stand = 'open' and not l.vervallen
                             and (a.soort = 'beurt' or (a.bron_stand = 'actief' and a.bron_plan = 'bevestigd')))))
$$;
revoke all on function mt_intern.mt_mijn_klassen() from public;

-- ============================================================================================
-- 4. Aanwezigheden (7, T2, B20, B34, B67, B86, B109, B113)
-- ============================================================================================

-- Een status bewaren: één dag, of meerdere dagen van dezelfde leerling in één keer ("Op alle dagen",
-- B133). Elke tik wordt meteen bewaard (B34); de revisie komt terug.
--   - Een open lijst: de leerkracht van de klas of de beheerder.
--   - Een bevestigde lijst: enkel de beheerder, rechtstreeks (B113). De wijziging komt erbij in
--     "wijzigingen", met de vorige status en de reden; het bewijs van de bevestiging blijft.
-- p_statussen: [{"dag": "2026-11-10", "status": "<id>"}]. "Aanwezig" wist de uitzondering (V7).
create or replace function mt_intern.status_bewaren(p_activiteit uuid, p_klas uuid, p_leerling uuid,
                                                    p_statussen jsonb, p_reden text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_lijst public.klaslijsten;
  v_act public.activiteiten;
  v_status public.statussen;
  v_reden text := nullif(btrim(coalesce(p_reden, '')), '');
  v_aanwezig uuid;
  v_oud uuid;
  v_gezien date[] := '{}';
  v_n integer := 0;
  v_revisie bigint;
  r record;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht');
  v_lijst := mt_intern.lijst_slot(p_activiteit, p_klas);
  select * into v_act from public.activiteiten a where a.id = p_activiteit;
  perform mt_intern.eis_lijst_actief(v_lijst, v_act);
  if v_lijst.stand = 'bevestigd' and v_rol <> 'beheerder' then
    raise exception 'MT: de aanwezigheden van deze klas zijn bevestigd. Vraag een wijziging aan.' using errcode = 'MT422';
  end if;
  if mt_intern.vandaag() < v_act.datum_start then
    raise exception 'MT: aanwezigheden ingeven kan pas vanaf de dag van de activiteit' using errcode = 'MT422';
  end if;
  if not exists (select 1 from mt_intern.lijst_leerlingen(p_activiteit, p_klas) x where x.leerling_id = p_leerling) then
    raise exception 'MT: deze leerling staat niet op de lijst van deze klas' using errcode = 'MT422';
  end if;
  if exists (select 1 from public.deelname d
              where d.activiteit_id = p_activiteit and d.leerling_id = p_leerling and d.klas_id = p_klas) then
    raise exception 'MT: deze leerling neemt niet deel' using errcode = 'MT422';
  end if;
  if p_statussen is null or jsonb_typeof(p_statussen) <> 'array' or jsonb_array_length(p_statussen) not between 1 and 60 then
    raise exception 'MT: geen status meegegeven' using errcode = '22023';
  end if;
  select s.id into v_aanwezig from public.statussen s where s.soort = 'aanwezig';

  for r in select (e.rij ->> 'dag')::date as dag, (e.rij ->> 'status')::uuid as status
             from jsonb_array_elements(p_statussen) as e(rij)
  loop
    if r.dag is null or r.status is null or r.dag < v_act.datum_start or r.dag > v_act.datum_eind or r.dag = any (v_gezien) then
      raise exception 'MT: de dag hoort niet bij deze activiteit, of staat er twee keer' using errcode = '22023';
    end if;
    v_gezien := v_gezien || r.dag;
    select * into v_status from public.statussen s where s.id = r.status;
    if not found then
      raise exception 'MT: deze status bestaat niet' using errcode = '22023';
    end if;
    select af.status_id into v_oud from public.afwezigheden af
     where af.activiteit_id = p_activiteit and af.leerling_id = p_leerling and af.dag = r.dag;
    v_oud := coalesce(v_oud, v_aanwezig);
    if v_oud = v_status.id then
      continue;
    end if;
    if not v_status.actief then
      raise exception 'MT: de status % staat uit', v_status.naam using errcode = 'MT422';
    end if;
    if v_status.soort = 'te_bepalen' and v_lijst.stand = 'bevestigd' then
      raise exception 'MT: na de bevestiging kan een leerling niet terug naar "nog te bepalen"' using errcode = 'MT422';
    end if;
    if v_act.ging_niet_door is not null
       and not (v_status.soort = 'aanwezig' or (v_status.soort = 'afwezig' and not v_status.aangerekend)) then
      raise exception 'MT: deze beurt ging niet door. Kies enkel nog een status die niet aangerekend wordt, zoals een attest.'
        using errcode = 'MT422';
    end if;

    if v_status.soort = 'aanwezig' then
      delete from public.afwezigheden af
       where af.activiteit_id = p_activiteit and af.leerling_id = p_leerling and af.dag = r.dag;
    else
      insert into public.afwezigheden (activiteit_id, leerling_id, dag, klas_id, schooljaar, status_id, gewijzigd_op, gewijzigd_door)
      values (p_activiteit, p_leerling, r.dag, p_klas, v_lijst.schooljaar, v_status.id, now(), v_wie)
      on conflict (activiteit_id, leerling_id, dag) do update
        set status_id = excluded.status_id, klas_id = excluded.klas_id, gewijzigd_op = now(), gewijzigd_door = excluded.gewijzigd_door;
    end if;
    if v_lijst.stand = 'bevestigd' then
      insert into public.wijzigingen (bevestiging_id, activiteit_id, klas_id, schooljaar, leerling_id, wat, dag,
                                      oude_status_id, nieuwe_status_id, reden, gewijzigd_door)
      values (v_lijst.bevestiging_id, p_activiteit, p_klas, v_lijst.schooljaar, p_leerling, 'status', r.dag,
              v_oud, v_status.id, v_reden, v_wie);
    end if;
    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    v_revisie := mt_intern.revisie_omhoog(p_activiteit, p_klas);
  else
    v_revisie := v_lijst.revisie;
  end if;
  return jsonb_build_object('revisie', v_revisie, 'stand', v_lijst.stand, 'gewijzigd', v_n);
end
$$;
revoke all on function mt_intern.status_bewaren(uuid, uuid, uuid, jsonb, text) from public;

-- De deelname bij een meerdaagse uitstap (B109): wie niet meegaat, wordt uitgevinkt, zodra de uitstap
-- bevestigd is. De beheerder kan het ook na de bevestiging, bij elke activiteit (B113).
create or replace function mt_intern.deelname_bewaren(p_activiteit uuid, p_klas uuid, p_leerling uuid,
                                                      p_neemt_deel boolean, p_reden text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_lijst public.klaslijsten;
  v_act public.activiteiten;
  v_reden text := nullif(btrim(coalesce(p_reden, '')), '');
  v_nu boolean;
  v_revisie bigint;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht');
  v_lijst := mt_intern.lijst_slot(p_activiteit, p_klas);
  select * into v_act from public.activiteiten a where a.id = p_activiteit;
  perform mt_intern.eis_lijst_actief(v_lijst, v_act);
  if p_neemt_deel is null then
    raise exception 'MT: neemt de leerling deel of niet?' using errcode = '22023';
  end if;
  if v_lijst.stand = 'bevestigd' and v_rol <> 'beheerder' then
    raise exception 'MT: de aanwezigheden van deze klas zijn bevestigd. Vraag een wijziging aan.' using errcode = 'MT422';
  end if;
  if not (v_act.meerdaags or (v_rol = 'beheerder' and v_lijst.stand = 'bevestigd')) then
    raise exception 'MT: een leerling uitvinken kan enkel bij een meerdaagse uitstap (B109)' using errcode = 'MT422';
  end if;
  if v_act.soort = 'uitstap' and v_act.bron_plan is distinct from 'bevestigd' then
    raise exception 'MT: dat kan pas zodra de uitstap bevestigd is in de uitstappentool' using errcode = 'MT422';
  end if;
  if not exists (select 1 from mt_intern.lijst_leerlingen(p_activiteit, p_klas) x where x.leerling_id = p_leerling) then
    raise exception 'MT: deze leerling staat niet op de lijst van deze klas' using errcode = 'MT422';
  end if;
  if exists (select 1 from public.deelname d
              where d.activiteit_id = p_activiteit and d.leerling_id = p_leerling and d.klas_id <> p_klas) then
    raise exception 'MT: deze leerling staat voor deze activiteit ook op de bevestigde lijst van een andere klas. Heropen die klas eerst.'
      using errcode = 'MT422';
  end if;
  v_nu := not exists (select 1 from public.deelname d
                       where d.activiteit_id = p_activiteit and d.leerling_id = p_leerling and d.klas_id = p_klas);
  if v_nu = p_neemt_deel then
    return jsonb_build_object('revisie', v_lijst.revisie, 'stand', v_lijst.stand, 'gewijzigd', 0);
  end if;
  if p_neemt_deel then
    delete from public.deelname d where d.activiteit_id = p_activiteit and d.leerling_id = p_leerling;
  else
    insert into public.deelname (activiteit_id, leerling_id, klas_id, schooljaar, gewijzigd_op, gewijzigd_door)
    values (p_activiteit, p_leerling, p_klas, v_lijst.schooljaar, now(), v_wie);
  end if;
  if v_lijst.stand = 'bevestigd' then
    insert into public.wijzigingen (bevestiging_id, activiteit_id, klas_id, schooljaar, leerling_id, wat,
                                    oude_deelname, nieuwe_deelname, reden, gewijzigd_door)
    values (v_lijst.bevestiging_id, p_activiteit, p_klas, v_lijst.schooljaar, p_leerling, 'deelname',
            v_nu, p_neemt_deel, v_reden, v_wie);
  end if;
  v_revisie := mt_intern.revisie_omhoog(p_activiteit, p_klas);
  return jsonb_build_object('revisie', v_revisie, 'stand', v_lijst.stand, 'gewijzigd', 1);
end
$$;
revoke all on function mt_intern.deelname_bewaren(uuid, uuid, uuid, boolean, text) from public;

-- Een opmerking bewaren (B86): de opmerking van de leerkracht, zolang de klas niet bevestigd is, door
-- een leerkracht van de klas; de opmerking van de beheerder, altijd en enkel door de beheerder.
-- Een lege tekst wist de opmerking.
create or replace function mt_intern.opmerking_bewaren(p_activiteit uuid, p_klas uuid, p_leerling uuid,
                                                       p_soort text, p_tekst text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_lijst public.klaslijsten;
  v_act public.activiteiten;
  v_tekst text := btrim(coalesce(p_tekst, ''));
  v_oud text;
  v_revisie bigint;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht');
  v_lijst := mt_intern.lijst_slot(p_activiteit, p_klas);
  select * into v_act from public.activiteiten a where a.id = p_activiteit;
  perform mt_intern.eis_lijst_actief(v_lijst, v_act);
  if p_soort is null or p_soort not in ('leerkracht', 'beheerder') then
    raise exception 'MT: een opmerking is van de leerkracht of van de beheerder' using errcode = '22023';
  end if;
  if p_soort <> v_rol then
    raise exception 'MT: je wijzigt enkel je eigen soort opmerking (B86)' using errcode = '42501';
  end if;
  if p_soort = 'leerkracht' and v_lijst.stand = 'bevestigd' then
    raise exception 'MT: de aanwezigheden van deze klas zijn bevestigd. Vraag een wijziging aan.' using errcode = 'MT422';
  end if;
  if char_length(v_tekst) > 500 then
    raise exception 'MT: een opmerking telt hoogstens 500 tekens' using errcode = 'MT422';
  end if;
  if not exists (select 1 from mt_intern.lijst_leerlingen(p_activiteit, p_klas) x where x.leerling_id = p_leerling) then
    raise exception 'MT: deze leerling staat niet op de lijst van deze klas' using errcode = 'MT422';
  end if;
  select o.tekst into v_oud from public.opmerkingen o
   where o.activiteit_id = p_activiteit and o.leerling_id = p_leerling and o.soort = p_soort;
  if coalesce(v_oud, '') = v_tekst then
    return jsonb_build_object('revisie', v_lijst.revisie, 'stand', v_lijst.stand, 'gewijzigd', 0);
  end if;
  if v_tekst = '' then
    delete from public.opmerkingen o
     where o.activiteit_id = p_activiteit and o.leerling_id = p_leerling and o.soort = p_soort;
  else
    insert into public.opmerkingen (activiteit_id, leerling_id, soort, klas_id, schooljaar, tekst, gewijzigd_op, gewijzigd_door)
    values (p_activiteit, p_leerling, p_soort, p_klas, v_lijst.schooljaar, v_tekst, now(), v_wie)
    on conflict (activiteit_id, leerling_id, soort) do update
      set tekst = excluded.tekst, klas_id = excluded.klas_id, gewijzigd_op = now(), gewijzigd_door = excluded.gewijzigd_door;
  end if;
  v_revisie := mt_intern.revisie_omhoog(p_activiteit, p_klas);
  return jsonb_build_object('revisie', v_revisie, 'stand', v_lijst.stand, 'gewijzigd', 1);
end
$$;
revoke all on function mt_intern.opmerking_bewaren(uuid, uuid, uuid, text, text) from public;

-- Een klas bevestigen (B20, B39, B67, T2): één functie, die onder het slot van de lijst alles nakijkt
-- en dan in één keer vastlegt wie er op de lijst stond, met de status per dag, en de stand van de
-- uitstap zoals ze waargenomen werd.
--   - p_revisie: de revisie die het scherm toont. Wijkt ze af, dan is er intussen iets gewijzigd, en
--     gebeurt er niets (MT409). Zo legt een tik die nog onderweg is nooit een oude stand vast.
--   - p_uitstap_stand: wat de pagina in de uitstappentool zag. De databank kan dat niet zelf nagaan
--     (17.3); ze eist wel dat het dezelfde versie is als die de MT laatst verwerkte.
create or replace function mt_intern.bevestigen(p_activiteit uuid, p_klas uuid, p_revisie bigint,
                                                p_uitstap_stand jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_lijst public.klaslijsten;
  v_act public.activiteiten;
  v_jaar text;
  v_groep text;
  v_n integer;
  v_aanwezig uuid;
  v_bevestiging uuid := gen_random_uuid();
  v_revisie bigint;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht');
  v_lijst := mt_intern.lijst_slot(p_activiteit, p_klas);
  select * into v_act from public.activiteiten a where a.id = p_activiteit;
  perform mt_intern.eis_lijst_actief(v_lijst, v_act);
  if v_lijst.stand <> 'open' then
    raise exception 'MT: deze klas is al bevestigd' using errcode = 'MT409';
  end if;
  if p_revisie is null or p_revisie <> v_lijst.revisie then
    raise exception 'MT: de lijst wijzigde intussen. Kijk ze opnieuw na; er is niets bevestigd.' using errcode = 'MT409';
  end if;
  select s.stand into v_jaar from public.schooljaren s where s.schooljaar = v_lijst.schooljaar;
  if v_jaar is null or v_jaar not in ('lopend', 'voorbij') then
    raise exception 'MT: in dit schooljaar kan niets bevestigd worden' using errcode = 'MT422';
  end if;
  if mt_intern.vandaag() < v_act.datum_eind then
    raise exception 'MT: bevestigen kan pas vanaf de laatste dag van de activiteit' using errcode = 'MT422';
  end if;
  if v_act.soort = 'uitstap' then
    if v_act.bron_plan is distinct from 'bevestigd' then
      raise exception 'MT: de uitstap is nog niet bevestigd in de uitstappentool (B20)' using errcode = 'MT422';
    end if;
    if p_uitstap_stand is null or jsonb_typeof(p_uitstap_stand) <> 'object' or char_length(p_uitstap_stand::text) > 20000 then
      raise exception 'MT: de waargenomen stand van de uitstap ontbreekt' using errcode = '22023';
    end if;
    if (p_uitstap_stand ->> 'gewijzigd')::timestamptz is distinct from v_act.bron_gewijzigd_op then
      raise exception 'MT: de uitstap wijzigde in de uitstappentool. Ververs en kijk opnieuw na; er is niets bevestigd.'
        using errcode = 'MT409';
    end if;
  elsif not exists (select 1 from public.lopende_activiteiten la
                     where la.id = v_act.lopende_activiteit_id and la.stand = 'bevestigd') then
    raise exception 'MT: deze lopende activiteit is nog niet bevestigd' using errcode = 'MT422';
  end if;

  select k.groep into v_groep from public.klassen k where k.id = p_klas;
  select count(*) into v_n from mt_intern.lijst_leerlingen(p_activiteit, p_klas);
  if v_groep = 'Andere' and v_n = 0 then
    raise exception 'MT: stel eerst de deelnemers samen (B143)' using errcode = 'MT422';
  end if;
  select count(distinct af.leerling_id) into v_n
    from public.afwezigheden af
    join public.statussen s on s.id = af.status_id and s.soort = 'te_bepalen'
    join mt_intern.lijst_leerlingen(p_activiteit, p_klas) x on x.leerling_id = af.leerling_id
   where af.activiteit_id = p_activiteit and af.dag between v_act.datum_start and v_act.datum_eind
     and not exists (select 1 from public.deelname d
                      where d.activiteit_id = p_activiteit and d.leerling_id = af.leerling_id and d.klas_id = p_klas);
  if v_n > 0 then
    raise exception 'MT: % leerling(en) staan nog op "nog te bepalen" (B20)', v_n using errcode = 'MT422';
  end if;

  -- Het bewijs. Eerst wie er op de lijst staat: daarna is de lijst bevestigd, en leest ze uit dit bewijs.
  insert into public.bevestigingen (id, activiteit_id, klas_id, schooljaar, revisie, bevestigd_op, bevestigd_door, uitstap_stand)
  values (v_bevestiging, p_activiteit, p_klas, v_lijst.schooljaar, v_lijst.revisie + 1, now(), v_wie,
          case when v_act.soort = 'uitstap' then p_uitstap_stand end);
  insert into public.bevestiging_leerlingen (bevestiging_id, leerling_id, klasnummer, neemt_deel)
  select v_bevestiging, x.leerling_id, x.klasnummer,
         not exists (select 1 from public.deelname d
                      where d.activiteit_id = p_activiteit and d.leerling_id = x.leerling_id and d.klas_id = p_klas)
    from mt_intern.lijst_leerlingen(p_activiteit, p_klas) x;
  get diagnostics v_n = row_count;
  select s.id into v_aanwezig from public.statussen s where s.soort = 'aanwezig';
  insert into public.bevestiging_dagen (bevestiging_id, leerling_id, dag, status_id)
  select v_bevestiging, bl.leerling_id, d.dag::date, coalesce(af.status_id, v_aanwezig)
    from public.bevestiging_leerlingen bl
    cross join generate_series(v_act.datum_start::timestamp, v_act.datum_eind::timestamp, interval '1 day') as d(dag)
    left join public.afwezigheden af
      on af.activiteit_id = p_activiteit and af.leerling_id = bl.leerling_id and af.dag = d.dag::date
   where bl.bevestiging_id = v_bevestiging and bl.neemt_deel;
  update public.klaslijsten l
     set stand = 'bevestigd', bevestiging_id = v_bevestiging, revisie = l.revisie + 1, gewijzigd_op = now()
   where l.activiteit_id = p_activiteit and l.klas_id = p_klas
  returning l.revisie into v_revisie;
  return jsonb_build_object('revisie', v_revisie, 'stand', 'bevestigd', 'bevestiging', v_bevestiging, 'leerlingen', v_n);
end
$$;
revoke all on function mt_intern.bevestigen(uuid, uuid, bigint, jsonb) from public;

-- Een bevestigde klas heropenen (B113): enkel de beheerder. De bevestiging blijft als bewijs bewaard,
-- met wie heropende en waarom. Een aanvraag of een taak "Was hij mee?" die nog openstond, vervalt: de
-- lijst is weer gewoon te bewerken.
create or replace function mt_intern.heropenen(p_activiteit uuid, p_klas uuid, p_reden text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_lijst public.klaslijsten;
  v_revisie bigint;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  v_lijst := mt_intern.lijst_slot(p_activiteit, p_klas);
  if v_lijst.stand <> 'bevestigd' then
    raise exception 'MT: deze klas is niet bevestigd' using errcode = 'MT409';
  end if;
  if exists (select 1 from public.facturatieregels r join public.facturaties f on f.id = r.facturatie_id
              where r.activiteit_id = p_activiteit and f.stand in ('klaar', 'gefactureerd')) then
    raise exception 'MT: deze activiteit zit in een facturatie. Wijzig per leerling; dat wordt een correctie (F2).'
      using errcode = 'MT422';
  end if;
  update public.bevestigingen b
     set heropend_op = now(), heropend_door = v_wie, heropend_reden = nullif(btrim(coalesce(p_reden, '')), '')
   where b.id = v_lijst.bevestiging_id;
  update public.klaslijsten l
     set stand = 'open', bevestiging_id = null, revisie = l.revisie + 1, gewijzigd_op = now()
   where l.activiteit_id = p_activiteit and l.klas_id = p_klas
  returning l.revisie into v_revisie;
  update public.wijzigingsaanvragen a
     set stand = 'ingetrokken', behandeld_op = now(), behandeld_door = v_wie, antwoord = 'Vervallen: de klas werd heropend.'
   where a.activiteit_id = p_activiteit and a.klas_id = p_klas and a.stand = 'open';
  update public.taken t
     set stand = 'afgehandeld', afgehandeld_op = now(), afgehandeld_door = v_wie, afhandeling = 'vervallen'
   where t.stand = 'open' and t.soort in ('was_hij_mee', 'was_hij_toch_mee')
     and t.activiteit_id = p_activiteit and t.klas_id = p_klas;
  return jsonb_build_object('revisie', v_revisie, 'stand', 'open');
end
$$;
revoke all on function mt_intern.heropenen(uuid, uuid, text) from public;

-- Na het bevestigen wijzigt een leerkracht niet zelf: ze vraagt een wijziging aan (B20, B40). De
-- aanvraag bewaart per regel de oude en de gevraagde waarde, en de revisie waarop ze steunt.
-- p_regels: [{"leerling": "<id>", "wat": "status", "dag": "…", "status": "<id>"},
--            {"leerling": "<id>", "wat": "deelname", "deelname": false},
--            {"leerling": "<id>", "wat": "opmerking", "opmerking": "…"}]
create or replace function mt_intern.wijziging_aanvragen(p_activiteit uuid, p_klas uuid, p_revisie bigint,
                                                         p_regels jsonb, p_reden text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_lijst public.klaslijsten;
  v_act public.activiteiten;
  v_status public.statussen;
  v_aanvraag uuid := gen_random_uuid();
  v_aanwezig uuid;
  v_leerling uuid;
  v_dag date;
  v_oud uuid;
  v_deelname boolean;
  v_tekst text;
  v_n integer := 0;
  r record;
begin
  v_rol := mt_intern.eis_rol('leerkracht');
  v_lijst := mt_intern.lijst_slot(p_activiteit, p_klas);
  select * into v_act from public.activiteiten a where a.id = p_activiteit;
  perform mt_intern.eis_lijst_actief(v_lijst, v_act);
  if v_lijst.stand <> 'bevestigd' then
    raise exception 'MT: deze klas is niet bevestigd: pas de lijst gewoon aan' using errcode = 'MT422';
  end if;
  if p_revisie is null or p_revisie <> v_lijst.revisie then
    raise exception 'MT: de lijst wijzigde intussen. Kijk ze opnieuw na; er is niets aangevraagd.' using errcode = 'MT409';
  end if;
  if exists (select 1 from public.wijzigingsaanvragen a
              where a.activiteit_id = p_activiteit and a.klas_id = p_klas and a.stand = 'open') then
    raise exception 'MT: voor deze klas staat al een aanvraag open' using errcode = 'MT422';
  end if;
  if p_regels is null or jsonb_typeof(p_regels) <> 'array' or jsonb_array_length(p_regels) not between 1 and 300 then
    raise exception 'MT: de aanvraag bevat geen wijzigingen' using errcode = '22023';
  end if;
  select s.id into v_aanwezig from public.statussen s where s.soort = 'aanwezig';

  insert into public.wijzigingsaanvragen (id, activiteit_id, klas_id, schooljaar, bevestiging_id, verwachte_revisie,
                                          reden, aangevraagd_op, aangevraagd_door)
  values (v_aanvraag, p_activiteit, p_klas, v_lijst.schooljaar, v_lijst.bevestiging_id, v_lijst.revisie,
          nullif(btrim(coalesce(p_reden, '')), ''), now(), v_wie);

  for r in select e.rij from jsonb_array_elements(p_regels) as e(rij)
  loop
    v_leerling := (r.rij ->> 'leerling')::uuid;
    if not exists (select 1 from public.bevestiging_leerlingen bl
                    where bl.bevestiging_id = v_lijst.bevestiging_id and bl.leerling_id = v_leerling) then
      raise exception 'MT: een leerling van de aanvraag staat niet op de bevestigde lijst' using errcode = 'MT422';
    end if;
    v_deelname := not exists (select 1 from public.deelname d
                               where d.activiteit_id = p_activiteit and d.leerling_id = v_leerling and d.klas_id = p_klas);
    case r.rij ->> 'wat'
      when 'status' then
        v_dag := (r.rij ->> 'dag')::date;
        if v_dag is null or v_dag < v_act.datum_start or v_dag > v_act.datum_eind then
          raise exception 'MT: de dag hoort niet bij deze activiteit' using errcode = '22023';
        end if;
        select * into v_status from public.statussen s where s.id = (r.rij ->> 'status')::uuid;
        if not found or not v_status.actief or v_status.soort = 'te_bepalen' then
          raise exception 'MT: deze status kan niet aangevraagd worden' using errcode = 'MT422';
        end if;
        if v_act.ging_niet_door is not null
           and not (v_status.soort = 'aanwezig' or (v_status.soort = 'afwezig' and not v_status.aangerekend)) then
          raise exception 'MT: deze beurt ging niet door. Kies enkel nog een status die niet aangerekend wordt, zoals een attest.'
            using errcode = 'MT422';
        end if;
        if not v_deelname then
          raise exception 'MT: een leerling van de aanvraag neemt niet deel' using errcode = 'MT422';
        end if;
        select af.status_id into v_oud from public.afwezigheden af
         where af.activiteit_id = p_activiteit and af.leerling_id = v_leerling and af.dag = v_dag;
        v_oud := coalesce(v_oud, v_aanwezig);
        if v_oud = v_status.id then
          continue;
        end if;
        insert into public.wijzigingsaanvraag_regels (aanvraag_id, leerling_id, wat, dag, oude_status_id, nieuwe_status_id)
        values (v_aanvraag, v_leerling, 'status', v_dag, v_oud, v_status.id);
      when 'deelname' then
        if not v_act.meerdaags or (r.rij ->> 'deelname') is null then
          raise exception 'MT: de deelname wijzigen kan enkel bij een meerdaagse uitstap (B109)' using errcode = 'MT422';
        end if;
        if (r.rij ->> 'deelname')::boolean = v_deelname then
          continue;
        end if;
        insert into public.wijzigingsaanvraag_regels (aanvraag_id, leerling_id, wat, oude_deelname, nieuwe_deelname)
        values (v_aanvraag, v_leerling, 'deelname', v_deelname, (r.rij ->> 'deelname')::boolean);
      when 'opmerking' then
        v_tekst := btrim(coalesce(r.rij ->> 'opmerking', ''));
        if char_length(v_tekst) > 500 then
          raise exception 'MT: een opmerking telt hoogstens 500 tekens' using errcode = 'MT422';
        end if;
        if v_tekst = coalesce((select o.tekst from public.opmerkingen o
                                where o.activiteit_id = p_activiteit and o.leerling_id = v_leerling and o.soort = 'leerkracht'), '') then
          continue;
        end if;
        insert into public.wijzigingsaanvraag_regels (aanvraag_id, leerling_id, wat, nieuwe_opmerking)
        values (v_aanvraag, v_leerling, 'opmerking', v_tekst);
      else
        raise exception 'MT: een regel van de aanvraag is onbekend' using errcode = '22023';
    end case;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    raise exception 'MT: de aanvraag wijzigt niets' using errcode = 'MT422';
  end if;
  return jsonb_build_object('aanvraag', v_aanvraag, 'regels', v_n);
end
$$;
revoke all on function mt_intern.wijziging_aanvragen(uuid, uuid, bigint, jsonb, text) from public;

-- Een leerkracht van de klas trekt een open aanvraag weer in.
create or replace function mt_intern.aanvraag_intrekken(p_aanvraag uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_aanvraag public.wijzigingsaanvragen;
  v_lijst public.klaslijsten;
begin
  v_rol := mt_intern.eis_rol('leerkracht');
  select * into v_aanvraag from public.wijzigingsaanvragen a where a.id = p_aanvraag;
  if not found then
    raise exception 'MT: geen rechten voor deze lijst' using errcode = '42501';
  end if;
  v_lijst := mt_intern.lijst_slot(v_aanvraag.activiteit_id, v_aanvraag.klas_id);
  select * into v_aanvraag from public.wijzigingsaanvragen a where a.id = p_aanvraag for update;
  if v_aanvraag.stand <> 'open' then
    raise exception 'MT: deze aanvraag is al behandeld' using errcode = 'MT409';
  end if;
  update public.wijzigingsaanvragen a
     set stand = 'ingetrokken', behandeld_op = now(), behandeld_door = v_wie
   where a.id = p_aanvraag;
  return jsonb_build_object('aanvraag', p_aanvraag, 'stand', 'ingetrokken');
end
$$;
revoke all on function mt_intern.aanvraag_intrekken(uuid) from public;

-- De beheerder keurt een aanvraag goed of weigert ze (B113, T2). Goedkeuren en wijzigen gebeuren
-- samen, onder het slot van de lijst. Wijzigde een leerling van de aanvraag intussen nog, dan gebeurt
-- er niets: de fout noemt die leerlingen, zodat het scherm het verschil toont (MT409).
create or replace function mt_intern.aanvraag_behandelen(p_aanvraag uuid, p_goedkeuren boolean,
                                                         p_antwoord text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_aanvraag public.wijzigingsaanvragen;
  v_lijst public.klaslijsten;
  v_antwoord text := nullif(btrim(coalesce(p_antwoord, '')), '');
  v_aanwezig uuid;
  v_nu uuid;
  v_anders uuid[] := '{}';
  v_revisie bigint;
  r record;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  if p_goedkeuren is null then
    raise exception 'MT: goedkeuren of weigeren?' using errcode = '22023';
  end if;
  select * into v_aanvraag from public.wijzigingsaanvragen a where a.id = p_aanvraag;
  if not found then
    raise exception 'MT: deze aanvraag bestaat niet' using errcode = 'MT422';
  end if;
  v_lijst := mt_intern.lijst_slot(v_aanvraag.activiteit_id, v_aanvraag.klas_id);
  select * into v_aanvraag from public.wijzigingsaanvragen a where a.id = p_aanvraag for update;
  if v_aanvraag.stand <> 'open' then
    raise exception 'MT: deze aanvraag is al behandeld' using errcode = 'MT409';
  end if;

  if not p_goedkeuren then
    update public.wijzigingsaanvragen a
       set stand = 'geweigerd', behandeld_op = now(), behandeld_door = v_wie, antwoord = v_antwoord
     where a.id = p_aanvraag;
    return jsonb_build_object('aanvraag', p_aanvraag, 'stand', 'geweigerd', 'revisie', v_lijst.revisie);
  end if;

  if v_lijst.stand <> 'bevestigd' or v_lijst.bevestiging_id is distinct from v_aanvraag.bevestiging_id then
    raise exception 'MT: de klas werd intussen heropend' using errcode = 'MT409';
  end if;
  select s.id into v_aanwezig from public.statussen s where s.soort = 'aanwezig';

  -- Eerst nakijken: is wat de leerkracht zag, nog wat er staat?
  for r in select * from public.wijzigingsaanvraag_regels x where x.aanvraag_id = p_aanvraag
  loop
    if r.wat = 'status' then
      select af.status_id into v_nu from public.afwezigheden af
       where af.activiteit_id = v_aanvraag.activiteit_id and af.leerling_id = r.leerling_id and af.dag = r.dag;
      if coalesce(v_nu, v_aanwezig) <> r.oude_status_id then
        v_anders := v_anders || r.leerling_id;
      end if;
    elsif r.wat = 'deelname' then
      if r.oude_deelname is distinct from
         (not exists (select 1 from public.deelname d
                       where d.activiteit_id = v_aanvraag.activiteit_id and d.leerling_id = r.leerling_id
                         and d.klas_id = v_aanvraag.klas_id)) then
        v_anders := v_anders || r.leerling_id;
      end if;
    end if;
  end loop;
  if cardinality(v_anders) > 0 then
    raise exception 'MT: de lijst wijzigde sinds de aanvraag, bij % leerling(en). Bekijk het verschil; er is niets overschreven.',
      cardinality(v_anders) using errcode = 'MT409', detail = to_jsonb(v_anders)::text;
  end if;

  -- Dan toepassen, met bij elke wijziging de aanvraag waaruit ze komt.
  for r in select * from public.wijzigingsaanvraag_regels x where x.aanvraag_id = p_aanvraag
  loop
    if r.wat = 'status' then
      if r.nieuwe_status_id = v_aanwezig then
        delete from public.afwezigheden af
         where af.activiteit_id = v_aanvraag.activiteit_id and af.leerling_id = r.leerling_id and af.dag = r.dag;
      else
        insert into public.afwezigheden (activiteit_id, leerling_id, dag, klas_id, schooljaar, status_id, gewijzigd_op, gewijzigd_door)
        values (v_aanvraag.activiteit_id, r.leerling_id, r.dag, v_aanvraag.klas_id, v_aanvraag.schooljaar, r.nieuwe_status_id, now(), v_wie)
        on conflict (activiteit_id, leerling_id, dag) do update
          set status_id = excluded.status_id, klas_id = excluded.klas_id, gewijzigd_op = now(), gewijzigd_door = excluded.gewijzigd_door;
      end if;
    elsif r.wat = 'deelname' then
      if r.nieuwe_deelname then
        delete from public.deelname d
         where d.activiteit_id = v_aanvraag.activiteit_id and d.leerling_id = r.leerling_id;
      else
        insert into public.deelname (activiteit_id, leerling_id, klas_id, schooljaar, gewijzigd_op, gewijzigd_door)
        values (v_aanvraag.activiteit_id, r.leerling_id, v_aanvraag.klas_id, v_aanvraag.schooljaar, now(), v_wie);
      end if;
    elsif coalesce(r.nieuwe_opmerking, '') = '' then
      delete from public.opmerkingen o
       where o.activiteit_id = v_aanvraag.activiteit_id and o.leerling_id = r.leerling_id and o.soort = 'leerkracht';
    else
      insert into public.opmerkingen (activiteit_id, leerling_id, soort, klas_id, schooljaar, tekst, gewijzigd_op, gewijzigd_door)
      values (v_aanvraag.activiteit_id, r.leerling_id, 'leerkracht', v_aanvraag.klas_id, v_aanvraag.schooljaar,
              r.nieuwe_opmerking, now(), v_aanvraag.aangevraagd_door)
      on conflict (activiteit_id, leerling_id, soort) do update
        set tekst = excluded.tekst, klas_id = excluded.klas_id, gewijzigd_op = now(), gewijzigd_door = excluded.gewijzigd_door;
    end if;
    insert into public.wijzigingen (bevestiging_id, activiteit_id, klas_id, schooljaar, leerling_id, wat, dag,
                                    oude_status_id, nieuwe_status_id, oude_deelname, nieuwe_deelname, reden, aanvraag_id, gewijzigd_door)
    values (v_aanvraag.bevestiging_id, v_aanvraag.activiteit_id, v_aanvraag.klas_id, v_aanvraag.schooljaar, r.leerling_id, r.wat, r.dag,
            r.oude_status_id, r.nieuwe_status_id, r.oude_deelname, r.nieuwe_deelname, v_aanvraag.reden, p_aanvraag, v_wie);
  end loop;
  v_revisie := mt_intern.revisie_omhoog(v_aanvraag.activiteit_id, v_aanvraag.klas_id);
  update public.wijzigingsaanvragen a
     set stand = 'goedgekeurd', behandeld_op = now(), behandeld_door = v_wie, antwoord = v_antwoord
   where a.id = p_aanvraag;
  return jsonb_build_object('aanvraag', p_aanvraag, 'stand', 'goedgekeurd', 'revisie', v_revisie);
end
$$;
revoke all on function mt_intern.aanvraag_behandelen(uuid, boolean, text) from public;

-- ============================================================================================
-- 5. Taken en "Was hij mee?" (B67, B192)
-- ============================================================================================
-- Een klaswissel of instroom die pas later ingegeven wordt, verandert een bevestigde lijst nooit
-- stil. De databank maakt zelf een taak, via een trigger op de klasindelingen: zo geldt het voor elke
-- weg, de import, de fiche en een script.

-- Een leerling telt voor één activiteit nooit twee keer. Staat hij op de bevestigde lijst van een klas
-- waarin hij die dag niet zat, terwijl hij voor dezelfde activiteit ook bij zijn eigen klas telt, dan
-- valt hij op die eerste lijst weg. Aan de bedragen verandert daardoor niets: een gedeelde kost wordt
-- verdeeld over alle klassen van de activiteit samen, en zijn status blijft. Het staat bij de wijzigingen.
create or replace function mt_intern.telt_een_keer(p_activiteit uuid, p_leerling uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_wie uuid := auth.uid();
  r record;
begin
  for r in
    select l.activiteit_id, l.klas_id, l.schooljaar, l.bevestiging_id
      from public.klaslijsten l
      join public.klassen k on k.id = l.klas_id and k.groep <> 'Andere'
      join public.activiteiten a on a.id = l.activiteit_id
      join public.bevestiging_leerlingen bl on bl.bevestiging_id = l.bevestiging_id and bl.leerling_id = p_leerling
     where l.activiteit_id = p_activiteit and l.stand = 'bevestigd' and not l.vervallen
       and not exists (select 1 from public.klasindelingen ki
                        where ki.leerling_id = p_leerling and ki.klas_id = l.klas_id
                          and ki.van <= a.datum_start and a.datum_start < ki.einde)
       and not exists (select 1 from public.deelname d where d.activiteit_id = p_activiteit and d.leerling_id = p_leerling)
       and exists (select 1 from public.klaslijsten l2
                    where l2.activiteit_id = p_activiteit and l2.klas_id <> l.klas_id and not l2.vervallen
                      and ((l2.stand = 'open'
                            and exists (select 1 from public.klasindelingen k2
                                         where k2.leerling_id = p_leerling and k2.klas_id = l2.klas_id
                                           and k2.van <= a.datum_start and a.datum_start < k2.einde))
                           or (l2.stand = 'bevestigd'
                               and exists (select 1 from public.bevestiging_leerlingen b2
                                            where b2.bevestiging_id = l2.bevestiging_id and b2.leerling_id = p_leerling))))
     order by l.klas_id
  loop
    insert into public.deelname (activiteit_id, leerling_id, klas_id, schooljaar, gewijzigd_op, gewijzigd_door)
    values (r.activiteit_id, p_leerling, r.klas_id, r.schooljaar, now(), v_wie);
    insert into public.wijzigingen (bevestiging_id, activiteit_id, klas_id, schooljaar, leerling_id, wat,
                                    oude_deelname, nieuwe_deelname, reden, gewijzigd_door)
    values (r.bevestiging_id, r.activiteit_id, r.klas_id, r.schooljaar, p_leerling, 'deelname', true, false,
            'Zat die dag in een andere klas die ook meeging: telt daar mee', v_wie);
    perform mt_intern.revisie_omhoog(r.activiteit_id, r.klas_id);
  end loop;
end
$$;
revoke all on function mt_intern.telt_een_keer(uuid, uuid) from public;

-- Geldt de aanleiding van een taak nog?
--   was_hij_mee       hij zat die dag in de klas, maar staat niet op haar bevestigde lijst;
--   was_hij_toch_mee  hij staat op de bevestigde lijst, maar zat die dag niet in die klas, en gaat
--                     voor die activiteit ook niet met een andere klas mee.
create or replace function mt_intern.was_hij_mee_geldt(p_soort text, p_bevestiging uuid, p_leerling uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.klaslijsten l
      join public.activiteiten a on a.id = l.activiteit_id
     where l.bevestiging_id = p_bevestiging and l.stand = 'bevestigd' and not l.vervallen
       and (a.soort = 'beurt' or (a.bron_stand = 'actief' and a.bron_plan is distinct from 'geannuleerd'))
       and case p_soort
             when 'was_hij_mee' then
               exists (select 1 from public.klasindelingen ki
                        where ki.leerling_id = p_leerling and ki.klas_id = l.klas_id
                          and ki.van <= a.datum_start and a.datum_start < ki.einde)
               and not exists (select 1 from public.bevestiging_leerlingen bl
                                where bl.bevestiging_id = l.bevestiging_id and bl.leerling_id = p_leerling)
             when 'was_hij_toch_mee' then
               exists (select 1 from public.bevestiging_leerlingen bl
                        where bl.bevestiging_id = l.bevestiging_id and bl.leerling_id = p_leerling)
               and not exists (select 1 from public.deelname d
                                where d.activiteit_id = l.activiteit_id and d.leerling_id = p_leerling)
               and not mt_intern.gaat_mee_met_klas(l.activiteit_id, p_leerling, a.datum_start)
             else false
           end)
$$;
revoke all on function mt_intern.was_hij_mee_geldt(text, uuid, uuid) from public;

-- Na elke wijziging aan de klasindelingen van een leerling: de taken van dat schooljaar bijwerken.
create or replace function mt_intern.klaswissel_taken(p_leerling uuid, p_schooljaar text) returns void
language plpgsql set search_path = '' as $$
declare
  v_wie uuid := auth.uid();
  r record;
begin
  if not exists (select 1 from public.schooljaren s where s.schooljaar = p_schooljaar and s.stand in ('lopend', 'voorbij')) then
    return;
  end if;

  -- Eerst: nooit twee keer voor dezelfde activiteit.
  for r in
    select distinct l.activiteit_id
      from public.bevestiging_leerlingen bl
      join public.klaslijsten l on l.bevestiging_id = bl.bevestiging_id and l.stand = 'bevestigd' and l.schooljaar = p_schooljaar
     where bl.leerling_id = p_leerling
  loop
    perform mt_intern.telt_een_keer(r.activiteit_id, p_leerling);
  end loop;

  -- Zit nu in de klas op de dag van een bevestigde lijst, maar staat er niet op: "Was hij mee?"
  insert into public.taken (schooljaar, soort, sleutel, activiteit_id, klas_id, leerling_id, gegevens, aangemaakt_door)
  select p_schooljaar, 'was_hij_mee', 'was_hij_mee:' || l.bevestiging_id || ':' || p_leerling,
         l.activiteit_id, l.klas_id, p_leerling, jsonb_build_object('bevestiging', l.bevestiging_id), v_wie
    from public.klasindelingen ki
    join public.klaslijsten l on l.klas_id = ki.klas_id and l.stand = 'bevestigd'
   where ki.leerling_id = p_leerling and ki.schooljaar = p_schooljaar
     and mt_intern.was_hij_mee_geldt('was_hij_mee', l.bevestiging_id, p_leerling)
  on conflict (sleutel) do nothing;

  -- Staat op een bevestigde lijst, maar zat die dag niet in die klas: "Was hij toch mee?"
  insert into public.taken (schooljaar, soort, sleutel, activiteit_id, klas_id, leerling_id, gegevens, aangemaakt_door)
  select p_schooljaar, 'was_hij_toch_mee', 'was_hij_toch_mee:' || l.bevestiging_id || ':' || p_leerling,
         l.activiteit_id, l.klas_id, p_leerling, jsonb_build_object('bevestiging', l.bevestiging_id), v_wie
    from public.bevestiging_leerlingen bl
    join public.klaslijsten l on l.bevestiging_id = bl.bevestiging_id and l.stand = 'bevestigd' and l.schooljaar = p_schooljaar
    join public.klassen k on k.id = l.klas_id and k.groep <> 'Andere'
    join public.activiteiten a on a.id = l.activiteit_id
   where bl.leerling_id = p_leerling
     and not exists (select 1 from public.klasindelingen ki
                      where ki.leerling_id = p_leerling and ki.klas_id = l.klas_id
                        and ki.van <= a.datum_start and a.datum_start < ki.einde)
     and mt_intern.was_hij_mee_geldt('was_hij_toch_mee', l.bevestiging_id, p_leerling)
  on conflict (sleutel) do nothing;

  -- Een open taak waarvan de aanleiding verdween, bv. na een rechtzetting, vervalt.
  update public.taken t
     set stand = 'afgehandeld', afgehandeld_op = now(), afgehandeld_door = v_wie, afhandeling = 'vervallen'
   where t.stand = 'open' and t.leerling_id = p_leerling and t.schooljaar = p_schooljaar
     and t.soort in ('was_hij_mee', 'was_hij_toch_mee')
     and not mt_intern.was_hij_mee_geldt(t.soort, (t.gegevens ->> 'bevestiging')::uuid, p_leerling);
end
$$;
revoke all on function mt_intern.klaswissel_taken(uuid, text) from public;

create or replace function mt_intern.na_klasindeling() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.klas_id = old.klas_id and new.van = old.van and new.einde = old.einde then
      return null;
    end if;
  end if;
  if tg_op <> 'INSERT' then
    perform mt_intern.klaswissel_taken(old.leerling_id, old.schooljaar);
  end if;
  if tg_op <> 'DELETE' then
    perform mt_intern.klaswissel_taken(new.leerling_id, new.schooljaar);
  end if;
  return null;
end
$$;
revoke all on function mt_intern.na_klasindeling() from public;

drop trigger if exists mt_na_klasindeling on public.klasindelingen;
create constraint trigger mt_na_klasindeling after insert or update or delete on public.klasindelingen
  deferrable initially deferred for each row execute function mt_intern.na_klasindeling();

-- "Was hij mee?" beantwoorden (B192). Hoe de beheerder ook antwoordt, het gebeurt niet stil: het staat
-- bij de wijzigingen, en de taak met het antwoord staat in het logboek.
--   was_hij_mee: de leerling komt op de lijst, want hij zat in de klas. "Hij was mee": aanwezig.
--     "Hij was niet mee": met de gekozen status, bv. attest, briefje ouders of ongewettigd afwezig.
--     Op zijn tegel staat "Later toegevoegd, na de bevestiging".
--   was_hij_toch_mee: "Hij was mee": hij blijft op de lijst. "Hij was niet mee": hij telt er niet meer mee.
create or replace function mt_intern.was_hij_mee(p_taak uuid, p_mee boolean, p_status uuid default null,
                                                 p_opmerking text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_taak public.taken;
  v_lijst public.klaslijsten;
  v_act public.activiteiten;
  v_status public.statussen;
  v_bevestiging uuid;
  v_tekst text := btrim(coalesce(p_opmerking, ''));
  v_nummer integer;
  v_revisie bigint;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  if p_mee is null then
    raise exception 'MT: was hij mee of niet?' using errcode = '22023';
  end if;
  select * into v_taak from public.taken t where t.id = p_taak;
  if not found or v_taak.soort not in ('was_hij_mee', 'was_hij_toch_mee') then
    raise exception 'MT: deze taak bestaat niet' using errcode = 'MT422';
  end if;
  -- alle lijsten van de activiteit, in een vaste volgorde: de leerling kan op een tweede lijst wegvallen
  perform 1 from public.klaslijsten l where l.activiteit_id = v_taak.activiteit_id order by l.klas_id for update;
  v_lijst := mt_intern.lijst_slot(v_taak.activiteit_id, v_taak.klas_id);
  select * into v_taak from public.taken t where t.id = p_taak for update;
  if v_taak.stand <> 'open' then
    raise exception 'MT: deze taak is al afgehandeld' using errcode = 'MT409';
  end if;
  v_bevestiging := (v_taak.gegevens ->> 'bevestiging')::uuid;
  if v_lijst.bevestiging_id is distinct from v_bevestiging
     or not mt_intern.was_hij_mee_geldt(v_taak.soort, v_bevestiging, v_taak.leerling_id) then
    update public.taken t
       set stand = 'afgehandeld', afgehandeld_op = now(), afgehandeld_door = v_wie, afhandeling = 'vervallen'
     where t.id = p_taak;
    return jsonb_build_object('taak', p_taak, 'afhandeling', 'vervallen', 'revisie', v_lijst.revisie);
  end if;
  if char_length(v_tekst) > 500 then
    raise exception 'MT: een opmerking telt hoogstens 500 tekens' using errcode = 'MT422';
  end if;
  select * into v_act from public.activiteiten a where a.id = v_taak.activiteit_id;

  if v_taak.soort = 'was_hij_mee' then
    if not p_mee then
      select * into v_status from public.statussen s where s.id = p_status;
      if not found or v_status.soort <> 'afwezig' or not v_status.actief then
        raise exception 'MT: kies waarom hij niet mee was, bv. attest, briefje ouders of ongewettigd afwezig' using errcode = 'MT422';
      end if;
      if v_act.ging_niet_door is not null and v_status.aangerekend then
        raise exception 'MT: deze beurt ging niet door. Kies enkel nog een status die niet aangerekend wordt, zoals een attest.'
          using errcode = 'MT422';
      end if;
    end if;
    select ki.klasnummer into v_nummer from public.klasindelingen ki
     where ki.leerling_id = v_taak.leerling_id and ki.klas_id = v_taak.klas_id
       and ki.van <= v_act.datum_start and v_act.datum_start < ki.einde;
    insert into public.bevestiging_leerlingen (bevestiging_id, leerling_id, klasnummer, neemt_deel, later_toegevoegd, toegevoegd_op, toegevoegd_door)
    values (v_bevestiging, v_taak.leerling_id, coalesce(v_nummer, 0), true, true, now(), v_wie);
    insert into public.wijzigingen (bevestiging_id, activiteit_id, klas_id, schooljaar, leerling_id, wat, nieuwe_deelname, reden, gewijzigd_door)
    values (v_bevestiging, v_taak.activiteit_id, v_taak.klas_id, v_lijst.schooljaar, v_taak.leerling_id, 'deelname', true,
            'Later toegevoegd, na de bevestiging', v_wie);
    if not p_mee then
      insert into public.afwezigheden (activiteit_id, leerling_id, dag, klas_id, schooljaar, status_id, gewijzigd_op, gewijzigd_door)
      select v_taak.activiteit_id, v_taak.leerling_id, d.dag::date, v_taak.klas_id, v_lijst.schooljaar, v_status.id, now(), v_wie
        from generate_series(v_act.datum_start::timestamp, v_act.datum_eind::timestamp, interval '1 day') as d(dag)
      on conflict (activiteit_id, leerling_id, dag) do update
        set status_id = excluded.status_id, klas_id = excluded.klas_id, gewijzigd_op = now(), gewijzigd_door = excluded.gewijzigd_door;
      insert into public.wijzigingen (bevestiging_id, activiteit_id, klas_id, schooljaar, leerling_id, wat, dag, nieuwe_status_id, reden, gewijzigd_door)
      select v_bevestiging, v_taak.activiteit_id, v_taak.klas_id, v_lijst.schooljaar, v_taak.leerling_id, 'status', d.dag::date, v_status.id,
             'Later toegevoegd, na de bevestiging', v_wie
        from generate_series(v_act.datum_start::timestamp, v_act.datum_eind::timestamp, interval '1 day') as d(dag);
    else
      delete from public.afwezigheden af
       where af.activiteit_id = v_taak.activiteit_id and af.leerling_id = v_taak.leerling_id;
    end if;
    -- stond hij voor dezelfde activiteit nog op de bevestigde lijst van zijn vorige klas, dan telt hij daar niet meer
    perform mt_intern.telt_een_keer(v_taak.activiteit_id, v_taak.leerling_id);
  elsif not p_mee then
    insert into public.deelname (activiteit_id, leerling_id, klas_id, schooljaar, gewijzigd_op, gewijzigd_door)
    values (v_taak.activiteit_id, v_taak.leerling_id, v_taak.klas_id, v_lijst.schooljaar, now(), v_wie);
    insert into public.wijzigingen (bevestiging_id, activiteit_id, klas_id, schooljaar, leerling_id, wat,
                                    oude_deelname, nieuwe_deelname, reden, gewijzigd_door)
    values (v_bevestiging, v_taak.activiteit_id, v_taak.klas_id, v_lijst.schooljaar, v_taak.leerling_id, 'deelname', true, false,
            'Zat die dag niet meer in deze klas, en was niet mee', v_wie);
  end if;

  if v_tekst <> '' then
    insert into public.opmerkingen (activiteit_id, leerling_id, soort, klas_id, schooljaar, tekst, gewijzigd_op, gewijzigd_door)
    values (v_taak.activiteit_id, v_taak.leerling_id, 'beheerder', v_taak.klas_id, v_lijst.schooljaar, v_tekst, now(), v_wie)
    on conflict (activiteit_id, leerling_id, soort) do update
      set tekst = excluded.tekst, klas_id = excluded.klas_id, gewijzigd_op = now(), gewijzigd_door = excluded.gewijzigd_door;
  end if;
  v_revisie := mt_intern.revisie_omhoog(v_taak.activiteit_id, v_taak.klas_id);
  update public.taken t
     set stand = 'afgehandeld', afgehandeld_op = now(), afgehandeld_door = v_wie,
         afhandeling = case when p_mee then 'was_mee' else 'was_niet_mee' end,
         afhandeling_gegevens = jsonb_build_object('status', p_status)
   where t.id = p_taak;
  return jsonb_build_object('taak', p_taak, 'afhandeling', case when p_mee then 'was_mee' else 'was_niet_mee' end, 'revisie', v_revisie);
end
$$;
revoke all on function mt_intern.was_hij_mee(uuid, boolean, uuid, text) from public;

-- Een melding afhandelen die enkel gezien moet worden, zoals "de datum wijzigde" of "de uitstap is
-- verwijderd". "Was hij mee?" vraagt een antwoord, en heeft daarom haar eigen functie.
create or replace function mt_intern.taak_afhandelen(p_taak uuid, p_afhandeling text default 'gezien',
                                                     p_gegevens jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_taak public.taken;
  v_afhandeling text := coalesce(nullif(btrim(coalesce(p_afhandeling, '')), ''), 'gezien');
begin
  v_rol := mt_intern.eis_rol('beheerder');
  select * into v_taak from public.taken t where t.id = p_taak for update;
  if not found then
    raise exception 'MT: deze taak bestaat niet' using errcode = 'MT422';
  end if;
  if v_taak.stand <> 'open' then
    raise exception 'MT: deze taak is al afgehandeld' using errcode = 'MT409';
  end if;
  if v_taak.soort in ('was_hij_mee', 'was_hij_toch_mee') then
    raise exception 'MT: deze taak vraagt een antwoord: was hij mee of niet?' using errcode = 'MT422';
  end if;
  if v_afhandeling !~ '^[a-z_]{3,40}$' or (p_gegevens is not null and jsonb_typeof(p_gegevens) <> 'object') then
    raise exception 'MT: de afhandeling klopt niet' using errcode = '22023';
  end if;
  update public.taken t
     set stand = 'afgehandeld', afgehandeld_op = now(), afgehandeld_door = auth.uid(),
         afhandeling = v_afhandeling, afhandeling_gegevens = p_gegevens
   where t.id = p_taak;
  return jsonb_build_object('taak', p_taak, 'afhandeling', v_afhandeling);
end
$$;
revoke all on function mt_intern.taak_afhandelen(uuid, text, jsonb) from public;

-- ============================================================================================
-- 6. Uitstappen uit de uitstappentool (4, B14, B67, T1, B158)
-- ============================================================================================
-- De MT leest de uitstappentool live, in de browser. Van een uitstap bewaart ze enkel wat nodig is om
-- lijsten aan op te hangen en wijzigingen op te merken: het id, de datums, de klassen en de stand
-- zoals ze laatst waargenomen werden. Elke sessie van een beheerder of een leerkracht zet dat bij het
-- openen gelijk met wat ze in de uitstappentool ziet; niemand hoeft daarvoor iets te doen.
--
-- De databank kan de uitstappentool niet zelf lezen (17.3): ze gaat uit van wat de pagina meldt. Een
-- foute melding herstelt zich bij de volgende lezing en staat in het logboek. Bedragen hangen er niet
-- van af: die rekent de pagina uit de uitstappentool zelf, en de facturatie leest ze op de server (B69).
--
-- Na een beslismoment, een bevestigde klas of een facturatie, wijzigt er niets stil (B67):
--   - een andere datum wordt niet overgenomen zolang een klas bevestigd is. De MT houdt de datum van
--     toen, en omdat de versie dan afwijkt, kan geen andere klas van die uitstap bevestigd worden tot
--     het opgelost is: de klas heropenen, of de datum terugzetten in de uitstappentool;
--   - een klas die wegvalt, of een uitstap die verwijderd, geannuleerd of een nascholing wordt, telt
--     niet meer mee (B14); wat ingegeven was, blijft bewaard, met een taak voor de beheerder.

-- De lijsten van een uitstap gelijkzetten met haar klassen. Een uitstap bewaart namen, geen id's: de
-- naam wordt per schooljaar opgezocht, ook een vroegere naam (B158). Een onbekende naam geeft nooit
-- een lege klas: de functie geeft ze terug, en de pagina toont "klas onbekend".
create or replace function mt_intern.lijsten_bijwerken(p_activiteit uuid, p_namen text[], p_stempel text) returns text[]
language plpgsql set search_path = '' as $$
declare
  v_act public.activiteiten;
  v_naam text;
  v_klas uuid;
  v_gewenst uuid[] := '{}';
  v_onbekend text[] := '{}';
  r record;
begin
  select * into v_act from public.activiteiten a where a.id = p_activiteit;
  foreach v_naam in array p_namen loop
    select kn.klas_id into v_klas from public.klas_namen kn
     where kn.schooljaar = v_act.schooljaar and kn.naam = v_naam;
    if v_klas is null then
      v_onbekend := v_onbekend || v_naam;
    else
      v_gewenst := v_gewenst || v_klas;
    end if;
  end loop;

  insert into public.klaslijsten (activiteit_id, klas_id, schooljaar, aangemaakt_door)
  select p_activiteit, k.klas, v_act.schooljaar, auth.uid() from (select distinct unnest(v_gewenst) as klas) k
  on conflict (activiteit_id, klas_id) do update
    set vervallen = false, revisie = public.klaslijsten.revisie + 1, gewijzigd_op = now()
    where public.klaslijsten.vervallen;

  -- Een klas eraf: enkel als elke naam gekend is, anders kan een hernoemde klas ten onrechte wegvallen.
  if cardinality(v_onbekend) = 0 then
    for r in select l.klas_id, l.stand from public.klaslijsten l
              where l.activiteit_id = p_activiteit and not l.vervallen and l.klas_id <> all (v_gewenst)
              order by l.klas_id for update
    loop
      if r.stand = 'open' and not mt_intern.heeft_gegevens(p_activiteit, r.klas_id) then
        delete from public.klaslijsten l where l.activiteit_id = p_activiteit and l.klas_id = r.klas_id;
      else
        update public.klaslijsten l set vervallen = true, revisie = l.revisie + 1, gewijzigd_op = now()
         where l.activiteit_id = p_activiteit and l.klas_id = r.klas_id;
        perform mt_intern.taak_maken(v_act.schooljaar, 'klas_weg', 'klas_weg:' || p_activiteit || ':' || r.klas_id || ':' || p_stempel,
                                     p_activiteit, r.klas_id, null, '{}'::jsonb);
      end if;
    end loop;
  end if;
  return v_onbekend;
end
$$;
revoke all on function mt_intern.lijsten_bijwerken(uuid, text[], text) from public;

-- Eén uitstap verwerken, zoals de pagina ze in de uitstappentool zag:
--   {"id", "gewijzigd", "categorie", "verwijderd", "planStatus", "type", "datumStart", "datumEind", "klassen": [namen]}
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
  v_rijen public.afwezigheden[];
  v_delta integer;
  v_n integer;
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
     or v_plan is null or v_plan not in ('aangevraagd', 'bevestigd', 'geannuleerd') then
    return jsonb_build_object('wat', 'ongeldig', 'uitstap', v_id);
  end if;
  v_jaar := mt_intern.schooljaar_van(v_start);
  v_stempel := to_char(v_gewijzigd at time zone 'UTC', 'YYYYMMDD"T"HH24MISSUS');

  select * into v_act from public.activiteiten a where a.uitstap_id = v_id for update;

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
    return jsonb_build_object('wat', 'nieuw', 'uitstap', v_id, 'onbekend', to_jsonb(v_onbekend));
  end if;

  select s.stand into v_stand from public.schooljaren s where s.schooljaar = v_act.schooljaar;
  if v_stand = 'afgesloten' then
    return jsonb_build_object('wat', 'gesloten', 'uitstap', v_id);
  end if;
  v_gegevens := mt_intern.heeft_gegevens(v_act.id);

  -- Verwijderd, of omgezet naar een nascholing: telt niet meer mee (B14, V21).
  if v_weg is not null then
    if v_act.bron_stand is not distinct from v_weg then
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
    else
      -- Binnen het schooljaar, en nog niets bevestigd: de MT volgt. Wat al ingegeven was, schuift mee
      -- met de dagen; de beheerder krijgt een taak om de lijst na te kijken.
      v_delta := v_start - v_act.datum_start;
      v_rijen := array(select af from public.afwezigheden af where af.activiteit_id = v_act.id);
      delete from public.afwezigheden af where af.activiteit_id = v_act.id;
      update public.activiteiten a set datum_start = v_start, datum_eind = v_eind, meerdaags = v_meerdaags where a.id = v_act.id;
      insert into public.afwezigheden (activiteit_id, leerling_id, dag, klas_id, schooljaar, status_id, gewijzigd_op, gewijzigd_door)
      select w.activiteit_id, w.leerling_id, w.dag + v_delta, w.klas_id, w.schooljaar, w.status_id, w.gewijzigd_op, w.gewijzigd_door
        from unnest(v_rijen) as w
       where w.dag + v_delta between v_start and v_eind;
      get diagnostics v_n = row_count;
      if cardinality(v_rijen) > 0 then
        perform mt_intern.taak_maken(v_act.schooljaar, 'datum_gewijzigd', 'datum_gewijzigd:' || v_act.id || ':' || v_stempel,
                                     v_act.id, null, null,
                                     jsonb_build_object('van', v_act.datum_start, 'naar', v_start, 'verschoven', v_n,
                                                        'vervallen', cardinality(v_rijen) - v_n));
      end if;
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
  return jsonb_build_object('wat', v_wat, 'uitstap', v_id, 'onbekend', to_jsonb(v_onbekend));
end
$$;
revoke all on function mt_intern.uitstap_bijwerken(jsonb) from public;

-- De uitstappen bijwerken: wat de pagina in de uitstappentool zag en wat nieuw of anders is dan wat
-- de MT kent. Elke leerkracht en elke beheerder; zo wacht een leerkracht nooit tot de beheerder de MT
-- opende. p_alle_ids, de volledige lijst van id's in de uitstappentool, telt enkel bij de beheerder:
-- wat daar niet meer in staat, is "niet gevonden". Een lege lijst terwijl de MT uitstappen kent, is
-- een fout, geen resultaat (17.3).
create or replace function mt_intern.uitstappen_bijwerken(p_uitstappen jsonb, p_alle_ids text[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_r jsonb;
  v_tel jsonb := jsonb_build_object('nieuw', 0, 'gewijzigd', 0, 'weg', 0, 'ongewijzigd', 0, 'ongeldig', 0, 'buiten', 0, 'geen', 0, 'gesloten', 0);
  v_onbekend jsonb := '[]'::jsonb;
  v_wacht jsonb := '[]'::jsonb;
  v_weg integer := 0;
  u record;
  r record;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht');
  if p_uitstappen is null or jsonb_typeof(p_uitstappen) <> 'array' or jsonb_array_length(p_uitstappen) > 5000 then
    raise exception 'MT: de lijst van uitstappen klopt niet' using errcode = '22023';
  end if;
  -- één sessie tegelijk: twee leerkrachten die tegelijk openen, maken een uitstap maar één keer aan
  perform pg_advisory_xact_lock(hashtext('mt_uitstappen_bijwerken'));

  for u in select e.rij from jsonb_array_elements(p_uitstappen) as e(rij)
  loop
    v_r := mt_intern.uitstap_bijwerken(u.rij);
    v_tel := jsonb_set(v_tel, array[v_r ->> 'wat'], to_jsonb((v_tel ->> (v_r ->> 'wat'))::integer + 1));
    if jsonb_array_length(coalesce(v_r -> 'onbekend', '[]'::jsonb)) > 0 then
      v_onbekend := v_onbekend || jsonb_build_object('uitstap', v_r ->> 'uitstap', 'klassen', v_r -> 'onbekend');
    end if;
    if coalesce((v_r ->> 'wacht')::boolean, false) then
      v_wacht := v_wacht || (v_r -> 'uitstap');
    end if;
  end loop;

  if v_rol = 'beheerder' and p_alle_ids is not null then
    if cardinality(p_alle_ids) = 0 and exists (
         select 1 from public.activiteiten a join public.schooljaren s on s.schooljaar = a.schooljaar
          where a.soort = 'uitstap' and s.stand in ('lopend', 'voorbij') and a.bron_stand = 'actief') then
      raise exception 'MT: de uitstappentool gaf geen enkele uitstap terug. Dat is een fout, geen resultaat; er is niets gewijzigd.'
        using errcode = 'MT422';
    end if;
    for r in select a.id, a.schooljaar from public.activiteiten a join public.schooljaren s on s.schooljaar = a.schooljaar
              where a.soort = 'uitstap' and s.stand in ('lopend', 'voorbij')
                and a.bron_stand is distinct from 'niet_gevonden' and a.uitstap_id <> all (p_alle_ids)
              order by a.id for update of a
    loop
      update public.activiteiten a set bron_stand = 'niet_gevonden' where a.id = r.id;
      if mt_intern.heeft_gegevens(r.id) then
        perform mt_intern.taak_maken(r.schooljaar, 'uitstap_weg', 'uitstap_weg:' || r.id || ':niet_gevonden',
                                     r.id, null, null, jsonb_build_object('reden', 'niet_gevonden'));
      end if;
      v_weg := v_weg + 1;
    end loop;
  end if;
  return v_tel || jsonb_build_object('niet_gevonden', v_weg, 'onbekende_klassen', v_onbekend, 'wacht', v_wacht);
end
$$;
revoke all on function mt_intern.uitstappen_bijwerken(jsonb, text[]) from public;

-- ============================================================================================
-- 7. Schooljaar, klassen en leerlingen (4, 5, B132, B144, B169, B174)
-- ============================================================================================

-- De klassen van één schooljaar gelijkzetten met de klassenlijst van de uitstappentool:
--   [{"id", "naam", "groep", "actief"}], in de volgorde van de lijst.
-- Een nieuwe klas of naam verschijnt vanzelf; een vroegere naam blijft bij de klas horen (B158). Een
-- klas die uit de lijst verdween, wordt uitgezet, nooit gewist.
create or replace function mt_intern.klassen_toepassen(p_schooljaar text, p_klassen jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_klas public.klassen;
  v_gezien text[] := '{}';
  v_nieuw integer := 0;
  v_gewijzigd integer := 0;
  v_uit integer := 0;
  r record;
begin
  if p_klassen is null or jsonb_typeof(p_klassen) <> 'array' or jsonb_array_length(p_klassen) not between 1 and 300 then
    raise exception 'MT: de klassenlijst is leeg of klopt niet. Er is niets gewijzigd.' using errcode = 'MT422';
  end if;
  for r in select e.rij ->> 'id' as bron_id, btrim(coalesce(e.rij ->> 'naam', '')) as naam, e.rij ->> 'groep' as groep,
                  coalesce((e.rij ->> 'actief')::boolean, true) as actief, e.nr::integer as nr
             from jsonb_array_elements(p_klassen) with ordinality as e(rij, nr) order by e.nr
  loop
    if r.bron_id is null or char_length(r.bron_id) not between 1 and 60 or char_length(r.naam) not between 1 and 40
       or r.groep is null or r.groep not in ('Kleuter', 'Lager', 'Andere') or r.bron_id = any (v_gezien) then
      raise exception 'MT: klas % in de klassenlijst klopt niet. Er is niets gewijzigd.', r.nr using errcode = 'MT422';
    end if;
    v_gezien := v_gezien || r.bron_id;
    select * into v_klas from public.klassen k where k.schooljaar = p_schooljaar and k.bron_id = r.bron_id for update;
    if not found then
      insert into public.klassen (schooljaar, bron_id, naam, groep, actief, volgorde)
      values (p_schooljaar, r.bron_id, r.naam, r.groep, r.actief, r.nr);
      v_nieuw := v_nieuw + 1;
    elsif (v_klas.naam, v_klas.groep, v_klas.actief, v_klas.volgorde) is distinct from (r.naam, r.groep, r.actief, r.nr) then
      if v_klas.groep <> r.groep
         and ((r.groep = 'Andere' and exists (select 1 from public.klasindelingen ki where ki.klas_id = v_klas.id))
              or (v_klas.groep = 'Andere' and exists (select 1 from public.deelnemers d where d.klas_id = v_klas.id))) then
        raise exception 'MT: de groep van klas % kan niet meer wijzigen: er hangen al leerlingen aan. Er is niets gewijzigd.', v_klas.naam
          using errcode = 'MT422';
      end if;
      update public.klassen k set naam = r.naam, groep = r.groep, actief = r.actief, volgorde = r.nr where k.id = v_klas.id;
      v_gewijzigd := v_gewijzigd + 1;
    end if;
  end loop;
  update public.klassen k set actief = false
   where k.schooljaar = p_schooljaar and k.actief and k.bron_id <> all (v_gezien);
  get diagnostics v_uit = row_count;
  return jsonb_build_object('schooljaar', p_schooljaar, 'nieuw', v_nieuw, 'gewijzigd', v_gewijzigd, 'uitgezet', v_uit);
end
$$;
revoke all on function mt_intern.klassen_toepassen(text, jsonb) from public;

-- De klassen van het lopende schooljaar bijwerken. Enkel de beheerder: de groep van een klas bepaalt
-- het plafond. Een schooljaar dat voorbij is, houdt de namen van toen (4).
create or replace function mt_intern.klassen_bijwerken(p_klassen jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_jaar text;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  select s.schooljaar into v_jaar from public.schooljaren s where s.stand = 'lopend';
  if v_jaar is null then
    raise exception 'MT: er is nog geen lopend schooljaar' using errcode = 'MT422';
  end if;
  return mt_intern.klassen_toepassen(v_jaar, p_klassen);
end
$$;
revoke all on function mt_intern.klassen_bijwerken(jsonb) from public;

-- "Aanmaak nieuw schooljaar bevestigen" (B144, B169): het schooljaar wordt lopend, het vorige wordt
-- "voorbij, maar nog open" (B132). Ten vroegste vanaf 1 juli. Met de klassenlijst erbij staan de
-- klassen van het nieuwe schooljaar er meteen.
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
  return jsonb_build_object('schooljaar', p_schooljaar, 'vorig', v_vorig, 'open_lijsten_vorig', v_open, 'klassen', v_klassen);
end
$$;
revoke all on function mt_intern.schooljaar_bevestigen(text, jsonb) from public;

-- Eén leerling terugvinden, op zijn id of op zijn stamnummer.
create or replace function mt_intern.leerling_vinden(p_rij jsonb) returns uuid
language sql stable set search_path = '' as $$
  select l.id from public.leerlingen l
   where l.id = (p_rij ->> 'leerling')::uuid
      or ((p_rij ->> 'leerling') is null and l.stamnummer = p_rij ->> 'stamnummer')
$$;
revoke all on function mt_intern.leerling_vinden(jsonb) from public;

-- Wijzigingen aan leerlingen en klasindelingen doorvoeren, in één keer: alles of niets (B56, B174).
-- De pagina leest het bestand van Informat, toont de verschillen en stuurt wat de beheerder besliste.
-- Dezelfde functie dient voor "Leerling toevoegen", "Klas wijzigen" en "Uitschrijven" op de fiche.
-- p_regels, elk met "actie" en een leerling ("leerling": id, of "stamnummer"):
--   inschrijven    stamnummer, voornaam, familienaam, klas, klasnummer, van, laatste_dag (kan leeg)
--   klaswissel     klas, klasnummer, vanaf
--   uitschrijven   laatste_dag: die dag telt nog mee (B89)
--   einde_wissen   de leerling blijft toch
--   klasnummer     klasnummer, manueel, op (kan leeg: vandaag)
--   naam           voornaam, familienaam
-- p_import: {"bestandsnaam", "opnieuw"} bij een import uit Informat. Het bestand zelf wordt niet
-- bewaard (T13). De eerste import van een schooljaar is de eerste lijst, elke volgende een bijwerking;
-- "opnieuw" vervangt de eerste lijst, zolang er nog niets van afhangt (B174).
create or replace function mt_intern.leerlingen_doorvoeren(p_schooljaar text, p_regels jsonb, p_import jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_stand text;
  v_soort text;
  v_waar text := '';
  v_leerling uuid;
  v_ki public.klasindelingen;
  v_id uuid;
  v_dag date;
  v_klas uuid;
  v_weg uuid[] := '{}';
  v_nummers jsonb := '[]'::jsonb;
  v_tel jsonb := '{}'::jsonb;
  v_fase text;
  r record;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  select s.stand into v_stand from public.schooljaren s where s.schooljaar = p_schooljaar;
  if v_stand is null or not (v_stand = 'lopend' or (v_stand = 'voorbij' and p_import is null)) then
    raise exception 'MT: een import gaat altijd naar het lopende schooljaar (B132). In een schooljaar dat voorbij is, kan enkel een rechtzetting bij één leerling.'
      using errcode = 'MT422';
  end if;
  if p_regels is null or jsonb_typeof(p_regels) <> 'array' or jsonb_array_length(p_regels) > 3000
     or (p_import is not null and jsonb_typeof(p_import) <> 'object')
     or exists (select 1 from jsonb_array_elements(p_regels) as e(rij)
                 where coalesce(e.rij ->> 'actie', '') not in ('inschrijven', 'klaswissel', 'uitschrijven', 'einde_wissen', 'klasnummer', 'naam')) then
    raise exception 'MT: de lijst van wijzigingen klopt niet' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('mt_leerlingen'));

  if p_import is not null then
    if coalesce((p_import ->> 'opnieuw')::boolean, false) then
      if not exists (select 1 from public.imports i where i.schooljaar = p_schooljaar) then
        raise exception 'MT: er is in dit schooljaar nog geen eerste lijst' using errcode = 'MT422';
      end if;
      if exists (select 1 from public.bevestigingen b where b.schooljaar = p_schooljaar)
         or exists (select 1 from public.voorschotten v where v.schooljaar = p_schooljaar and v.aangerekend_op is not null)
         or exists (select 1 from public.facturaties f where f.schooljaar = p_schooljaar) then
        raise exception 'MT: opnieuw beginnen kan niet meer: aan deze lijst hangen al bevestigde aanwezigheden, een aangerekend voorschot of een facturatie. Zet een fout recht met een bijwerking (B174).'
          using errcode = 'MT422';
      end if;
      v_weg := array(select distinct ki.leerling_id from public.klasindelingen ki where ki.schooljaar = p_schooljaar);
      delete from public.klasindelingen ki where ki.schooljaar = p_schooljaar;
      v_soort := 'opnieuw_eerste_lijst';
    elsif exists (select 1 from public.imports i where i.schooljaar = p_schooljaar) then
      v_soort := 'bijwerking';
    else
      v_soort := 'eerste_lijst';
    end if;
  end if;

  -- In een vaste volgorde, zodat een klasnummer dat vrijkomt, in dezelfde import opnieuw kan dienen:
  -- eerst komen nummers vrij, dan komen de nieuwe perioden erbij, en pas op het einde de nummers.
  foreach v_fase in array array['naam', 'klasnummer', 'uitschrijven', 'einde_wissen', 'klaswissel', 'inschrijven']
  loop
    for r in select e.rij, e.nr from jsonb_array_elements(p_regels) with ordinality as e(rij, nr)
              where e.rij ->> 'actie' = v_fase order by e.nr
    loop
      v_waar := 'regel ' || r.nr || ' (' || v_fase || coalesce(', stamnummer ' || (r.rij ->> 'stamnummer'), '') || ')';
      if v_fase <> 'inschrijven' then
        v_leerling := mt_intern.leerling_vinden(r.rij);
        if v_leerling is null then
          raise exception 'MT: %: deze leerling bestaat niet', v_waar using errcode = 'MT422';
        end if;
      end if;

      if v_fase = 'naam' then
        update public.leerlingen l set voornaam = btrim(r.rij ->> 'voornaam'), familienaam = btrim(r.rij ->> 'familienaam')
         where l.id = v_leerling;

      elsif v_fase = 'klasnummer' then
        v_dag := coalesce((r.rij ->> 'op')::date, mt_intern.vandaag());
        select * into v_ki from public.klasindelingen ki
         where ki.leerling_id = v_leerling and ki.schooljaar = p_schooljaar
         order by (ki.van <= v_dag and v_dag < ki.einde) desc, ki.van desc limit 1 for update;
        if not found then
          raise exception 'MT: %: de leerling zit dit schooljaar in geen enkele klas', v_waar using errcode = 'MT422';
        end if;
        update public.klasindelingen ki set klasnummer = 0 where ki.id = v_ki.id and ki.klasnummer <> 0;
        v_nummers := v_nummers || jsonb_build_object('id', v_ki.id, 'nummer', coalesce((r.rij ->> 'klasnummer')::integer, 0),
                                                     'manueel', coalesce((r.rij ->> 'manueel')::boolean, false), 'waar', v_waar);

      elsif v_fase = 'uitschrijven' then
        v_dag := (r.rij ->> 'laatste_dag')::date;
        select * into v_ki from public.klasindelingen ki
         where ki.leerling_id = v_leerling and ki.schooljaar = p_schooljaar and ki.van <= v_dag and v_dag < ki.einde for update;
        if not found then
          raise exception 'MT: %: de leerling zit op die dag in geen enkele klas', v_waar using errcode = 'MT422';
        end if;
        delete from public.klasindelingen ki
         where ki.leerling_id = v_leerling and ki.schooljaar = p_schooljaar and ki.van > v_dag;
        update public.klasindelingen ki set tot = v_dag + 1 where ki.id = v_ki.id;

      elsif v_fase = 'einde_wissen' then
        select * into v_ki from public.klasindelingen ki
         where ki.leerling_id = v_leerling and ki.schooljaar = p_schooljaar order by ki.van desc limit 1 for update;
        if not found then
          raise exception 'MT: %: de leerling zit dit schooljaar in geen enkele klas', v_waar using errcode = 'MT422';
        end if;
        update public.klasindelingen ki set tot = null where ki.id = v_ki.id;

      elsif v_fase = 'klaswissel' then
        v_dag := (r.rij ->> 'vanaf')::date;
        v_klas := (r.rij ->> 'klas')::uuid;
        select * into v_ki from public.klasindelingen ki
         where ki.leerling_id = v_leerling and ki.schooljaar = p_schooljaar and ki.van <= v_dag and v_dag < ki.einde for update;
        if not found then
          raise exception 'MT: %: de leerling zit op die dag in geen enkele klas', v_waar using errcode = 'MT422';
        end if;
        if v_ki.klas_id = v_klas then
          raise exception 'MT: %: de leerling zit al in die klas', v_waar using errcode = 'MT422';
        end if;
        if v_ki.van = v_dag then
          update public.klasindelingen ki set klas_id = v_klas, klasnummer = 0, klasnummer_manueel = false where ki.id = v_ki.id;
          v_id := v_ki.id;
        else
          update public.klasindelingen ki set tot = v_dag where ki.id = v_ki.id;
          insert into public.klasindelingen (leerling_id, schooljaar, klas_id, klasnummer, van, tot)
          values (v_leerling, p_schooljaar, v_klas, 0, v_dag, v_ki.tot) returning id into v_id;
        end if;
        v_nummers := v_nummers || jsonb_build_object('id', v_id, 'nummer', coalesce((r.rij ->> 'klasnummer')::integer, 0),
                                                     'manueel', coalesce((r.rij ->> 'manueel')::boolean, false), 'waar', v_waar);

      else
        insert into public.leerlingen (stamnummer, voornaam, familienaam)
        values (r.rij ->> 'stamnummer', btrim(r.rij ->> 'voornaam'), btrim(r.rij ->> 'familienaam'))
        on conflict (stamnummer) do update set voornaam = excluded.voornaam, familienaam = excluded.familienaam
        returning id into v_leerling;
        insert into public.klasindelingen (leerling_id, schooljaar, klas_id, klasnummer, van, tot)
        values (v_leerling, p_schooljaar, (r.rij ->> 'klas')::uuid, 0, (r.rij ->> 'van')::date, (r.rij ->> 'laatste_dag')::date + 1)
        returning id into v_id;
        v_nummers := v_nummers || jsonb_build_object('id', v_id, 'nummer', coalesce((r.rij ->> 'klasnummer')::integer, 0),
                                                     'manueel', coalesce((r.rij ->> 'manueel')::boolean, false), 'waar', v_waar);
      end if;
      v_tel := jsonb_set(v_tel, array[v_fase], to_jsonb(coalesce((v_tel ->> v_fase)::integer, 0) + 1));
    end loop;
  end loop;

  for r in select (x.rij ->> 'id')::uuid as id, (x.rij ->> 'nummer')::integer as nummer, (x.rij ->> 'manueel')::boolean as manueel,
                  x.rij ->> 'waar' as waar
             from jsonb_array_elements(v_nummers) as x(rij)
  loop
    v_waar := r.waar || ', klasnummer ' || r.nummer;
    update public.klasindelingen ki set klasnummer = r.nummer, klasnummer_manueel = r.manueel
     where ki.id = r.id and (ki.klasnummer, ki.klasnummer_manueel) is distinct from (r.nummer, r.manueel);
  end loop;
  v_waar := '';

  -- Na "opnieuw": wie enkel door de vervangen lijst bestond en nergens meer aan hangt, verdwijnt.
  if v_soort = 'opnieuw_eerste_lijst' then
    for r in select l.id from public.leerlingen l
              where l.id = any (v_weg) and not exists (select 1 from public.klasindelingen ki where ki.leerling_id = l.id)
    loop
      begin
        delete from public.leerlingen l where l.id = r.id;
      exception when foreign_key_violation then
        null;
      end;
    end loop;
  end if;

  if p_import is not null then
    insert into public.imports (schooljaar, soort, bestandsnaam, aantallen, uitgevoerd_op, uitgevoerd_door)
    values (p_schooljaar, v_soort, left(nullif(btrim(coalesce(p_import ->> 'bestandsnaam', '')), ''), 200), v_tel, now(), v_wie);
  end if;
  return jsonb_build_object('schooljaar', p_schooljaar, 'soort', v_soort, 'aantallen', v_tel);
exception
  when exclusion_violation then
    raise exception 'MT: % kan niet: de leerling zit in die periode al in een klas, of het klasnummer is in die klas al in gebruik. Er is niets gewijzigd.', v_waar
      using errcode = 'MT422';
  when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'MT: % klopt niet (%). Er is niets gewijzigd.', v_waar, sqlerrm using errcode = 'MT422';
end
$$;
revoke all on function mt_intern.leerlingen_doorvoeren(text, jsonb, jsonb) from public;

-- ============================================================================================
-- 8. Lopende activiteiten, zoals zwemmen (6, B36, B149, B176, B196, B200)
-- ============================================================================================

-- Eén beurt maken, met een lijst per klas. Bestaat er op die dag al een beurt, dan gebeurt er niets.
create or replace function mt_intern.beurt_maken(p_lopende uuid, p_dag date) returns boolean
language plpgsql set search_path = '' as $$
declare
  v_la public.lopende_activiteiten;
  v_id uuid;
begin
  select * into v_la from public.lopende_activiteiten la where la.id = p_lopende;
  if p_dag is null or p_dag < make_date(left(v_la.schooljaar, 4)::integer, 9, 1)
     or p_dag >= make_date(right(v_la.schooljaar, 4)::integer, 9, 1) then
    raise exception 'MT: de beurt van % valt buiten schooljaar %', to_char(p_dag, 'DD/MM/YYYY'), v_la.schooljaar using errcode = 'MT422';
  end if;
  insert into public.activiteiten (schooljaar, soort, lopende_activiteit_id, datum_start, datum_eind, prijs_per_kind_afwezigen)
  values (v_la.schooljaar, 'beurt', p_lopende, p_dag, p_dag, v_la.iedereen_betaalt)
  on conflict (lopende_activiteit_id, datum_start) where soort = 'beurt' do nothing
  returning id into v_id;
  if v_id is null then
    return false;
  end if;
  insert into public.klaslijsten (activiteit_id, klas_id, schooljaar, aangemaakt_door)
  select v_id, lk.klas_id, lk.schooljaar, auth.uid()
    from public.lopende_activiteit_klassen lk where lk.lopende_activiteit_id = p_lopende;
  return true;
end
$$;
revoke all on function mt_intern.beurt_maken(uuid, date) from public;

-- Lopende activiteiten aanmaken, één of meerdere in één keer (B200: per leerjaar of per klas een eigen
-- lopende activiteit). De beheerder maakt ze meteen, met hun beurten. Een leerkracht vraagt ze aan,
-- enkel voor haar eigen klassen: de beurten komen er pas bij de bevestiging (B36).
-- p_activiteiten: [{"id", "schooljaar", "naam", "zwemmen", "iedereen_betaalt", "planning": {…},
--   "klassen": [id's], "data": ["2027-01-05", …],
--   "kostenregels": [{"omschrijving", "verdeling", "onderdeel", "bedrag_cent"}]}]
-- Het id komt van de pagina: een tweede poging met hetzelfde id maakt niets dubbel.
create or replace function mt_intern.lopende_activiteiten_aanmaken(p_activiteiten jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_mijn uuid[] := '{}';
  v_id uuid;
  v_jaar text;
  v_stand text;
  v_naam text;
  v_klassen uuid[];
  v_data date[];
  v_planning jsonb;
  v_regel uuid;
  v_dag date;
  v_gemaakt integer := 0;
  v_over integer := 0;
  v_beurten integer := 0;
  r record;
  q record;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht');
  if p_activiteiten is null or jsonb_typeof(p_activiteiten) <> 'array' or jsonb_array_length(p_activiteiten) not between 1 and 60 then
    raise exception 'MT: geen lopende activiteit meegegeven' using errcode = '22023';
  end if;
  if v_rol = 'leerkracht' then
    v_mijn := mt_intern.mt_mijn_klassen();
  end if;
  for r in select e.rij from jsonb_array_elements(p_activiteiten) with ordinality as e(rij, nr) order by e.nr
  loop
    v_id := coalesce((r.rij ->> 'id')::uuid, gen_random_uuid());
    if exists (select 1 from public.lopende_activiteiten la where la.id = v_id) then
      v_over := v_over + 1;
      continue;
    end if;
    v_jaar := r.rij ->> 'schooljaar';
    select s.stand into v_stand from public.schooljaren s where s.schooljaar = v_jaar;
    if v_stand is null or not (v_stand = 'lopend' or (v_stand = 'voorbij' and v_rol = 'beheerder')) then
      raise exception 'MT: in dit schooljaar kan geen lopende activiteit bij' using errcode = 'MT422';
    end if;
    v_naam := btrim(coalesce(r.rij ->> 'naam', ''));
    if char_length(v_naam) not between 1 and 80 then
      raise exception 'MT: geef de activiteit een naam, van hoogstens 80 tekens' using errcode = 'MT422';
    end if;
    v_klassen := array(select distinct x.klas::uuid
                         from jsonb_array_elements_text(coalesce(r.rij -> 'klassen', '[]'::jsonb)) as x(klas));
    if cardinality(v_klassen) = 0
       or exists (select 1 from unnest(v_klassen) as k(id)
                   where not exists (select 1 from public.klassen c
                                      where c.id = k.id and c.schooljaar = v_jaar and c.groep in ('Kleuter', 'Lager'))) then
      raise exception 'MT: kies minstens één kleuterklas of lagere klas van dat schooljaar' using errcode = 'MT422';
    end if;
    if v_rol = 'leerkracht' and not (v_klassen <@ v_mijn) then
      raise exception 'MT: een leerkracht vraagt enkel voor haar eigen klassen aan' using errcode = '42501';
    end if;
    v_data := array(select distinct x.dag::date
                      from jsonb_array_elements_text(coalesce(r.rij -> 'data', '[]'::jsonb)) as x(dag) order by 1);
    v_planning := coalesce(r.rij -> 'planning', '{}'::jsonb);
    if cardinality(v_data) > 250 or jsonb_typeof(v_planning) <> 'object' or char_length(v_planning::text) > 20000 then
      raise exception 'MT: de planning klopt niet' using errcode = '22023';
    end if;

    insert into public.lopende_activiteiten (id, schooljaar, naam, zwemmen, iedereen_betaalt, planning, stand, aangevraagd_door, aangevraagd_op)
    values (v_id, v_jaar, v_naam, coalesce((r.rij ->> 'zwemmen')::boolean, false), coalesce((r.rij ->> 'iedereen_betaalt')::boolean, false),
            v_planning || jsonb_build_object('data', to_jsonb(v_data)),
            case when v_rol = 'beheerder' then 'bevestigd' else 'aangevraagd' end,
            case when v_rol = 'leerkracht' then v_wie end, case when v_rol = 'leerkracht' then now() end);
    insert into public.lopende_activiteit_klassen (lopende_activiteit_id, klas_id, schooljaar)
    select v_id, k.id, v_jaar from unnest(v_klassen) as k(id);
    for q in select x.rij, x.nr::integer as nr
               from jsonb_array_elements(coalesce(r.rij -> 'kostenregels', '[]'::jsonb)) with ordinality as x(rij, nr) order by x.nr
    loop
      v_regel := gen_random_uuid();
      insert into public.kostenregels (id, lopende_activiteit_id, schooljaar, omschrijving, verdeling, onderdeel, volgorde)
      values (v_regel, v_id, v_jaar, btrim(q.rij ->> 'omschrijving'), q.rij ->> 'verdeling', q.rij ->> 'onderdeel', q.nr);
      insert into public.tarieven (kostenregel_id, geldig_vanaf, schooljaar, bedrag_cent)
      values (v_regel, make_date(left(v_jaar, 4)::integer, 9, 1), v_jaar, (q.rij ->> 'bedrag_cent')::integer);
    end loop;
    if v_rol = 'beheerder' then
      foreach v_dag in array v_data loop
        if mt_intern.beurt_maken(v_id, v_dag) then
          v_beurten := v_beurten + 1;
        end if;
      end loop;
    end if;
    v_gemaakt := v_gemaakt + 1;
  end loop;
  return jsonb_build_object('gemaakt', v_gemaakt, 'bestond_al', v_over, 'beurten', v_beurten,
                            'stand', case when v_rol = 'beheerder' then 'bevestigd' else 'aangevraagd' end);
exception
  when check_violation or not_null_violation or foreign_key_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'MT: de gegevens van de lopende activiteit kloppen niet (%). Er is niets bewaard.', sqlerrm using errcode = 'MT422';
end
$$;
revoke all on function mt_intern.lopende_activiteiten_aanmaken(jsonb) from public;

-- De beheerder bevestigt of weigert een aangevraagde lopende activiteit (B36). Bij het bevestigen
-- komen de beurten erbij, uit de gevraagde data.
create or replace function mt_intern.lopende_activiteit_behandelen(p_id uuid, p_bevestigen boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_la public.lopende_activiteiten;
  v_dag date;
  v_beurten integer := 0;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  if p_bevestigen is null then
    raise exception 'MT: bevestigen of weigeren?' using errcode = '22023';
  end if;
  select * into v_la from public.lopende_activiteiten la where la.id = p_id for update;
  if not found then
    raise exception 'MT: deze lopende activiteit bestaat niet' using errcode = 'MT422';
  end if;
  if v_la.stand <> 'aangevraagd' then
    raise exception 'MT: deze aanvraag is al behandeld' using errcode = 'MT409';
  end if;
  update public.lopende_activiteiten la
     set stand = case when p_bevestigen then 'bevestigd' else 'geweigerd' end, behandeld_door = auth.uid(), behandeld_op = now()
   where la.id = p_id;
  if p_bevestigen then
    for v_dag in select distinct x.dag::date
                   from jsonb_array_elements_text(case when jsonb_typeof(v_la.planning -> 'data') = 'array'
                                                       then v_la.planning -> 'data' else '[]'::jsonb end) as x(dag) order by 1
    loop
      if mt_intern.beurt_maken(p_id, v_dag) then
        v_beurten := v_beurten + 1;
      end if;
    end loop;
  end if;
  return jsonb_build_object('id', p_id, 'stand', case when p_bevestigen then 'bevestigd' else 'geweigerd' end, 'beurten', v_beurten);
end
$$;
revoke all on function mt_intern.lopende_activiteit_behandelen(uuid, boolean) from public;

-- De beurten van een lopende activiteit aanpassen (B196): beurten erbij, weg of verplaatsen. Een beurt
-- waar al iets aan hangt, kan niet weg; een bevestigde beurt verplaatst niet. De beurten die nog
-- komen, volgen de klassen van de lopende activiteit.
-- p_verplaatsen: [{"van": "2027-01-05", "naar": "2027-01-12"}]
create or replace function mt_intern.beurten_plannen(p_lopende uuid, p_toevoegen date[] default null,
                                                     p_verwijderen date[] default null, p_verplaatsen jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_la public.lopende_activiteiten;
  v_act public.activiteiten;
  v_stand text;
  v_dag date;
  v_rijen public.afwezigheden[];
  v_bij integer := 0;
  v_weg integer := 0;
  v_verplaatst integer := 0;
  r record;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  select * into v_la from public.lopende_activiteiten la where la.id = p_lopende for update;
  if not found or v_la.stand <> 'bevestigd' then
    raise exception 'MT: deze lopende activiteit bestaat niet, of is nog niet bevestigd' using errcode = 'MT422';
  end if;
  select s.stand into v_stand from public.schooljaren s where s.schooljaar = v_la.schooljaar;
  if v_stand not in ('lopend', 'voorbij') then
    raise exception 'MT: in dit schooljaar kunnen geen beurten meer wijzigen' using errcode = 'MT422';
  end if;

  foreach v_dag in array coalesce(p_verwijderen, '{}'::date[]) loop
    select * into v_act from public.activiteiten a
     where a.lopende_activiteit_id = p_lopende and a.soort = 'beurt' and a.datum_start = v_dag for update;
    if not found then
      continue;
    end if;
    if mt_intern.heeft_gegevens(v_act.id) then
      raise exception 'MT: aan de beurt van % hangen al aanwezigheden of een bevestiging: ze kan niet weg. Ging ze niet door, duid dat dan aan bij de beurt.',
        to_char(v_dag, 'DD/MM/YYYY') using errcode = 'MT422';
    end if;
    delete from public.activiteiten a where a.id = v_act.id;
    v_weg := v_weg + 1;
  end loop;

  for r in select (x.rij ->> 'van')::date as van, (x.rij ->> 'naar')::date as naar
             from jsonb_array_elements(coalesce(p_verplaatsen, '[]'::jsonb)) as x(rij)
  loop
    select * into v_act from public.activiteiten a
     where a.lopende_activiteit_id = p_lopende and a.soort = 'beurt' and a.datum_start = r.van for update;
    if not found or r.naar is null then
      raise exception 'MT: er is geen beurt op %', to_char(r.van, 'DD/MM/YYYY') using errcode = 'MT422';
    end if;
    if r.naar < make_date(left(v_la.schooljaar, 4)::integer, 9, 1) or r.naar >= make_date(right(v_la.schooljaar, 4)::integer, 9, 1) then
      raise exception 'MT: de beurt van % valt buiten schooljaar %', to_char(r.naar, 'DD/MM/YYYY'), v_la.schooljaar using errcode = 'MT422';
    end if;
    if exists (select 1 from public.klaslijsten l where l.activiteit_id = v_act.id and l.stand = 'bevestigd') then
      raise exception 'MT: de beurt van % is al bevestigd en kan niet verplaatsen', to_char(r.van, 'DD/MM/YYYY') using errcode = 'MT422';
    end if;
    if exists (select 1 from public.activiteiten a
                where a.lopende_activiteit_id = p_lopende and a.soort = 'beurt' and a.datum_start = r.naar) then
      raise exception 'MT: er is al een beurt op %', to_char(r.naar, 'DD/MM/YYYY') using errcode = 'MT422';
    end if;
    v_rijen := array(select af from public.afwezigheden af where af.activiteit_id = v_act.id);
    delete from public.afwezigheden af where af.activiteit_id = v_act.id;
    update public.activiteiten a set datum_start = r.naar, datum_eind = r.naar where a.id = v_act.id;
    insert into public.afwezigheden (activiteit_id, leerling_id, dag, klas_id, schooljaar, status_id, gewijzigd_op, gewijzigd_door)
    select w.activiteit_id, w.leerling_id, r.naar, w.klas_id, w.schooljaar, w.status_id, w.gewijzigd_op, w.gewijzigd_door
      from unnest(v_rijen) as w;
    update public.klaslijsten l set revisie = l.revisie + 1, gewijzigd_op = now() where l.activiteit_id = v_act.id;
    v_verplaatst := v_verplaatst + 1;
  end loop;

  foreach v_dag in array coalesce(p_toevoegen, '{}'::date[]) loop
    if mt_intern.beurt_maken(p_lopende, v_dag) then
      v_bij := v_bij + 1;
    end if;
  end loop;

  insert into public.klaslijsten (activiteit_id, klas_id, schooljaar, aangemaakt_door)
  select a.id, lk.klas_id, lk.schooljaar, auth.uid()
    from public.activiteiten a
    join public.lopende_activiteit_klassen lk on lk.lopende_activiteit_id = a.lopende_activiteit_id
   where a.lopende_activiteit_id = p_lopende and a.soort = 'beurt' and a.datum_start >= mt_intern.vandaag()
  on conflict (activiteit_id, klas_id) do nothing;
  delete from public.klaslijsten l
   using public.activiteiten a
   where a.id = l.activiteit_id and a.lopende_activiteit_id = p_lopende and a.soort = 'beurt'
     and a.datum_start >= mt_intern.vandaag() and l.stand = 'open'
     and not exists (select 1 from public.lopende_activiteit_klassen lk
                      where lk.lopende_activiteit_id = p_lopende and lk.klas_id = l.klas_id)
     and not mt_intern.heeft_gegevens(l.activiteit_id, l.klas_id);
  return jsonb_build_object('erbij', v_bij, 'weg', v_weg, 'verplaatst', v_verplaatst);
end
$$;
revoke all on function mt_intern.beurten_plannen(uuid, date[], date[], jsonb) from public;

-- "Deze beurt ging niet door" (B149, B176): de beurt blijft staan en wordt bevestigd zoals altijd.
--   p_wie: 'organisator' (bv. het zwembad annuleerde: geen kosten), 'school' (de school ging niet: de
--   kosten vult de beheerder in, ook 0 kan), of leeg: "ging toch door", en alles staat er weer.
-- Wie de aanwezigheden ingeeft, leerkracht of beheerder, kan het aanduiden; de kosten enkel de
-- beheerder. Zolang ze bij "school" niet ingevuld zijn, toont de te-doenlijst "kosten te bekijken".
-- Wat al aangeduid was, blijft bewaard: enkel een status die niet aangerekend wordt, telt nog.
create or replace function mt_intern.beurt_ging_niet_door(p_activiteit uuid, p_wie text, p_activiteit_cent integer default null,
                                                          p_vervoer_cent integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_act public.activiteiten;
  v_kost_a integer;
  v_kost_v integer;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht');
  select * into v_act from public.activiteiten a where a.id = p_activiteit for update;
  if not found or v_act.soort <> 'beurt'
     or not exists (select 1 from public.klaslijsten l
                     where l.activiteit_id = p_activiteit and mt_intern.mt_mag_lijst(l.activiteit_id, l.klas_id)) then
    raise exception 'MT: geen rechten voor deze beurt' using errcode = '42501';
  end if;
  if (p_wie is not null and p_wie not in ('organisator', 'school'))
     or (p_wie is distinct from 'school' and (p_activiteit_cent is not null or p_vervoer_cent is not null))
     or p_activiteit_cent < 0 or p_vervoer_cent < 0 then
    raise exception 'MT: wie annuleerde, of de kosten, kloppen niet' using errcode = '22023';
  end if;
  if v_rol <> 'beheerder' and (p_activiteit_cent is not null or p_vervoer_cent is not null) then
    raise exception 'MT: de kosten vult de beheerder in' using errcode = '42501';
  end if;
  perform 1 from public.klaslijsten l where l.activiteit_id = p_activiteit order by l.klas_id for update;
  if exists (select 1 from public.klaslijsten l where l.activiteit_id = p_activiteit and l.stand = 'bevestigd') then
    raise exception 'MT: een klas van deze beurt is al bevestigd. Heropen ze eerst.' using errcode = 'MT422';
  end if;
  if p_wie = 'school' then
    if v_rol = 'beheerder' then
      v_kost_a := p_activiteit_cent;
      v_kost_v := p_vervoer_cent;
    elsif v_act.ging_niet_door = 'school' then
      v_kost_a := v_act.niet_door_activiteit_cent;
      v_kost_v := v_act.niet_door_vervoer_cent;
    end if;
  end if;
  update public.activiteiten a
     set ging_niet_door = p_wie, niet_door_activiteit_cent = v_kost_a, niet_door_vervoer_cent = v_kost_v
   where a.id = p_activiteit;
  update public.klaslijsten l set revisie = l.revisie + 1, gewijzigd_op = now() where l.activiteit_id = p_activiteit;
  return jsonb_build_object('ging_niet_door', p_wie,
                            'kosten_te_bekijken', coalesce(p_wie = 'school' and (v_kost_a is null or v_kost_v is null), false));
end
$$;
revoke all on function mt_intern.beurt_ging_niet_door(uuid, text, integer, integer) from public;

-- ============================================================================================
-- 9. Lezen: totalen, namen en voorkeuren (T6)
-- ============================================================================================

-- De aantallen per lijst, voor één schooljaar. Een gedeelde kost wordt verdeeld over alle klassen van
-- een activiteit samen: de leerkracht van 4A heeft dus ook de aantallen van 4B nodig. Ze krijgt enkel
-- aantallen, nooit namen of statussen van een andere klas, en enkel van activiteiten waar haar klassen
-- of haar leerlingen van nu bij betrokken zijn. De beheerder en de lezer krijgen alle lijsten: zo
-- rekent de pagina voor elke rol met dezelfde cijfers.
--   op_lijst     wie op de lijst staat
--   deelnemers   zonder wie niet deelneemt (uitgevinkt bij een meerdaagse, B109)
--   aangerekend  deelnemers zonder een status die niet aangerekend wordt; bij een meerdaagse alle
--                deelnemers (B112)
--   aanwezig     deelnemers zonder afwezigheid
--   te_bepalen   deelnemers die nog op "nog te bepalen" staan
create or replace function mt_intern.lijst_totalen(p_schooljaar text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rol text;
  v_alles boolean;
  v_klassen uuid[] := '{}';
  v_nu uuid[] := '{}';
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht', 'lezer');
  v_alles := v_rol in ('beheerder', 'lezer');
  if not v_alles then
    v_klassen := mt_intern.mt_mijn_klassen();
    v_nu := mt_intern.mt_mijn_leerlingen_nu();
  end if;
  return coalesce((
    with lijsten as (
      select l.activiteit_id, l.klas_id, l.stand, l.bevestiging_id, a.datum_start, a.datum_eind, a.meerdaags, k.groep
        from public.klaslijsten l
        join public.activiteiten a on a.id = l.activiteit_id
        join public.klassen k on k.id = l.klas_id
       where l.schooljaar = p_schooljaar and not l.vervallen
         and (v_alles
              or exists (select 1 from public.klaslijsten l2
                          where l2.activiteit_id = l.activiteit_id and l2.klas_id = any (v_klassen))
              or exists (select 1 from public.klaslijsten l2
                           join public.klasindelingen ki on ki.klas_id = l2.klas_id
                            and ki.van <= a.datum_start and a.datum_start < ki.einde
                          where l2.activiteit_id = l.activiteit_id and ki.leerling_id = any (v_nu)))
    ),
    leden as (
      select x.activiteit_id, x.klas_id, bl.leerling_id
        from lijsten x join public.bevestiging_leerlingen bl on bl.bevestiging_id = x.bevestiging_id
       where x.stand = 'bevestigd'
      union all
      select x.activiteit_id, x.klas_id, ki.leerling_id
        from lijsten x join public.klasindelingen ki on ki.klas_id = x.klas_id
         and ki.van <= x.datum_start and x.datum_start < ki.einde
       where x.stand = 'open' and x.groep <> 'Andere'
      union all
      select x.activiteit_id, x.klas_id, d.leerling_id
        from lijsten x join public.deelnemers d on d.activiteit_id = x.activiteit_id and d.klas_id = x.klas_id
       where x.stand = 'open' and x.groep = 'Andere'
         and not mt_intern.gaat_mee_met_klas(x.activiteit_id, d.leerling_id, x.datum_start)
    ),
    per_leerling as (
      select m.activiteit_id, m.klas_id, x.meerdaags,
             exists (select 1 from public.deelname dn
                      where dn.activiteit_id = m.activiteit_id and dn.leerling_id = m.leerling_id and dn.klas_id = m.klas_id) as uitgevinkt,
             z.afwezig, z.dag1_vrij, z.te_bepalen
        from leden m
        join lijsten x on x.activiteit_id = m.activiteit_id and x.klas_id = m.klas_id
        cross join lateral (
          select count(*) > 0 as afwezig,
                 coalesce(bool_or(af.dag = x.datum_start and not s.aangerekend), false) as dag1_vrij,
                 coalesce(bool_or(s.soort = 'te_bepalen'), false) as te_bepalen
            from public.afwezigheden af join public.statussen s on s.id = af.status_id
           where af.activiteit_id = m.activiteit_id and af.leerling_id = m.leerling_id
             and af.dag between x.datum_start and x.datum_eind) z
    ),
    tellingen as (
      select p.activiteit_id, p.klas_id,
             count(*) as op_lijst,
             count(*) filter (where not p.uitgevinkt) as deelnemers,
             count(*) filter (where not p.uitgevinkt and (p.meerdaags or not p.dag1_vrij)) as aangerekend,
             count(*) filter (where not p.uitgevinkt and not p.afwezig) as aanwezig,
             count(*) filter (where not p.uitgevinkt and p.te_bepalen) as te_bepalen
        from per_leerling p group by p.activiteit_id, p.klas_id
    )
    select jsonb_agg(jsonb_build_object(
             'activiteit', x.activiteit_id, 'klas', x.klas_id, 'stand', x.stand,
             'op_lijst', coalesce(t.op_lijst, 0), 'deelnemers', coalesce(t.deelnemers, 0),
             'aangerekend', coalesce(t.aangerekend, 0), 'aanwezig', coalesce(t.aanwezig, 0),
             'te_bepalen', coalesce(t.te_bepalen, 0),
             'annulering_betalers', (select count(*) from public.annulering_betalers ab
                                      where ab.activiteit_id = x.activiteit_id and ab.klas_id = x.klas_id))
             order by x.activiteit_id, x.klas_id)
      from lijsten x
      left join tellingen t on t.activiteit_id = x.activiteit_id and t.klas_id = x.klas_id
  ), '[]'::jsonb);
end
$$;
revoke all on function mt_intern.lijst_totalen(text) from public;

-- De namen van de gebruikers, voor "bevestigd door …" en "gewijzigd door …". Enkel id en naam: geen
-- e-mailadres, rol of accountgegevens (B158).
create or replace function mt_intern.gebruikers_namen() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rol text;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht', 'lezer');
  return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'naam', g.naam) order by g.naam, g.id)
                     from public.gebruikers g), '[]'::jsonb);
end
$$;
revoke all on function mt_intern.gebruikers_namen() from public;

-- De eigen voorkeuren bewaren: de standaardfilter, de gekozen soort en het gekozen schooljaar. Elke
-- gebruiker, enkel voor zichzelf.
create or replace function mt_intern.voorkeuren_bewaren(p_voorkeuren jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht', 'lezer');
  if p_voorkeuren is null or jsonb_typeof(p_voorkeuren) <> 'object' or char_length(p_voorkeuren::text) > 8000 then
    raise exception 'MT: de voorkeuren kloppen niet, of zijn te groot' using errcode = 'MT422';
  end if;
  insert into public.gebruiker_voorkeuren (gebruiker_id, voorkeuren, bijgewerkt_op)
  values (auth.uid(), p_voorkeuren, now())
  on conflict (gebruiker_id) do update set voorkeuren = excluded.voorkeuren, bijgewerkt_op = now();
  return p_voorkeuren;
end
$$;
revoke all on function mt_intern.voorkeuren_bewaren(jsonb) from public;

-- De deelnemerslijst van een klas uit de groep Andere stelt de beheerder rechtstreeks samen (B143).
-- Twee regels erbij: wie al met zijn eigen klas meegaat, kan er niet nog eens bij; en elke wijziging
-- verhoogt de revisie van de lijst, zodat bevestigen ze opmerkt (T2).
create or replace function mt_intern.bewaak_deelnemer_dubbel() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_dag date;
begin
  select a.datum_start into v_dag from public.activiteiten a where a.id = new.activiteit_id;
  if mt_intern.gaat_mee_met_klas(new.activiteit_id, new.leerling_id, v_dag) then
    raise exception 'MT: deze leerling gaat al mee met zijn eigen klas, en telt daar mee' using errcode = 'MT422';
  end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_deelnemer_dubbel() from public;

create or replace function mt_intern.na_deelnemer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform mt_intern.revisie_omhoog(old.activiteit_id, old.klas_id);
  else
    perform mt_intern.revisie_omhoog(new.activiteit_id, new.klas_id);
  end if;
  return null;
end
$$;
revoke all on function mt_intern.na_deelnemer() from public;

create or replace trigger mt_dubbel before insert on public.deelnemers
  for each row execute function mt_intern.bewaak_deelnemer_dubbel();
create or replace trigger mt_revisie after insert or delete on public.deelnemers
  for each row execute function mt_intern.na_deelnemer();

-- ============================================================================================
-- 10. De doorgeefluiken en de rechten
-- ============================================================================================
-- De Data API bereikt enkel het schema public. Voor elke functie van de lijst hieronder komt daar een
-- doorgeefluik: dezelfde naam met mt_ ervoor, dezelfde invoer, en als enige inhoud de oproep van de
-- functie in mt_intern. Het doorgeefluik omzeilt zelf niets (geen security definer); de functie
-- erachter begint met de toegangscontrole. Enkel authenticated mag ze uitvoeren: anon en
-- service_role niet.

do $$
declare
  r record;
  v_door text;
begin
  for r in
    select p.proname, p.provolatile, p.pronargs,
           pg_get_function_arguments(p.oid) as invoer,
           pg_get_function_identity_arguments(p.oid) as soorten,
           pg_get_function_result(p.oid) as uitvoer
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'mt_intern'
       and p.proname = any (array[
         'status_bewaren', 'deelname_bewaren', 'opmerking_bewaren', 'bevestigen', 'heropenen',
         'wijziging_aanvragen', 'aanvraag_intrekken', 'aanvraag_behandelen', 'was_hij_mee', 'taak_afhandelen',
         'uitstappen_bijwerken', 'klassen_bijwerken', 'schooljaar_bevestigen', 'leerlingen_doorvoeren',
         'lopende_activiteiten_aanmaken', 'lopende_activiteit_behandelen', 'beurten_plannen', 'beurt_ging_niet_door',
         'lijst_totalen', 'gebruikers_namen', 'voorkeuren_bewaren'])
  loop
    select coalesce(string_agg('$' || i, ', ' order by i), '') into v_door from generate_series(1, r.pronargs) as i;
    execute format('create or replace function public.%I(%s) returns %s language sql %s set search_path = '''' as $w$ select mt_intern.%I(%s) $w$',
                   'mt_' || r.proname, r.invoer, r.uitvoer, case r.provolatile when 's' then 'stable' else 'volatile' end, r.proname, v_door);
    execute format('revoke all on function public.%I(%s) from public, anon, service_role', 'mt_' || r.proname, r.soorten);
    execute format('grant execute on function public.%I(%s) to authenticated', 'mt_' || r.proname, r.soorten);
    execute format('revoke all on function mt_intern.%I(%s) from public, anon, service_role', r.proname, r.soorten);
    execute format('grant execute on function mt_intern.%I(%s) to authenticated', r.proname, r.soorten);
  end loop;
end
$$;

-- De controle op de functies, ook bruikbaar in de proef: geeft wat niet klopt, of niets.
--   - een functie die een gebruiker kan oproepen en RLS omzeilt, begint met de toegangscontrole;
--   - in public staat enkel een doorgeefluik;
--   - anon en service_role voeren geen functie van de MT uit, behalve de ping.
create or replace function mt_intern.controleer_functies() returns text
language sql stable set search_path = '' as $$
  select string_agg(x.fout, '; ' order by x.fout)
    from (
      select p.oid::regprocedure::text || ' begint niet met de toegangscontrole' as fout
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'mt_intern' and p.prosecdef and p.prorettype <> 'trigger'::regtype
         and has_function_privilege('authenticated', p.oid, 'execute')
         and p.proname not in ('mt_mfa_ok', 'mt_rol', 'mt_is_beheerder', 'mt_leest_alles', 'mt_mijn_klassen', 'mt_mijn_leerlingen',
                               'mt_mijn_leerlingen_nu', 'mt_mag_klas', 'mt_mag_lijst', 'mt_mag_bevestiging', 'mt_mag_aanvraag',
                               'mt_mag_correctie')
         and coalesce(substring(p.prosrc from '\mbegin\M(.*)$'), '') !~ '^\s+(v_rol\s*:=\s*|perform\s+)mt_intern\.eis_rol\('
      union all
      select p.oid::regprocedure::text || ' in public is geen doorgeefluik'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
         and (p.prosecdef
              or p.prosrc !~ ('^\s*select mt_intern\.' || substr(p.proname, 4) || '\((\$[0-9]+(, \$[0-9]+)*)?\)\s*$'))
      union all
      select p.oid::regprocedure::text || ' is uitvoerbaar voor anon of service_role'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where ((n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping') or n.nspname = 'mt_intern')
         and p.prorettype <> 'trigger'::regtype
         and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))
    ) x
$$;
revoke all on function mt_intern.controleer_functies() from public;

insert into mt_intern.scripts (nummer, naam) values (3, '003_functies')
on conflict (nummer) do update set laatst_op = now(), keren = mt_intern.scripts.keren + 1;

-- ============================================================================================
-- 11. De controles, in dezelfde transactie: lukt er één niet, dan wordt niets bewaard
-- ============================================================================================

do $$
declare
  v_fout text;
  v_n integer;
begin
  v_fout := mt_intern.controleer_functies();
  if v_fout is not null then
    raise exception 'MT 003: %', v_fout;
  end if;

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
     and has_function_privilege('authenticated', p.oid, 'execute');
  if v_n <> 21 then
    raise exception 'MT 003: % doorgeefluiken in plaats van 21', v_n;
  end if;

  -- Een functie zonder rechten voor authenticated blijft binnenskamers: enkel de 21, de hulpfuncties
  -- van de toegang uit 002 en vandaag().
  select string_agg(p.proname, ', ' order by p.proname) into v_fout
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'mt_intern' and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('authenticated', p.oid, 'execute')
     and p.proname not in ('vandaag', 'mt_mfa_ok', 'mt_rol', 'mt_is_beheerder', 'mt_leest_alles', 'mt_mijn_klassen', 'mt_mijn_leerlingen',
                           'mt_mijn_leerlingen_nu', 'mt_mag_klas', 'mt_mag_lijst', 'mt_mag_bevestiging', 'mt_mag_aanvraag', 'mt_mag_correctie')
     and not exists (select 1 from pg_proc w join pg_namespace wn on wn.oid = w.pronamespace
                      where wn.nspname = 'public' and w.proname = 'mt_' || p.proname);
  if v_fout is not null then
    raise exception 'MT 003: uitvoerbaar voor authenticated zonder doorgeefluik: %', v_fout;
  end if;

  if not exists (select 1 from pg_trigger t where t.tgname = 'mt_na_klasindeling' and t.tgrelid = 'public.klasindelingen'::regclass)
     or not exists (select 1 from pg_trigger t where t.tgname = 'mt_revisie' and t.tgrelid = 'public.deelnemers'::regclass)
     or not exists (select 1 from pg_trigger t where t.tgname = 'mt_dubbel' and t.tgrelid = 'public.deelnemers'::regclass) then
    raise exception 'MT 003: een trigger ontbreekt';
  end if;

  if not exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = 'activiteiten' and c.column_name = 'bron_plan')
     or not exists (select 1 from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'klaslijsten' and c.column_name = 'vervallen') then
    raise exception 'MT 003: een kolom ontbreekt';
  end if;

  -- Wat 002 vastlegde, geldt nog: authenticated schrijft enkel in de 22 beheertabellen.
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
          or has_any_column_privilege('authenticated', c.oid, 'insert, update'));
  if v_n <> 22 then
    raise exception 'MT 003: authenticated kan schrijven in % tabellen in plaats van 22', v_n;
  end if;
end
$$;

commit;

-- De Data API kent de nieuwe functies meteen.
notify pgrst, 'reload schema';

-- Het resultaat: elke regel moet OK tonen.
select c.controle, c.resultaat
from (values
  (1, 'Scripts 001 tot 003 geregistreerd',
      (select case when count(*) = 3 then 'OK' else 'FOUT' end from mt_intern.scripts where nummer in (1, 2, 3))),
  (2, 'Functies voor de pagina, elk met een doorgeefluik',
      (select case when count(*) = 21 then 'OK: 21 functies' else 'FOUT: ' || count(*) end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
          and has_function_privilege('authenticated', p.oid, 'execute'))),
  (3, 'Elke functie begint met de toegangscontrole',
      coalesce('FOUT: ' || mt_intern.controleer_functies(), 'OK')),
  (4, 'anon en service_role: enkel anon de pingfunctie',
      (select case when count(*) = 0 then 'OK' else 'FOUT: ' || count(*) end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'mt_intern') and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
          and p.prorettype <> 'trigger'::regtype
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute')))),
  (5, 'De taken bij een klaswissel ontstaan in de databank',
      (select case when count(*) = 1 then 'OK' else 'FOUT' end
         from pg_trigger t where t.tgname = 'mt_na_klasindeling' and t.tgrelid = 'public.klasindelingen'::regclass)),
  (6, 'Twee kolommen erbij: de stand van de planning, en een vervallen lijst',
      (select case when count(*) = 2 then 'OK' else 'FOUT' end
         from information_schema.columns c
        where c.table_schema = 'public'
          and (c.table_name, c.column_name) in (('activiteiten', 'bron_plan'), ('klaslijsten', 'vervallen')))),
  (7, 'Tabellen van de MT: nog altijd 57, elk met RLS',
      (select case when count(*) = 57 and bool_and(c.relrowsecurity) then 'OK' else 'FOUT: ' || count(*) || ' tabellen' end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r')),
  (8, 'Rechtstreeks schrijven nog altijd enkel in de 22 beheertabellen',
      (select case when count(*) = 22 then 'OK' else 'FOUT: ' || count(*) end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
               or has_any_column_privilege('authenticated', c.oid, 'insert, update'))))
) as c(nr, controle, resultaat)
order by c.nr;
