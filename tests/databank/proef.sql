-- MT · tests/databank/proef.sql
-- De proef op de databank (17.12): verzonnen gegevens, en dan rechtstreeks, buiten de schermen om,
-- proberen wat mag en wat niet mag: per rol, met en zonder tweestapsverificatie.
-- Alles gebeurt in één transactie die op het einde teruggedraaid wordt: er blijft niets achter.
-- Enkel voor de nagebootste Supabase van de databanktest; alle namen zijn verzonnen.
--
-- De datums volgen de dag van vandaag, zodat de proef in elk schooljaar hetzelfde nagaat.

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

-- Het toegangsbewijs zoals PostgREST het doorgeeft.
create function proef.aangemeld(p_wie uuid, p_aal text default 'aal2', p_code_oud interval default interval '1 hour',
                                p_sessie uuid default null, p_amr jsonb default null) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_wie, 'role', 'authenticated', 'aal', p_aal, 'session_id', coalesce(p_sessie, p_wie),
    'amr', coalesce(p_amr, jsonb_build_array(
      jsonb_build_object('method', 'totp', 'timestamp', floor(extract(epoch from now() - p_code_oud))::bigint),
      jsonb_build_object('method', 'password', 'timestamp', floor(extract(epoch from now() - interval '40 days'))::bigint)))
  )::text, true);
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
-- teruggedraaid, tenzij p_houden.
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
      raise exception using errcode = 'MT000', message = n::text;
    end if;
    v := 'geen fout, ' || n || ' rijen';
  exception
    when sqlstate 'MT000' then v := 'geen fout, ' || sqlerrm || ' rijen';
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
insert into auth.sessions (id, user_id, not_after) values (proef.id(90), proef.id(3), now() - interval '1 minute');

insert into public.gebruikers (id, naam, email, rol, actief, wachtwoord_tijdelijk, eerste_aanmelding_afgerond, app_koppelen, open_operatie) values
  (proef.id(1), 'Proef Beheerder', 'proef1@voorbeeld.test', 'beheerder', true, false, true, false, null),
  (proef.id(2), 'Proef Tweede', 'proef2@voorbeeld.test', 'beheerder', true, false, true, false, null),
  (proef.id(3), 'Proef Vier A', 'proef3@voorbeeld.test', 'leerkracht', true, false, true, false, null),
  (proef.id(4), 'Proef Vier B', 'proef4@voorbeeld.test', 'leerkracht', true, false, true, false, null),
  (proef.id(5), 'Proef Lezer', 'proef5@voorbeeld.test', 'lezer', true, false, true, false, null),
  (proef.id(6), 'Proef Nieuw', 'proef6@voorbeeld.test', 'leerkracht', true, true, false, true, null),
  (proef.id(7), 'Proef Uit', 'proef7@voorbeeld.test', 'leerkracht', false, false, true, false, null),
  (proef.id(9), 'Proef Open', 'proef9@voorbeeld.test', 'beheerder', true, false, true, false, proef.id(900)),
  (proef.id(10), 'Proef Eerste', 'proef10@voorbeeld.test', 'leerkracht', true, false, false, true, null);
insert into public.account_operaties (id, soort, door, voor) values (proef.id(900), 'app_opnieuw_koppelen', proef.id(1), proef.id(9));

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
insert into public.activiteiten (id, schooljaar, soort, uitstap_id, datum_start, datum_eind)
select proef.id(a.n), case a.j when 0 then c.sj0 when 1 then c.sj1 else c.sj2 end, 'uitstap', 'uproef' || a.n,
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
