-- MT · tests/databank/proef.sql
-- De proef op de databank (17.12): verzonnen gegevens, en dan rechtstreeks, buiten de schermen om,
-- proberen wat mag en wat niet mag: per rol, met en zonder tweestapsverificatie.
-- Alles gebeurt in één transactie die op het einde teruggedraaid wordt: er blijft niets achter.
-- Enkel voor de nagebootste Supabase van de databanktest; alle namen zijn verzonnen.
--
-- De datums volgen de dag van vandaag, zodat de proef in elk schooljaar hetzelfde nagaat. De functies
-- van 003 worden nagegaan met een vaste "vandaag", honderd dagen na het begin van het schooljaar.

\set ON_ERROR_STOP on
begin;
set constraints all immediate;
\o /dev/null

create schema proef;
grant usage on schema proef to public;

create table proef.uitslag (nr serial primary key, naam text not null, ok boolean not null, detail text);

create function proef.zeker(p_naam text, p_ok boolean, p_detail text default null) returns void
language plpgsql as $$
begin
  insert into proef.uitslag (naam, ok, detail) values (p_naam, coalesce(p_ok, false), p_detail);
end $$;

create function proef.id(n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- Het toegangsbewijs zoals PostgREST het doorgeeft, en de sessie zoals Supabase ze bewaart: sinds 005
-- leest de databank het niveau, de app en de stappen van de aanmelding bij de sessie zelf. Elke
-- gebruiker van de proef heeft één gekoppelde app, met hetzelfde id als de gebruiker.
create function proef.aangemeld(p_wie uuid, p_aal text default 'aal2', p_code_oud interval default interval '1 hour',
                                p_sessie uuid default null, p_amr jsonb default null) returns void
language plpgsql as $$
declare
  v_sessie uuid := coalesce(p_sessie, p_wie);
  v_amr jsonb := coalesce(p_amr, jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now() - p_code_oud))::bigint),
      jsonb_build_object('method', 'password', 'timestamp', floor(extract(epoch from now() - interval '40 days'))::bigint)));
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_wie, 'role', 'authenticated', 'aal', p_aal, 'session_id', v_sessie, 'amr', v_amr)::text, true);
  update auth.sessions s
     set aal = case when p_aal in ('aal1', 'aal2') then p_aal::auth.aal_level end,
         factor_id = case when p_aal = 'aal2' then s.user_id end
   where s.id = v_sessie;
  delete from auth.mfa_amr_claims a where a.session_id = v_sessie;
  if jsonb_typeof(v_amr) = 'array' and exists (select 1 from auth.sessions s where s.id = v_sessie) then
    insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method)
    select v_sessie, to_timestamp((e.stap ->> 'timestamp')::numeric), to_timestamp((e.stap ->> 'timestamp')::numeric), e.stap ->> 'method'
      from jsonb_array_elements(v_amr) as e(stap)
     where jsonb_typeof(e.stap) = 'object' and jsonb_typeof(e.stap -> 'timestamp') = 'number' and (e.stap ->> 'method') is not null
    on conflict (session_id, authentication_method) do update set updated_at = excluded.updated_at;
  end if;
end $$;

-- Het aantal rijen dat een rol ziet; -1 bij een fout.
create function proef.tel(p_sql text, p_rol text default 'authenticated') returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute format('set local role %I', p_rol);
  begin
    execute 'select count(*) from (' || p_sql || ') q' into n;
  exception when others then
    n := -1;
  end;
  set local role none;
  return n;
end $$;

-- Voert iets uit als een rol, en geeft de fout terug, of "geen fout, N rijen". Wat lukte, wordt
-- teruggedraaid, tenzij p_houden. De code om terug te draaien is bewust geen klasse: een code op 000
-- vangt in plpgsql ook elke andere fout van die klasse, zoals MT409 en MT422 van de functies.
create function proef.fout(p_sql text, p_rol text default 'authenticated', p_houden boolean default false) returns text
language plpgsql as $$
declare
  v text;
  n bigint;
begin
  execute format('set local role %I', p_rol);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    if not p_houden then
      raise exception using errcode = 'PROEF', message = n::text;
    end if;
    v := 'geen fout, ' || n || ' rijen';
  exception
    when sqlstate 'PROEF' then v := 'geen fout, ' || sqlerrm || ' rijen';
    when others then v := sqlstate || ': ' || sqlerrm;
  end;
  set local role none;
  return v;
end $$;

-- ---------- De vaste gegevens van de proef ----------

create table proef.c as
select v.vandaag, j.jaar,
       j.jaar || '-' || (j.jaar + 1) as sj0,
       (j.jaar - 1) || '-' || j.jaar as sj1,
       (j.jaar - 2) || '-' || (j.jaar - 1) as sj2,
       make_date(j.jaar, 9, 1) as begin0,
       make_date(j.jaar, 9, 2) as wissel
  from (select mt_intern.vandaag() as vandaag) v,
       lateral (select case when extract(month from v.vandaag) >= 9 then extract(year from v.vandaag)::integer
                            else extract(year from v.vandaag)::integer - 1 end as jaar) j;
grant select on proef.c to public;

-- Gebruikers: 1 beheerder, 2 tweede beheerder, 3 leerkracht 4A, 4 leerkracht 4B, 5 lezer, 6 tijdelijk
-- wachtwoord, 7 uitgeschakeld, 8 zonder rij in de MT, 9 open accounthandeling, 10 eerste aanmelding niet rond.
insert into auth.users (id, email) select proef.id(n), 'proef' || n || '@voorbeeld.test' from generate_series(1, 10) n;
insert into auth.sessions (id, user_id) select proef.id(n), proef.id(n) from generate_series(1, 10) n;
insert into auth.mfa_factors (id, user_id, factor_type, status) select proef.id(n), proef.id(n), 'totp', 'verified' from generate_series(1, 10) n;
insert into auth.sessions (id, user_id, not_after) values (proef.id(90), proef.id(3), now() - interval '1 minute');

-- De eerste beheerder komt er zoals op de echte Supabase: het account bestaat bij Supabase (het
-- dashboard), en één oproep in de SQL Editor maakt er de eerste beheerder van (004).
select proef.zeker('eerste beheerder: een adres zonder account bij Supabase wordt geweigerd',
  proef.fout($q$select mt_intern.eerste_beheerder('niemand@voorbeeld.test', 'Niemand')$q$, 'postgres') like 'P0001%dashboard%');
select proef.zeker('eerste beheerder: een naam is verplicht',
  proef.fout($q$select mt_intern.eerste_beheerder('proef1@voorbeeld.test', '  ')$q$, 'postgres') like 'P0001%naam%');
select proef.zeker('eerste beheerder: niet bereikbaar via de Data API',
  proef.fout($q$select mt_intern.eerste_beheerder('proef1@voorbeeld.test', 'Proef Beheerder')$q$, 'authenticated') like '42501%'
  and proef.fout($q$select mt_intern.eerste_beheerder('proef1@voorbeeld.test', 'Proef Beheerder')$q$, 'service_role') like '42501%'
  and proef.fout($q$select mt_intern.eerste_beheerder('proef1@voorbeeld.test', 'Proef Beheerder')$q$, 'anon') like '42501%');
select proef.zeker('eerste beheerder: aangemaakt uit het account van het dashboard',
  proef.fout($q$select mt_intern.eerste_beheerder(' PROEF1@voorbeeld.test ', ' Proef Beheerder ')$q$, 'postgres', true) = 'geen fout, 1 rijen');
select proef.zeker('eerste beheerder: met een tijdelijk wachtwoord van 48 uur, en de app nog te koppelen',
  (select rol = 'beheerder' and actief and wachtwoord_tijdelijk and not eerste_aanmelding_afgerond and app_koppelen
          and tijdelijk_tot between now() + interval '47 hours' and now() + interval '49 hours'
          and naam = 'Proef Beheerder' and email = 'proef1@voorbeeld.test'
     from public.gebruikers where id = proef.id(1)));
select proef.zeker('eerste beheerder: een tweede keer kan niet',
  proef.fout($q$select mt_intern.eerste_beheerder('proef2@voorbeeld.test', 'Proef Tweede')$q$, 'postgres') like 'P0001%al een gebruiker%');
update public.gebruikers set wachtwoord_tijdelijk = false, tijdelijk_tot = null, eerste_aanmelding_afgerond = true, app_koppelen = false
 where id = proef.id(1);

insert into public.gebruikers (id, naam, email, rol, actief, wachtwoord_tijdelijk, eerste_aanmelding_afgerond, app_koppelen, open_operatie) values
  (proef.id(2), 'Proef Tweede', 'proef2@voorbeeld.test', 'beheerder', true, false, true, false, null),
  (proef.id(3), 'Proef Vier A', 'proef3@voorbeeld.test', 'leerkracht', true, false, true, false, null),
  (proef.id(4), 'Proef Vier B', 'proef4@voorbeeld.test', 'leerkracht', true, false, true, false, null),
  (proef.id(5), 'Proef Lezer', 'proef5@voorbeeld.test', 'lezer', true, false, true, false, null),
  (proef.id(6), 'Proef Nieuw', 'proef6@voorbeeld.test', 'leerkracht', true, true, false, true, null),
  (proef.id(7), 'Proef Uit', 'proef7@voorbeeld.test', 'leerkracht', false, false, true, false, null),
  (proef.id(9), 'Proef Open', 'proef9@voorbeeld.test', 'beheerder', true, false, true, false, proef.id(900)),
  (proef.id(10), 'Proef Eerste', 'proef10@voorbeeld.test', 'leerkracht', true, false, false, true, null);
insert into public.account_operaties (id, soort, door, voor) values (proef.id(900), 'app_opnieuw_koppelen', proef.id(1), proef.id(9));
-- Wie volledig aangemeld is, heeft de app die telt (005).
update public.gebruikers set app_factor = id where eerste_aanmelding_afgerond and not app_koppelen;

-- Drie schooljaren: het lopende, het vorige (voorbij, nog open) en dat daarvoor (straks afgesloten).
insert into public.schooljaren (schooljaar, stand, plafond_kleuter_cent, plafond_lager_cent, marge_kleuter_cent, marge_lager_cent)
select s, st, 5500, 11000, 200, 400
  from proef.c, lateral (values (sj2, 'voorbij'), (sj1, 'voorbij'), (sj0, 'lopend')) as x(s, st);

insert into public.klassen (id, schooljaar, bron_id, naam, groep, volgorde)
select proef.id(k.n), case k.j when 0 then c.sj0 when 1 then c.sj1 else c.sj2 end, 'bron' || k.b, k.naam, k.groep, k.n
  from proef.c c, (values
    (101, 0, 'a', '4A', 'Lager'), (102, 0, 'b', '4B', 'Lager'), (103, 0, 'c', '1instA', 'Kleuter'),
    (104, 0, 'd', '1A', 'Lager'), (105, 0, 'e', '6B', 'Lager'), (106, 0, 'f', 'LO', 'Andere'),
    (107, 0, 'g', '1KA', 'Kleuter'), (111, 1, 'a', '3A', 'Lager'), (121, 2, 'a', '2A', 'Lager')
  ) as k(n, j, b, naam, groep);

insert into public.klastoewijzingen (gebruiker_id, klas_id, schooljaar)
select proef.id(t.g), proef.id(t.k), case t.j when 0 then c.sj0 when 1 then c.sj1 else c.sj2 end
  from proef.c c, (values (3, 101, 0), (3, 111, 1), (3, 121, 2), (4, 102, 0), (7, 101, 0)) as t(g, k, j);

-- Leerlingen: 201-203 in 4A, 204-205 in 4B, 206 wisselt van 4A naar 4B, 207-208 zaten vorig jaar in 3A,
-- 209 het jaar daarvoor in 2A.
insert into public.leerlingen (id, stamnummer, voornaam, familienaam)
select proef.id(200 + n), lpad((200 + n)::text, 7, '0'), 'Leerling' || n, 'Proef' from generate_series(1, 9) n;

insert into public.klasindelingen (id, leerling_id, schooljaar, klas_id, klasnummer, van, tot)
select proef.id(700 + i.nr), proef.id(i.l), case i.j when 0 then c.sj0 when 1 then c.sj1 else c.sj2 end, proef.id(i.k), i.nummer,
       case i.j when 0 then (case when i.later then c.wissel else c.begin0 end)
                when 1 then make_date(c.jaar - 1, 9, 1) else make_date(c.jaar - 2, 9, 1) end,
       case when i.tot then c.wissel end
  from proef.c c, (values
    (1, 201, 0, 101, 1, false, false), (2, 202, 0, 101, 2, false, false), (3, 203, 0, 101, 3, false, false),
    (4, 204, 0, 102, 1, false, false), (5, 205, 0, 102, 2, false, false),
    (6, 206, 0, 101, 4, false, true), (7, 206, 0, 102, 3, true, false),
    (8, 207, 1, 111, 1, false, false), (9, 208, 1, 111, 2, false, false), (10, 209, 2, 121, 1, false, false)
  ) as i(nr, l, j, k, nummer, later, tot);

-- Uitstappen: 301 dit schooljaar (4A en 4B), 311 vorig schooljaar (3A), 321 het jaar daarvoor (2A).
insert into public.activiteiten (id, schooljaar, soort, uitstap_id, bron_gewijzigd_op, bron_stand, bron_plan, datum_start, datum_eind)
select proef.id(a.n), case a.j when 0 then c.sj0 when 1 then c.sj1 else c.sj2 end, 'uitstap', 'uproef' || a.n,
       timestamptz '2026-01-01 09:00:00+00', 'actief', 'bevestigd',
       make_date(c.jaar - a.j, 9, 1), make_date(c.jaar - a.j, 9, 1)
  from proef.c c, (values (301, 0), (311, 1), (321, 2)) as a(n, j);
insert into public.klaslijsten (activiteit_id, klas_id, schooljaar)
select proef.id(l.a), proef.id(l.k), case l.j when 0 then c.sj0 when 1 then c.sj1 else c.sj2 end
  from proef.c c, (values (301, 101, 0), (301, 102, 0), (311, 111, 1), (321, 121, 2)) as l(a, k, j);
insert into public.afwezigheden (activiteit_id, leerling_id, dag, klas_id, schooljaar, status_id)
select proef.id(x.a), proef.id(x.l), make_date(c.jaar - x.j, 9, 1), proef.id(x.k),
       case x.j when 0 then c.sj0 when 1 then c.sj1 else c.sj2 end, (select id from public.statussen where naam = x.status)
  from proef.c c, (values
    (301, 201, 101, 0, 'Attest'), (301, 206, 101, 0, 'Briefje ouders'), (301, 204, 102, 0, 'Ongewettigd afwezig'),
    (311, 207, 111, 1, 'Attest'), (321, 209, 121, 2, 'Attest')
  ) as x(a, l, k, j, status);

-- Zwemmen voor 4A: een beurt die bevestigd is (dag 8) en een die nog open is (dag 15).
insert into public.lopende_activiteiten (id, schooljaar, naam, zwemmen) select proef.id(401), sj0, 'Zwemmen 4A', true from proef.c;
insert into public.lopende_activiteit_klassen (lopende_activiteit_id, klas_id, schooljaar) select proef.id(401), proef.id(101), sj0 from proef.c;
insert into public.kostenregels (id, lopende_activiteit_id, schooljaar, omschrijving, verdeling, onderdeel) select proef.id(411), proef.id(401), sj0, 'Bus', 'verdeeld', 'vervoer' from proef.c;
insert into public.tarieven (kostenregel_id, geldig_vanaf, schooljaar, bedrag_cent) select proef.id(411), begin0, sj0, 9500 from proef.c;
insert into public.activiteiten (id, schooljaar, soort, lopende_activiteit_id, datum_start, datum_eind)
select proef.id(330 + b.n), c.sj0, 'beurt', proef.id(401), c.begin0 + b.dagen, c.begin0 + b.dagen from proef.c c, (values (1, 7), (2, 14)) as b(n, dagen);
insert into public.klaslijsten (activiteit_id, klas_id, schooljaar) select proef.id(330 + n), proef.id(101), sj0 from proef.c, generate_series(1, 2) n;
insert into public.bevestigingen (id, activiteit_id, klas_id, schooljaar, revisie, bevestigd_door) select proef.id(501), proef.id(331), proef.id(101), sj0, 0, proef.id(3) from proef.c;
update public.klaslijsten set stand = 'bevestigd', bevestiging_id = proef.id(501) where activiteit_id = proef.id(331);

-- Een correctie voor leerling 202, met een interne notitie.
insert into public.correcties (id, schooljaar, datum, reden) select proef.id(601), sj0, begin0, 'Creditnota van de bus' from proef.c;
insert into public.correctie_leerlingen (correctie_id, leerling_id, schooljaar, bedrag_cent) select proef.id(601), proef.id(202), sj0, -500 from proef.c;
insert into public.interne_notities (correctie_id, schooljaar, tekst) select proef.id(601), sj0, 'Factuur 2026-0412' from proef.c;

-- Het oudste schooljaar wordt afgesloten.
update public.schooljaren set stand = 'afgesloten' where schooljaar = (select sj2 from proef.c);

-- ---------- 1. De tweestapsverificatie (17.2, T5) ----------

select set_config('request.jwt.claims', '', true);
select proef.zeker('tweestaps: zonder aanmelding geen toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3));
select proef.zeker('tweestaps: aal2 met een verse code', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 1);
select proef.aangemeld(proef.id(3), 'aal1');
select proef.zeker('tweestaps: aal1 volstaat niet', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.zeker('tweestaps: met aal1 geen enkele leerling', proef.tel('select 1 from public.leerlingen') = 0);
select proef.aangemeld(proef.id(3), 'aal2', interval '13 days');
select proef.zeker('tweestaps: een code van 13 dagen geldt nog', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 1);
select proef.aangemeld(proef.id(3), 'aal2', interval '15 days');
select proef.zeker('tweestaps: een code van 15 dagen is te oud', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), 'aal2', interval '-10 minutes');
select proef.zeker('tweestaps: een code uit de toekomst geldt niet', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), 'aal2', interval '-20 seconds');
select proef.zeker('tweestaps: enkele seconden klokverschil mag', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 1);
select proef.aangemeld(proef.id(3), p_amr => jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', floor(extract(epoch from now()))::bigint)));
select proef.zeker('tweestaps: zonder totp in amr geen toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), p_amr => '["totp"]'::jsonb);
select proef.zeker('tweestaps: amr in een vreemde vorm geen toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), p_amr => '{"method": "totp"}'::jsonb);
select proef.zeker('tweestaps: amr die geen lijst is, geen toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), p_amr => jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now()))::text)));
select proef.zeker('tweestaps: een tijd als tekst geldt niet', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), p_sessie => proef.id(999));
select proef.zeker('tweestaps: een sessie die niet meer bestaat', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), p_sessie => proef.id(4));
select proef.zeker('tweestaps: de sessie van iemand anders', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), p_sessie => proef.id(90));
select proef.zeker('tweestaps: een verlopen sessie', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(6));
select proef.zeker('tweestaps: met een tijdelijk wachtwoord toont de databank niets', proef.tel('select 1 from public.schooljaren') = 0);
select proef.aangemeld(proef.id(7));
select proef.zeker('tweestaps: een uitgeschakeld account ziet niets', proef.tel('select 1 from public.leerlingen') = 0 and proef.tel('select 1 from public.schooljaren') = 0);
select proef.aangemeld(proef.id(8));
select proef.zeker('tweestaps: een account zonder rij in de MT ziet niets', proef.tel('select 1 from public.schooljaren') = 0);
select proef.aangemeld(proef.id(9));
select proef.zeker('tweestaps: een open accounthandeling blokkeert', proef.tel('select 1 from public.schooljaren') = 0);
select proef.aangemeld(proef.id(10));
select proef.zeker('tweestaps: eerste aanmelding niet afgerond', proef.tel('select 1 from public.schooljaren') = 0);
select set_config('request.jwt.claims', jsonb_build_object('sub', proef.id(1), 'role', 'anon', 'aal', 'aal2', 'session_id', proef.id(1),
  'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now()))::bigint)))::text, true);
select proef.zeker('tweestaps: een andere rol in het toegangsbewijs', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
update public.instellingen set code_geldig_dagen = 7;
select proef.aangemeld(proef.id(3), 'aal2', interval '8 days');
select proef.zeker('tweestaps: de termijn volgt de instelling (7 dagen)', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
update public.instellingen set code_geldig_dagen = 14;
select proef.zeker('instellingen: een termijn buiten de grenzen wordt geweigerd',
  proef.fout('update public.instellingen set code_geldig_dagen = 60', 'postgres') like '23514%');

-- ---------- 2. Lezen per rol (17.3, T6) ----------

select proef.aangemeld(proef.id(1));
select proef.zeker('beheerder: leest alle leerlingen', proef.tel('select 1 from public.leerlingen') = 9);
select proef.zeker('beheerder: leest alle gebruikers', proef.tel('select 1 from public.gebruikers') = 9);
select proef.zeker('beheerder: leest instellingen, notities en het logboek',
  proef.tel('select 1 from public.instellingen') = 1 and proef.tel('select 1 from public.interne_notities') = 1
  and proef.tel('select 1 from public.logboek') > 0 and proef.tel('select 1 from public.account_operaties') = 1);

select proef.aangemeld(proef.id(5));
select proef.zeker('lezer: leest alle leerlingen en afwezigheden',
  proef.tel('select 1 from public.leerlingen') = 9 and proef.tel('select 1 from public.afwezigheden') = 5);
select proef.zeker('lezer: van de gebruikers enkel zichzelf', proef.tel('select 1 from public.gebruikers') = 1);
select proef.zeker('lezer: geen instellingen, accounts, interne notities of logboek',
  proef.tel('select 1 from public.instellingen') = 0 and proef.tel('select 1 from public.account_operaties') = 0
  and proef.tel('select 1 from public.interne_notities') = 0 and proef.tel('select 1 from public.logboek') = 0);

select proef.aangemeld(proef.id(3));
select proef.zeker('leerkracht 4A: haar leerlingen, en die van vorig jaar zolang een lijst openstaat',
  proef.tel('select 1 from public.leerlingen') = 6, proef.tel('select 1 from public.leerlingen')::text);
select proef.zeker('leerkracht 4A: geen leerling van 4B, en niemand uit een afgesloten schooljaar',
  proef.tel('select 1 from public.leerlingen where id in (proef.id(204), proef.id(205), proef.id(209))') = 0);
select proef.zeker('leerkracht 4A: de afwezigheden van haar lijsten',
  proef.tel('select 1 from public.afwezigheden') = 3, proef.tel('select 1 from public.afwezigheden')::text);
select proef.zeker('leerkracht 4A: geen afwezigheid van 4B',
  proef.tel('select 1 from public.afwezigheden where leerling_id = proef.id(204)') = 0);
select proef.zeker('leerkracht 4A: de klasindelingen van haar klassen',
  proef.tel('select 1 from public.klasindelingen') = (select case when vandaag >= wissel then 6 else 7 end from proef.c),
  proef.tel('select 1 from public.klasindelingen')::text);
select proef.zeker('leerkracht 4A: de correctie van haar leerling, zonder de interne notitie',
  proef.tel('select 1 from public.correcties') = 1 and proef.tel('select 1 from public.correctie_leerlingen') = 1
  and proef.tel('select 1 from public.interne_notities') = 0);
select proef.zeker('leerkracht 4A: van de gebruikers enkel zichzelf, en haar eigen klassen',
  proef.tel('select 1 from public.gebruikers') = 1 and proef.tel('select 1 from public.klastoewijzingen') = 3);
select proef.zeker('leerkracht 4A: geen facturaties, taken, voorschotten, instellingen of logboek',
  proef.tel('select 1 from public.facturaties') = 0 and proef.tel('select 1 from public.taken') = 0
  and proef.tel('select 1 from public.voorschotten') = 0 and proef.tel('select 1 from public.instellingen') = 0
  and proef.tel('select 1 from public.logboek') = 0);
select proef.zeker('leerkracht 4A: klassen, schooljaren en statussen wel',
  proef.tel('select 1 from public.klassen') = 9 and proef.tel('select 1 from public.schooljaren') = 3
  and proef.tel('select 1 from public.statussen') = 5);
select proef.zeker('mt_mag_klas: haar klas wel, een andere klas niet, het afgesloten jaar niet',
  proef.tel('select 1 from proef.c where mt_intern.mt_mag_klas(proef.id(101), sj0)') = 1
  and proef.tel('select 1 from proef.c where mt_intern.mt_mag_klas(proef.id(102), sj0)') = 0
  and proef.tel('select 1 from proef.c where mt_intern.mt_mag_klas(proef.id(121), sj2)') = 0
  and proef.tel('select 1 from proef.c where mt_intern.mt_mag_klas(proef.id(101), sj1)') = 0);

select proef.aangemeld(proef.id(4));
select proef.zeker('leerkracht 4B: haar leerlingen, met wie naar haar klas wisselde',
  proef.tel('select 1 from public.leerlingen') = 3, proef.tel('select 1 from public.leerlingen')::text);
select proef.zeker('leerkracht 4B: de volledige fiche van de wisselaar, niet de rest van zijn vroegere klas',
  (select vandaag < wissel from proef.c)
  or (proef.tel('select 1 from public.afwezigheden') = 2
      and proef.tel('select 1 from public.afwezigheden where leerling_id = proef.id(206)') = 1
      and proef.tel('select 1 from public.afwezigheden where leerling_id = proef.id(201)') = 0
      and proef.tel('select 1 from public.klasindelingen') = 4),
  proef.tel('select 1 from public.afwezigheden')::text || ' / ' || proef.tel('select 1 from public.klasindelingen')::text);

-- De open lijst van vorig schooljaar wordt bevestigd: dan verdwijnt dat schooljaar voor de leerkracht.
insert into public.bevestigingen (id, activiteit_id, klas_id, schooljaar, revisie, bevestigd_door) select proef.id(502), proef.id(311), proef.id(111), sj1, 0, proef.id(3) from proef.c;
update public.klaslijsten set stand = 'bevestigd', bevestiging_id = proef.id(502) where activiteit_id = proef.id(311);
select proef.aangemeld(proef.id(3));
select proef.zeker('leerkracht 4A: na de laatste bevestiging niets meer van vorig schooljaar',
  proef.tel('select 1 from public.leerlingen') = 4 and proef.tel('select 1 from public.afwezigheden') = 2
  and proef.tel('select 1 from public.bevestigingen') = 1,
  proef.tel('select 1 from public.leerlingen')::text || ' / ' || proef.tel('select 1 from public.afwezigheden')::text);

select proef.zeker('anon: geen recht op de tabellen', proef.tel('select 1 from public.leerlingen', 'anon') = -1
  and proef.tel('select 1 from public.schooljaren', 'anon') = -1 and proef.tel('select 1 from public.statussen', 'anon') = -1);
select proef.zeker('anon: de pingfunctie werkt', proef.tel('select 1 where public.mt_ping()', 'anon') = 1);
select proef.zeker('anon: de hulpfuncties niet', proef.tel('select mt_intern.mt_rol()', 'anon') = -1);
select proef.zeker('service_role: nog geen rechten op de tabellen', proef.tel('select 1 from public.leerlingen', 'service_role') = -1
  and proef.tel('select 1 from public.gebruikers', 'service_role') = -1);

-- ---------- 3. Schrijven per rol ----------

select proef.aangemeld(proef.id(3));
select proef.zeker('leerkracht: schrijft niet rechtstreeks in de afwezigheden',
  proef.fout($q$insert into public.afwezigheden (activiteit_id, leerling_id, dag, klas_id, schooljaar, status_id)
             select proef.id(301), proef.id(202), begin0, proef.id(101), sj0, (select id from public.statussen where naam = 'Attest') from proef.c$q$) like '42501%');
select proef.zeker('leerkracht: kan geen leerling toevoegen',
  proef.fout($q$insert into public.leerlingen (stamnummer, voornaam, familienaam) values ('0000999', 'Nep', 'Proef')$q$) like '42501%');
select proef.zeker('leerkracht: een wijziging raakt geen enkele rij',
  proef.fout($q$update public.leerlingen set voornaam = 'Anders'$q$) = 'geen fout, 0 rijen'
  and proef.fout($q$delete from public.klasindelingen$q$) = 'geen fout, 0 rijen'
  and proef.fout($q$update public.schooljaren set plafond_lager_cent = 1$q$) = 'geen fout, 0 rijen'
  and proef.fout($q$update public.statussen set actief = false$q$) = 'geen fout, 0 rijen');
select proef.zeker('leerkracht: kan zichzelf geen rol of klas geven',
  proef.fout($q$update public.gebruikers set rol = 'beheerder'$q$) like '42501%'
  and proef.fout($q$insert into public.klastoewijzingen (gebruiker_id, klas_id, schooljaar) select proef.id(3), proef.id(102), sj0 from proef.c$q$) like '42501%');

select proef.aangemeld(proef.id(5));
select proef.zeker('lezer: schrijft nergens',
  proef.fout($q$insert into public.leerlingen (stamnummer, voornaam, familienaam) values ('0000999', 'Nep', 'Proef')$q$) like '42501%'
  and proef.fout($q$update public.leerlingen set voornaam = 'Anders'$q$) = 'geen fout, 0 rijen'
  and proef.fout($q$delete from public.tarieven$q$) = 'geen fout, 0 rijen'
  and proef.fout($q$update public.instellingen set afmelden_na_minuten = 60$q$) = 'geen fout, 0 rijen');

select proef.aangemeld(proef.id(1));
select proef.zeker('beheerder: voegt een leerling toe',
  proef.fout($q$insert into public.leerlingen (id, stamnummer, voornaam, familienaam) values (proef.id(250), '0012345', 'Nieuw', 'Proef')$q$, 'authenticated', true) = 'geen fout, 1 rijen');
select proef.zeker('logboek: wie, wat en de rol', exists (
  select 1 from public.logboek where tabel = 'leerlingen' and rij = proef.id(250)::text and actie = 'toegevoegd'
     and wie = proef.id(1) and databankrol = 'authenticated' and nieuw ->> 'stamnummer' = '0012345'));
select proef.zeker('wie en wanneer: de stempel volgt het toegangsbewijs',
  (select aangemaakt_door = proef.id(1) and bijgewerkt_door = proef.id(1) from public.leerlingen where id = proef.id(250)));
select proef.zeker('stamnummer: een voorloopnul blijft', (select stamnummer = '0012345' from public.leerlingen where id = proef.id(250)));
select proef.zeker('stamnummer: zes cijfers wordt geweigerd',
  proef.fout($q$insert into public.leerlingen (stamnummer, voornaam, familienaam) values ('123456', 'Nep', 'Proef')$q$) like '23514%');
select proef.zeker('beheerder: wijzigt het plafond, niet de stand van een schooljaar',
  proef.fout($q$update public.schooljaren set plafond_lager_cent = 12000 where schooljaar = (select sj0 from proef.c)$q$) = 'geen fout, 1 rijen'
  and proef.fout($q$update public.schooljaren set stand = 'afgesloten' where schooljaar = (select sj1 from proef.c)$q$) like '42501%');
select proef.zeker('beheerder: maakt een schooljaar aan, dat in te vullen is',
  proef.fout($q$insert into public.schooljaren (schooljaar) select (jaar + 1) || '-' || (jaar + 2) from proef.c$q$) = 'geen fout, 1 rijen'
  and proef.fout($q$insert into public.schooljaren (schooljaar, stand) select (jaar + 1) || '-' || (jaar + 2), 'lopend' from proef.c$q$) like '42501%');
select proef.zeker('beheerder: schrijft niet rechtstreeks in bewijs, accounts of het logboek',
  proef.fout($q$insert into public.logboek (tabel, rij, actie) values ('x', 'y', 'gewist')$q$) like '42501%'
  and proef.fout($q$delete from public.logboek$q$) like '42501%'
  and proef.fout($q$update public.gebruikers set rol = 'lezer' where id = proef.id(4)$q$) like '42501%'
  and proef.fout($q$insert into public.facturaties (schooljaar, maximumfactuur, soort, operatie, tot_en_met, rekenversie) select sj0, 'scherp', 'maand', proef.id(1), begin0, '1' from proef.c$q$) like '42501%'
  and proef.fout($q$update public.klaslijsten set stand = 'open', bevestiging_id = null$q$) like '42501%'
  and proef.fout($q$delete from public.bevestigingen$q$) like '42501%'
  and proef.fout($q$update public.correctie_leerlingen set gefactureerd_in = null$q$) like '42501%'
  and proef.fout($q$update public.statussen set gebruikt = false$q$) like '42501%');

-- ---------- 4. De bewakers van de gegevens ----------

select proef.zeker('status: na gebruik wisselt "aangerekend" niet meer (B73)',
  proef.fout($q$update public.statussen set aangerekend = true where naam = 'Attest'$q$) like '42501%B73%');
select proef.zeker('status: een andere naam kan wel',
  proef.fout($q$update public.statussen set naam = 'Attest van de dokter' where naam = 'Attest'$q$) = 'geen fout, 1 rijen');
select proef.zeker('status: een gebruikte status wissen kan niet (B73)',
  proef.fout($q$delete from public.statussen where naam = 'Attest'$q$) like '42501%B73%');
select proef.zeker('status: "aanwezig" heeft geen rij bij de afwezigheden',
  proef.fout($q$insert into public.afwezigheden (activiteit_id, leerling_id, dag, klas_id, schooljaar, status_id)
             select proef.id(301), proef.id(202), begin0, proef.id(101), sj0, (select id from public.statussen where soort = 'aanwezig') from proef.c$q$, 'postgres') like '23514%');

select proef.zeker('klasindeling: nooit twee klassen tegelijk',
  proef.fout($q$insert into public.klasindelingen (leerling_id, schooljaar, klas_id, van) select proef.id(201), sj0, proef.id(102), begin0 + 30 from proef.c$q$) like '23P01%');
select proef.zeker('klasnummer: twee leerlingen tegelijk met hetzelfde nummer kan niet',
  proef.fout($q$update public.klasindelingen set klasnummer = 2 where id = proef.id(701)$q$) like '23P01%');
select proef.zeker('klasnummer: hetzelfde nummer na elkaar kan wel, en 0 mag vaker (B158)',
  proef.fout($q$insert into public.klasindelingen (leerling_id, schooljaar, klas_id, klasnummer, van) select proef.id(250), sj0, proef.id(101), 4, wissel from proef.c$q$) = 'geen fout, 1 rijen'
  and proef.fout($q$update public.klasindelingen set klasnummer = 0 where klas_id = proef.id(102)$q$) = 'geen fout, 3 rijen');
select proef.zeker('klasindeling: buiten het schooljaar wordt geweigerd',
  proef.fout($q$insert into public.klasindelingen (leerling_id, schooljaar, klas_id, van) select proef.id(250), sj0, proef.id(101), begin0 - 1 from proef.c$q$) like '23514%');
select proef.zeker('klasindeling: begin- en einddatum op dezelfde dag kan (B89)',
  proef.fout($q$insert into public.klasindelingen (leerling_id, schooljaar, klas_id, van, tot) select proef.id(250), sj0, proef.id(104), begin0 + 40, begin0 + 41 from proef.c$q$) = 'geen fout, 1 rijen');
select proef.zeker('klasindeling: het einde is de dag na de laatste dag, of het einde van het schooljaar',
  (select einde = wissel from public.klasindelingen, proef.c where id = proef.id(706))
  and (select einde = make_date(jaar + 1, 9, 1) from public.klasindelingen, proef.c where id = proef.id(701)));
select proef.zeker('klasindeling: niet in een klas uit de groep Andere (B143)',
  proef.fout($q$insert into public.klasindelingen (leerling_id, schooljaar, klas_id, van) select proef.id(250), sj0, proef.id(106), begin0 from proef.c$q$) like '23514%B143%');
select proef.zeker('afgesloten schooljaar: vergrendeld, ook voor de beheerder en voor een script',
  proef.fout($q$update public.klasindelingen set klasnummer = 9 where id = proef.id(710)$q$) like '42501%afgesloten%'
  and proef.fout($q$delete from public.afwezigheden where activiteit_id = proef.id(321)$q$, 'postgres') like '42501%afgesloten%'
  and proef.fout($q$update public.schooljaren set plafond_lager_cent = 1 where schooljaar = (select sj2 from proef.c)$q$, 'postgres') like '42501%afgesloten%');
select proef.zeker('schooljaar: de stand gaat enkel vooruit',
  proef.fout($q$update public.schooljaren set stand = 'in_te_vullen' where schooljaar = (select sj0 from proef.c)$q$, 'postgres') like '42501%'
  and proef.fout($q$delete from public.schooljaren where schooljaar = (select sj1 from proef.c)$q$, 'postgres') like '42501%');

select proef.zeker('leerjaar: afgeleid uit de naam van een lagere klas, nooit bij een kleuterklas (B208, G20)',
  (select leerjaar from public.klassen where id = proef.id(101)) = 4
  and (select leerjaar from public.klassen where id = proef.id(104)) = 1
  and (select leerjaar from public.klassen where id = proef.id(105)) = 6
  and (select leerjaar from public.klassen where id = proef.id(103)) is null
  and (select leerjaar from public.klassen where id = proef.id(107)) is null
  and (select leerjaar from public.klassen where id = proef.id(106)) is null);
update public.klassen set leerjaar = 5, leerjaar_manueel = true where id = proef.id(102);
update public.klassen set naam = '4X' where id = proef.id(102);
select proef.zeker('leerjaar: wat de beheerder zelf invulde, blijft staan',
  (select leerjaar from public.klassen where id = proef.id(102)) = 5);
select proef.zeker('klasnaam: de vroegere naam blijft bij de klas horen (B158)',
  (select count(*) from public.klas_namen where klas_id = proef.id(102)) = 2
  and (select not huidig from public.klas_namen where naam = '4B' and klas_id = proef.id(102))
  and proef.fout($q$update public.klassen set naam = '4B' where id = proef.id(104)$q$, 'postgres') like '23505%');

-- Voorschotten: twee, het tweede vult aan tot het plafond.
select proef.zeker('voorschotten: aanmaken',
  proef.fout($q$insert into public.voorschotten (id, schooljaar, volgnummer, bedrag_kleuter_cent, bedrag_lager_cent, vult_aan)
             select proef.id(801), sj0, 1, 2000, 4000, false from proef.c union all select proef.id(802), sj0, 2, null, null, true from proef.c$q$, 'authenticated', true) = 'geen fout, 2 rijen');
select proef.zeker('voorschotten: samen nooit hoger dan het plafond (B96)',
  proef.fout($q$update public.voorschotten set bedrag_lager_cent = 11001 where id = proef.id(801)$q$) like '23514%B96%');
select proef.zeker('voorschotten: enkel het laatste kan aanvullen (B145)',
  proef.fout($q$insert into public.voorschotten (schooljaar, volgnummer, bedrag_kleuter_cent, bedrag_lager_cent) select sj0, 3, 100, 100 from proef.c$q$) like '23514%B145%');
select proef.zeker('voorschotten: geen datum in de toekomst',
  proef.fout($q$update public.voorschotten set aangerekend_op = vandaag + 1 from proef.c where id = proef.id(801)$q$) like '23514%');
select proef.zeker('voorschotten: aanrekenen',
  proef.fout($q$update public.voorschotten set aangerekend_op = begin0 from proef.c where id = proef.id(801)$q$, 'authenticated', true) = 'geen fout, 1 rijen');
select proef.zeker('voorschotten: wie aanrekende, staat erbij',
  (select aangerekend_door = proef.id(1) and aangerekend_vastgelegd_op is not null from public.voorschotten where id = proef.id(801)));
select proef.zeker('voorschotten: na het aanrekenen ligt het vast (B162)',
  proef.fout($q$update public.voorschotten set bedrag_lager_cent = 1 where id = proef.id(801)$q$) like '42501%B162%'
  and proef.fout($q$delete from public.voorschotten where id = proef.id(801)$q$, 'postgres') like '42501%B162%');
select proef.zeker('voorschotten: het laatste vult aan tot het plafond',
  proef.fout($q$update public.voorschotten set aangerekend_op = begin0 from proef.c where id = proef.id(802)$q$, 'authenticated', true) = 'geen fout, 1 rijen');
select proef.zeker('voorschotten: het plafond min de vorige: 35,00 en 70,00',
  (select bedrag_kleuter_cent = 3500 and bedrag_lager_cent = 7000 from public.voorschotten where id = proef.id(802)));

select proef.zeker('tarief: niet voor een beurt die al bevestigd is (B73)',
  proef.fout($q$update public.tarieven set bedrag_cent = 9000 where kostenregel_id = proef.id(411)$q$) like '42501%B73%'
  and proef.fout($q$delete from public.tarieven where kostenregel_id = proef.id(411)$q$) like '42501%B73%'
  and proef.fout($q$update public.kostenregels set verdeling = 'per_kind' where id = proef.id(411)$q$) like '42501%B73%');
select proef.zeker('tarief: een nieuw tarief vanaf een latere beurt kan',
  proef.fout($q$insert into public.tarieven (kostenregel_id, geldig_vanaf, schooljaar, bedrag_cent) select proef.id(411), begin0 + 10, sj0, 9900 from proef.c$q$) = 'geen fout, 1 rijen'
  and proef.fout($q$insert into public.tarieven (kostenregel_id, geldig_vanaf, schooljaar, bedrag_cent) select proef.id(411), begin0 + 5, sj0, 9900 from proef.c$q$) like '42501%B73%');

select proef.zeker('deelnemerslijst: enkel bij een klas uit de groep Andere (B143)',
  proef.fout($q$insert into public.deelnemers (activiteit_id, leerling_id, klas_id, schooljaar) select proef.id(301), proef.id(202), proef.id(101), sj0 from proef.c$q$) like '42501%B143%');

select proef.zeker('correctie: wijzigen kan tot ze gefactureerd is',
  proef.fout($q$update public.correctie_leerlingen set bedrag_cent = -600 where correctie_id = proef.id(601)$q$) = 'geen fout, 1 rijen');

select proef.zeker('beheerders: de laatste actieve beheerder blijft (17.4)',
  proef.fout($q$update public.gebruikers set actief = false where id in (proef.id(2), proef.id(9))$q$, 'postgres', true) = 'geen fout, 2 rijen'
  and proef.fout($q$update public.gebruikers set actief = false where id = proef.id(1)$q$, 'postgres') like '42501%17.4%'
  and proef.fout($q$update public.gebruikers set rol = 'lezer' where id = proef.id(1)$q$, 'postgres') like '42501%17.4%');

select proef.zeker('logboek: wijzigen, wissen of leegmaken kan niemand (T9)',
  proef.fout($q$update public.logboek set tabel = 'x'$q$, 'postgres') like '42501%'
  and proef.fout($q$delete from public.logboek$q$, 'postgres') like '42501%'
  and proef.fout($q$truncate public.logboek$q$, 'postgres') like '42501%');
select proef.zeker('logboek: bij een wijziging enkel wat wijzigde, met het schooljaar', exists (
  select 1 from public.logboek l, proef.c c where l.tabel = 'klassen' and l.rij = proef.id(102)::text and l.actie = 'gewijzigd'
     and l.schooljaar = c.sj0 and l.oud = '{"naam": "4B"}'::jsonb and l.nieuw = '{"naam": "4X"}'::jsonb));
select proef.zeker('vandaag: de dag in Brussel, wat de tijdzone van de sessie ook is',
  mt_intern.vandaag() = (now() at time zone 'Europe/Brussels')::date);

-- ============================================================================================
-- De databankfuncties van 003 (stap 1b)
-- ============================================================================================
-- Vanaf hier staat "vandaag" vast op honderd dagen na het begin van het schooljaar, zodat de proef op
-- elke dag van het jaar hetzelfde nagaat. Alles loopt via de doorgeefluiken in public, als de rol
-- authenticated, zoals de pagina het doet.

create function proef.zet_vandaag(p_dag date) returns void
language plpgsql as $$
begin
  if p_dag is null then
    execute $f$create or replace function mt_intern.vandaag() returns date language sql stable set search_path = '' as $v$ select (now() at time zone 'Europe/Brussels')::date $v$ $f$;
  else
    execute format($f$create or replace function mt_intern.vandaag() returns date language sql stable set search_path = '' as $v$ select %L::date $v$ $f$, p_dag);
  end if;
end $$;

-- Roept iets op als een rol en geeft het antwoord terug; bij een fout {"fout": code, "tekst": melding}.
create function proef.json(p_sql text, p_rol text default 'authenticated') returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  execute format('set local role %I', p_rol);
  begin
    execute p_sql into v;
  exception when others then
    v := jsonb_build_object('fout', sqlstate, 'tekst', sqlerrm);
  end;
  set local role none;
  return v;
end $$;

-- Voert iets uit zoals de serverfunctie: de rol service_role, en een toegangsbewijs zonder gebruiker.
create function proef.srv(p_sql text) returns jsonb
language plpgsql as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v jsonb;
begin
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  v := proef.json(p_sql, 'service_role');
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v;
end $$;

create function proef.d(n integer) returns date language sql stable as $$ select begin0 + n from proef.c $$;
create function proef.st(p_naam text) returns uuid language sql stable as $$ select id from public.statussen where naam = p_naam $$;
create function proef.act(p_uitstap text) returns uuid language sql stable as $$ select id from public.activiteiten where uitstap_id = p_uitstap $$;
create function proef.rev(a uuid, k uuid) returns bigint language sql stable as $$
  select revisie from public.klaslijsten where activiteit_id = a and klas_id = k
$$;
create function proef.nieuw_jaar() returns text language sql stable as $$ select (jaar + 1) || '-' || (jaar + 2) from proef.c $$;
create table proef.onthoud (naam text primary key, id uuid);
create function proef.wat(p_naam text) returns uuid language sql stable as $$ select id from proef.onthoud where naam = p_naam $$;

create function proef.status(a uuid, k uuid, l uuid, p_status text, p_dag date default null, p_reden text default null) returns jsonb
language sql as $$
  select proef.json(format('select public.mt_status_bewaren(%L, %L, %L, %L, %L)', a, k, l,
    jsonb_build_array(jsonb_build_object('dag', coalesce(p_dag, (select datum_start from public.activiteiten where id = a)),
                                          'status', proef.st(p_status))), p_reden))
$$;
create function proef.bevestig(a uuid, k uuid) returns jsonb language sql as $$
  select proef.json(format('select public.mt_bevestigen(%L, %L, %L, %L)', a, k, proef.rev(a, k),
    (select case when soort = 'uitstap' then jsonb_build_object('gewijzigd', bron_gewijzigd_op, 'planStatus', bron_plan) end
       from public.activiteiten where id = a)))
$$;
create function proef.opmerking(a uuid, k uuid, l uuid, p_soort text, p_tekst text) returns jsonb language sql as $$
  select proef.json(format('select public.mt_opmerking_bewaren(%L, %L, %L, %L, %L)', a, k, l, p_soort, p_tekst))
$$;
create function proef.aanvraag(a uuid, k uuid, p_regels jsonb, p_revisie bigint default null, p_reden text default null) returns jsonb
language sql as $$
  select proef.json(format('select public.mt_wijziging_aanvragen(%L, %L, %L, %L, %L)', a, k, coalesce(p_revisie, proef.rev(a, k)), p_regels, p_reden))
$$;
create function proef.regel_status(l uuid, p_dag date, p_status text) returns jsonb language sql stable as $$
  select jsonb_build_object('leerling', l, 'wat', 'status', 'dag', p_dag, 'status', proef.st(p_status))
$$;
create function proef.open_aanvraag(a uuid, k uuid) returns uuid language sql stable as $$
  select id from public.wijzigingsaanvragen where activiteit_id = a and klas_id = k and stand = 'open'
$$;
create function proef.uitstap(p_id text, p_gewijzigd text, p_start date, p_klassen text[], p_plan text default 'bevestigd',
                              p_eind date default null, p_verwijderd boolean default false, p_categorie text default 'uitstap') returns jsonb
language sql stable as $$
  select jsonb_build_object('id', p_id, 'gewijzigd', p_gewijzigd, 'categorie', p_categorie, 'verwijderd', p_verwijderd, 'planStatus', p_plan,
    'type', case when p_eind is null then 'dag' else 'meerdaags' end, 'datumStart', p_start, 'datumEind', coalesce(p_eind, p_start),
    'klassen', to_jsonb(p_klassen))
$$;
-- De uitstappen bijwerken doet sinds 005 enkel de serverfunctie die de uitstappentool zelf leest (B212).
create function proef.lees(p_uitstap jsonb, p_alle text[] default null) returns jsonb language sql as $$
  select proef.srv(format('select public.mt_uitstappen_bijwerken(%L, %L)', jsonb_build_array(p_uitstap), p_alle))
$$;
create function proef.totaal(a uuid, k uuid, p_veld text) returns integer language sql as $$
  with t as (select proef.json(format('select public.mt_lijst_totalen(%L)', (select schooljaar from public.activiteiten where id = a))) as j)
  select (x.rij ->> p_veld)::integer
    from t, jsonb_array_elements(case when jsonb_typeof(t.j) = 'array' then t.j else '[]'::jsonb end) as x(rij)
   where x.rij ->> 'activiteit' = a::text and x.rij ->> 'klas' = k::text
$$;
create function proef.leerlingen(p_schooljaar text, p_regels jsonb, p_import jsonb default null) returns jsonb language sql as $$
  select proef.json(format('select public.mt_leerlingen_doorvoeren(%L, %L, %L)', p_schooljaar, p_regels, p_import))
$$;
create function proef.wissel(l uuid, k uuid, p_nummer integer, p_vanaf date) returns jsonb language sql stable as $$
  select jsonb_build_array(jsonb_build_object('actie', 'klaswissel', 'leerling', l, 'klas', k, 'klasnummer', p_nummer, 'vanaf', p_vanaf))
$$;
create function proef.klassenlijst(p_tweede text default '4Y', p_groep_a text default 'Lager') returns jsonb language sql stable as $$
  select jsonb_build_array(
    jsonb_build_object('id', 'brona', 'naam', '4A', 'groep', p_groep_a, 'actief', true),
    jsonb_build_object('id', 'bronb', 'naam', p_tweede, 'groep', 'Lager'),
    jsonb_build_object('id', 'bronc', 'naam', '1instA', 'groep', 'Kleuter'),
    jsonb_build_object('id', 'brond', 'naam', '1A', 'groep', 'Lager'),
    jsonb_build_object('id', 'brone', 'naam', '6B', 'groep', 'Lager'),
    jsonb_build_object('id', 'bronf', 'naam', 'LO', 'groep', 'Andere'),
    jsonb_build_object('id', 'bronh', 'naam', '5A', 'groep', 'Lager'))
$$;

select proef.zet_vandaag(proef.d(100));

-- ---------- 5. De databankfuncties: wie ze bereikt (17.1, regel 5) ----------

select proef.zeker('functies: de controle van het script vindt niets', mt_intern.controleer_functies() is null, mt_intern.controleer_functies());
create function mt_intern.proef_zonder_controle() returns integer language plpgsql security definer set search_path = '' as $f$ begin return 1; end $f$;
grant execute on function mt_intern.proef_zonder_controle() to authenticated;
select proef.zeker('functies: een functie die niet op de lijst staat, valt op (regel 5, O6)',
  mt_intern.controleer_functies() like '%proef_zonder_controle() in mt_intern is uitvoerbaar via de API, maar staat op geen lijst%', mt_intern.controleer_functies());
drop function mt_intern.proef_zonder_controle();
create view public.proef_zicht as select id from public.leerlingen;
select proef.zeker('functies: een view in public valt op (O6)',
  mt_intern.controleer_functies() like '%de view public.proef_zicht hoort niet in public%', mt_intern.controleer_functies());
drop view public.proef_zicht;
create function public.proef_buiten_lijst() returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
revoke all on function public.proef_buiten_lijst() from public, anon, service_role;
grant execute on function public.proef_buiten_lijst() to authenticated;
select proef.zeker('functies: een functie in public die niet op de lijst staat, valt op, ook zonder mt_ in de naam (O6)',
  mt_intern.controleer_functies() like '%public.proef_buiten_lijst() staat in public, maar niet op de lijst%', mt_intern.controleer_functies());
drop function public.proef_buiten_lijst();
create function public.mt_proef_luik() returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
select proef.zeker('functies: in public staat enkel een doorgeefluik, dat zelf niets omzeilt',
  mt_intern.controleer_functies() like '%mt_proef_luik() in public is geen doorgeefluik%', mt_intern.controleer_functies());
drop function public.mt_proef_luik();
select proef.zeker('functies: anon en service_role bereiken er geen enkele, en een hulpfunctie bereikt niemand',
  proef.json('select public.mt_gebruikers_namen()', 'anon') ->> 'fout' = '42501'
  and proef.json('select public.mt_gebruikers_namen()', 'service_role') ->> 'fout' = '42501'
  and proef.json('select mt_intern.gebruikers_namen()', 'anon') ->> 'fout' = '42501'
  and proef.json('select mt_intern.eis_rol(''beheerder'')') ->> 'fout' = '42501'
  and proef.json('select mt_intern.revisie_omhoog(proef.id(301), proef.id(101))') ->> 'fout' = '42501');

select proef.aangemeld(proef.id(3), 'aal1');
select proef.zeker('functies: zonder tweestapsverificatie gebeurt er niets',
  proef.status(proef.id(301), proef.id(101), proef.id(202), 'Briefje ouders') ->> 'fout' = '42501'
  and proef.json('select public.mt_gebruikers_namen()') ->> 'fout' = '42501');
select proef.aangemeld(proef.id(7));
select proef.zeker('functies: een uitgeschakeld account bereikt niets', proef.json('select public.mt_gebruikers_namen()') ->> 'fout' = '42501');
select proef.aangemeld(proef.id(5));
select proef.zeker('functies: een lezer schrijft ook via een functie niets',
  proef.status(proef.id(301), proef.id(101), proef.id(202), 'Briefje ouders') ->> 'fout' = '42501'
  and proef.json(format('select public.mt_uitstappen_bijwerken(%L, null)', '[]'::jsonb)) ->> 'fout' = '42501'
  and proef.json(format('select public.mt_bevestigen(%L, %L, 0, null)', proef.id(301), proef.id(101))) ->> 'fout' = '42501');

-- ---------- 6. Aanwezigheden (7, T2) ----------

select proef.aangemeld(proef.id(3));
select proef.zeker('status: de leerkracht bewaart een tik, en krijgt de revisie terug (B34)',
  proef.status(proef.id(301), proef.id(101), proef.id(202), 'Nog te bepalen') ->> 'revisie' = '1');
select proef.zeker('status: de uitzondering staat er, met wie ze ingaf',
  (select status_id = proef.st('Nog te bepalen') and gewijzigd_door = proef.id(3) and klas_id = proef.id(101)
     from public.afwezigheden where activiteit_id = proef.id(301) and leerling_id = proef.id(202)));
select proef.zeker('status: dezelfde status nog eens verhoogt de revisie niet',
  proef.status(proef.id(301), proef.id(101), proef.id(202), 'Nog te bepalen') ->> 'revisie' = '1');
select proef.zeker('status: een leerling van een andere klas staat niet op de lijst',
  proef.status(proef.id(301), proef.id(101), proef.id(204), 'Attest') ->> 'fout' = 'MT422');
select proef.zeker('status: de lijst van een andere klas is niet van haar',
  proef.status(proef.id(301), proef.id(102), proef.id(204), 'Attest') ->> 'fout' = '42501');
select proef.zeker('status: een dag die niet bij de activiteit hoort',
  proef.status(proef.id(301), proef.id(101), proef.id(202), 'Attest', proef.d(1)) ->> 'fout' = '22023');
select proef.zeker('bevestigen: niet zolang iemand nog te bepalen is (B20)', proef.bevestig(proef.id(301), proef.id(101)) ->> 'fout' = 'MT422');
select proef.zeker('status: "aanwezig" wist de uitzondering (V7)',
  proef.status(proef.id(301), proef.id(101), proef.id(202), 'Aanwezig') ->> 'revisie' = '2');
select proef.zeker('status: na "aanwezig" is er geen rij meer',
  not exists (select 1 from public.afwezigheden where activiteit_id = proef.id(301) and leerling_id = proef.id(202)));
select proef.zeker('bevestigen: een andere revisie dan het scherm toont, legt niets vast (T2)',
  proef.json(format('select public.mt_bevestigen(%L, %L, 1, %L)', proef.id(301), proef.id(101),
    (select jsonb_build_object('gewijzigd', bron_gewijzigd_op) from public.activiteiten where id = proef.id(301)))) ->> 'fout' = 'MT409');
select proef.zeker('bevestigen: niet zonder de waargenomen stand van de uitstap, en niet op een andere versie (B67)',
  proef.json(format('select public.mt_bevestigen(%L, %L, 2, null)', proef.id(301), proef.id(101))) ->> 'fout' = '22023'
  and proef.json(format('select public.mt_bevestigen(%L, %L, 2, %L)', proef.id(301), proef.id(101),
        jsonb_build_object('gewijzigd', '2001-01-01T00:00:00Z'))) ->> 'fout' = 'MT409');
update public.activiteiten set bron_plan = 'aangevraagd' where id = proef.id(301);
select proef.zeker('bevestigen: niet zolang de uitstap niet bevestigd is in de uitstappentool (B20)',
  proef.bevestig(proef.id(301), proef.id(101)) ->> 'fout' = 'MT422');
select proef.zeker('status: bij een aangevraagde uitstap kan ingeven al (B15)',
  proef.status(proef.id(301), proef.id(101), proef.id(203), 'Briefje ouders') ->> 'revisie' = '3');
update public.activiteiten set bron_plan = 'bevestigd' where id = proef.id(301);

select proef.zeker('opmerking: de leerkracht bewaart haar opmerking (B86)',
  proef.opmerking(proef.id(301), proef.id(101), proef.id(203), 'leerkracht', '  Kwam later aan  ') ->> 'revisie' = '4');
select proef.zeker('opmerking: bewaard zonder spaties vooraan en achteraan, met wie ze schreef',
  (select tekst = 'Kwam later aan' and gewijzigd_door = proef.id(3) from public.opmerkingen
    where activiteit_id = proef.id(301) and leerling_id = proef.id(203) and soort = 'leerkracht'));
select proef.zeker('opmerking: die van de beheerder wijzigt een leerkracht niet, en hoogstens 500 tekens',
  proef.opmerking(proef.id(301), proef.id(101), proef.id(203), 'beheerder', 'x') ->> 'fout' = '42501'
  and proef.opmerking(proef.id(301), proef.id(101), proef.id(203), 'leerkracht', repeat('a', 501)) ->> 'fout' = 'MT422');

select proef.zeker('bevestigen: de leerkracht bevestigt haar klas',
  proef.bevestig(proef.id(301), proef.id(101)) @> '{"revisie": 5, "stand": "bevestigd", "leerlingen": 4}'::jsonb);
select proef.zeker('bevestigen: het bewijs bewaart wie er op de lijst stond, met de status per dag (B67)',
  (select count(*) from public.bevestiging_leerlingen bl join public.klaslijsten l on l.bevestiging_id = bl.bevestiging_id
    where l.activiteit_id = proef.id(301) and l.klas_id = proef.id(101)) = 4
  and (select string_agg(s.naam, ',' order by bd.leerling_id) from public.bevestiging_dagen bd
         join public.klaslijsten l on l.bevestiging_id = bd.bevestiging_id join public.statussen s on s.id = bd.status_id
        where l.activiteit_id = proef.id(301) and l.klas_id = proef.id(101)) = 'Attest,Aanwezig,Briefje ouders,Briefje ouders');
select proef.zeker('bevestigen: wie bevestigde, de revisie en de stand van de uitstap staan erbij',
  (select b.bevestigd_door = proef.id(3) and b.revisie = 5 and b.uitstap_stand ->> 'planStatus' = 'bevestigd' and l.stand = 'bevestigd'
     from public.klaslijsten l join public.bevestigingen b on b.id = l.bevestiging_id
    where l.activiteit_id = proef.id(301) and l.klas_id = proef.id(101)));
select proef.zeker('bevestigen: een tweede keer bevestigen legt niets vast (T2)', proef.bevestig(proef.id(301), proef.id(101)) ->> 'fout' = 'MT409');
select proef.zeker('na de bevestiging: de leerkracht wijzigt niet meer zelf (B20)',
  proef.status(proef.id(301), proef.id(101), proef.id(202), 'Attest') ->> 'fout' = 'MT422'
  and proef.opmerking(proef.id(301), proef.id(101), proef.id(203), 'leerkracht', 'Anders') ->> 'fout' = 'MT422');

select proef.aangemeld(proef.id(1));
select proef.zeker('na de bevestiging: de beheerder wijzigt één leerling rechtstreeks (B113)',
  proef.status(proef.id(301), proef.id(101), proef.id(202), 'Attest', null, 'Attest nagekomen') ->> 'revisie' = '6');
select proef.zeker('na de bevestiging: de wijziging staat erbij, met de vorige status en de reden; het bewijs blijft (B193)',
  (select w.oude_status_id = proef.st('Aanwezig') and w.nieuwe_status_id = proef.st('Attest') and w.reden = 'Attest nagekomen'
          and w.gewijzigd_door = proef.id(1)
     from public.wijzigingen w where w.activiteit_id = proef.id(301) and w.leerling_id = proef.id(202) and w.wat = 'status')
  and (select bd.status_id = proef.st('Aanwezig') from public.bevestiging_dagen bd join public.klaslijsten l on l.bevestiging_id = bd.bevestiging_id
        where l.activiteit_id = proef.id(301) and l.klas_id = proef.id(101) and bd.leerling_id = proef.id(202)));
select proef.zeker('na de bevestiging: niemand gaat terug naar "nog te bepalen"',
  proef.status(proef.id(301), proef.id(101), proef.id(201), 'Nog te bepalen') ->> 'fout' = 'MT422');
select proef.zeker('opmerking: de beheerder bewaart de zijne, ook na de bevestiging, en niet die van de leerkracht',
  proef.opmerking(proef.id(301), proef.id(101), proef.id(202), 'beheerder', 'Attest in het dossier') ->> 'revisie' = '7'
  and proef.opmerking(proef.id(301), proef.id(101), proef.id(202), 'leerkracht', 'x') ->> 'fout' = '42501');
select proef.zeker('afgesloten schooljaar: ook via een functie wijzigt er niets',
  proef.status(proef.id(321), proef.id(121), proef.id(209), 'Aanwezig') ->> 'fout' = '42501');

select proef.aangemeld(proef.id(4));
select proef.zeker('aanvraag: enkel een leerkracht van de klas',
  proef.aanvraag(proef.id(301), proef.id(101), jsonb_build_array(proef.regel_status(proef.id(203), proef.d(0), 'Attest'))) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(3));
select proef.zeker('aanvraag: niet op een andere revisie dan het scherm toont',
  proef.aanvraag(proef.id(301), proef.id(101), jsonb_build_array(proef.regel_status(proef.id(203), proef.d(0), 'Attest')), 3) ->> 'fout' = 'MT409');
select proef.zeker('aanvraag: een aanvraag die niets wijzigt, komt er niet',
  proef.aanvraag(proef.id(301), proef.id(101), jsonb_build_array(proef.regel_status(proef.id(203), proef.d(0), 'Briefje ouders'))) ->> 'fout' = 'MT422');
select proef.zeker('aanvraag: de leerkracht vraagt een wijziging aan, met een nieuwe opmerking (B40, B159)',
  proef.aanvraag(proef.id(301), proef.id(101), jsonb_build_array(
    proef.regel_status(proef.id(203), proef.d(0), 'Ongewettigd afwezig'),
    jsonb_build_object('leerling', proef.id(201), 'wat', 'opmerking', 'opmerking', 'Attest volgt'))) ->> 'regels' = '2');
select proef.zeker('aanvraag: bewaart de oude en de gevraagde status, en de revisie waarop ze steunt',
  (select a.verwachte_revisie = 7 and a.aangevraagd_door = proef.id(3) from public.wijzigingsaanvragen a
    where a.id = proef.open_aanvraag(proef.id(301), proef.id(101)))
  and (select r.oude_status_id = proef.st('Briefje ouders') and r.nieuwe_status_id = proef.st('Ongewettigd afwezig')
         from public.wijzigingsaanvraag_regels r
        where r.aanvraag_id = proef.open_aanvraag(proef.id(301), proef.id(101)) and r.wat = 'status'));
select proef.zeker('aanvraag: hoogstens één open aanvraag per klas, en goedkeuren kan een leerkracht niet',
  proef.aanvraag(proef.id(301), proef.id(101), jsonb_build_array(proef.regel_status(proef.id(201), proef.d(0), 'Aanwezig'))) ->> 'fout' = 'MT422'
  and proef.json(format('select public.mt_aanvraag_behandelen(%L, true)', proef.open_aanvraag(proef.id(301), proef.id(101)))) ->> 'fout' = '42501');

select proef.aangemeld(proef.id(1));
select proef.zeker('goedkeuren: de beheerder wijzigde dezelfde leerling intussen zelf',
  proef.status(proef.id(301), proef.id(101), proef.id(203), 'Attest') ->> 'revisie' = '8');
select proef.zeker('goedkeuren: bij een conflict gebeurt er niets (T2)',
  proef.json(format('select public.mt_aanvraag_behandelen(%L, true)', proef.open_aanvraag(proef.id(301), proef.id(101)))) ->> 'fout' = 'MT409');
select proef.zeker('goedkeuren: na het conflict staat de aanvraag nog open, en is niets overschreven',
  proef.open_aanvraag(proef.id(301), proef.id(101)) is not null
  and (select status_id = proef.st('Attest') from public.afwezigheden where activiteit_id = proef.id(301) and leerling_id = proef.id(203))
  and not exists (select 1 from public.opmerkingen where activiteit_id = proef.id(301) and leerling_id = proef.id(201)));
insert into proef.onthoud select 'aanvraag1', proef.open_aanvraag(proef.id(301), proef.id(101));
select proef.zeker('weigeren: de aanvraag is behandeld, met het antwoord',
  proef.json(format('select public.mt_aanvraag_behandelen(%L, false, %L)', proef.wat('aanvraag1'), 'Het attest is al verwerkt')) ->> 'stand' = 'geweigerd');
select proef.zeker('weigeren: twee keer behandelen kan niet (T2)',
  proef.json(format('select public.mt_aanvraag_behandelen(%L, true)', proef.wat('aanvraag1'))) ->> 'fout' = 'MT409'
  and proef.json(format('select public.mt_aanvraag_behandelen(%L, false)', proef.wat('aanvraag1'))) ->> 'fout' = 'MT409'
  and (select stand = 'geweigerd' and behandeld_door = proef.id(1) and antwoord = 'Het attest is al verwerkt'
         from public.wijzigingsaanvragen where id = proef.wat('aanvraag1')));

select proef.aangemeld(proef.id(3));
select proef.zeker('aanvraag: een nieuwe aanvraag, met een reden',
  proef.aanvraag(proef.id(301), proef.id(101), jsonb_build_array(
    proef.regel_status(proef.id(203), proef.d(0), 'Briefje ouders'),
    jsonb_build_object('leerling', proef.id(201), 'wat', 'opmerking', 'opmerking', 'Attest volgt')), null, 'Vergissing') ->> 'regels' = '2');
insert into proef.onthoud select 'aanvraag2', proef.open_aanvraag(proef.id(301), proef.id(101));
select proef.aangemeld(proef.id(1));
select proef.zeker('goedkeuren: goedkeuren en wijzigen gebeuren samen',
  proef.json(format('select public.mt_aanvraag_behandelen(%L, true)', proef.wat('aanvraag2'))) @> '{"stand": "goedgekeurd", "revisie": 9}'::jsonb);
select proef.zeker('goedkeuren: de status en de opmerking zijn aangepast, met de aanvraag en haar reden erbij',
  (select status_id = proef.st('Briefje ouders') from public.afwezigheden where activiteit_id = proef.id(301) and leerling_id = proef.id(203))
  and (select tekst = 'Attest volgt' and gewijzigd_door = proef.id(3) from public.opmerkingen
        where activiteit_id = proef.id(301) and leerling_id = proef.id(201) and soort = 'leerkracht')
  and (select count(*) = 2 and bool_and(reden = 'Vergissing' and gewijzigd_door = proef.id(1)) from public.wijzigingen where aanvraag_id = proef.wat('aanvraag2')));
select proef.zeker('goedkeuren: een tweede keer goedkeuren verandert niets (T2)',
  proef.json(format('select public.mt_aanvraag_behandelen(%L, true)', proef.wat('aanvraag2'))) ->> 'fout' = 'MT409');

select proef.aangemeld(proef.id(3));
select proef.zeker('intrekken: de leerkracht vraagt aan',
  proef.aanvraag(proef.id(301), proef.id(101), jsonb_build_array(proef.regel_status(proef.id(201), proef.d(0), 'Aanwezig'))) ->> 'regels' = '1');
select proef.zeker('intrekken: en trekt haar aanvraag weer in',
  proef.json(format('select public.mt_aanvraag_intrekken(%L)', proef.open_aanvraag(proef.id(301), proef.id(101)))) ->> 'stand' = 'ingetrokken');
select proef.zeker('aanvraag: daarna kan er weer een nieuwe',
  proef.aanvraag(proef.id(301), proef.id(101), jsonb_build_array(proef.regel_status(proef.id(201), proef.d(0), 'Aanwezig'))) ->> 'regels' = '1');
select proef.zeker('heropenen: een leerkracht kan dat niet (B113)',
  proef.json(format('select public.mt_heropenen(%L, %L)', proef.id(301), proef.id(101))) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1));
select proef.zeker('heropenen: de beheerder heropent een bevestigde klas',
  proef.json(format('select public.mt_heropenen(%L, %L, %L)', proef.id(301), proef.id(101), 'Op vraag van de leerkracht')) @> '{"stand": "open", "revisie": 10}'::jsonb);
select proef.zeker('heropenen: de bevestiging blijft als bewijs, en de open aanvraag vervalt',
  (select count(*) = 1 and bool_and(heropend_door = proef.id(1) and heropend_reden = 'Op vraag van de leerkracht')
     from public.bevestigingen where activiteit_id = proef.id(301) and klas_id = proef.id(101))
  and proef.open_aanvraag(proef.id(301), proef.id(101)) is null
  and (select count(*) from public.wijzigingsaanvragen where activiteit_id = proef.id(301) and stand = 'ingetrokken') = 2);
select proef.aangemeld(proef.id(3));
select proef.zeker('heropenen: de leerkracht past de lijst weer zelf aan',
  proef.status(proef.id(301), proef.id(101), proef.id(201), 'Aanwezig') ->> 'revisie' = '11');
select proef.zeker('bevestigen: opnieuw bevestigen maakt een nieuw bewijs',
  proef.bevestig(proef.id(301), proef.id(101)) @> '{"revisie": 12, "leerlingen": 4}'::jsonb);
select proef.aangemeld(proef.id(4));
select proef.zeker('bevestigen: elke klas apart (B39)', proef.bevestig(proef.id(301), proef.id(102)) @> '{"revisie": 1, "leerlingen": 2}'::jsonb);

select proef.aangemeld(proef.id(3));
select proef.zeker('totalen: de leerkracht van 4A krijgt de aantallen van haar klas',
  proef.totaal(proef.id(301), proef.id(101), 'op_lijst') = 4 and proef.totaal(proef.id(301), proef.id(101), 'aangerekend') = 3
  and proef.totaal(proef.id(301), proef.id(101), 'aanwezig') = 1 and proef.totaal(proef.id(301), proef.id(101), 'te_bepalen') = 0);
select proef.zeker('totalen: en van de andere klas van dezelfde uitstap enkel de aantallen, nooit de leerlingen (T6)',
  proef.totaal(proef.id(301), proef.id(102), 'op_lijst') = 2 and proef.totaal(proef.id(301), proef.id(102), 'aangerekend') = 2
  and proef.totaal(proef.id(301), proef.id(102), 'aanwezig') = 1
  and proef.tel('select 1 from public.afwezigheden where leerling_id = proef.id(204)') = 0);
select proef.aangemeld(proef.id(4));
select proef.zeker('totalen: niets van een activiteit waar haar klas niet bij is',
  proef.totaal(proef.id(301), proef.id(101), 'aangerekend') = 3 and proef.totaal(proef.id(332), proef.id(101), 'op_lijst') is null);
select proef.aangemeld(proef.id(5));
select proef.zeker('totalen: de lezer krijgt alle lijsten van het schooljaar',
  proef.totaal(proef.id(332), proef.id(101), 'op_lijst') = 3 and proef.totaal(proef.id(301), proef.id(102), 'op_lijst') = 2);

-- ---------- 7. Klaswissel, instroom, "Was hij mee?" en de import (B67, B174, B192) ----------

select proef.aangemeld(proef.id(3));
select proef.zeker('leerlingen: een leerkracht voert geen wijzigingen door',
  proef.leerlingen((select sj0 from proef.c), '[]'::jsonb) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1));
select proef.zeker('klaswissel: later ingegeven, met terugwerkende kracht: 206 zat op de dag van de uitstap al in 4B (B67)',
  proef.leerlingen((select sj0 from proef.c), proef.wissel(proef.id(206), proef.id(102), 3, proef.d(0))) -> 'aantallen' ->> 'klaswissel' = '1');
select proef.zeker('was hij mee: de nieuwe klas was al bevestigd, dus er komt één taak, en geen bevestigde lijst wijzigt stil',
  (select count(*) = 1 and bool_and(soort = 'was_hij_mee' and klas_id = proef.id(102) and stand = 'open')
     from public.taken where activiteit_id = proef.id(301) and leerling_id = proef.id(206))
  and not exists (select 1 from public.deelname where activiteit_id = proef.id(301))
  and (select count(*) from public.bevestiging_leerlingen bl join public.klaslijsten l on l.bevestiging_id = bl.bevestiging_id
        where l.activiteit_id = proef.id(301) and l.klas_id = proef.id(102)) = 2);
select proef.zeker('was hij mee: tot de beheerder beslist, telt de leerling één keer, zoals bevestigd',
  proef.totaal(proef.id(301), proef.id(101), 'deelnemers') = 4 and proef.totaal(proef.id(301), proef.id(102), 'deelnemers') = 2);
insert into proef.onthoud select 'taak1', id from public.taken where activiteit_id = proef.id(301) and leerling_id = proef.id(206);
select proef.aangemeld(proef.id(4));
select proef.zeker('was hij mee: antwoorden kan enkel de beheerder, ook niet de leerkracht van die klas',
  proef.json(format('select public.mt_was_hij_mee(%L, true)', proef.wat('taak1'))) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1));
select proef.zeker('was hij mee: een taak die een antwoord vraagt, sluit je niet met "gezien"',
  proef.json(format('select public.mt_taak_afhandelen(%L)', proef.wat('taak1'))) ->> 'fout' = 'MT422');
select proef.zeker('was hij mee: "hij was mee" (B192)',
  proef.json(format('select public.mt_was_hij_mee(%L, true, null, %L)', proef.wat('taak1'), 'Bevestigd door de leerkracht')) ->> 'afhandeling' = 'was_mee');
select proef.zeker('was hij mee: hij staat op de lijst als later toegevoegd, en telt bij zijn vorige klas niet meer mee',
  (select bl.later_toegevoegd and bl.toegevoegd_door = proef.id(1)
     from public.bevestiging_leerlingen bl join public.klaslijsten l on l.bevestiging_id = bl.bevestiging_id
    where l.activiteit_id = proef.id(301) and l.klas_id = proef.id(102) and bl.leerling_id = proef.id(206))
  and (select klas_id = proef.id(101) from public.deelname where activiteit_id = proef.id(301) and leerling_id = proef.id(206))
  and (select count(*) from public.wijzigingen where activiteit_id = proef.id(301) and leerling_id = proef.id(206) and wat = 'deelname') = 2
  and (select tekst = 'Bevestigd door de leerkracht' from public.opmerkingen
        where activiteit_id = proef.id(301) and leerling_id = proef.id(206) and soort = 'beheerder')
  and (select stand = 'afgehandeld' and afhandeling = 'was_mee' and afgehandeld_door = proef.id(1) from public.taken where id = proef.wat('taak1')));
select proef.zeker('was hij mee: nooit twee keer voor dezelfde activiteit',
  proef.totaal(proef.id(301), proef.id(101), 'deelnemers') = 3 and proef.totaal(proef.id(301), proef.id(102), 'deelnemers') = 3
  and proef.totaal(proef.id(301), proef.id(102), 'aanwezig') = 2);
select proef.zeker('was hij mee: een tweede antwoord kan niet',
  proef.json(format('select public.mt_was_hij_mee(%L, false, %L)', proef.wat('taak1'), proef.st('Attest'))) ->> 'fout' = 'MT409');

select proef.zeker('klaswissel: naar een klas die niet mee was',
  proef.leerlingen((select sj0 from proef.c), proef.wissel(proef.id(203), proef.id(104), 1, proef.d(0))) -> 'aantallen' ->> 'klaswissel' = '1');
select proef.zeker('was hij toch mee: hij staat op een bevestigde lijst van een klas waarin hij die dag niet zat',
  (select count(*) = 1 and bool_and(soort = 'was_hij_toch_mee' and klas_id = proef.id(101) and stand = 'open')
     from public.taken where activiteit_id = proef.id(301) and leerling_id = proef.id(203))
  and proef.totaal(proef.id(301), proef.id(101), 'deelnemers') = 3);
select proef.zeker('was hij toch mee: "hij was niet mee"',
  proef.json(format('select public.mt_was_hij_mee(%L, false)',
    (select id from public.taken where activiteit_id = proef.id(301) and leerling_id = proef.id(203)))) ->> 'afhandeling' = 'was_niet_mee');
select proef.zeker('was hij toch mee: hij telt er niet meer mee, en het staat bij de wijzigingen',
  proef.totaal(proef.id(301), proef.id(101), 'deelnemers') = 2
  and (select oude_deelname and not nieuwe_deelname from public.wijzigingen
        where activiteit_id = proef.id(301) and leerling_id = proef.id(203) and wat = 'deelname'));
select proef.zeker('klaswissel: een vergissing bij een andere leerling',
  proef.leerlingen((select sj0 from proef.c), proef.wissel(proef.id(202), proef.id(104), 2, proef.d(0))) -> 'aantallen' ->> 'klaswissel' = '1');
select proef.zeker('taak: er staat een taak open',
  (select count(*) = 1 and bool_and(stand = 'open') from public.taken where activiteit_id = proef.id(301) and leerling_id = proef.id(202)));
select proef.zeker('klaswissel: de vergissing wordt rechtgezet',
  proef.leerlingen((select sj0 from proef.c), proef.wissel(proef.id(202), proef.id(101), 2, proef.d(0))) -> 'aantallen' ->> 'klaswissel' = '1');
select proef.zeker('taak: een taak waarvan de aanleiding verdween, vervalt vanzelf',
  (select count(*) = 1 and bool_and(stand = 'afgehandeld' and afhandeling = 'vervallen')
     from public.taken where activiteit_id = proef.id(301) and leerling_id = proef.id(202)));

select proef.zeker('import: de eerste import van een schooljaar is de eerste lijst (B174)',
  proef.leerlingen((select sj0 from proef.c), jsonb_build_array(
    jsonb_build_object('actie', 'inschrijven', 'stamnummer', '0000301', 'voornaam', ' Nieuw ', 'familienaam', 'Proef',
                       'klas', proef.id(101), 'klasnummer', 5, 'van', proef.d(30))),
    '{"bestandsnaam": "proef.xlsx"}'::jsonb) ->> 'soort' = 'eerste_lijst');
select proef.zeker('import: de leerling en zijn klasindeling staan er; de import is geregistreerd, zonder het bestand (T13)',
  (select l.voornaam = 'Nieuw' and ki.klasnummer = 5 and ki.van = proef.d(30) and ki.tot is null
     from public.leerlingen l join public.klasindelingen ki on ki.leerling_id = l.id where l.stamnummer = '0000301')
  and (select count(*) = 1 and bool_and(soort = 'eerste_lijst' and bestandsnaam = 'proef.xlsx' and uitgevoerd_door = proef.id(1)
                                        and aantallen ->> 'inschrijven' = '1') from public.imports));
select proef.zeker('import: elke volgende import is een bijwerking',
  proef.leerlingen((select sj0 from proef.c), jsonb_build_array(
    jsonb_build_object('actie', 'klasnummer', 'stamnummer', '0000301', 'klasnummer', 6),
    jsonb_build_object('actie', 'uitschrijven', 'leerling', proef.id(205), 'laatste_dag', proef.d(40)),
    jsonb_build_object('actie', 'naam', 'leerling', proef.id(204), 'voornaam', 'Leerling4', 'familienaam', 'Proefpersoon')),
    '{"bestandsnaam": "proef2.xlsx"}'::jsonb) ->> 'soort' = 'bijwerking');
select proef.zeker('import: het klasnummer, de laatste dag die nog meetelt (B89) en de naam',
  (select ki.klasnummer = 6 from public.klasindelingen ki join public.leerlingen l on l.id = ki.leerling_id where l.stamnummer = '0000301')
  and (select tot = proef.d(41) from public.klasindelingen where leerling_id = proef.id(205))
  and (select familienaam = 'Proefpersoon' from public.leerlingen where id = proef.id(204)));
select proef.zeker('import: een klasnummer dat in die periode al in gebruik is, houdt alles tegen',
  proef.leerlingen((select sj0 from proef.c), jsonb_build_array(
    jsonb_build_object('actie', 'naam', 'leerling', proef.id(204), 'voornaam', 'Anders', 'familienaam', 'Proef'),
    jsonb_build_object('actie', 'klasnummer', 'stamnummer', '0000301', 'klasnummer', 1))) ->> 'fout' = 'MT422');
select proef.zeker('import: alles of niets: ook de naam uit dezelfde lijst is niet gewijzigd',
  (select familienaam = 'Proefpersoon' from public.leerlingen where id = proef.id(204))
  and (select ki.klasnummer = 6 from public.klasindelingen ki join public.leerlingen l on l.id = ki.leerling_id where l.stamnummer = '0000301'));
select proef.zeker('instroom: een leerling die later ingegeven wordt, komt niet stil op een bevestigde lijst (B67)',
  proef.leerlingen((select sj0 from proef.c), jsonb_build_array(
    jsonb_build_object('actie', 'inschrijven', 'stamnummer', '0000302', 'voornaam', 'Later', 'familienaam', 'Proef',
                       'klas', proef.id(102), 'klasnummer', 9, 'van', proef.d(0)))) -> 'aantallen' ->> 'inschrijven' = '1');
insert into proef.onthoud select 'taak2', t.id from public.taken t join public.leerlingen l on l.id = t.leerling_id
 where l.stamnummer = '0000302' and t.activiteit_id = proef.id(301) and t.soort = 'was_hij_mee' and t.stand = 'open';
select proef.zeker('instroom: er komt een taak "Was hij mee?", en hij betaalt intussen niets',
  proef.wat('taak2') is not null and proef.totaal(proef.id(301), proef.id(102), 'op_lijst') = 3);
select proef.zeker('was hij mee: "hij was niet mee" vraagt waarom',
  proef.json(format('select public.mt_was_hij_mee(%L, false)', proef.wat('taak2'))) ->> 'fout' = 'MT422');
select proef.zeker('was hij mee: "hij was niet mee", met de status die de beheerder kiest (B192)',
  proef.json(format('select public.mt_was_hij_mee(%L, false, %L)', proef.wat('taak2'), proef.st('Ongewettigd afwezig'))) ->> 'afhandeling' = 'was_niet_mee');
select proef.zeker('was hij mee: hij staat op de lijst, met die status, en telt nu mee',
  proef.totaal(proef.id(301), proef.id(102), 'op_lijst') = 4 and proef.totaal(proef.id(301), proef.id(102), 'aangerekend') = 4
  and proef.totaal(proef.id(301), proef.id(102), 'aanwezig') = 2);
select proef.zeker('import: opnieuw als eerste lijst kan niet meer als er al iets van afhangt (B174)',
  proef.leerlingen((select sj0 from proef.c), '[]'::jsonb, '{"opnieuw": true}'::jsonb) ->> 'fout' = 'MT422');
select proef.zeker('import: nooit naar een schooljaar dat voorbij is (B132); een rechtzetting bij één leerling kan daar wel',
  proef.leerlingen((select sj1 from proef.c), '[]'::jsonb, '{"bestandsnaam": "x"}'::jsonb) ->> 'fout' = 'MT422'
  and proef.leerlingen((select sj1 from proef.c), jsonb_build_array(jsonb_build_object('actie', 'klasnummer', 'leerling', proef.id(207),
        'klasnummer', 7, 'op', make_date((select jaar from proef.c), 3, 1)))) -> 'aantallen' ->> 'klasnummer' = '1');
select proef.zeker('import: een stamnummer dat niet klopt, houdt alles tegen; in een afgesloten schooljaar wijzigt niets',
  proef.leerlingen((select sj0 from proef.c), jsonb_build_array(
    jsonb_build_object('actie', 'inschrijven', 'stamnummer', '12', 'voornaam', 'Fout', 'familienaam', 'Proef', 'klas', proef.id(101), 'van', proef.d(0)))) ->> 'fout' = 'MT422'
  and proef.leerlingen((select sj2 from proef.c), jsonb_build_array(jsonb_build_object('actie', 'klasnummer', 'leerling', proef.id(209), 'klasnummer', 7))) ->> 'fout' = 'MT422');

-- ---------- 8. Uitstappen uit de uitstappentool (4, T1, B14, B67) ----------

select proef.aangemeld(proef.id(3));
select proef.zeker('uitstappen: een leerkracht meldt een nieuwe uitstap',
  proef.lees(proef.uitstap('u-n1', '2026-01-01T10:00:00Z', proef.d(20), array['4A', '4B', 'Fantasie'])) @> '{"nieuw": 1}'::jsonb);
select proef.zeker('uitstappen: de lijsten staan er; de klas komt uit de naam van dat schooljaar, ook een vroegere naam (B158)',
  (select count(*) = 2 and bool_and(stand = 'open' and klas_id in (proef.id(101), proef.id(102))) from public.klaslijsten where activiteit_id = proef.act('u-n1'))
  and (select bron_plan = 'bevestigd' and bron_stand = 'actief' and datum_start = proef.d(20) and not meerdaags
              and schooljaar = (select sj0 from proef.c) from public.activiteiten where id = proef.act('u-n1')));
select proef.zeker('uitstappen: een onbekende naam geeft nooit een lege klas: ze komt terug, voor "klas onbekend"',
  proef.lees(proef.uitstap('u-n1', '2026-01-01T10:00:00Z', proef.d(20), array['4A', '4B', 'Fantasie']))
    @> '{"ongewijzigd": 1, "onbekende_klassen": [{"uitstap": "u-n1", "klassen": ["Fantasie"]}]}'::jsonb);
select proef.zeker('uitstappen: twee keer melden maakt niets dubbel', (select count(*) = 1 from public.activiteiten where uitstap_id = 'u-n1'));
select proef.zeker('uitstappen: de datum wijzigt vóór er iets ingegeven is: de MT volgt',
  proef.lees(proef.uitstap('u-n1', '2026-01-02T10:00:00Z', proef.d(21), array['4A', '4B'])) @> '{"gewijzigd": 1}'::jsonb);
select proef.zeker('uitstappen: de datum en de versie zijn die van de uitstappentool',
  (select datum_start = proef.d(21) and bron_gewijzigd_op = '2026-01-02T10:00:00Z'::timestamptz from public.activiteiten where id = proef.act('u-n1')));
select proef.zeker('uitstappen: een afwezigheid op de dag zelf',
  proef.status(proef.act('u-n1'), proef.id(101), proef.id(201), 'Attest') ->> 'revisie' = '2');
select proef.zeker('uitstappen: een oudere melding wordt overgeslagen (B212)',
  proef.lees(proef.uitstap('u-n1', '2026-01-01T12:00:00Z', proef.d(25), array['4A'])) @> '{"ouder": 1}'::jsonb);
select proef.zeker('uitstappen: ze draait de datum, de versie en de klassen niet terug',
  (select datum_start = proef.d(21) and bron_gewijzigd_op = '2026-01-02T10:00:00Z'::timestamptz from public.activiteiten where id = proef.act('u-n1'))
  and (select count(*) = 2 from public.klaslijsten where activiteit_id = proef.act('u-n1')));
select proef.zeker('uitstappen: een melding uit de toekomst is ongeldig',
  proef.lees(proef.uitstap('u-n1', (now() + interval '1 hour')::text, proef.d(25), array['4A'])) @> '{"ongeldig": 1}'::jsonb);
select proef.zeker('uitstappen: een andere datum terwijl er afwezigheden zijn: de datum wacht (B212)',
  proef.lees(proef.uitstap('u-n1', '2026-01-02T15:00:00Z', proef.d(22), array['4A', '4B'])) @> '{"wacht": ["u-n1"]}'::jsonb);
select proef.zeker('uitstappen: de MT verschuift of wist dan niets, en maakt een taak voor de beheerder',
  (select datum_start = proef.d(21) and bron_gewijzigd_op = '2026-01-02T10:00:00Z'::timestamptz from public.activiteiten where id = proef.act('u-n1'))
  and (select count(*) = 1 and bool_and(dag = proef.d(21)) from public.afwezigheden where activiteit_id = proef.act('u-n1'))
  and (select count(*) = 1 and bool_and(gegevens ->> 'wacht' = 'true' and (gegevens ->> 'naar')::date = proef.d(22)) from public.taken
        where activiteit_id = proef.act('u-n1') and soort = 'datum_gewijzigd' and stand = 'open'));
select proef.zeker('uitstappen: dezelfde melding nog eens wacht opnieuw',
  proef.lees(proef.uitstap('u-n1', '2026-01-02T15:00:00Z', proef.d(22), array['4A', '4B'])) @> '{"wacht": ["u-n1"]}'::jsonb);
select proef.zeker('uitstappen: en maakt geen tweede taak',
  (select count(*) = 1 from public.taken where activiteit_id = proef.act('u-n1') and soort = 'datum_gewijzigd'));
select proef.zeker('uitstappen: staat de datum in de uitstappentool weer zoals de MT ze kent, dan volgt de MT de nieuwe versie',
  proef.lees(proef.uitstap('u-n1', '2026-01-02T18:00:00Z', proef.d(21), array['4A', '4B'])) @> '{"gewijzigd": 1}'::jsonb);
select proef.zeker('uitstappen: de klas wordt bevestigd', proef.bevestig(proef.act('u-n1'), proef.id(101)) ->> 'stand' = 'bevestigd');
select proef.zeker('uitstappen: een andere datum na een bevestiging wordt niet stil overgenomen (B67)',
  proef.lees(proef.uitstap('u-n1', '2026-01-03T10:00:00Z', proef.d(22), array['4A', '4B'])) @> '{"wacht": ["u-n1"]}'::jsonb);
select proef.zeker('uitstappen: de MT houdt de datum en de versie van toen',
  (select datum_start = proef.d(21) and bron_gewijzigd_op = '2026-01-02T18:00:00Z'::timestamptz from public.activiteiten where id = proef.act('u-n1')));
select proef.aangemeld(proef.id(4));
select proef.zeker('uitstappen: zolang dat niet opgelost is, kan geen andere klas van die uitstap bevestigd worden',
  proef.json(format('select public.mt_bevestigen(%L, %L, %L, %L)', proef.act('u-n1'), proef.id(102), proef.rev(proef.act('u-n1'), proef.id(102)),
    jsonb_build_object('gewijzigd', '2026-01-03T10:00:00Z'))) ->> 'fout' = 'MT409');

select proef.aangemeld(proef.id(1));
select proef.zeker('uitstappen: een klas valt weg',
  proef.lees(proef.uitstap('u-n1', '2026-01-04T10:00:00Z', proef.d(21), array['4A'])) @> '{"gewijzigd": 1}'::jsonb);
select proef.zeker('uitstappen: een lege, open lijst verdwijnt',
  not exists (select 1 from public.klaslijsten where activiteit_id = proef.act('u-n1') and klas_id = proef.id(102)));
select proef.zeker('uitstappen: een klas met een bevestiging valt weg',
  proef.lees(proef.uitstap('u-n1', '2026-01-05T10:00:00Z', proef.d(21), array['4B'])) @> '{"gewijzigd": 1}'::jsonb);
select proef.zeker('uitstappen: de lijst blijft bewaard, maar telt niet meer mee, met een taak voor de beheerder (B14)',
  (select vervallen and stand = 'bevestigd' from public.klaslijsten where activiteit_id = proef.act('u-n1') and klas_id = proef.id(101))
  and (select count(*) = 1 from public.taken where activiteit_id = proef.act('u-n1') and soort = 'klas_weg' and stand = 'open')
  and proef.totaal(proef.act('u-n1'), proef.id(101), 'op_lijst') is null
  and proef.totaal(proef.act('u-n1'), proef.id(102), 'op_lijst') is not null);
select proef.zeker('uitstappen: op een vervallen lijst wijzigt niets meer',
  proef.status(proef.act('u-n1'), proef.id(101), proef.id(202), 'Attest') ->> 'fout' = 'MT422');
select proef.zeker('taak: een melding handelt de beheerder af met "gezien"',
  proef.json(format('select public.mt_taak_afhandelen(%L)',
    (select id from public.taken where activiteit_id = proef.act('u-n1') and soort = 'klas_weg'))) ->> 'afhandeling' = 'gezien');
select proef.zeker('uitstappen: verwijderd in de uitstappentool',
  proef.lees(proef.uitstap('u-n1', '2026-01-06T10:00:00Z', proef.d(21), array['4A', '4B'], 'bevestigd', null, true)) @> '{"weg": 1}'::jsonb);
select proef.zeker('uitstappen: telt niet meer mee, met een taak omdat er al iets aan hing (B14)',
  (select bron_stand = 'verwijderd' from public.activiteiten where id = proef.act('u-n1'))
  and (select count(*) = 1 and bool_and(gegevens ->> 'reden' = 'verwijderd') from public.taken
        where activiteit_id = proef.act('u-n1') and soort = 'uitstap_weg' and stand = 'open'));
select proef.zeker('uitstappen: teruggezet uit de prullenbak',
  proef.lees(proef.uitstap('u-n1', '2026-01-07T10:00:00Z', proef.d(21), array['4A', '4B'])) @> '{"gewijzigd": 1}'::jsonb);
select proef.zeker('uitstappen: weer actief, de klas die terugkwam telt weer mee, en de taak is afgehandeld',
  (select bron_stand = 'actief' from public.activiteiten where id = proef.act('u-n1'))
  and (select not vervallen from public.klaslijsten where activiteit_id = proef.act('u-n1') and klas_id = proef.id(101))
  and (select afhandeling = 'hersteld' from public.taken where activiteit_id = proef.act('u-n1') and soort = 'uitstap_weg'));
select proef.zeker('uitstappen: geannuleerd in de uitstappentool',
  proef.lees(proef.uitstap('u-n1', '2026-01-08T10:00:00Z', proef.d(21), array['4A', '4B'], 'geannuleerd')) @> '{"gewijzigd": 1}'::jsonb);
select proef.zeker('uitstappen: met een taak, en ingeven kan niet meer',
  (select bron_plan = 'geannuleerd' from public.activiteiten where id = proef.act('u-n1'))
  and (select count(*) = 1 from public.taken
        where activiteit_id = proef.act('u-n1') and soort = 'uitstap_weg' and stand = 'open' and gegevens ->> 'reden' = 'geannuleerd')
  and proef.status(proef.act('u-n1'), proef.id(102), proef.id(204), 'Attest') ->> 'fout' = 'MT422');
select proef.zeker('uitstappen: een nascholing, een verwijderde uitstap, een schooljaar dat niet open is en een uitstap zonder datum komen er niet in (B64)',
  proef.lees(proef.uitstap('u-nas', '2026-01-01T10:00:00Z', proef.d(30), array['4A'], 'bevestigd', null, false, 'nascholing')) @> '{"geen": 1}'::jsonb
  and proef.lees(proef.uitstap('u-weg', '2026-01-01T10:00:00Z', proef.d(30), array['4A'], 'bevestigd', null, true)) @> '{"geen": 1}'::jsonb
  and proef.lees(proef.uitstap('u-later', '2026-01-01T10:00:00Z', proef.d(400), array['4A'])) @> '{"buiten": 1}'::jsonb
  and proef.lees(proef.uitstap('u-toen', '2026-01-01T10:00:00Z', proef.d(-500), array['2A'])) @> '{"buiten": 1}'::jsonb
  and proef.lees(jsonb_build_object('id', 'u-leeg', 'gewijzigd', '2026-01-01T10:00:00Z', 'planStatus', 'bevestigd')) @> '{"ongeldig": 1}'::jsonb);
select proef.zeker('uitstappen: geen van die vijf werd een activiteit',
  not exists (select 1 from public.activiteiten where uitstap_id in ('u-nas', 'u-weg', 'u-later', 'u-toen', 'u-leeg')));
select proef.zeker('uitstappen: een uitstap zonder één afwezige',
  proef.lees(proef.uitstap('u-vast', '2026-01-10T10:00:00Z', proef.d(40), array['4A'])) @> '{"nieuw": 1}'::jsonb);
select proef.zeker('uitstappen: haar klas wordt bevestigd', proef.bevestig(proef.act('u-vast'), proef.id(101)) ->> 'stand' = 'bevestigd');
select proef.zeker('uitstappen: ook zonder afwezigheden wacht een andere datum na een bevestiging (B67)',
  proef.lees(proef.uitstap('u-vast', '2026-01-11T10:00:00Z', proef.d(41), array['4A'])) @> '{"wacht": ["u-vast"]}'::jsonb);
select proef.zeker('uitstappen: de datum van toen blijft',
  (select datum_start = proef.d(40) and bron_gewijzigd_op = '2026-01-10T10:00:00Z'::timestamptz from public.activiteiten where id = proef.act('u-vast')));

select proef.aangemeld(proef.id(3));
select proef.zeker('uitstappen: de browser meldt niets meer: een leerkracht bereikt de functie niet (B212)',
  proef.json(format('select public.mt_uitstappen_bijwerken(%L, null)', '[]'::jsonb)) ->> 'fout' = '42501'
  and proef.json(format('select mt_intern.uitstappen_bijwerken(%L, null)', '[]'::jsonb)) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1));
select proef.zeker('uitstappen: ook een beheerder niet (B212)',
  proef.json(format('select public.mt_uitstappen_bijwerken(%L, null)', '[]'::jsonb)) ->> 'fout' = '42501'
  and proef.json(format('select mt_intern.uitstappen_bijwerken(%L, null)', '[]'::jsonb)) ->> 'fout' = '42501');
select proef.zeker('uitstappen: een lege uitstappentool is een fout, geen resultaat (17.3)',
  proef.srv(format('select public.mt_uitstappen_bijwerken(%L, %L)', '[]'::jsonb, '{}'::text[])) ->> 'fout' = 'MT422');
select proef.zeker('uitstappen: wat de uitstappentool niet meer kent, is "niet gevonden"',
  proef.srv(format('select public.mt_uitstappen_bijwerken(%L, %L)', '[]'::jsonb, array['uproef301', 'u-n1', 'u-vast'])) ->> 'niet_gevonden' = '1');
select proef.zeker('uitstappen: enkel in een schooljaar dat open is, en met een taak als er iets aan hing',
  (select bron_stand = 'niet_gevonden' from public.activiteiten where id = proef.id(311))
  and (select bron_stand = 'actief' from public.activiteiten where id = proef.id(321))
  and (select bron_stand = 'actief' from public.activiteiten where id = proef.id(301))
  and (select count(*) = 1 from public.taken where activiteit_id = proef.id(311) and soort = 'uitstap_weg' and stand = 'open'));
select proef.zeker('uitstappen: omgezet naar een nascholing: zoals verwijderd (V21)',
  proef.lees(proef.uitstap('uproef301', '2026-02-01T10:00:00Z', proef.d(0), array['4A', '4B'], 'bevestigd', null, false, 'nascholing')) @> '{"weg": 1}'::jsonb);
select proef.zeker('uitstappen: de nascholing telt niet meer mee, met een melding',
  (select bron_stand = 'nascholing' from public.activiteiten where id = proef.id(301))
  and (select count(*) = 1 from public.taken
        where activiteit_id = proef.id(301) and soort = 'uitstap_weg' and stand = 'open' and gegevens ->> 'reden' = 'nascholing'));
select proef.zeker('uitstappen: beide staan er weer',
  proef.lees(proef.uitstap('uproef301', '2026-02-02T10:00:00Z', proef.d(0), array['4A', '4B'])) @> '{"gewijzigd": 1}'::jsonb
  and proef.lees(proef.uitstap('uproef311', '2026-02-02T10:00:00Z', make_date((select jaar from proef.c) - 1, 9, 1), array['3A'])) @> '{"gewijzigd": 1}'::jsonb);
select proef.zeker('uitstappen: de taken zijn afgehandeld als hersteld',
  (select count(*) = 2 and bool_and(afhandeling = 'hersteld') from public.taken
    where soort = 'uitstap_weg' and activiteit_id in (proef.id(301), proef.id(311))));

select proef.aangemeld(proef.id(3));
create table proef.telling as select proef.tel('select 1 from public.leerlingen') as n;
select proef.aangemeld(proef.id(1));
select proef.zeker('vorig schooljaar: een geannuleerde uitstap met een open lijst',
  proef.lees(proef.uitstap('u-oud', '2026-01-01T10:00:00Z', make_date((select jaar from proef.c) - 1, 10, 1), array['3A'], 'geannuleerd')) @> '{"nieuw": 1}'::jsonb);
select proef.aangemeld(proef.id(3));
select proef.zeker('vorig schooljaar: een open lijst van een geannuleerde uitstap houdt het niet open (B171)',
  proef.tel('select 1 from public.leerlingen') = (select n from proef.telling));
select proef.aangemeld(proef.id(1));
select proef.zeker('vorig schooljaar: de uitstap is toch bevestigd',
  proef.lees(proef.uitstap('u-oud', '2026-01-02T10:00:00Z', make_date((select jaar from proef.c) - 1, 10, 1), array['3A'])) @> '{"gewijzigd": 1}'::jsonb);
select proef.aangemeld(proef.id(3));
select proef.zeker('vorig schooljaar: een lijst die nog te doen is, wel: de leerkracht ziet haar leerlingen van toen',
  proef.tel('select 1 from public.leerlingen') = (select n + 2 from proef.telling));
select proef.zeker('vorig schooljaar: ze geeft de lijst in',
  proef.status(proef.act('u-oud'), proef.id(111), proef.id(208), 'Attest') ->> 'revisie' = '1');
select proef.zeker('vorig schooljaar: en bevestigt ze', proef.bevestig(proef.act('u-oud'), proef.id(111)) ->> 'stand' = 'bevestigd');
select proef.zeker('vorig schooljaar: daarna leest ze er niets meer van, en vraagt ze er geen wijziging meer aan (B171)',
  proef.tel('select 1 from public.leerlingen') = (select n from proef.telling)
  and proef.aanvraag(proef.act('u-oud'), proef.id(111), jsonb_build_array(
        proef.regel_status(proef.id(208), make_date((select jaar from proef.c) - 1, 10, 1), 'Aanwezig'))) ->> 'fout' = '42501');

-- ---------- 9. Meerdaagse uitstappen en de groep Andere (B109, B110, B112, B143) ----------

select proef.zeker('meerdaags: een GWP van drie dagen, nog aangevraagd',
  proef.lees(proef.uitstap('u-gwp', '2026-01-01T10:00:00Z', proef.d(50), array['4A'], 'aangevraagd', proef.d(52))) @> '{"nieuw": 1}'::jsonb);
select proef.zeker('deelname: uitvinken kan pas zodra de uitstap bevestigd is (B109)',
  proef.json(format('select public.mt_deelname_bewaren(%L, %L, %L, false)', proef.act('u-gwp'), proef.id(101), proef.id(202))) ->> 'fout' = 'MT422');
select proef.zeker('meerdaags: bevestigd in de uitstappentool',
  proef.lees(proef.uitstap('u-gwp', '2026-01-02T10:00:00Z', proef.d(50), array['4A'], 'bevestigd', proef.d(52))) @> '{"gewijzigd": 1}'::jsonb);
select proef.zeker('deelname: de leerkracht vinkt uit wie niet meegaat',
  proef.json(format('select public.mt_deelname_bewaren(%L, %L, %L, false)', proef.act('u-gwp'), proef.id(101), proef.id(202))) ->> 'revisie' = '1');
select proef.zeker('deelname: wie niet deelneemt, krijgt geen status',
  proef.status(proef.act('u-gwp'), proef.id(101), proef.id(202), 'Attest') ->> 'fout' = 'MT422');
select proef.zeker('status: meerdere dagen van één leerling in één keer, met één revisie ("Op alle dagen", B133)',
  proef.json(format('select public.mt_status_bewaren(%L, %L, %L, %L)', proef.act('u-gwp'), proef.id(101), proef.id(201),
    (select jsonb_agg(jsonb_build_object('dag', proef.d(50 + n), 'status', proef.st('Attest'))) from generate_series(0, 2) n)))
    @> '{"revisie": 2, "gewijzigd": 3}'::jsonb);
select proef.zeker('meerdaags: de leerkracht bevestigt na de laatste dag',
  proef.bevestig(proef.act('u-gwp'), proef.id(101)) @> '{"leerlingen": 3}'::jsonb);
select proef.zeker('meerdaags: het bewijs heeft per deelnemer een status per dag (B110); wie niet deelneemt, heeft er geen',
  (select count(*) = 6 from public.bevestiging_dagen bd join public.klaslijsten l on l.bevestiging_id = bd.bevestiging_id
    where l.activiteit_id = proef.act('u-gwp'))
  and (select not bl.neemt_deel from public.bevestiging_leerlingen bl join public.klaslijsten l on l.bevestiging_id = bl.bevestiging_id
        where l.activiteit_id = proef.act('u-gwp') and bl.leerling_id = proef.id(202)));
select proef.zeker('totalen: bij een meerdaagse telt elke deelnemer mee, ongeacht attesten (B112)',
  proef.totaal(proef.act('u-gwp'), proef.id(101), 'op_lijst') = 3 and proef.totaal(proef.act('u-gwp'), proef.id(101), 'deelnemers') = 2
  and proef.totaal(proef.act('u-gwp'), proef.id(101), 'aangerekend') = 2 and proef.totaal(proef.act('u-gwp'), proef.id(101), 'aanwezig') = 1);
select proef.zeker('aanvraag: ook de deelname wijzigt na de bevestiging via een aanvraag',
  proef.aanvraag(proef.act('u-gwp'), proef.id(101), jsonb_build_array(
    jsonb_build_object('leerling', proef.id(202), 'wat', 'deelname', 'deelname', true))) ->> 'regels' = '1');
select proef.aangemeld(proef.id(1));
select proef.zeker('goedkeuren: de deelname',
  proef.json(format('select public.mt_aanvraag_behandelen(%L, true)', proef.open_aanvraag(proef.act('u-gwp'), proef.id(101)))) ->> 'stand' = 'goedgekeurd');
select proef.zeker('goedkeuren: hij neemt weer deel', proef.totaal(proef.act('u-gwp'), proef.id(101), 'deelnemers') = 3);
select proef.zeker('deelname: de beheerder vinkt na de bevestiging rechtstreeks uit (B113)',
  proef.json(format('select public.mt_deelname_bewaren(%L, %L, %L, false, %L)', proef.act('u-gwp'), proef.id(101), proef.id(202), 'Bleef thuis')) ->> 'gewijzigd' = '1');
select proef.zeker('deelname: met de wijziging en de reden erbij',
  (select count(*) = 2 and bool_or(reden = 'Bleef thuis' and gewijzigd_door = proef.id(1) and not nieuwe_deelname)
     from public.wijzigingen where activiteit_id = proef.act('u-gwp') and leerling_id = proef.id(202) and wat = 'deelname'));

select proef.zeker('groep Andere: een uitstap voor LO en 4A, die nog moet komen',
  proef.lees(proef.uitstap('u-lo', '2026-01-01T10:00:00Z', proef.d(120), array['LO', '4A'])) @> '{"nieuw": 1}'::jsonb);
select proef.aangemeld(proef.id(3));
select proef.zeker('status: ingeven kan pas vanaf de dag van de activiteit; bij een daguitstap bestaat uitvinken niet (B109)',
  proef.status(proef.act('u-lo'), proef.id(101), proef.id(201), 'Attest') ->> 'fout' = 'MT422'
  and proef.json(format('select public.mt_deelname_bewaren(%L, %L, %L, false)', proef.act('u-lo'), proef.id(101), proef.id(201))) ->> 'fout' = 'MT422');
select proef.zeker('bevestigen: pas vanaf de dag van de activiteit',
  proef.bevestig(proef.act('u-lo'), proef.id(101)) ->> 'fout' = 'MT422');
select proef.zet_vandaag(proef.d(120));
select proef.zeker('status: op de dag zelf kan het', proef.status(proef.act('u-lo'), proef.id(101), proef.id(201), 'Attest') ->> 'revisie' = '1');
select proef.aangemeld(proef.id(1));
select proef.zeker('groep Andere: zonder deelnemers kan de lijst niet bevestigd worden (B143)',
  proef.bevestig(proef.act('u-lo'), proef.id(106)) ->> 'fout' = 'MT422');
select proef.zeker('groep Andere: de beheerder stelt de deelnemers samen',
  proef.fout(format('insert into public.deelnemers (activiteit_id, leerling_id, klas_id, schooljaar) values (%L, %L, %L, %L)',
    proef.act('u-lo'), proef.id(204), proef.id(106), (select sj0 from proef.c)), 'authenticated', true) = 'geen fout, 1 rijen');
select proef.zeker('groep Andere: wie al met zijn eigen klas meegaat, kan er niet nog eens bij',
  proef.fout(format('insert into public.deelnemers (activiteit_id, leerling_id, klas_id, schooljaar) values (%L, %L, %L, %L)',
    proef.act('u-lo'), proef.id(201), proef.id(106), (select sj0 from proef.c))) like 'MT422%');
select proef.zeker('groep Andere: elke wijziging aan de deelnemers verhoogt de revisie, en de lijst telt wie erop staat',
  proef.rev(proef.act('u-lo'), proef.id(106)) = 1 and proef.totaal(proef.act('u-lo'), proef.id(106), 'op_lijst') = 1);
select proef.zeker('groep Andere: bevestigen kan nu', proef.bevestig(proef.act('u-lo'), proef.id(106)) @> '{"leerlingen": 1}'::jsonb);
select proef.zet_vandaag(proef.d(100));

-- ---------- 10. Lopende activiteiten (6, B36, B149, B176, B196) ----------

select proef.aangemeld(proef.id(3));
select proef.zeker('lopende activiteit: een leerkracht vraagt ze aan voor haar eigen klas (B36)',
  proef.json(format('select public.mt_lopende_activiteiten_aanmaken(%L)', jsonb_build_array(jsonb_build_object(
    'id', proef.id(450), 'schooljaar', (select sj0 from proef.c), 'naam', 'Schaatsen 4A', 'klassen', jsonb_build_array(proef.id(101)),
    'data', jsonb_build_array(proef.d(80), proef.d(87)), 'planning', '{"ritme": "wekelijks"}'::jsonb,
    'kostenregels', jsonb_build_array(jsonb_build_object('omschrijving', 'Toegang', 'verdeling', 'per_kind', 'onderdeel', 'activiteit', 'bedrag_cent', 450))))))
    @> '{"gemaakt": 1, "stand": "aangevraagd", "beurten": 0}'::jsonb);
select proef.zeker('lopende activiteit: aangevraagd, met wie en met de gevraagde data, nog zonder beurten',
  (select stand = 'aangevraagd' and aangevraagd_door = proef.id(3) and jsonb_array_length(planning -> 'data') = 2 and planning ->> 'ritme' = 'wekelijks'
     from public.lopende_activiteiten where id = proef.id(450))
  and not exists (select 1 from public.activiteiten where lopende_activiteit_id = proef.id(450))
  and (select t.bedrag_cent = 450 from public.tarieven t join public.kostenregels k on k.id = t.kostenregel_id where k.lopende_activiteit_id = proef.id(450)));
select proef.zeker('lopende activiteit: dezelfde aanvraag nog eens maakt niets dubbel; voor een andere klas of zelf bevestigen kan ze niet',
  proef.json(format('select public.mt_lopende_activiteiten_aanmaken(%L)', jsonb_build_array(jsonb_build_object(
    'id', proef.id(450), 'schooljaar', (select sj0 from proef.c), 'naam', 'Schaatsen 4A', 'klassen', jsonb_build_array(proef.id(101)))))) @> '{"gemaakt": 0, "bestond_al": 1}'::jsonb
  and proef.json(format('select public.mt_lopende_activiteiten_aanmaken(%L)', jsonb_build_array(jsonb_build_object(
    'id', proef.id(452), 'schooljaar', (select sj0 from proef.c), 'naam', 'Schaatsen', 'klassen', jsonb_build_array(proef.id(102)))))) ->> 'fout' = '42501'
  and proef.json(format('select public.mt_lopende_activiteit_behandelen(%L, true)', proef.id(450))) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1));
select proef.zeker('lopende activiteit: de beheerder bevestigt, en de beurten komen erbij',
  proef.json(format('select public.mt_lopende_activiteit_behandelen(%L, true)', proef.id(450))) @> '{"stand": "bevestigd", "beurten": 2}'::jsonb);
select proef.zeker('lopende activiteit: elke beurt heeft een lijst per klas; twee keer behandelen kan niet',
  (select count(*) = 2 from public.klaslijsten l join public.activiteiten a on a.id = l.activiteit_id
    where a.lopende_activiteit_id = proef.id(450) and l.klas_id = proef.id(101))
  and proef.json(format('select public.mt_lopende_activiteit_behandelen(%L, false)', proef.id(450))) ->> 'fout' = 'MT409');
select proef.zeker('lopende activiteit: de beheerder maakt er zelf een, meteen met haar beurten',
  proef.json(format('select public.mt_lopende_activiteiten_aanmaken(%L)', jsonb_build_array(jsonb_build_object(
    'id', proef.id(451), 'schooljaar', (select sj0 from proef.c), 'naam', 'Zwemmen 4B', 'zwemmen', true, 'klassen', jsonb_build_array(proef.id(102)),
    'data', jsonb_build_array(proef.d(10), proef.d(17)))))) @> '{"gemaakt": 1, "stand": "bevestigd", "beurten": 2}'::jsonb);
select proef.zeker('lopende activiteit: zonder naam, of voor een klas uit de groep Andere, kan niet',
  proef.json(format('select public.mt_lopende_activiteiten_aanmaken(%L)', jsonb_build_array(jsonb_build_object(
    'schooljaar', (select sj0 from proef.c), 'naam', ' ', 'klassen', jsonb_build_array(proef.id(101)))))) ->> 'fout' = 'MT422'
  and proef.json(format('select public.mt_lopende_activiteiten_aanmaken(%L)', jsonb_build_array(jsonb_build_object(
    'schooljaar', (select sj0 from proef.c), 'naam', 'LO', 'klassen', jsonb_build_array(proef.id(106)))))) ->> 'fout' = 'MT422');
select proef.zeker('beurten: erbij en verplaatsen (B196)',
  proef.json(format('select public.mt_beurten_plannen(%L, %L, null, %L)', proef.id(450), array[proef.d(94)],
    jsonb_build_array(jsonb_build_object('van', proef.d(87), 'naar', proef.d(88))))) @> '{"erbij": 1, "verplaatst": 1}'::jsonb);
select proef.zeker('beurten: de data kloppen',
  (select array_agg(datum_start order by datum_start) = array[proef.d(80), proef.d(88), proef.d(94)]
     from public.activiteiten where lopende_activiteit_id = proef.id(450)));
select proef.zeker('beurten: een lege beurt kan weg',
  proef.json(format('select public.mt_beurten_plannen(%L, null, %L)', proef.id(450), array[proef.d(94)])) @> '{"weg": 1}'::jsonb);
select proef.aangemeld(proef.id(3));
select proef.zeker('beurten: plannen kan een leerkracht niet',
  proef.json(format('select public.mt_beurten_plannen(%L, %L)', proef.id(450), array[proef.d(95)])) ->> 'fout' = '42501');
select proef.zeker('beurt: een afwezigheid bij een zwembeurt',
  proef.status(proef.id(332), proef.id(101), proef.id(201), 'Briefje ouders') ->> 'revisie' = '1');
select proef.aangemeld(proef.id(1));
select proef.zeker('beurten: een beurt waar al iets aan hangt, kan niet weg',
  proef.json(format('select public.mt_beurten_plannen(%L, null, %L)', proef.id(401), array[proef.d(14)])) ->> 'fout' = 'MT422');
select proef.aangemeld(proef.id(4));
select proef.zeker('ging niet door: enkel wie de beurt mag ingeven',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L)', proef.id(332), 'organisator')) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(3));
select proef.zeker('ging niet door: de leerkracht duidt aan dat het zwembad annuleerde (B176)',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L)', proef.id(332), 'organisator'))
    @> '{"ging_niet_door": "organisator", "kosten_te_bekijken": false}'::jsonb);
select proef.zeker('ging niet door: de kosten vult enkel de beheerder in; een uitstap is geen beurt',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L, 100, 100)', proef.id(332), 'school')) ->> 'fout' = '42501'
  and proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L)', proef.id(301), 'organisator')) ->> 'fout' = '42501');
select proef.zeker('ging niet door: een status die aangerekend wordt, kan niet meer (B149)',
  proef.status(proef.id(332), proef.id(101), proef.id(202), 'Ongewettigd afwezig') ->> 'fout' = 'MT422');
select proef.zeker('ging niet door: een attest kan nog',
  proef.status(proef.id(332), proef.id(101), proef.id(202), 'Attest') ->> 'revisie' = '3');
select proef.zeker('ging niet door: de school ging niet: tot de beheerder de kosten invult, staat er "kosten te bekijken"',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L)', proef.id(332), 'school'))
    @> '{"ging_niet_door": "school", "kosten_te_bekijken": true}'::jsonb);
select proef.aangemeld(proef.id(1));
select proef.zeker('ging niet door: de beheerder vult de kosten in, ook 0 kan',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L, 5000, 0)', proef.id(332), 'school')) @> '{"kosten_te_bekijken": false}'::jsonb);
select proef.aangemeld(proef.id(3));
select proef.zeker('ging niet door: duidt de leerkracht het opnieuw aan, dan blijven de kosten van de beheerder staan',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L)', proef.id(332), 'school')) @> '{"kosten_te_bekijken": false}'::jsonb);
select proef.zeker('ging niet door: de leerkracht bevestigt de beurt zoals altijd',
  proef.bevestig(proef.id(332), proef.id(101)) ->> 'stand' = 'bevestigd');
select proef.zeker('ging niet door: de kosten en wat aangeduid was, staan in het bewijs',
  (select ging_niet_door = 'school' and niet_door_activiteit_cent = 5000 and niet_door_vervoer_cent = 0 from public.activiteiten where id = proef.id(332))
  and (select string_agg(s.naam, ',' order by bd.leerling_id) = 'Briefje ouders,Attest'
         from public.bevestiging_dagen bd join public.klaslijsten l on l.bevestiging_id = bd.bevestiging_id
         join public.statussen s on s.id = bd.status_id
        where l.activiteit_id = proef.id(332) and bd.leerling_id in (proef.id(201), proef.id(202))));
select proef.zeker('ging niet door: na de bevestiging wijzigt dat niet meer zonder heropenen',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, null)', proef.id(332))) ->> 'fout' = 'MT422'
  and proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L)', proef.id(331), 'organisator')) ->> 'fout' = 'MT422');

-- Een beurt die niet doorging, en de kosten van de beheerder (B213, O4).
insert into public.activiteiten (id, schooljaar, soort, lopende_activiteit_id, datum_start, datum_eind)
select proef.id(9601), sj0, 'beurt', proef.id(401), proef.d(77), proef.d(77) from proef.c;
insert into public.klaslijsten (activiteit_id, klas_id, schooljaar) select proef.id(9601), proef.id(101), sj0 from proef.c;
select proef.aangemeld(proef.id(3));
select proef.zeker('beurt: de leerkracht duidt aan dat de school niet ging; de kosten zijn nog te bekijken',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L)', proef.id(9601), 'school')) @> '{"ging_niet_door": "school", "kosten_te_bekijken": true}'::jsonb);
select proef.aangemeld(proef.id(1));
select proef.zeker('beurt: de beheerder vult de kosten in',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L, 5000, 1200)', proef.id(9601), 'school')) @> '{"kosten_te_bekijken": false}'::jsonb);
select proef.aangemeld(proef.id(3));
select proef.zeker('beurt: daarna wijzigt een leerkracht de beurt niet meer (B213, O4)',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, null)', proef.id(9601))) ->> 'fout' = 'MT422'
  and proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L)', proef.id(9601), 'organisator')) ->> 'fout' = 'MT422');
select proef.zeker('beurt: dezelfde stand opnieuw melden mag, en wijzigt niets',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, %L)', proef.id(9601), 'school')) @> '{"ging_niet_door": "school", "kosten_te_bekijken": false}'::jsonb);
select proef.zeker('beurt: de kosten van de beheerder staan er nog',
  (select ging_niet_door = 'school' and niet_door_activiteit_cent = 5000 and niet_door_vervoer_cent = 1200 from public.activiteiten where id = proef.id(9601)));
select proef.aangemeld(proef.id(1));
select proef.zeker('beurt: de beheerder zelf zet ze terug op "ging toch door"',
  proef.json(format('select public.mt_beurt_ging_niet_door(%L, null)', proef.id(9601))) @> '{"kosten_te_bekijken": false}'::jsonb);
select proef.zeker('beurt: dan zijn de kosten weg, en kan de leerkracht weer aanduiden',
  (select ging_niet_door is null and niet_door_activiteit_cent is null from public.activiteiten where id = proef.id(9601)));
delete from public.klaslijsten where activiteit_id = proef.id(9601);
delete from public.activiteiten where id = proef.id(9601);
select proef.aangemeld(proef.id(3));

-- ---------- 11. Lezen, klassen en het schooljaar (T6, B144, B158, B169) ----------

select proef.zeker('namen: elke gebruiker leest de namen van de gebruikers, zonder e-mail of rol',
  (select jsonb_array_length(x.j) = 9 and (x.j -> 0) ?& array['id', 'naam'] and not (x.j -> 0) ?| array['email', 'rol']
     from (select proef.json('select public.mt_gebruikers_namen()') as j) x));
select proef.zeker('voorkeuren: elke gebruiker bewaart de zijne',
  proef.json(format('select public.mt_voorkeuren_bewaren(%L)', '{"soort": "scherp", "filter": "actie"}'::jsonb)) ->> 'filter' = 'actie');
select proef.zeker('voorkeuren: en vervangt ze',
  proef.json(format('select public.mt_voorkeuren_bewaren(%L)', '{"soort": "minder_scherp"}'::jsonb)) ->> 'soort' = 'minder_scherp');
select proef.zeker('voorkeuren: één rij per gebruiker, enkel de eigen rij leesbaar; te groot of geen object wordt geweigerd',
  (select count(*) = 1 and bool_and(voorkeuren = '{"soort": "minder_scherp"}'::jsonb) from public.gebruiker_voorkeuren where gebruiker_id = proef.id(3))
  and proef.tel('select 1 from public.gebruiker_voorkeuren') = 1
  and proef.json(format('select public.mt_voorkeuren_bewaren(%L)', jsonb_build_object('x', repeat('a', 8000)))) ->> 'fout' = 'MT422'
  and proef.json(format('select public.mt_voorkeuren_bewaren(%L)', '[1]'::jsonb)) ->> 'fout' = 'MT422');
select proef.zeker('klassen: bijwerken kan enkel de beheerder',
  proef.json(format('select public.mt_klassen_bijwerken(%L)', proef.klassenlijst())) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(5));
select proef.zeker('voorkeuren: ook een lezer bewaart de zijne',
  proef.json(format('select public.mt_voorkeuren_bewaren(%L)', '{"schooljaar": "x"}'::jsonb)) ->> 'schooljaar' = 'x');
select proef.aangemeld(proef.id(1));
select proef.zeker('klassen: een lege klassenlijst wijzigt niets; de groep van een klas met leerlingen kan niet naar Andere',
  proef.json(format('select public.mt_klassen_bijwerken(%L)', '[]'::jsonb)) ->> 'fout' = 'MT422'
  and proef.json(format('select public.mt_klassen_bijwerken(%L)', proef.klassenlijst('4Y', 'Andere'))) ->> 'fout' = 'MT422');
select proef.zeker('klassen: een nieuwe klas, een nieuwe naam en een klas die uit de lijst verdween',
  proef.json(format('select public.mt_klassen_bijwerken(%L)', proef.klassenlijst())) @> '{"nieuw": 1, "uitgezet": 1}'::jsonb);
select proef.zeker('klassen: het leerjaar volgt uit de naam, de vroegere namen blijven, en niets wordt gewist (B158, B208)',
  (select leerjaar = 5 and groep = 'Lager' from public.klassen where schooljaar = (select sj0 from proef.c) and bron_id = 'bronh')
  and (select naam = '4Y' from public.klassen where id = proef.id(102))
  and (select count(*) = 3 from public.klas_namen where klas_id = proef.id(102))
  and (select not actief from public.klassen where id = proef.id(107))
  and (select naam = '3A' from public.klassen where id = proef.id(111)));
select proef.zeker('klassen: een uitstap met de nieuwe naam vindt haar klas',
  proef.lees(proef.uitstap('u-n2', '2026-01-01T10:00:00Z', proef.d(60), array['4Y', '5A'])) -> 'onbekende_klassen' = '[]'::jsonb);
select proef.zeker('klassen: met een lijst voor de hernoemde en voor de nieuwe klas',
  (select count(*) = 2 from public.klaslijsten l join public.klassen k on k.id = l.klas_id
    where l.activiteit_id = proef.act('u-n2') and k.bron_id in ('bronb', 'bronh')));

insert into public.schooljaren (schooljaar) select proef.nieuw_jaar();
select proef.zeker('schooljaar: bevestigen kan niet zonder plafonds en marges (B144)',
  proef.json(format('select public.mt_schooljaar_bevestigen(%L)', proef.nieuw_jaar())) ->> 'tekst' like '%plafonds%');
update public.schooljaren set plafond_kleuter_cent = 5500, plafond_lager_cent = 11000, marge_kleuter_cent = 200, marge_lager_cent = 400
 where schooljaar = proef.nieuw_jaar();
select proef.zeker('schooljaar: ten vroegste vanaf 1 juli (B169)',
  proef.json(format('select public.mt_schooljaar_bevestigen(%L)', proef.nieuw_jaar())) ->> 'tekst' like '%1 juli%');
select proef.zet_vandaag(make_date((select jaar from proef.c) + 1, 7, 1));
select proef.aangemeld(proef.id(3));
select proef.zeker('schooljaar: een leerkracht bevestigt geen schooljaar',
  proef.json(format('select public.mt_schooljaar_bevestigen(%L)', proef.nieuw_jaar())) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1));
select proef.zeker('schooljaar: vanaf 1 juli bevestigt de beheerder het, met de klassen erbij',
  proef.json(format('select public.mt_schooljaar_bevestigen(%L, %L)', proef.nieuw_jaar(), proef.klassenlijst())) ->> 'vorig' = (select sj0 from proef.c));
select proef.zeker('schooljaar: het nieuwe is lopend, het vorige voorbij maar nog open (B132), en de klassen staan er',
  (select stand = 'lopend' and lopend_sinds is not null from public.schooljaren where schooljaar = proef.nieuw_jaar())
  and (select stand = 'voorbij' from public.schooljaren where schooljaar = (select sj0 from proef.c))
  and (select count(*) = 7 from public.klassen where schooljaar = proef.nieuw_jaar()));
select proef.zeker('schooljaar: twee keer bevestigen kan niet',
  proef.json(format('select public.mt_schooljaar_bevestigen(%L)', proef.nieuw_jaar())) ->> 'fout' = 'MT409');
select proef.zeker('import: de eerste lijst van het nieuwe schooljaar',
  proef.leerlingen(proef.nieuw_jaar(), jsonb_build_array(
    jsonb_build_object('actie', 'inschrijven', 'stamnummer', '0000401', 'voornaam', 'Een', 'familienaam', 'Proef',
      'klas', (select id from public.klassen where schooljaar = proef.nieuw_jaar() and bron_id = 'brona'), 'klasnummer', 1,
      'van', make_date((select jaar from proef.c) + 1, 9, 1)),
    jsonb_build_object('actie', 'inschrijven', 'stamnummer', '0000201', 'voornaam', 'Leerling1', 'familienaam', 'Proef',
      'klas', (select id from public.klassen where schooljaar = proef.nieuw_jaar() and bron_id = 'bronh'), 'klasnummer', 1,
      'van', make_date((select jaar from proef.c) + 1, 9, 1))),
    '{"bestandsnaam": "juli.xlsx"}'::jsonb) ->> 'soort' = 'eerste_lijst');
select proef.zeker('import: opnieuw als eerste lijst vervangt ze, zolang er nog niets van afhangt (B174)',
  proef.leerlingen(proef.nieuw_jaar(), jsonb_build_array(
    jsonb_build_object('actie', 'inschrijven', 'stamnummer', '0000201', 'voornaam', 'Leerling1', 'familienaam', 'Proef',
      'klas', (select id from public.klassen where schooljaar = proef.nieuw_jaar() and bron_id = 'bronh'), 'klasnummer', 1,
      'van', make_date((select jaar from proef.c) + 1, 9, 1))),
    '{"bestandsnaam": "augustus.xlsx", "opnieuw": true}'::jsonb) ->> 'soort' = 'opnieuw_eerste_lijst');
select proef.zeker('import: wie enkel door de vervangen lijst bestond, is weg; wie al bestond, blijft',
  not exists (select 1 from public.leerlingen where stamnummer = '0000401')
  and (select count(*) = 1 from public.klasindelingen where schooljaar = proef.nieuw_jaar())
  and exists (select 1 from public.leerlingen where id = proef.id(201) and stamnummer = '0000201'));
select proef.aangemeld(proef.id(3));
select proef.zeker('vorig schooljaar: na de start van het nieuwe schooljaar geeft de leerkracht nog in wat openstaat (B171)',
  proef.status((select id from public.activiteiten where lopende_activiteit_id = proef.id(450) and datum_start = proef.d(80)),
               proef.id(101), proef.id(201), 'Attest') ->> 'revisie' = '1');
select proef.zeker('vorig schooljaar: een bevestigde lijst van toen raakt ze niet meer aan, en een lopende activiteit vraagt ze er niet meer aan',
  proef.aanvraag(proef.id(301), proef.id(101), jsonb_build_array(proef.regel_status(proef.id(201), proef.d(0), 'Attest'))) ->> 'fout' = '42501'
  and proef.json(format('select public.mt_lopende_activiteiten_aanmaken(%L)', jsonb_build_array(jsonb_build_object(
        'schooljaar', (select sj0 from proef.c), 'naam', 'Te laat', 'klassen', jsonb_build_array(proef.id(101)))))) ->> 'fout' = 'MT422');
select proef.zeker('logboek: wat via een functie gebeurt, staat erin met wie het deed',
  exists (select 1 from public.logboek where tabel = 'afwezigheden' and wie = proef.id(3) and databankrol = 'authenticated' and actie = 'toegevoegd')
  and exists (select 1 from public.logboek where tabel = 'bevestigingen' and wie = proef.id(3) and actie = 'toegevoegd')
  and exists (select 1 from public.logboek where tabel = 'taken' and wie = proef.id(1) and actie = 'gewijzigd' and nieuw ->> 'afhandeling' = 'was_mee'));
select proef.zet_vandaag(null);

-- ============================================================================================
-- De accounts van 004 (stap 2)
-- ============================================================================================
-- Wat de serverfunctie doet, loopt hier als de rol service_role, met haar eigen toegangsbewijs: zonder
-- gebruiker erin. Wat een beheerder doet, loopt als authenticated, via de doorgeefluiken.

create function proef.start(p_op integer, p_soort text, p_voor integer default null, p_gegevens jsonb default '{}') returns jsonb language sql as $$
  select proef.json(format('select public.mt_account_start(%L, %L, %L, %L)', proef.id(p_op), p_soort,
                           case when p_voor is null then null else proef.id(p_voor) end, p_gegevens))
$$;
create function proef.klaar(p_op integer, p_gelukt boolean, p_gegevens jsonb default '{}', p_melding text default null) returns jsonb language sql as $$
  select proef.srv(format('select public.mt_account_klaar(%L, %L, %L, %L)', proef.id(p_op), p_gelukt, p_gegevens, p_melding))
$$;
create function proef.eigen(p_op integer, p_gebruiker integer) returns jsonb language sql as $$
  select proef.srv(format('select public.mt_account_eigen_start(%L, %L, %L)', proef.id(p_op), 'wachtwoord_kiezen', proef.id(p_gebruiker)))
$$;
create function proef.stand(p_gebruiker integer) returns jsonb language sql as $$
  select proef.srv(format('select public.mt_account_stand(%L)', proef.id(p_gebruiker)))
$$;
-- Afronden: de sessie van die gebruiker kreeg net een code uit zijn app, tenzij p_met_code uit staat.
create function proef.rond(p_gebruiker integer, p_met_code boolean default true) returns jsonb language plpgsql as $$
begin
  if p_met_code then
    update auth.sessions s set aal = 'aal2', factor_id = proef.id(p_gebruiker) where s.id = proef.id(p_gebruiker);
  end if;
  return proef.srv(format('select public.mt_account_afgerond(%L, %L)', proef.id(p_gebruiker), proef.id(p_gebruiker)));
end $$;
create function proef.nk(p_bron text) returns uuid language sql stable as $$
  select id from public.klassen where schooljaar = proef.nieuw_jaar() and bron_id = p_bron
$$;
create function proef.revisie(p_gebruiker integer) returns bigint language sql stable as $$
  select revisie from public.gebruikers where id = proef.id(p_gebruiker)
$$;
create function proef.wijzig(p_gebruiker integer, p_naam text, p_rol text, p_revisie bigint default null) returns jsonb language sql as $$
  select proef.json(format('select public.mt_gebruiker_wijzigen(%L, %L, %L, %L)', proef.id(p_gebruiker), p_naam, p_rol,
                           coalesce(p_revisie, proef.revisie(p_gebruiker))))
$$;
create function proef.klassen(p_gebruiker integer, p_schooljaar text, p_klassen uuid[], p_revisie bigint default null) returns jsonb language sql as $$
  select proef.json(format('select public.mt_klassen_toewijzen(%L, %L, %L, %L)', proef.id(p_gebruiker), p_schooljaar, p_klassen,
                           coalesce(p_revisie, proef.revisie(p_gebruiker))))
$$;

-- Gebruikers: 11 de app opnieuw te koppelen, 12 een tijdelijk wachtwoord dat nog geldt, 13 een dat
-- verlopen is, 14 een lezer in orde, 15 enkel bij Supabase, 16 een tweede beheerder, 17 tot 19 een
-- tijdelijk wachtwoord dat nog geldt.
insert into auth.users (id, email) select proef.id(n), 'proef' || n || '@voorbeeld.test' from generate_series(11, 19) n;
insert into auth.sessions (id, user_id) select proef.id(n), proef.id(n) from generate_series(11, 19) n;
insert into auth.mfa_factors (id, user_id, factor_type, status) select proef.id(n), proef.id(n), 'totp', 'verified' from generate_series(11, 19) n;
insert into public.gebruikers (id, naam, email, rol, actief, wachtwoord_tijdelijk, tijdelijk_tot, eerste_aanmelding_afgerond, app_koppelen) values
  (proef.id(11), 'Proef App', 'proef11@voorbeeld.test', 'leerkracht', true, false, null, true, true),
  (proef.id(12), 'Proef Kiezer', 'proef12@voorbeeld.test', 'leerkracht', true, true, now() + interval '1 hour', false, true),
  (proef.id(13), 'Proef Verlopen', 'proef13@voorbeeld.test', 'leerkracht', true, true, now() - interval '1 minute', false, true),
  (proef.id(14), 'Proef Doel', 'proef14@voorbeeld.test', 'lezer', true, false, null, true, false),
  (proef.id(16), 'Proef Collega', 'proef16@voorbeeld.test', 'beheerder', true, false, null, true, false),
  (proef.id(17), 'Proef Hangt', 'proef17@voorbeeld.test', 'leerkracht', true, true, now() + interval '1 hour', false, true),
  (proef.id(18), 'Proef Mislukt', 'proef18@voorbeeld.test', 'leerkracht', true, true, now() + interval '1 hour', false, true),
  (proef.id(19), 'Proef Tempo', 'proef19@voorbeeld.test', 'leerkracht', true, true, now() + interval '1 hour', false, true);
update public.gebruikers set app_factor = id where eerste_aanmelding_afgerond and not app_koppelen and app_factor is null;

-- ---------- De tweestapsverificatie, strenger ----------

select proef.aangemeld(proef.id(3), p_amr => jsonb_build_array(
  jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now()))::bigint),
  jsonb_build_object('method', 'recovery', 'timestamp', floor(extract(epoch from now()))::bigint)));
select proef.zeker('tweestaps: een sessie uit een herstellink telt niet, ook niet met de code erbij', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), p_amr => jsonb_build_array(
  jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now()))::bigint),
  jsonb_build_object('method', 'magiclink', 'timestamp', floor(extract(epoch from now()))::bigint)));
select proef.zeker('tweestaps: een sessie uit een aanmeldlink telt niet', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3), p_amr => jsonb_build_array(
  jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now()))::bigint),
  jsonb_build_object('method', 'otp', 'timestamp', floor(extract(epoch from now()))::bigint)));
select proef.zeker('tweestaps: een sessie uit een code in een mail telt niet', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(3));
select proef.zeker('tweestaps: met het wachtwoord en de code wel', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 1);
select proef.aangemeld(proef.id(11));
select proef.zeker('tweestaps: zolang de app opnieuw te koppelen is, toont de databank niets', proef.tel('select 1 from public.schooljaren') = 0);
update public.gebruikers set app_koppelen = false, app_factor = id where id = proef.id(11);
select proef.zeker('tweestaps: na het koppelen wel', proef.tel('select 1 from public.schooljaren') > 0);
update public.gebruikers set eerste_aanmelding_afgerond = false where id = proef.id(11);
select proef.zeker('tweestaps: zonder afgeronde eerste aanmelding niets, ook met een gekoppelde app', proef.tel('select 1 from public.schooljaren') = 0);
update public.gebruikers set eerste_aanmelding_afgerond = true where id = proef.id(11);

-- ---------- Wie welke functie bereikt ----------

select proef.aangemeld(proef.id(1));
select proef.zeker('serverfuncties: niet voor een aangemelde gebruiker, ook geen beheerder',
  proef.json(format('select public.mt_account_stand(%L)', proef.id(1))) ->> 'fout' = '42501'
  and proef.json(format('select public.mt_account_klaar(%L, true)', proef.id(900))) ->> 'fout' = '42501'
  and proef.json(format('select public.mt_account_eigen_start(%L, %L, %L)', proef.id(901), 'wachtwoord_kiezen', proef.id(12))) ->> 'fout' = '42501'
  and proef.json(format('select public.mt_account_afgerond(%L, %L)', proef.id(12), proef.id(12))) ->> 'fout' = '42501'
  and proef.json(format('select mt_intern.account_afgerond(%L, %L)', proef.id(12), proef.id(12))) ->> 'fout' = '42501');
select proef.zeker('serverfuncties: niet voor anon',
  proef.json(format('select public.mt_account_stand(%L)', proef.id(1)), 'anon') ->> 'fout' = '42501'
  and proef.json(format('select public.mt_account_afgerond(%L, %L)', proef.id(12), proef.id(12)), 'anon') ->> 'fout' = '42501');
select proef.zeker('serverfuncties: de controle zelf weigert elke andere rol',
  proef.json(format('select mt_intern.account_stand(%L)', proef.id(12)), 'postgres') ->> 'fout' = '42501'
  and proef.json(format('select mt_intern.account_klaar(%L, true)', proef.id(900)), 'postgres') ->> 'fout' = '42501'
  and proef.json(format('select mt_intern.account_eigen_start(%L, %L, %L)', proef.id(901), 'wachtwoord_kiezen', proef.id(12)), 'postgres') ->> 'fout' = '42501'
  and proef.json(format('select mt_intern.account_afgerond(%L, %L)', proef.id(12), proef.id(12)), 'postgres') ->> 'fout' = '42501');
select proef.zeker('service_role: enkel de vijf functies; geen functie van de pagina en geen tabel',
  proef.srv('select public.mt_mijn_account()') ->> 'fout' = '42501'
  and proef.srv(format('select public.mt_account_start(%L, %L)', proef.id(902), 'aanmaken')) ->> 'fout' = '42501'
  and proef.srv(format('select public.mt_gebruiker_wijzigen(%L, %L, %L, 1)', proef.id(14), 'Nep', 'lezer')) ->> 'fout' = '42501'
  and proef.srv(format('select public.mt_klassen_toewijzen(%L, %L, %L, 1)', proef.id(3), proef.nieuw_jaar(), '{}')) ->> 'fout' = '42501'
  and proef.tel('select 1 from public.gebruikers', 'service_role') = -1
  and proef.tel('select 1 from public.account_operaties', 'service_role') = -1);
select proef.zeker('functies: na 004 klopt de controle op alle functies nog', mt_intern.controleer_functies() is null, mt_intern.controleer_functies());

-- ---------- De stand van het eigen account ----------

select proef.zeker('stand: een account dat de MT niet kent', proef.stand(15) ->> 'bekend' = 'false' and proef.stand(15) -> 'account' is null);
select proef.zeker('stand: een tijdelijk wachtwoord dat nog geldt, met de instellingen om aan te melden',
  (select j -> 'account' ->> 'wachtwoord_tijdelijk' = 'true' and j -> 'account' ->> 'tijdelijk_verlopen' = 'false'
          and j -> 'account' ->> 'app_koppelen' = 'true' and j -> 'account' ->> 'bezig' = 'false' and j -> 'account' ->> 'rol' = 'leerkracht'
          and j -> 'account' ->> 'actief' = 'true' and j -> 'account' ->> 'naam' = 'Proef Kiezer'
          and j -> 'instellingen' ->> 'afmelden_na_minuten' = '30' and j -> 'instellingen' ->> 'wachtwoord_min_lengte' = '12'
          and j -> 'instellingen' ->> 'code_geldig_dagen' = '14' and j -> 'instellingen' ->> 'tijdelijk_wachtwoord_uren' = '48'
          and j -> 'instellingen' ->> 'aangemeld_blijven' = 'true'
     from (select proef.stand(12) as j) x));
select proef.zeker('stand: een verlopen tijdelijk wachtwoord', proef.stand(13) -> 'account' ->> 'tijdelijk_verlopen' = 'true');
update public.instellingen set aangemeld_blijven_leerkracht = false;
select proef.zeker('stand: aangemeld blijven volgt de rol (B148)',
  proef.stand(12) -> 'instellingen' ->> 'aangemeld_blijven' = 'false' and proef.stand(14) -> 'instellingen' ->> 'aangemeld_blijven' = 'true');
update public.instellingen set aangemeld_blijven_leerkracht = true;

-- ---------- Een eigen wachtwoord kiezen (17.4, T5) ----------

select proef.zeker('eigen wachtwoord: niet na de termijn, met de tijd van de databank',
  proef.eigen(910, 13) ->> 'fout' = 'MT422' and proef.eigen(910, 13) ->> 'tekst' like '%verlopen%');
select proef.zeker('eigen wachtwoord: enkel bij een tijdelijk wachtwoord', proef.eigen(911, 14) ->> 'tekst' like '%geen tijdelijk wachtwoord%');
select proef.zeker('eigen wachtwoord: niet voor een uitgeschakeld of een onbekend account',
  proef.eigen(912, 7) ->> 'tekst' like '%uitgeschakeld%' and proef.eigen(913, 15) ->> 'fout' = '42501');
select proef.zeker('eigen wachtwoord: een andere eigen handeling bestaat niet',
  proef.srv(format('select public.mt_account_eigen_start(%L, %L, %L)', proef.id(914), 'uitschakelen', proef.id(12))) ->> 'fout' = '22023');
select proef.zeker('eigen wachtwoord: de start geeft het e-mailadres en de minimumlengte',
  (select j ->> 'email' = 'proef12@voorbeeld.test' and j ->> 'wachtwoord_min_lengte' = '12' from (select proef.eigen(920, 12) as j) x));
select proef.zeker('eigen wachtwoord: tijdens de handeling is het account geblokkeerd, met de beginstand bewaard',
  (select open_operatie = proef.id(920) from public.gebruikers where id = proef.id(12))
  and (select soort = 'wachtwoord_kiezen' and door = proef.id(12) and voor = proef.id(12) and afgerond_op is null
              and beginstand -> 'account' ->> 'wachtwoord_tijdelijk' = 'true'
         from public.account_operaties where id = proef.id(920)));
select proef.zeker('eigen wachtwoord: geen tweede handeling terwijl er een loopt', proef.eigen(921, 12) ->> 'fout' = 'MT409');
select proef.zeker('eigen wachtwoord: de stand meldt dat er een handeling loopt', proef.stand(12) -> 'account' ->> 'bezig' = 'true');
select proef.zeker('eigen wachtwoord: afronden', proef.klaar(920, true) ->> 'ok' = 'true');
select proef.zeker('eigen wachtwoord: niet meer tijdelijk, zonder termijn, niet meer geblokkeerd',
  (select not wachtwoord_tijdelijk and tijdelijk_tot is null and open_operatie is null and not eerste_aanmelding_afgerond and app_koppelen
     from public.gebruikers where id = proef.id(12))
  and (select resultaat = 'gelukt' and afgerond_op is not null and eindstand -> 'account' ->> 'wachtwoord_tijdelijk' = 'false'
         from public.account_operaties where id = proef.id(920)));
select proef.zeker('eigen wachtwoord: het einde herhalen geeft hetzelfde antwoord (I2)', proef.klaar(920, true) @> '{"ok": true, "herhaald": true}'::jsonb);
select proef.zeker('eigen wachtwoord: een andere uitkomst melden over een afgeronde handeling blijft een conflict', proef.klaar(920, false) ->> 'fout' = 'MT409');
select proef.zeker('afronden: een handeling die niet bestaat', proef.klaar(999, true) ->> 'fout' = '22023');

select proef.zeker('hangende handeling: de start', proef.eigen(930, 17) ->> 'email' is not null);
update public.account_operaties set begonnen_op = now() - interval '4 minutes' where id = proef.id(930);
select proef.zeker('hangende handeling: na drie minuten vervalt ze bij de volgende vraag naar de stand', proef.stand(17) -> 'account' ->> 'bezig' = 'false');
select proef.zeker('hangende handeling: mislukt in het register, en het account houdt zijn tijdelijke wachtwoord',
  (select resultaat = 'mislukt' and afgerond_op is not null from public.account_operaties where id = proef.id(930))
  and (select open_operatie is null and wachtwoord_tijdelijk from public.gebruikers where id = proef.id(17)));
select proef.zeker('hangende handeling: te laat afronden kan niet meer', proef.klaar(930, true) ->> 'fout' = 'MT409');
select proef.zeker('hangende handeling: opnieuw starten', proef.eigen(931, 17) ->> 'email' is not null);
update public.account_operaties set begonnen_op = now() - interval '4 minutes' where id = proef.id(931);
select proef.zeker('hangende handeling: ook een nieuwe start ruimt ze op', proef.eigen(932, 17) ->> 'email' is not null);
select proef.zeker('hangende handeling: de nieuwe blokkeert, de oude is mislukt',
  (select open_operatie = proef.id(932) from public.gebruikers where id = proef.id(17))
  and (select resultaat = 'mislukt' from public.account_operaties where id = proef.id(931)));

select proef.zeker('mislukt: de start', proef.eigen(940, 18) ->> 'email' is not null);
select proef.zeker('mislukt: de serverfunctie meldt dat het bij Supabase niet lukte',
  (select j ->> 'ok' = 'false' and j ->> 'geblokkeerd' = 'false' from (select proef.klaar(940, false, '{}', 'Supabase weigerde het wachtwoord.') as j) x));
select proef.zeker('mislukt: het account is niet meer geblokkeerd en houdt zijn stand, met de melding in het register',
  (select open_operatie is null and wachtwoord_tijdelijk from public.gebruikers where id = proef.id(18))
  and (select resultaat = 'mislukt' and melding = 'Supabase weigerde het wachtwoord.' from public.account_operaties where id = proef.id(940)));

do $$
begin
  for i in 1..10 loop
    perform proef.eigen(950 + i, 19);
    perform proef.klaar(950 + i, false);
  end loop;
end $$;
select proef.zeker('tempo: tien pogingen in tien minuten', (select count(*) = 10 from public.account_operaties where door = proef.id(19)));
select proef.zeker('tempo: de elfde wordt geweigerd', proef.eigen(961, 19) ->> 'fout' = 'MT429');
update public.account_operaties set begonnen_op = begonnen_op - interval '11 minutes' where door = proef.id(19);
select proef.zeker('tempo: na tien minuten kan het weer', proef.eigen(962, 19) ->> 'email' is not null);

-- ---------- De eerste aanmelding afronden ----------

select proef.zeker('afronden: niet met een tijdelijk wachtwoord, niet uitgeschakeld, niet onbekend',
  proef.rond(13) ->> 'tekst' like '%eigen wachtwoord%' and proef.rond(7) ->> 'tekst' like '%uitgeschakeld%' and proef.rond(15) ->> 'fout' = '42501');
select proef.aangemeld(proef.id(12));
select proef.zeker('afronden: vóór het afronden toont de databank niets, ook met een code', proef.tel('select 1 from public.schooljaren') = 0);
select proef.zeker('afronden: de eerste aanmelding en de koppeling', proef.rond(12) ->> 'al_afgerond' = 'false');
select proef.zeker('afronden: de stand, en de handeling in het register',
  (select eerste_aanmelding_afgerond and not app_koppelen from public.gebruikers where id = proef.id(12))
  and (select count(*) = 1 from public.account_operaties
        where soort = 'afronden' and voor = proef.id(12) and door = proef.id(12) and resultaat = 'gelukt'
          and beginstand -> 'account' ->> 'app_koppelen' = 'true' and eindstand -> 'account' ->> 'app_koppelen' = 'false'));
select proef.zeker('afronden: daarna toont de databank haar gegevens', proef.tel('select 1 from public.schooljaren') > 0);
select proef.zeker('afronden: herhalen wijzigt niets', proef.rond(12) ->> 'al_afgerond' = 'true');
select proef.zeker('afronden: geen tweede regel in het register', (select count(*) = 1 from public.account_operaties where soort = 'afronden' and voor = proef.id(12)));

-- ---------- Een account aanmaken (B25) ----------

select proef.aangemeld(proef.id(3));
select proef.zeker('accounts: een leerkracht start geen handeling',
  proef.start(1000, 'aanmaken', null, '{"naam": "Nep", "email": "nep@voorbeeld.test", "rol": "beheerder"}') ->> 'fout' = '42501');
select proef.aangemeld(proef.id(5));
select proef.zeker('accounts: een lezer ook niet',
  proef.start(1000, 'aanmaken', null, '{"naam": "Nep", "email": "nep@voorbeeld.test", "rol": "beheerder"}') ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1), 'aal1');
select proef.zeker('accounts: een beheerder zonder code ook niet',
  proef.start(1000, 'aanmaken', null, '{"naam": "Nep", "email": "nep@voorbeeld.test", "rol": "beheerder"}') ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1));
select proef.zeker('aanmaken: naam, e-mailadres en rol worden nagekeken',
  proef.start(1001, 'aanmaken', null, '{"naam": " ", "email": "a@voorbeeld.test", "rol": "lezer"}') ->> 'tekst' like '%naam%'
  and proef.start(1001, 'aanmaken', null, '{"naam": "A", "email": "geen adres", "rol": "lezer"}') ->> 'tekst' like '%geldig e-mailadres%'
  and proef.start(1001, 'aanmaken', null, '{"naam": "A", "email": "a@voorbeeld", "rol": "lezer"}') ->> 'tekst' like '%geldig e-mailadres%'
  and proef.start(1001, 'aanmaken', null, '{"naam": "A", "email": "a@voorbeeld.test", "rol": "directeur"}') ->> 'tekst' like '%kies een rol%'
  and proef.start(1001, 'aanmaken', null, '{"naam": "A", "email": " PROEF3@voorbeeld.test ", "rol": "lezer"}') ->> 'tekst' like '%bestaat al%');
select proef.zeker('accounts: een oproep die niet klopt',
  proef.start(1001, 'aanmaken', 14, '{"naam": "A", "email": "a@voorbeeld.test", "rol": "lezer"}') ->> 'fout' = '22023'
  and proef.start(1001, 'opruimen', 14) ->> 'fout' = '22023'
  and proef.start(1001, 'uitschakelen') ->> 'fout' = '22023');
select proef.zeker('aanmaken: de start zet het adres netjes',
  proef.start(1002, 'aanmaken', null, '{"naam": "  Proef Vijftien ", "email": " Proef15@Voorbeeld.TEST ", "rol": "leerkracht"}') ->> 'email' = 'proef15@voorbeeld.test');
select proef.zeker('aanmaken: het plan staat in de databank, op naam van de beheerder, met het losse account dat er bij Supabase al stond (I1)',
  (select door = proef.id(1) and voor is null and afgerond_op is null
          and beginstand -> 'plan' = jsonb_build_object('naam', 'Proef Vijftien', 'email', 'proef15@voorbeeld.test', 'rol', 'leerkracht', 'bestaand', proef.id(15))
     from public.account_operaties where id = proef.id(1002)));
select proef.zeker('aanmaken: hetzelfde operatienummer start geen tweede handeling',
  proef.start(1002, 'aanmaken', null, '{"naam": "Dubbel", "email": "dubbel@voorbeeld.test", "rol": "lezer"}') ->> 'fout' = 'MT409');
select proef.zeker('aanmaken: een ander account van Supabase dan gevraagd wordt geweigerd',
  proef.klaar(1002, true, jsonb_build_object('gebruiker', proef.id(14))) ->> 'tekst' like '%klopt niet%'
  and proef.klaar(1002, true) ->> 'tekst' like '%klopt niet%');
select proef.zeker('aanmaken: afronden met het account dat Supabase aanmaakte',
  proef.klaar(1002, true, jsonb_build_object('gebruiker', proef.id(15))) ->> 'gebruiker' = proef.id(15)::text);
select proef.zeker('aanmaken: de gebruiker, met een tijdelijk wachtwoord van 48 uur en de app nog te koppelen',
  (select naam = 'Proef Vijftien' and email = 'proef15@voorbeeld.test' and rol = 'leerkracht' and actief and wachtwoord_tijdelijk
          and tijdelijk_tot between now() + interval '47 hours' and now() + interval '49 hours'
          and not eerste_aanmelding_afgerond and app_koppelen and open_operatie is null and aangemaakt_door = proef.id(1)
     from public.gebruikers where id = proef.id(15))
  and (select voor = proef.id(15) and resultaat = 'gelukt' and eindstand -> 'account' ->> 'rol' = 'leerkracht'
         from public.account_operaties where id = proef.id(1002)));
select proef.zeker('aanmaken: een tweede start voor een ander adres',
  proef.start(1003, 'aanmaken', null, '{"naam": "Proef Weg", "email": "weg@voorbeeld.test", "rol": "lezer"}') ->> 'email' = 'weg@voorbeeld.test');
select proef.zeker('aanmaken: mislukt bij Supabase', proef.klaar(1003, false, '{}', 'Supabase gaf geen antwoord.') ->> 'geblokkeerd' = 'false');
select proef.zeker('aanmaken: dan is er geen gebruiker, en staat de mislukking in het register',
  not exists (select 1 from public.gebruikers where email = 'weg@voorbeeld.test')
  and (select resultaat = 'mislukt' and voor is null and melding = 'Supabase gaf geen antwoord.' from public.account_operaties where id = proef.id(1003)));

-- ---------- Een nieuw tijdelijk wachtwoord, en de app opnieuw koppelen ----------

select proef.aangemeld(proef.id(14));
select proef.zeker('tijdelijk wachtwoord: vooraf leest de lezer', proef.tel('select 1 from public.schooljaren') > 0);
select proef.aangemeld(proef.id(1));
select proef.zeker('tijdelijk wachtwoord: niet op het eigen account, niet op een onbekend of een uitgeschakeld account',
  proef.start(1010, 'tijdelijk_wachtwoord', 1) ->> 'tekst' like '%eigen account%'
  and proef.start(1010, 'tijdelijk_wachtwoord', 8) ->> 'tekst' like '%bestaat niet%'
  and proef.start(1010, 'tijdelijk_wachtwoord', 7) ->> 'tekst' like '%uitgeschakeld%');
select proef.zeker('tijdelijk wachtwoord: de start geeft het e-mailadres en de termijn',
  (select j ->> 'email' = 'proef14@voorbeeld.test' and j ->> 'uren' = '48' and j ->> 'app_wissen' = 'false' and j ->> 'gebruiker' = proef.id(14)::text
     from (select proef.start(1010, 'tijdelijk_wachtwoord', 14) as j) x));
select proef.aangemeld(proef.id(14));
select proef.zeker('tijdelijk wachtwoord: de toegang is meteen geblokkeerd, vóór er iets bij Supabase wijzigt (T5)',
  proef.tel('select 1 from public.schooljaren') = 0);
select proef.zeker('afronden: niet terwijl er een handeling loopt', proef.rond(14) ->> 'fout' = 'MT409');
select proef.aangemeld(proef.id(1));
select proef.zeker('tijdelijk wachtwoord: geen tweede handeling terwijl de eerste loopt', proef.start(1011, 'tijdelijk_wachtwoord', 14) ->> 'fout' = 'MT409');
select proef.zeker('tijdelijk wachtwoord: afronden', proef.klaar(1010, true) ->> 'ok' = 'true');
select proef.zeker('tijdelijk wachtwoord: tijdelijk, met een termijn van 48 uur; de app blijft gekoppeld',
  (select wachtwoord_tijdelijk and tijdelijk_tot between now() + interval '47 hours' and now() + interval '49 hours'
          and not app_koppelen and open_operatie is null and eerste_aanmelding_afgerond
     from public.gebruikers where id = proef.id(14)));
select proef.aangemeld(proef.id(14));
select proef.zeker('tijdelijk wachtwoord: tot het eigen wachtwoord gekozen is, toont de databank niets', proef.tel('select 1 from public.schooljaren') = 0);
select proef.aangemeld(proef.id(1));
select proef.zeker('app opnieuw koppelen: de start', proef.start(1012, 'tijdelijk_wachtwoord', 14, '{"app_wissen": true}') ->> 'app_wissen' = 'true');
select proef.zeker('app opnieuw koppelen: afronden', proef.klaar(1012, true) ->> 'ok' = 'true');
select proef.zeker('app opnieuw koppelen: de koppeling staat op opnieuw te koppelen, met een nieuw tijdelijk wachtwoord',
  (select app_koppelen and wachtwoord_tijdelijk and open_operatie is null from public.gebruikers where id = proef.id(14)));

select proef.zeker('mislukte handeling: de start', proef.start(1013, 'tijdelijk_wachtwoord', 14) ->> 'gebruiker' is not null);
select proef.zeker('mislukte handeling: de serverfunctie meldt het', proef.klaar(1013, false, '{}', 'Supabase gaf een fout.') ->> 'geblokkeerd' = 'true');
select proef.zeker('mislukte handeling: het account blijft geblokkeerd tot een beheerder ze herhaalt (17.4)',
  (select open_operatie = proef.id(1013) from public.gebruikers where id = proef.id(14))
  and (select resultaat = 'mislukt' from public.account_operaties where id = proef.id(1013)));
select proef.zeker('mislukte handeling: ze alsnog als gelukt afronden kan niet', proef.klaar(1013, true) ->> 'fout' = 'MT409');
select proef.zeker('mislukte handeling: het account houdt zijn stand van voordien',
  (select open_operatie = proef.id(1013) and app_koppelen and wachtwoord_tijdelijk from public.gebruikers where id = proef.id(14)));
select proef.zeker('mislukte handeling: herhalen kan meteen', proef.start(1014, 'tijdelijk_wachtwoord', 14) ->> 'gebruiker' is not null);
update public.account_operaties set begonnen_op = now() - interval '4 minutes' where id = proef.id(1014);
select proef.zeker('hangende handeling van een beheerder: ze vervalt niet vanzelf', proef.stand(14) -> 'account' ->> 'bezig' = 'true');
select proef.zeker('hangende handeling van een beheerder: na drie minuten kan een nieuwe ze vervangen', proef.start(1015, 'tijdelijk_wachtwoord', 14) ->> 'gebruiker' is not null);
select proef.zeker('hangende handeling van een beheerder: hersteld in het register',
  (select resultaat = 'hersteld' and afgerond_op is not null from public.account_operaties where id = proef.id(1014)));
select proef.zeker('hangende handeling van een beheerder: de oude afronden kan niet meer', proef.klaar(1014, true) ->> 'fout' = 'MT409');
update public.gebruikers set open_operatie = null where id = proef.id(14);
select proef.zeker('afronden: enkel de handeling die het account blokkeert', proef.klaar(1015, true) ->> 'tekst' like '%vervangen door een nieuwe%');
update public.gebruikers set open_operatie = proef.id(1015) where id = proef.id(14);
select proef.zeker('hangende handeling van een beheerder: de nieuwe rondt af', proef.klaar(1015, true) ->> 'ok' = 'true');

-- ---------- Uitschakelen en weer inschakelen ----------

select proef.aangemeld(proef.id(4));
select proef.zeker('uitschakelen: vooraf werkt het account', proef.tel('select 1 from public.schooljaren') > 0);
select proef.aangemeld(proef.id(1));
select proef.zeker('inschakelen: niet voor een account dat actief is', proef.start(1020, 'inschakelen', 4) ->> 'tekst' like '%al actief%');
select proef.zeker('uitschakelen: de start', proef.start(1021, 'uitschakelen', 4) ->> 'gebruiker' = proef.id(4)::text);
select proef.zeker('uitschakelen: meteen niet meer actief, vóór de sessies ingetrokken zijn (T5)',
  (select not actief and open_operatie = proef.id(1021) from public.gebruikers where id = proef.id(4)));
select proef.zeker('uitschakelen: afronden', proef.klaar(1021, true) ->> 'ok' = 'true');
select proef.zeker('uitschakelen: uit, met een wachtwoord dat niet meer geldt',
  (select not actief and wachtwoord_tijdelijk and tijdelijk_tot <= now() and open_operatie is null from public.gebruikers where id = proef.id(4)));
select proef.aangemeld(proef.id(4));
select proef.zeker('uitschakelen: het account bereikt niets meer', proef.tel('select 1 from public.schooljaren') = 0);
select proef.aangemeld(proef.id(1));
select proef.zeker('inschakelen: de start laat het account nog uit', proef.start(1022, 'inschakelen', 4) ->> 'actief' = 'false');
select proef.zeker('inschakelen: nog niet actief tot Supabase klaar is', (select not actief from public.gebruikers where id = proef.id(4)));
select proef.zeker('inschakelen: afronden', proef.klaar(1022, true) ->> 'ok' = 'true');
select proef.zeker('inschakelen: actief, met een nieuw tijdelijk wachtwoord van 48 uur',
  (select actief and wachtwoord_tijdelijk and tijdelijk_tot > now() + interval '47 hours' and open_operatie is null
     from public.gebruikers where id = proef.id(4)));

insert into public.account_operaties (id, soort, door, afgerond_op, resultaat)
select gen_random_uuid(), 'aanmaken', proef.id(16), now(), 'mislukt' from generate_series(1, 120);
select proef.aangemeld(proef.id(16));
select proef.zeker('tempo: een beheerder start hoogstens 120 handelingen in tien minuten', proef.start(1030, 'tijdelijk_wachtwoord', 14) ->> 'fout' = 'MT429');
update public.account_operaties set begonnen_op = begonnen_op - interval '11 minutes' where door = proef.id(16);
select proef.zeker('tempo: daarna kan een beheerder weer verder', proef.start(1031, 'uitschakelen', 11) ->> 'gebruiker' is not null);
select proef.zeker('uitschakelen: een leerkracht, door de tweede beheerder', proef.klaar(1031, true) ->> 'ok' = 'true');
select proef.aangemeld(proef.id(1));
select proef.zeker('uitschakelen: een andere beheerder kan, want wie het vraagt blijft over', proef.start(1032, 'uitschakelen', 16) ->> 'gebruiker' is not null);
select proef.zeker('uitschakelen: de andere beheerder is uit', proef.klaar(1032, true) ->> 'ok' = 'true');

-- ---------- Een ander e-mailadres ----------

select proef.zeker('e-mailadres: geen ongeldig adres en geen adres dat al bestaat',
  proef.start(1040, 'email_wijzigen', 14, '{"email": "fout adres"}') ->> 'tekst' like '%geldig e-mailadres%'
  and proef.start(1040, 'email_wijzigen', 14, '{"email": "Proef3@voorbeeld.test"}') ->> 'tekst' like '%al een gebruiker met dit e-mailadres%'
  and proef.start(1040, 'email_wijzigen', 14, '{"email": "proef14@voorbeeld.test"}') ->> 'tekst' like '%is al het e-mailadres%');
select proef.zeker('e-mailadres: de start geeft het oude en het nieuwe adres',
  (select j ->> 'email' = 'proef14@voorbeeld.test' and j ->> 'email_nieuw' = 'nieuw14@voorbeeld.test'
     from (select proef.start(1041, 'email_wijzigen', 14, '{"email": " Nieuw14@Voorbeeld.test "}') as j) x));
select proef.zeker('e-mailadres: mislukt bij Supabase geeft het account weer vrij', proef.klaar(1041, false, '{}', 'Supabase weigerde het adres.') ->> 'geblokkeerd' = 'false');
select proef.zeker('e-mailadres: het oude adres staat er nog',
  (select email = 'proef14@voorbeeld.test' and open_operatie is null from public.gebruikers where id = proef.id(14)));
select proef.zeker('e-mailadres: een nieuwe poging', proef.start(1042, 'email_wijzigen', 14, '{"email": "nieuw14@voorbeeld.test"}') ->> 'email_nieuw' is not null);
select proef.zeker('e-mailadres: afronden', proef.klaar(1042, true) ->> 'ok' = 'true');
select proef.zeker('e-mailadres: het nieuwe adres', (select email = 'nieuw14@voorbeeld.test' and open_operatie is null from public.gebruikers where id = proef.id(14)));

-- ---------- Naam, rol en klassen (3, B126, B170) ----------

select proef.aangemeld(proef.id(3));
select proef.zeker('gebruiker wijzigen: enkel een beheerder',
  proef.wijzig(14, 'Proef Doel', 'beheerder') ->> 'fout' = '42501'
  and proef.klassen(3, proef.nieuw_jaar(), '{}') ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1));
select proef.zeker('gebruiker wijzigen: naam en rol worden nagekeken',
  proef.wijzig(14, '  ', 'lezer') ->> 'tekst' like '%naam%'
  and proef.wijzig(14, 'Proef Doel', 'directeur') ->> 'fout' = 'MT422'
  and proef.wijzig(8, 'Proef', 'lezer') ->> 'tekst' like '%bestaat niet%'
  and proef.wijzig(1, 'Proef Beheerder', 'lezer') ->> 'tekst' like '%eigen rol%');
select proef.zeker('gebruiker wijzigen: de eigen naam wel', proef.wijzig(1, ' Proef Beheerder Een ', 'beheerder') ->> 'naam' = 'Proef Beheerder Een');
select proef.zeker('gebruiker wijzigen: de naam en de rol van een ander', proef.wijzig(14, 'Proef Doelwit', 'leerkracht') ->> 'rol' = 'leerkracht');
select proef.zeker('gebruiker wijzigen: bewaard, met wie het deed',
  (select naam = 'Proef Doelwit' and rol = 'leerkracht' and bijgewerkt_door = proef.id(1) from public.gebruikers where id = proef.id(14))
  and exists (select 1 from public.logboek where tabel = 'gebruikers' and rij = proef.id(14)::text and wie = proef.id(1) and nieuw ->> 'rol' = 'leerkracht'));
select proef.zeker('klassen: twee klassen van het lopende schooljaar, elk één keer',
  jsonb_array_length(proef.klassen(14, proef.nieuw_jaar(), array[proef.nk('brona'), proef.nk('bronb'), proef.nk('brona')]) -> 'klassen') = 2);
select proef.zeker('klassen: bewaard, met wie het deed',
  (select count(*) = 2 and bool_and(aangemaakt_door = proef.id(1)) from public.klastoewijzingen
    where gebruiker_id = proef.id(14) and schooljaar = proef.nieuw_jaar()));
select proef.zeker('klassen: een nieuwe lijst', jsonb_array_length(proef.klassen(14, proef.nieuw_jaar(), array[proef.nk('bronb'), proef.nk('bronc')]) -> 'klassen') = 2);
select proef.zeker('klassen: de lijst vervangt wat er stond',
  (select count(*) = 2 and bool_and(klas_id in (proef.nk('bronb'), proef.nk('bronc'))) from public.klastoewijzingen
    where gebruiker_id = proef.id(14) and schooljaar = proef.nieuw_jaar()));
select proef.zeker('klassen: niet voor een lezer, niet met een klas van een ander schooljaar, niet in een afgesloten schooljaar',
  proef.klassen(5, proef.nieuw_jaar(), array[proef.nk('brona')]) ->> 'tekst' like '%enkel een leerkracht%'
  and proef.klassen(14, proef.nieuw_jaar(), array[proef.id(101)]) ->> 'fout' = 'MT422'
  and proef.klassen(14, (select sj2 from proef.c), array[proef.id(121)]) ->> 'fout' = 'MT422'
  and proef.klassen(14, '1999-2000', '{}') ->> 'fout' = '22023');
select proef.zeker('klassen: de leerkracht van 4A krijgt haar klas van het nieuwe schooljaar', proef.klassen(3, proef.nieuw_jaar(), array[proef.nk('brona')]) ->> 'gebruiker' = proef.id(3)::text);
select proef.zeker('klassen: haar klassen van de vorige schooljaren blijven staan', (select count(*) = 4 from public.klastoewijzingen where gebruiker_id = proef.id(3)));
select proef.aangemeld(proef.id(3));
select proef.zeker('mijn account: naam, rol, de klassen van het lopende schooljaar en wat de pagina nodig heeft om af te melden',
  (select j ->> 'naam' = 'Proef Vier A' and j ->> 'rol' = 'leerkracht' and j ->> 'email' = 'proef3@voorbeeld.test'
          and j ->> 'schooljaar' = proef.nieuw_jaar()
          and j -> 'klassen' = jsonb_build_array(jsonb_build_object('id', proef.nk('brona'), 'naam', '4A'))
          and j -> 'instellingen' ->> 'afmelden_na_minuten' = '30' and j -> 'instellingen' ->> 'code_geldig_dagen' = '14'
          and j -> 'instellingen' ->> 'aangemeld_blijven' = 'true'
     from (select proef.json('select public.mt_mijn_account()') as j) x), proef.json('select public.mt_mijn_account()')::text);
select proef.aangemeld(proef.id(3), 'aal1');
select proef.zeker('mijn account: niet zonder de code', proef.json('select public.mt_mijn_account()') ->> 'fout' = '42501');
select proef.aangemeld(proef.id(5));
select proef.zeker('mijn account: een lezer heeft geen klassen',
  (select j ->> 'rol' = 'lezer' and j -> 'klassen' = '[]'::jsonb from (select proef.json('select public.mt_mijn_account()') as j) x));
select proef.zeker('logboek: wat de serverfunctie afrondt, staat erin als service_role; de handeling zelf zegt wie het vroeg',
  exists (select 1 from public.logboek l where l.tabel = 'gebruikers' and l.rij = proef.id(15)::text and l.actie = 'toegevoegd'
             and l.databankrol = 'service_role' and l.wie is null)
  and exists (select 1 from public.logboek l where l.tabel = 'account_operaties' and l.rij = proef.id(1002)::text and l.actie = 'toegevoegd'
                 and l.wie = proef.id(1) and l.databankrol = 'authenticated'));

-- ============================================================================================
-- Review 1 (005): wat Astra en Opus 5.5 vonden, als controles (hoofdstuk 69 van het ontwerpdocument)
-- ============================================================================================
-- Gebruikers: 61 en 62 leerkrachten in orde, 63 een beheerder in orde; 64 tot 66 staan enkel bij Supabase.
insert into auth.users (id, email) select proef.id(n), 'her' || n || '@voorbeeld.test' from generate_series(61, 66) n;
insert into auth.sessions (id, user_id) select proef.id(n), proef.id(n) from generate_series(61, 66) n;
insert into auth.mfa_factors (id, user_id, factor_type, status) select proef.id(n), proef.id(n), 'totp', 'verified' from generate_series(61, 63) n;
insert into public.gebruikers (id, naam, email, rol, actief, wachtwoord_tijdelijk, tijdelijk_tot, eerste_aanmelding_afgerond, app_koppelen, app_factor) values
  (proef.id(61), 'Proef Reset', 'her61@voorbeeld.test', 'leerkracht', true, false, null, true, false, proef.id(61)),
  (proef.id(62), 'Proef Einde', 'her62@voorbeeld.test', 'leerkracht', true, false, null, true, false, proef.id(62)),
  (proef.id(63), 'Proef Derde', 'her63@voorbeeld.test', 'beheerder', true, false, null, true, false, proef.id(63));

-- ---------- De tweestapsverificatie leest de sessie in de databank (I8, O7) ----------

select proef.aangemeld(proef.id(63));
select proef.zeker('tweestaps (005): met het wachtwoord, een verse code en de app van het account: toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 1);
update auth.sessions set aal = 'aal1' where id = proef.id(63);
select proef.zeker('tweestaps (005): staat de sessie bij Supabase niet meer op twee stappen, dan geen toegang, wat het bewijs ook zegt (O7)',
  proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(63));
update auth.sessions set factor_id = proef.id(62) where id = proef.id(63);
select proef.zeker('tweestaps (005): een code uit een andere app dan die van het account telt niet (I8)', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(63));
update auth.sessions set factor_id = null where id = proef.id(63);
select proef.zeker('tweestaps (005): een sessie zonder app telt niet', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(63));
update auth.mfa_amr_claims set updated_at = now() - interval '15 days' where session_id = proef.id(63) and authentication_method = 'totp';
select proef.zeker('tweestaps (005): de tijd van de code komt uit de databank, niet uit het bewijs (O7)', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(63));
delete from auth.mfa_amr_claims where session_id = proef.id(63) and authentication_method = 'password';
select proef.zeker('tweestaps (005): zonder het wachtwoord als stap van de sessie: geen toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(63));
delete from auth.mfa_amr_claims where session_id = proef.id(63) and authentication_method = 'totp';
select proef.zeker('tweestaps (005): zonder de code als stap van de sessie: geen toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(63));
update public.gebruikers set app_factor = null where id = proef.id(63);
select proef.zeker('tweestaps (005): een account zonder app die telt: geen toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
update public.gebruikers set app_factor = id, herstel_app = true where id = proef.id(63);
select proef.zeker('tweestaps (005): zolang de app opnieuw moet: geen toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
update public.gebruikers set herstel_app = false, herstel_wachtwoord = true where id = proef.id(63);
select proef.zeker('tweestaps (005): zolang het wachtwoord opnieuw moet: geen toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
update public.gebruikers set herstel_wachtwoord = false, wachtwoord_tijdelijk = true where id = proef.id(63);
select proef.zeker('tweestaps (005): met een tijdelijk wachtwoord: geen toegang, ook met de app die telt', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
update public.gebruikers set wachtwoord_tijdelijk = false, app_koppelen = true where id = proef.id(63);
select proef.zeker('tweestaps (005): zolang de app opnieuw te koppelen is: geen toegang, ook als de vroegere app nog bekend is', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
update public.gebruikers set app_koppelen = false where id = proef.id(63);
select proef.zeker('tweestaps (005): alles weer in orde: toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 1);
select set_config('request.jwt.claims', (current_setting('request.jwt.claims')::jsonb || '{"aal": "aal1"}'::jsonb)::text, true);
select proef.zeker('tweestaps (005): een bewijs dat zelf maar één stap noemt, telt niet, ook al staat de sessie op twee stappen',
  proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(63), p_sessie => proef.id(62));
update auth.sessions set factor_id = proef.id(63) where id = proef.id(62);
select proef.zeker('tweestaps (005): de sessie van een ander account telt niet', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(62));

-- ---------- Een reset die begonnen is, blijft gelden tot hij gelukt is (B2) ----------

select proef.aangemeld(proef.id(61));
select proef.zeker('herstel: vooraf heeft het account toegang', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 1);
select proef.aangemeld(proef.id(1));
select proef.zeker('herstel: een reset met de app opnieuw start', proef.start(9801, 'tijdelijk_wachtwoord', 61, '{"app_wissen": true}') ->> 'app_wissen' = 'true');
select proef.zeker('herstel: Supabase antwoordt niet: mislukt, en het account blijft geblokkeerd',
  proef.klaar(9801, false, '{}', 'Supabase gaf geen antwoord.') @> '{"ok": false, "geblokkeerd": true}'::jsonb);
select proef.zeker('herstel: het account draagt het herstel zelf; aan zijn stand wijzigde nog niets',
  (select herstel_wachtwoord and herstel_app and not wachtwoord_tijdelijk and not app_koppelen and app_factor = proef.id(61)
     from public.gebruikers where id = proef.id(61)));
select proef.zeker('herstel: een e-mailwijziging start, en mislukt',
  proef.start(9802, 'email_wijzigen', 61, '{"email": "ander61@voorbeeld.test"}') ->> 'email_nieuw' = 'ander61@voorbeeld.test'
  and proef.klaar(9802, false, '{}', 'Supabase weigerde.') @> '{"ok": false, "geblokkeerd": false}'::jsonb);
select proef.aangemeld(proef.id(61));
select proef.zeker('herstel: na een mislukte e-mailwijziging blijft de oude sessie buiten (B2)', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.aangemeld(proef.id(1));
select proef.zeker('herstel: een e-mailwijziging die lukt',
  proef.start(9803, 'email_wijzigen', 61, '{"email": "ander61@voorbeeld.test"}') ? 'operatie' and proef.klaar(9803, true) ->> 'ok' = 'true');
select proef.aangemeld(proef.id(61));
select proef.zeker('herstel: ook dan blijft de oude sessie buiten (B2)', proef.tel('select 1 where mt_intern.mt_mfa_ok()') = 0);
select proef.zeker('herstel: de stand meldt dat er iets loopt, en zelf een wachtwoord kiezen of afronden kan niet',
  proef.stand(61) -> 'account' ->> 'bezig' = 'true' and proef.eigen(9804, 61) ->> 'fout' = 'MT409' and proef.rond(61) ->> 'fout' = 'MT409');
select proef.aangemeld(proef.id(1));
select proef.zeker('herstel: een nieuwe poging zonder "de app opnieuw" wordt toch met de app: enkel strenger (B2)',
  proef.start(9805, 'tijdelijk_wachtwoord', 61, '{}') ->> 'app_wissen' = 'true');
select proef.zeker('herstel: de poging lukt', proef.klaar(9805, true) ->> 'ok' = 'true');
select proef.zeker('herstel: een tijdelijk wachtwoord, de app opnieuw te koppelen, geen app die telt, en het herstel is rond',
  (select wachtwoord_tijdelijk and app_koppelen and app_factor is null and not herstel_wachtwoord and not herstel_app and open_operatie is null
     from public.gebruikers where id = proef.id(61)));
select proef.zeker('herstel: uitschakelen dat mislukt, blijft een herstel, ook na weer inschakelen dat mislukt',
  proef.start(9820, 'uitschakelen', 62) ? 'operatie' and proef.klaar(9820, false) @> '{"geblokkeerd": true}'::jsonb
  and proef.start(9821, 'inschakelen', 62, '{}') ? 'operatie' and proef.klaar(9821, false) @> '{"geblokkeerd": true}'::jsonb);
select proef.zeker('herstel: het account is uit, en draagt het herstel',
  (select not actief and herstel_wachtwoord and not herstel_app from public.gebruikers where id = proef.id(62)));
select proef.zeker('herstel: weer inschakelen dat lukt, rondt het af', proef.start(9822, 'inschakelen', 62, '{}') ? 'operatie' and proef.klaar(9822, true) ->> 'ok' = 'true');
select proef.zeker('herstel: actief, met een tijdelijk wachtwoord, en de app blijft die van het account',
  (select actief and wachtwoord_tijdelijk and not herstel_wachtwoord and not app_koppelen and app_factor = proef.id(62) from public.gebruikers where id = proef.id(62)));

-- ---------- Het einde is herhaalbaar (I2) ----------

create temp table h2 as select proef.start(9806, 'tijdelijk_wachtwoord', 62, '{}') as s;
alter table h2 add column a jsonb, add column b jsonb, add column c jsonb;
update h2 set a = proef.klaar(9806, true);
update h2 set b = proef.klaar(9806, true);
update h2 set c = proef.klaar(9806, false);
select proef.zeker('einde: hetzelfde einde herhalen geeft hetzelfde antwoord, met dezelfde termijn (I2)',
  (select a ->> 'ok' = 'true' and not a ? 'herhaald' and b @> '{"ok": true, "herhaald": true}'::jsonb and a ->> 'tijdelijk_tot' = b ->> 'tijdelijk_tot' from h2),
  (select a::text || ' ' || b::text from h2));
select proef.zeker('einde: een andere uitkomst melden over een afgeronde handeling blijft een conflict', (select c ->> 'fout' = 'MT409' from h2));

-- ---------- Een account aanmaken: één keer per adres, en nooit over een gebruiker heen (I1, O2) ----------

update auth.users set email = 'afwijkend4@voorbeeld.test' where id = proef.id(4);
select proef.zeker('aanmaken: een adres dat bij Supabase al van een gebruiker van de MT is, wordt bij de start geweigerd (O2)',
  proef.start(9810, 'aanmaken', null, '{"naam": "Nieuwe Lezer", "email": "afwijkend4@voorbeeld.test", "rol": "lezer"}') ->> 'fout' = 'MT422');
select proef.zeker('afwijkingen: de beheerder ziet welke accounts bij Supabase een ander adres hebben',
  (select j @> jsonb_build_array(proef.id(4)) and j @> jsonb_build_array(proef.id(61)) and not j @> jsonb_build_array(proef.id(1))
     from (select proef.json('select public.mt_account_afwijkingen()') as j) x));
select proef.aangemeld(proef.id(3));
select proef.zeker('afwijkingen: enkel voor een beheerder', proef.json('select public.mt_account_afwijkingen()') ->> 'fout' = '42501');
select proef.aangemeld(proef.id(1));
select proef.zeker('e-mailadres: hetzelfde adres opnieuw instellen kan als het bij Supabase afwijkt',
  proef.start(9816, 'email_wijzigen', 4, '{"email": "proef4@voorbeeld.test"}') ->> 'email_nieuw' = 'proef4@voorbeeld.test'
  and proef.klaar(9816, true) ->> 'ok' = 'true');
update auth.users set email = 'proef4@voorbeeld.test' where id = proef.id(4);
select proef.zeker('e-mailadres: een adres dat bij Supabase al van een ander account is, wordt bij de start geweigerd (O18)',
  proef.start(9815, 'email_wijzigen', 63, '{"email": "her65@voorbeeld.test"}') ->> 'tekst' like '%bij Supabase bestaat al%');
select proef.zeker('aanmaken: een los account bij Supabase komt in het plan (I1)',
  proef.start(9811, 'aanmaken', null, '{"naam": "Proef Los", "email": "her64@voorbeeld.test", "rol": "lezer"}') ->> 'bestaand' = proef.id(64)::text);
select proef.zeker('aanmaken: hetzelfde adres wordt geen tweede keer tegelijk aangemaakt (I1)',
  proef.start(9812, 'aanmaken', null, '{"naam": "Proef Los", "email": " HER64@voorbeeld.test ", "rol": "lezer"}') ->> 'fout' = 'MT409');
update auth.users set email = 'her64@voorbeeld.test' where id = proef.id(66);
select proef.zeker('aanmaken: enkel het losse account uit het plan mag de gebruiker worden (I1)',
  proef.klaar(9811, true, jsonb_build_object('gebruiker', proef.id(66))) ->> 'fout' = 'MT422');
update auth.users set email = 'her66@voorbeeld.test' where id = proef.id(66);
select proef.zeker('aanmaken: met het losse account lukt het', proef.klaar(9811, true, jsonb_build_object('gebruiker', proef.id(64))) ->> 'ok' = 'true');
select proef.zeker('aanmaken: het einde herhalen met een ander account blijft een conflict (I2)',
  proef.klaar(9811, true, jsonb_build_object('gebruiker', proef.id(66))) ->> 'fout' = 'MT409'
  and proef.klaar(9811, true, jsonb_build_object('gebruiker', proef.id(64))) @> '{"ok": true, "herhaald": true}'::jsonb);
select proef.zeker('aanmaken: de nieuwe gebruiker heeft nog geen app die telt',
  (select rol = 'lezer' and wachtwoord_tijdelijk and app_koppelen and app_factor is null and revisie = 1 from public.gebruikers where id = proef.id(64)));
select proef.zeker('aanmaken: een nieuw adres start zonder los account',
  proef.start(9840, 'aanmaken', null, '{"naam": "Proef Vers", "email": "vers@voorbeeld.test", "rol": "lezer"}') -> 'bestaand' = 'null'::jsonb);
select proef.zeker('aanmaken: een account van Supabase met een ander adres wordt die gebruiker niet',
  proef.klaar(9840, true, jsonb_build_object('gebruiker', proef.id(66))) ->> 'fout' = 'MT422');
select proef.zeker('aanmaken: die aanmaak mislukt dus', proef.klaar(9840, false) ->> 'ok' = 'false');
select proef.zeker('aanmaken: een aanmaak die bleef hangen, start',
  proef.start(9813, 'aanmaken', null, '{"naam": "Proef Hing", "email": "hing@voorbeeld.test", "rol": "lezer"}') ? 'operatie');
update public.account_operaties set begonnen_op = now() - interval '4 minutes' where id = proef.id(9813);
select proef.zeker('aanmaken: na drie minuten vervangt een nieuwe poging ze',
  proef.start(9814, 'aanmaken', null, '{"naam": "Proef Hing", "email": "hing@voorbeeld.test", "rol": "lezer"}') ? 'operatie');
select proef.zeker('aanmaken: de oude poging is afgesloten als vervangen, en haar einde wordt geweigerd',
  (select resultaat = 'hersteld' from public.account_operaties where id = proef.id(9813))
  and proef.klaar(9813, true, jsonb_build_object('gebruiker', proef.id(66))) ->> 'fout' = 'MT409');
select proef.zeker('aanmaken: de nieuwe poging mislukt bij Supabase: het adres is weer vrij', proef.klaar(9814, false) ->> 'ok' = 'false');
select proef.zeker('aanmaken: een mislukte aanmaak alsnog als gelukt afronden kan niet',
  proef.klaar(9814, true, jsonb_build_object('gebruiker', proef.id(66))) ->> 'fout' = 'MT409');

-- ---------- Naam, rol en klassen: enkel vanaf de stand die het scherm toonde (I7) ----------

create temp table h7 as select proef.revisie(63) as r0, proef.wijzig(63, 'Proef Derde Twee', 'beheerder') as a;
alter table h7 add column b jsonb, add column c jsonb;
update h7 set b = proef.wijzig(63, 'Proef Derde', 'lezer', r0);
select proef.zeker('wijzigen: de revisie gaat omhoog, en komt terug', (select (a ->> 'revisie')::bigint = r0 + 1 from h7), (select a::text from h7));
select proef.zeker('wijzigen: een venster dat nog de oude revisie toont, schrijft niets terug (I7)',
  (select b ->> 'fout' = 'MT409' from h7) and (select naam = 'Proef Derde Twee' and rol = 'beheerder' from public.gebruikers where id = proef.id(63)));
update h7 set r0 = proef.revisie(3), c = proef.klassen(3, proef.nieuw_jaar(), array[proef.nk('brona')]);
select proef.zeker('klassen: ook de klassen verhogen de revisie', (select (c ->> 'revisie')::bigint = r0 + 1 from h7), (select c::text from h7));
select proef.zeker('klassen: een oude revisie wijzigt de klassen niet (I7)',
  (select proef.klassen(3, proef.nieuw_jaar(), '{}', r0) ->> 'fout' = 'MT409' from h7));
select proef.zeker('klassen: de klas staat er nog',
  exists (select 1 from public.klastoewijzingen where gebruiker_id = proef.id(3) and klas_id = proef.nk('brona')));

-- ---------- Afronden: de app van de sessie wordt de app die telt (I8) ----------

select proef.zeker('afronden: de nieuwe gebruiker koos een eigen wachtwoord', proef.eigen(9830, 64) ? 'operatie' and proef.klaar(9830, true) ->> 'ok' = 'true');
select proef.zeker('afronden: zonder een code in de sessie niet (I8)', proef.rond(64, false) ->> 'fout' = 'MT422');
update auth.sessions set aal = 'aal2', factor_id = proef.id(63) where id = proef.id(64);
select proef.zeker('afronden: de app van iemand anders telt niet (I8)', proef.rond(64, false) ->> 'fout' = 'MT422');
update auth.sessions set aal = 'aal2', factor_id = proef.id(640) where id = proef.id(64);
select proef.zeker('afronden: een app die bij Supabase niet gekoppeld is, telt niet (I8)', proef.rond(64, false) ->> 'fout' = 'MT422');
insert into auth.mfa_factors (id, user_id, factor_type, status) values
  (proef.id(64), proef.id(64), 'totp', 'verified'), (proef.id(640), proef.id(64), 'totp', 'unverified'), (proef.id(641), proef.id(64), 'totp', 'verified');
select proef.zeker('afronden: een app die nog niet bevestigd is, telt niet', proef.rond(64, false) ->> 'fout' = 'MT422');
update auth.sessions set aal = 'aal1', factor_id = proef.id(64) where id = proef.id(64);
select proef.zeker('afronden: een sessie die bij Supabase niet op twee stappen staat, telt niet (I8)', proef.rond(64, false) ->> 'fout' = 'MT422');
select proef.zeker('afronden: met een code uit een gekoppelde app lukt het', proef.rond(64) ->> 'al_afgerond' = 'false');
select proef.zeker('afronden: de app van die sessie is de app die telt',
  (select app_factor = proef.id(64) and not app_koppelen and eerste_aanmelding_afgerond from public.gebruikers where id = proef.id(64)));
update auth.sessions set factor_id = proef.id(641) where id = proef.id(64);
select proef.zeker('afronden: wat al afgerond is, blijft zo, ook met een code uit een andere app (I8)',
  proef.rond(64, false) ->> 'al_afgerond' = 'true');
select proef.zeker('afronden: een app die er later zelf bij gekoppeld werd, wordt nooit stil de app van het account',
  (select app_factor = proef.id(64) from public.gebruikers where id = proef.id(64)));

-- ---------- De noodbeheerder (B214) ----------

select proef.zeker('noodbeheerder: niet bereikbaar via de Data API',
  proef.fout($q$select mt_intern.noodbeheerder('her65@voorbeeld.test', 'Proef Nood')$q$, 'authenticated') like '42501%'
  and proef.fout($q$select mt_intern.noodbeheerder('her65@voorbeeld.test', 'Proef Nood')$q$, 'service_role') like '42501%'
  and proef.fout($q$select mt_intern.noodbeheerder('her65@voorbeeld.test', 'Proef Nood')$q$, 'anon') like '42501%');
select proef.zeker('noodbeheerder: het adres van een bestaande gebruiker wordt geweigerd',
  proef.fout($q$select mt_intern.noodbeheerder('her63@voorbeeld.test', 'Proef Nood')$q$, 'postgres') like 'P0001%al van een gebruiker%');
select proef.zeker('noodbeheerder: zonder account bij Supabase niet, en een naam is verplicht',
  proef.fout($q$select mt_intern.noodbeheerder('niemand@voorbeeld.test', 'Proef Nood')$q$, 'postgres') like 'P0001%dashboard%'
  and proef.fout($q$select mt_intern.noodbeheerder('her65@voorbeeld.test', ' ')$q$, 'postgres') like 'P0001%naam%');
insert into auth.mfa_factors (id, user_id, factor_type, status) values (proef.id(66), proef.id(66), 'totp', 'verified');
select proef.zeker('noodbeheerder: een account dat al een app-koppeling heeft, wordt geweigerd',
  proef.fout($q$select mt_intern.noodbeheerder('her66@voorbeeld.test', 'Proef Nood')$q$, 'postgres') like 'P0001%app-koppeling%');
select proef.zeker('noodbeheerder: aangemaakt uit een nieuw account van het dashboard, ook als er al gebruikers zijn',
  proef.fout($q$select mt_intern.noodbeheerder(' HER65@voorbeeld.test ', ' Proef Nood ')$q$, 'postgres', true) = 'geen fout, 1 rijen');
select proef.zeker('noodbeheerder: een beheerder met een tijdelijk wachtwoord van 48 uur, de app nog te koppelen, en in het register',
  (select rol = 'beheerder' and actief and wachtwoord_tijdelijk and not eerste_aanmelding_afgerond and app_koppelen and app_factor is null
          and tijdelijk_tot between now() + interval '47 hours' and now() + interval '49 hours' and naam = 'Proef Nood' and email = 'her65@voorbeeld.test'
     from public.gebruikers where id = proef.id(65))
  and exists (select 1 from public.account_operaties o where o.soort = 'noodbeheerder' and o.voor = proef.id(65) and o.resultaat = 'gelukt'));

-- ---------- De uitslag ----------

\o
\echo 'Mislukt:'
select nr, naam, detail from proef.uitslag where not ok order by nr;
select count(*) filter (where ok) as geslaagd, count(*) filter (where not ok) as mislukt from proef.uitslag;

do $$
begin
  if exists (select 1 from proef.uitslag where not ok) then
    raise exception 'De proef op de databank mislukte: % van de % controles', (select count(*) from proef.uitslag where not ok), (select count(*) from proef.uitslag);
  end if;
end
$$;

rollback;
