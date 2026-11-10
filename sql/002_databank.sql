-- MT · sql/002_databank.sql · versie 0.2.0
-- Stap 1a van fase 1 (62.5 en hoofdstuk 63 van het ontwerpdocument): het volledige gegevensmodel
-- (17.11), de toegang (17.2, 17.3) en het logboek (17.5). De databankfuncties van fase 1, zoals
-- bevestigen, een wijziging aanvragen en de import, volgen in 003.
--
-- Zo voer je het uit: Supabase → project mt-test → SQL Editor → New query → dit hele bestand
-- plakken → Run. Onderaan verschijnt een kleine tabel: elke regel moet OK tonen.
--
-- Enkel toevoegend en herhaalbaar: opnieuw uitvoeren mag, zolang er geen later script uitgevoerd is.
-- Alles-of-niets: lukt een controle niet, dan wordt niets bewaard en toont de editor een fout die
-- begint met "MT 002" (17.12).
--
-- Opbouw:
--    1. de volgorde en het scriptregister       6. de regels per tabel (RLS)
--    2. de tabellen                              7. de rechten
--    3. algemene functies                        8. de triggers en het logboek
--    4. de toegang: de hulpfuncties              9. de basisgegevens
--    5. de bewakers van de gegevens             10. de controles
--
-- De toegang in het kort:
--   - anon krijgt niets. authenticated krijgt per tabel enkel wat in deel 7 uitdrukkelijk staat.
--   - Op elke tabel staat de tweestapsverificatie als een beperkende regel (mt_tweestaps). Ze komt bij
--     elke andere regel, zodat geen andere regel ze kan omzeilen (T6).
--   - Lezen gaat per rol en per klas (mt_lezen). Rechtstreeks schrijven kan enkel een beheerder, en
--     enkel in de beheertabellen. Een leerkracht schrijft nooit rechtstreeks in een tabel: dat loopt
--     via de databankfuncties van 003, die haar rechten en de staat van de lijst onder slot nakijken.
--   - Wat bewijs is, zoals bevestigingen, facturaties en het logboek, kan via de API niemand schrijven.
--
-- Afspraken in dit script:
--   - bedragen in hele centen (integer); datums als kalenderdatum; "vandaag" in de tijd van Brussel;
--   - een periode loopt van een dag tot vóór een dag (T7); een einddatum uit Informat telt nog mee en
--     wordt dus de dag erna (B89);
--   - schooljaar als tekst, zoals in de uitstappentool: 2026-2027, van 1 september tot 31 augustus;
--   - wie-kolommen (…_door) bevatten het id van een gebruiker; gebruikers worden nooit gewist.

begin;

-- ============================================================================================
-- 1. De volgorde en het scriptregister
-- ============================================================================================

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'mt_intern')
     or to_regprocedure('public.mt_ping()') is null then
    raise exception 'MT 002: voer eerst sql/001_basis.sql uit';
  end if;
end
$$;

-- Welke scripts uitgevoerd zijn. Elk script kijkt hier na of het aan de beurt is: een ouder script
-- opnieuw uitvoeren na een nieuwer zou functies en rechten terugzetten.
create table if not exists mt_intern.scripts (
  nummer integer primary key,
  naam text not null,
  eerst_op timestamptz not null default now(),
  laatst_op timestamptz not null default now(),
  keren integer not null default 1
);
alter table mt_intern.scripts enable row level security;

do $$
declare
  v_laatste integer;
begin
  select max(nummer) into v_laatste from mt_intern.scripts;
  if v_laatste > 2 then
    raise exception 'MT 002: script % is al uitgevoerd. Voer 002 niet opnieuw uit.', v_laatste;
  end if;
end
$$;

-- Voor de regels "nooit twee klassen tegelijk" en "een klasnummer is uniek in de tijd" (T7, B158).
create extension if not exists btree_gist with schema extensions;

-- ============================================================================================
-- 2. De tabellen
-- ============================================================================================

-- ---------- Schooljaren (9, 11, 14, 15) ----------
-- Elk schooljaar houdt zijn eigen bedragen en zijn eigen werkwijze.
create table if not exists public.schooljaren (
  schooljaar text primary key
    check (case when schooljaar ~ '^[0-9]{4}-[0-9]{4}$'
                then right(schooljaar, 4)::integer = left(schooljaar, 4)::integer + 1
                else false end),
  begint_op date generated always as (make_date(left(schooljaar, 4)::integer, 9, 1)) stored,
  eindigt_op date generated always as (make_date(right(schooljaar, 4)::integer, 8, 31)) stored,
  -- in te vullen → lopend → voorbij (maar nog open) → afgesloten (B132, B144)
  stand text not null default 'in_te_vullen'
    check (stand in ('in_te_vullen', 'lopend', 'voorbij', 'afgesloten')),
  -- de scherpe plafonds en de marges voor schoolverlaters, als bedrag (B77, B154)
  plafond_kleuter_cent integer check (plafond_kleuter_cent >= 0),
  plafond_lager_cent integer check (plafond_lager_cent >= 0),
  marge_kleuter_cent integer check (marge_kleuter_cent >= 0),
  marge_lager_cent integer check (marge_lager_cent >= 0),
  -- minder scherp: of dit schooljaar opgevolgd wordt, en het plafond over de loopbaan dat dan geldt (B53, B71)
  minder_scherp_opvolgen boolean not null default false,
  plafond_minder_scherp_cent integer check (plafond_minder_scherp_cent >= 0),
  gwp_credit_vanaf_cent integer not null default 500 check (gwp_credit_vanaf_cent >= 0),
  gwp_bijbetalen_vanaf_cent integer not null default 1000 check (gwp_bijbetalen_vanaf_cent >= 0),
  -- facturatie aan ouders (F3, F4, F5)
  voorschotten_gebruiken boolean not null default true,
  minimumbedrag_cent integer not null default 0 check (minimumbedrag_cent >= 0),
  credit_standaard text not null default 'laten_staan'
    check (credit_standaard in ('laten_staan', 'meteen_crediteren')),
  -- de standaard voor een prijs per kind: false = enkel aanwezige leerlingen, true = iedereen (B22, B166)
  prijs_per_kind_afwezigen boolean not null default false,
  -- het gratis zwemjaar (B103, B105, B163)
  gratis_zwemjaar_leerjaar smallint check (gratis_zwemjaar_leerjaar between 1 and 6),
  gratis_zwemjaar_toegang_aangerekend boolean not null default false,
  gratis_zwemjaar_bus text not null default 'school'
    check (gratis_zwemjaar_bus in ('school', 'ouders', 'geen')),
  lopend_sinds timestamptz,
  afgesloten_op timestamptz,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  constraint schooljaren_ingevuld check (
    stand = 'in_te_vullen'
    or (plafond_kleuter_cent is not null and plafond_lager_cent is not null
        and marge_kleuter_cent is not null and marge_lager_cent is not null)),
  constraint schooljaren_minder_scherp check (
    not minder_scherp_opvolgen or stand = 'in_te_vullen' or plafond_minder_scherp_cent is not null)
);
create unique index if not exists schooljaren_een_lopend on public.schooljaren ((1)) where stand = 'lopend';
create unique index if not exists schooljaren_een_in_te_vullen on public.schooljaren ((1)) where stand = 'in_te_vullen';
alter table public.schooljaren enable row level security;

-- ---------- Voorschotten (F4, B96, B145, B162) ----------
-- Een instelbaar aantal per schooljaar. De datum komt er pas bij het aanrekenen; daarna ligt het vast.
create table if not exists public.voorschotten (
  id uuid primary key default gen_random_uuid(),
  schooljaar text not null references public.schooljaren (schooljaar) on delete cascade,
  volgnummer smallint not null check (volgnummer between 1 and 12),
  bedrag_kleuter_cent integer check (bedrag_kleuter_cent >= 0),
  bedrag_lager_cent integer check (bedrag_lager_cent >= 0),
  -- het laatste voorschot kan aanvullen tot het plafond: dan rekent de MT de bedragen bij het aanrekenen
  vult_aan boolean not null default false,
  aangerekend_op date,
  aangerekend_door uuid,
  aangerekend_vastgelegd_op timestamptz,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  unique (schooljaar, volgnummer),
  constraint voorschotten_bedragen check (
    (vult_aan and aangerekend_op is null and bedrag_kleuter_cent is null and bedrag_lager_cent is null)
    or (bedrag_kleuter_cent is not null and bedrag_lager_cent is not null))
);
alter table public.voorschotten enable row level security;

-- ---------- Algemene instellingen (15): één rij ----------
create table if not exists public.instellingen (
  id boolean primary key default true check (id),
  -- aanmelden en sessies, instelbaar binnen veilige grenzen (B172); de databank weigert wat erbuiten valt
  code_geldig_dagen smallint not null default 14 check (code_geldig_dagen between 7 and 28),
  afmelden_na_minuten smallint not null default 30 check (afmelden_na_minuten between 15 and 60),
  tijdelijk_wachtwoord_uren smallint not null default 48 check (tijdelijk_wachtwoord_uren between 24 and 72),
  wachtwoord_min_lengte smallint not null default 12 check (wachtwoord_min_lengte between 12 and 64),
  -- "Aangemeld blijven" per rol (B148)
  aangemeld_blijven_beheerder boolean not null default true,
  aangemeld_blijven_leerkracht boolean not null default true,
  aangemeld_blijven_lezer boolean not null default true,
  -- de vaste redenen voor afboekingen: intern, nooit voor ouders (B138)
  reden_afboeking_marge text not null default 'Niet terugbetaald: tot en met de marge voor schoolverlaters'
    check (char_length(btrim(reden_afboeking_marge)) between 1 and 200),
  reden_afboeking_drempel text not null default 'Niet verrekend: onder de drempel bij een meerdaagse uitstap'
    check (char_length(btrim(reden_afboeking_drempel)) between 1 and 200),
  -- suggesties voor de reden van een correctie (12)
  correctie_suggesties text[] not null default '{}'
    check (coalesce(array_length(correctie_suggesties, 1), 0) <= 30
           and char_length(array_to_string(correctie_suggesties, '')) <= 6000),
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid
);
alter table public.instellingen enable row level security;

-- ---------- Afwezigheidsstatussen (7, B19, B73) ----------
create table if not exists public.statussen (
  id uuid primary key default gen_random_uuid(),
  -- aanwezig en "nog te bepalen" bestaan elk één keer; de rest is een afwezigheid
  soort text not null default 'afwezig' check (soort in ('aanwezig', 'afwezig', 'te_bepalen')),
  naam text not null check (naam = btrim(naam) and char_length(naam) between 1 and 40),
  kleur text not null check (kleur ~ '^[a-z_]{1,24}$'),
  aangerekend boolean not null,
  volgorde smallint not null default 0,
  actief boolean not null default true,
  -- eens gebruikt, kan "aangerekend" niet meer wisselen en kan de status niet meer gewist worden (B73)
  gebruikt boolean not null default false,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  constraint statussen_vast check (soort = 'afwezig' or (aangerekend and actief))
);
create unique index if not exists statussen_naam on public.statussen (lower(naam));
create unique index if not exists statussen_een_aanwezig on public.statussen ((1)) where soort = 'aanwezig';
create unique index if not exists statussen_een_te_bepalen on public.statussen ((1)) where soort = 'te_bepalen';
alter table public.statussen enable row level security;

-- ---------- Klassen per schooljaar (4, 5, B158, B208) ----------
-- Uit de klassenlijst van de uitstappentool. De MT bewaart per schooljaar de naam van toen.
create table if not exists public.klassen (
  id uuid primary key default gen_random_uuid(),
  schooljaar text not null references public.schooljaren (schooljaar),
  bron_id text not null check (char_length(bron_id) between 1 and 60),   -- het klas-id uit de uitstappentool
  naam text not null check (naam = btrim(naam) and char_length(naam) between 1 and 40),
  groep text not null check (groep in ('Kleuter', 'Lager', 'Andere')),   -- het niveau: nooit uit de klascode (B157)
  -- enkel in de lagere school; de MT leidt het zelf af uit het eerste cijfer van de naam (B208)
  leerjaar smallint check (leerjaar between 1 and 6),
  leerjaar_manueel boolean not null default false,
  actief boolean not null default true,
  volgorde integer not null default 0,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  unique (schooljaar, bron_id),
  unique (id, schooljaar),
  constraint klassen_leerjaar check (groep = 'Lager' or (leerjaar is null and not leerjaar_manueel))
);
alter table public.klassen enable row level security;

-- Een uitstap bewaart haar klassen als namen. Per schooljaar hoort een naam bij één klas, ook een
-- vroegere naam (B158).
create table if not exists public.klas_namen (
  schooljaar text not null,
  naam text not null check (naam = btrim(naam) and char_length(naam) between 1 and 40),
  klas_id uuid not null,
  huidig boolean not null default true,
  primary key (schooljaar, naam),
  foreign key (klas_id, schooljaar) references public.klassen (id, schooljaar) on delete cascade
);
create index if not exists klas_namen_klas on public.klas_namen (klas_id);
alter table public.klas_namen enable row level security;

-- Een klascode van Informat die anders heet dan de klas: één keer gekoppeld, daarna onthouden (5).
create table if not exists public.informat_codes (
  code text primary key check (code = btrim(code) and char_length(code) between 1 and 40),
  klas_bron_id text not null check (char_length(klas_bron_id) between 1 and 60),
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid
);
alter table public.informat_codes enable row level security;

-- ---------- Leerlingen (5, T7) ----------
-- Zuinig met gegevens: enkel naam en stamnummer (B6). Het stamnummer als tekst, zodat voorloopnullen blijven.
create table if not exists public.leerlingen (
  id uuid primary key default gen_random_uuid(),
  stamnummer text not null unique check (stamnummer ~ '^[0-9]{7}$'),
  voornaam text not null check (voornaam = btrim(voornaam) and char_length(voornaam) between 1 and 80),
  familienaam text not null check (familienaam = btrim(familienaam) and char_length(familienaam) between 1 and 80),
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid
);
alter table public.leerlingen enable row level security;

-- ---------- Klasindelingen (5, T7, B67, B89, B158) ----------
-- Een leerling zit per periode in een klas: van een dag tot vóór een dag, nooit twee klassen tegelijk.
create table if not exists public.klasindelingen (
  id uuid primary key default gen_random_uuid(),
  leerling_id uuid not null references public.leerlingen (id),
  schooljaar text not null,
  klas_id uuid not null,
  klasnummer integer not null default 0 check (klasnummer between 0 and 999),   -- 0 = nog geen nummer
  klasnummer_manueel boolean not null default false,                             -- B61
  van date not null,
  tot date,                                                                      -- tot vóór; leeg = tot het einde van het schooljaar
  einde date generated always as (coalesce(tot, make_date(right(schooljaar, 4)::integer, 9, 1))) stored,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  foreign key (klas_id, schooljaar) references public.klassen (id, schooljaar),
  constraint klasindelingen_in_schooljaar check (
    van >= make_date(left(schooljaar, 4)::integer, 9, 1)
    and van < make_date(right(schooljaar, 4)::integer, 9, 1)
    and (tot is null or (tot > van and tot <= make_date(right(schooljaar, 4)::integer, 9, 1)))),
  constraint klasindelingen_geen_overlap
    exclude using gist (leerling_id with =, daterange(van, einde, '[)') with &&),
  constraint klasindelingen_klasnummer_uniek
    exclude using gist (klas_id with =, klasnummer with =, daterange(van, einde, '[)') with &&)
    where (klasnummer > 0)
);
create index if not exists klasindelingen_klas on public.klasindelingen (klas_id, van);
create index if not exists klasindelingen_schooljaar on public.klasindelingen (schooljaar);
alter table public.klasindelingen enable row level security;

-- Schoolverlater volgt uit het 6de leerjaar of de einddatum; hier staan enkel de afwijkingen (B101).
create table if not exists public.schoolverlaters (
  leerling_id uuid not null references public.leerlingen (id),
  schooljaar text not null references public.schooljaren (schooljaar),
  schoolverlater boolean not null,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  primary key (leerling_id, schooljaar)
);
alter table public.schoolverlaters enable row level security;

-- ---------- Gebruikers (3, 17.2, T5) ----------
-- De databank beslist over de toegang: deze rij, niet een vlag in het toegangsbewijs.
create table if not exists public.gebruikers (
  id uuid primary key references auth.users (id) on delete restrict,
  naam text not null check (naam = btrim(naam) and char_length(naam) between 1 and 80),
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
                             and char_length(email) <= 254),
  rol text not null check (rol in ('beheerder', 'leerkracht', 'lezer')),
  actief boolean not null default true,
  wachtwoord_tijdelijk boolean not null default true,
  tijdelijk_tot timestamptz,
  eerste_aanmelding_afgerond boolean not null default false,
  app_koppelen boolean not null default true,
  -- een accounthandeling die nog niet rond is: tot het herstel blijft de toegang geblokkeerd (17.4)
  open_operatie uuid,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid
);
create unique index if not exists gebruikers_email on public.gebruikers (email);
alter table public.gebruikers enable row level security;

-- De klassen van een leerkracht, per schooljaar. Een heel leerjaar is een rij per klas.
create table if not exists public.klastoewijzingen (
  gebruiker_id uuid not null references public.gebruikers (id),
  klas_id uuid not null,
  schooljaar text not null,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  primary key (gebruiker_id, klas_id),
  foreign key (klas_id, schooljaar) references public.klassen (id, schooljaar)
);
create index if not exists klastoewijzingen_klas on public.klastoewijzingen (klas_id);
alter table public.klastoewijzingen enable row level security;

-- Voorkeuren per gebruiker: de standaardfilter, de gekozen soort en het gekozen schooljaar.
create table if not exists public.gebruiker_voorkeuren (
  gebruiker_id uuid primary key references public.gebruikers (id),
  voorkeuren jsonb not null default '{}'::jsonb
    check (jsonb_typeof(voorkeuren) = 'object' and char_length(voorkeuren::text) <= 8000),
  bijgewerkt_op timestamptz not null default now()
);
alter table public.gebruiker_voorkeuren enable row level security;

-- Elke accounthandeling krijgt een operatienummer en een begin- en eindstand (17.4). Nooit
-- wachtwoorden, tokens, TOTP-geheimen of QR-inhoud. Stap 2 vult deze tabel.
create table if not exists public.account_operaties (
  id uuid primary key,
  soort text not null check (soort ~ '^[a-z_]{3,40}$'),
  door uuid,
  voor uuid,
  begonnen_op timestamptz not null default now(),
  beginstand jsonb,
  afgerond_op timestamptz,
  eindstand jsonb,
  resultaat text check (resultaat in ('gelukt', 'mislukt', 'hersteld')),
  melding text check (char_length(melding) <= 500)
);
alter table public.account_operaties enable row level security;

-- Elke import: wanneer, wie en de aantallen. Het bestand zelf wordt niet bewaard (T13).
create table if not exists public.imports (
  id uuid primary key default gen_random_uuid(),
  schooljaar text not null references public.schooljaren (schooljaar),
  soort text not null check (soort in ('eerste_lijst', 'bijwerking', 'opnieuw_eerste_lijst')),
  bestandsnaam text check (char_length(bestandsnaam) <= 200),
  aantallen jsonb not null default '{}'::jsonb check (jsonb_typeof(aantallen) = 'object'),
  uitgevoerd_op timestamptz not null default now(),
  uitgevoerd_door uuid
);
alter table public.imports enable row level security;

-- ---------- Lopende activiteiten, zoals zwemmen (6, B7, B119, B200) ----------
create table if not exists public.lopende_activiteiten (
  id uuid primary key default gen_random_uuid(),
  schooljaar text not null references public.schooljaren (schooljaar),
  naam text not null check (naam = btrim(naam) and char_length(naam) between 1 and 80),
  zwemmen boolean not null default false,                -- het vakje "zwemmen": dan geldt het gratis zwemjaar (B103)
  iedereen_betaalt boolean not null default false,       -- false = enkel aanwezige leerlingen (B119)
  -- de planning zoals ze ingegeven werd (B196, B200); de beurten zelf zijn de waarheid
  planning jsonb not null default '{}'::jsonb check (jsonb_typeof(planning) = 'object'),
  -- een leerkracht vraagt aan, de beheerder bevestigt (B36)
  stand text not null default 'bevestigd' check (stand in ('aangevraagd', 'bevestigd', 'geweigerd')),
  aangevraagd_door uuid,
  aangevraagd_op timestamptz,
  behandeld_door uuid,
  behandeld_op timestamptz,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  unique (id, schooljaar)
);
create index if not exists lopende_activiteiten_schooljaar on public.lopende_activiteiten (schooljaar);
alter table public.lopende_activiteiten enable row level security;

create table if not exists public.lopende_activiteit_klassen (
  lopende_activiteit_id uuid not null,
  klas_id uuid not null,
  schooljaar text not null,
  primary key (lopende_activiteit_id, klas_id),
  foreign key (lopende_activiteit_id, schooljaar) references public.lopende_activiteiten (id, schooljaar) on delete cascade,
  foreign key (klas_id, schooljaar) references public.klassen (id, schooljaar)
);
create index if not exists lopende_activiteit_klassen_klas on public.lopende_activiteit_klassen (klas_id);
alter table public.lopende_activiteit_klassen enable row level security;

-- De kostenregels: "per beurt, verdeeld" zoals een bus of zwembanen, of "per kind per beurt" zoals
-- een ticket (B120). Het onderdeel zegt waar de kost op de fiche staat: activiteit of vervoer.
create table if not exists public.kostenregels (
  id uuid primary key default gen_random_uuid(),
  lopende_activiteit_id uuid not null,
  schooljaar text not null,
  omschrijving text not null check (omschrijving = btrim(omschrijving) and char_length(omschrijving) between 1 and 60),
  verdeling text not null check (verdeling in ('verdeeld', 'per_kind')),
  onderdeel text not null check (onderdeel in ('activiteit', 'vervoer')),
  volgorde smallint not null default 0,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  unique (id, schooljaar),
  foreign key (lopende_activiteit_id, schooljaar) references public.lopende_activiteiten (id, schooljaar) on delete cascade
);
create index if not exists kostenregels_lopende_activiteit on public.kostenregels (lopende_activiteit_id);
alter table public.kostenregels enable row level security;

-- Een tarief geldt vanaf een gekozen beurt, nooit voor beurten die al bevestigd zijn (B73).
create table if not exists public.tarieven (
  kostenregel_id uuid not null,
  geldig_vanaf date not null,
  schooljaar text not null,
  bedrag_cent integer not null check (bedrag_cent >= 0),
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  primary key (kostenregel_id, geldig_vanaf),
  foreign key (kostenregel_id, schooljaar) references public.kostenregels (id, schooljaar) on delete cascade
);
alter table public.tarieven enable row level security;

-- ---------- Activiteiten: één interne id voor uitstappen en beurten (T7) ----------
-- Een uitstap leeft in de uitstappentool; de MT kent haar id, en bewaart van datum en soort enkel wat
-- ze laatst waarnam, om lijsten aan op te hangen en wijzigingen op te merken (B14, B67, T1).
create table if not exists public.activiteiten (
  id uuid primary key default gen_random_uuid(),
  schooljaar text not null references public.schooljaren (schooljaar),
  soort text not null check (soort in ('uitstap', 'beurt')),
  -- een uitstap: het id uit de uitstappentool, als tekst
  uitstap_id text check (char_length(uitstap_id) between 1 and 60),
  bron_gewijzigd_op timestamptz,
  bron_stand text check (bron_stand in ('actief', 'verwijderd', 'nascholing', 'niet_gevonden')),
  -- een beurt van een lopende activiteit
  lopende_activiteit_id uuid,
  -- een beurt die niet doorging (B149, B176): wie annuleerde, en de kosten als de school niet ging
  ging_niet_door text check (ging_niet_door in ('organisator', 'school')),
  niet_door_activiteit_cent integer check (niet_door_activiteit_cent >= 0),
  niet_door_vervoer_cent integer check (niet_door_vervoer_cent >= 0),
  datum_start date not null,
  datum_eind date not null,
  meerdaags boolean not null default false,
  -- de beheerder kan een meerdaagse als scherp aanrekenen, met een verplichte reden (B16). Van dag
  -- naar minder scherp kan niet, zolang X1 open is (B65, B159).
  afwijking text check (afwijking in ('scherp')),
  afwijking_reden text check (char_length(btrim(afwijking_reden)) between 1 and 500),
  -- betalen aangerekende afwezigen ook de prijs per kind? De standaard van het schooljaar wordt bij
  -- het aanmaken overgenomen, zodat een latere wijziging van de standaard niets herschrijft (B22, B73).
  prijs_per_kind_afwezigen boolean not null default false,
  annulering_doorrekenen boolean not null default false,   -- B79
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  unique (id, schooljaar),
  foreign key (lopende_activiteit_id, schooljaar) references public.lopende_activiteiten (id, schooljaar),
  constraint activiteiten_datums check (
    datum_eind >= datum_start and (meerdaags or datum_eind = datum_start)
    and datum_start >= make_date(left(schooljaar, 4)::integer, 9, 1)
    and datum_start < make_date(right(schooljaar, 4)::integer, 9, 1)),
  constraint activiteiten_uitstap check ((soort = 'uitstap') = (uitstap_id is not null)),
  constraint activiteiten_beurt check ((soort = 'beurt') = (lopende_activiteit_id is not null)),
  constraint activiteiten_enkel_uitstap check (
    soort = 'uitstap'
    or (not meerdaags and bron_stand is null and bron_gewijzigd_op is null
        and not annulering_doorrekenen and afwijking is null)),
  constraint activiteiten_niet_door check (
    (soort = 'beurt' or ging_niet_door is null)
    and (ging_niet_door = 'school' or (niet_door_activiteit_cent is null and niet_door_vervoer_cent is null))),
  constraint activiteiten_afwijking check (
    (afwijking is null) = (afwijking_reden is null) and (afwijking is null or meerdaags))
);
create unique index if not exists activiteiten_uitstap_id on public.activiteiten (uitstap_id) where uitstap_id is not null;
create unique index if not exists activiteiten_beurt_dag on public.activiteiten (lopende_activiteit_id, datum_start) where soort = 'beurt';
create index if not exists activiteiten_schooljaar on public.activiteiten (schooljaar, datum_start);
alter table public.activiteiten enable row level security;

-- Per beurt: zonder een kost (bv. zonder bus), of met een afwijkende kost (6).
create table if not exists public.beurt_kosten (
  activiteit_id uuid not null,
  kostenregel_id uuid not null,
  schooljaar text not null,
  van_toepassing boolean not null default true,
  bedrag_cent integer check (bedrag_cent >= 0),
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  primary key (activiteit_id, kostenregel_id),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar) on delete cascade,
  foreign key (kostenregel_id, schooljaar) references public.kostenregels (id, schooljaar) on delete cascade,
  constraint beurt_kosten_bedrag check (van_toepassing or bedrag_cent is null)
);
alter table public.beurt_kosten enable row level security;

-- ---------- Klaslijsten: de aanwezigheden van één klas bij één activiteit (7, T2) ----------
-- De revisie gaat omhoog bij elke tik; bevestigen controleert ze, zodat een tik die nog onderweg is
-- of een tweede gebruiker nooit stil overschreven wordt.
create table if not exists public.klaslijsten (
  activiteit_id uuid not null,
  klas_id uuid not null,
  schooljaar text not null,
  revisie bigint not null default 0,
  stand text not null default 'open' check (stand in ('open', 'bevestigd')),
  bevestiging_id uuid,                                   -- de geldende bevestiging
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  gewijzigd_op timestamptz not null default now(),
  primary key (activiteit_id, klas_id),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar) on delete cascade,
  foreign key (klas_id, schooljaar) references public.klassen (id, schooljaar),
  constraint klaslijsten_bevestigd check ((stand = 'bevestigd') = (bevestiging_id is not null))
);
create index if not exists klaslijsten_klas on public.klaslijsten (klas_id, stand);
alter table public.klaslijsten enable row level security;

-- Enkel de uitzonderingen: wie geen rij heeft, is aanwezig (V7). Een daguitstap heeft één dag, een
-- meerdaagse één rij per dag (B110).
create table if not exists public.afwezigheden (
  activiteit_id uuid not null,
  leerling_id uuid not null references public.leerlingen (id),
  dag date not null,
  klas_id uuid not null,
  schooljaar text not null,
  status_id uuid not null references public.statussen (id),
  gewijzigd_op timestamptz not null default now(),
  gewijzigd_door uuid,
  primary key (activiteit_id, leerling_id, dag),
  foreign key (activiteit_id, klas_id) references public.klaslijsten (activiteit_id, klas_id),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar)
);
create index if not exists afwezigheden_lijst on public.afwezigheden (activiteit_id, klas_id);
create index if not exists afwezigheden_leerling on public.afwezigheden (leerling_id);
alter table public.afwezigheden enable row level security;

-- Bij een meerdaagse: wie niet deelneemt. Enkel wie uitgevinkt is, heeft een rij (B109).
create table if not exists public.deelname (
  activiteit_id uuid not null,
  leerling_id uuid not null references public.leerlingen (id),
  klas_id uuid not null,
  schooljaar text not null,
  gewijzigd_op timestamptz not null default now(),
  gewijzigd_door uuid,
  primary key (activiteit_id, leerling_id),
  foreign key (activiteit_id, klas_id) references public.klaslijsten (activiteit_id, klas_id),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar)
);
create index if not exists deelname_lijst on public.deelname (activiteit_id, klas_id);
alter table public.deelname enable row level security;

-- Per leerling per activiteit twee opmerkingen: één van de leerkracht, één van de beheerder (B86).
create table if not exists public.opmerkingen (
  activiteit_id uuid not null,
  leerling_id uuid not null references public.leerlingen (id),
  soort text not null check (soort in ('leerkracht', 'beheerder')),
  klas_id uuid not null,
  schooljaar text not null,
  tekst text not null check (tekst = btrim(tekst) and char_length(tekst) between 1 and 500),
  gewijzigd_op timestamptz not null default now(),
  gewijzigd_door uuid,
  primary key (activiteit_id, leerling_id, soort),
  foreign key (activiteit_id, klas_id) references public.klaslijsten (activiteit_id, klas_id),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar)
);
create index if not exists opmerkingen_lijst on public.opmerkingen (activiteit_id, klas_id);
alter table public.opmerkingen enable row level security;

-- De deelnemerslijst van een klas uit de groep Andere, die de beheerder samenstelt (B143).
create table if not exists public.deelnemers (
  activiteit_id uuid not null,
  leerling_id uuid not null references public.leerlingen (id),
  klas_id uuid not null,
  schooljaar text not null,
  toegevoegd_op timestamptz not null default now(),
  toegevoegd_door uuid,
  primary key (activiteit_id, leerling_id),
  foreign key (activiteit_id, klas_id) references public.klaslijsten (activiteit_id, klas_id),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar)
);
create index if not exists deelnemers_lijst on public.deelnemers (activiteit_id, klas_id);
alter table public.deelnemers enable row level security;

-- ---------- Bevestigingen: het bewijs op een beslismoment (B67, T2) ----------
-- Wie er toen op de lijst stond, met zijn status, en de stand van de uitstap zoals ze toen
-- waargenomen werd. Een heropening sluit de bevestiging af; ze wordt nooit gewist.
create table if not exists public.bevestigingen (
  id uuid primary key default gen_random_uuid(),
  activiteit_id uuid not null,
  klas_id uuid not null,
  schooljaar text not null,
  revisie bigint not null,
  bevestigd_op timestamptz not null default now(),
  bevestigd_door uuid,
  uitstap_stand jsonb check (jsonb_typeof(uitstap_stand) = 'object'),
  heropend_op timestamptz,
  heropend_door uuid,
  heropend_reden text check (char_length(btrim(heropend_reden)) between 1 and 500),
  foreign key (activiteit_id, klas_id) references public.klaslijsten (activiteit_id, klas_id),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar)
);
create unique index if not exists bevestigingen_geldend on public.bevestigingen (activiteit_id, klas_id) where heropend_op is null;
alter table public.bevestigingen enable row level security;

create table if not exists public.bevestiging_leerlingen (
  bevestiging_id uuid not null references public.bevestigingen (id),
  leerling_id uuid not null references public.leerlingen (id),
  klasnummer integer not null default 0,
  neemt_deel boolean not null default true,
  -- "Later toegevoegd, na de bevestiging": na de taak "Was hij mee?" (B192)
  later_toegevoegd boolean not null default false,
  toegevoegd_op timestamptz,
  toegevoegd_door uuid,
  primary key (bevestiging_id, leerling_id)
);
create index if not exists bevestiging_leerlingen_leerling on public.bevestiging_leerlingen (leerling_id);
alter table public.bevestiging_leerlingen enable row level security;

create table if not exists public.bevestiging_dagen (
  bevestiging_id uuid not null,
  leerling_id uuid not null,
  dag date not null,
  status_id uuid not null references public.statussen (id),
  primary key (bevestiging_id, leerling_id, dag),
  foreign key (bevestiging_id, leerling_id) references public.bevestiging_leerlingen (bevestiging_id, leerling_id)
);
alter table public.bevestiging_dagen enable row level security;

-- Wat na de bevestiging nog wijzigde: door de beheerder zelf, of uit een goedgekeurde aanvraag (B113, B193).
create table if not exists public.wijzigingen (
  id uuid primary key default gen_random_uuid(),
  bevestiging_id uuid not null references public.bevestigingen (id),
  activiteit_id uuid not null,
  klas_id uuid not null,
  schooljaar text not null,
  leerling_id uuid not null references public.leerlingen (id),
  wat text not null check (wat in ('status', 'deelname', 'opmerking')),
  dag date,
  oude_status_id uuid references public.statussen (id),
  nieuwe_status_id uuid references public.statussen (id),
  oude_deelname boolean,
  nieuwe_deelname boolean,
  reden text check (char_length(btrim(reden)) between 1 and 500),
  aanvraag_id uuid,
  gewijzigd_op timestamptz not null default now(),
  gewijzigd_door uuid,
  foreign key (activiteit_id, klas_id) references public.klaslijsten (activiteit_id, klas_id),
  constraint wijzigingen_wat check (
    (wat = 'status') = (dag is not null and nieuwe_status_id is not null)
    and (wat = 'deelname') = (nieuwe_deelname is not null))
);
create index if not exists wijzigingen_lijst on public.wijzigingen (activiteit_id, klas_id);
create index if not exists wijzigingen_leerling on public.wijzigingen (leerling_id);
alter table public.wijzigingen enable row level security;

-- Na het bevestigen wijzigt een leerkracht niet zelf: ze vraagt een wijziging aan (B20, B40).
create table if not exists public.wijzigingsaanvragen (
  id uuid primary key default gen_random_uuid(),
  activiteit_id uuid not null,
  klas_id uuid not null,
  schooljaar text not null,
  bevestiging_id uuid not null references public.bevestigingen (id),
  verwachte_revisie bigint not null,
  reden text check (char_length(btrim(reden)) between 1 and 500),
  stand text not null default 'open' check (stand in ('open', 'goedgekeurd', 'geweigerd', 'ingetrokken')),
  aangevraagd_op timestamptz not null default now(),
  aangevraagd_door uuid,
  behandeld_op timestamptz,
  behandeld_door uuid,
  antwoord text check (char_length(btrim(antwoord)) between 1 and 500),
  foreign key (activiteit_id, klas_id) references public.klaslijsten (activiteit_id, klas_id),
  constraint wijzigingsaanvragen_behandeld check ((stand = 'open') = (behandeld_op is null))
);
create unique index if not exists wijzigingsaanvragen_een_open on public.wijzigingsaanvragen (activiteit_id, klas_id) where stand = 'open';
alter table public.wijzigingsaanvragen enable row level security;

create table if not exists public.wijzigingsaanvraag_regels (
  id uuid primary key default gen_random_uuid(),
  aanvraag_id uuid not null references public.wijzigingsaanvragen (id),
  leerling_id uuid not null references public.leerlingen (id),
  wat text not null check (wat in ('status', 'deelname', 'opmerking')),
  dag date,
  oude_status_id uuid references public.statussen (id),
  nieuwe_status_id uuid references public.statussen (id),
  oude_deelname boolean,
  nieuwe_deelname boolean,
  nieuwe_opmerking text check (char_length(nieuwe_opmerking) <= 500),   -- leeg = de opmerking wissen
  constraint wijzigingsaanvraag_regels_wat check (
    (wat = 'status') = (dag is not null and nieuwe_status_id is not null)
    and (wat = 'deelname') = (nieuwe_deelname is not null))
);
create unique index if not exists wijzigingsaanvraag_regels_uniek
  on public.wijzigingsaanvraag_regels (aanvraag_id, leerling_id, wat, coalesce(dag, date '0001-01-01'));
alter table public.wijzigingsaanvraag_regels enable row level security;

-- ---------- Taken voor de beheerder (6) ----------
-- Wat een beslissing vraagt en nooit twee keer mag ontstaan: "was hij mee?", omgezet naar een
-- nascholing, een onbekende schemaversie, een onbekende klas, ... De sleutel maakt een taak uniek.
create table if not exists public.taken (
  id uuid primary key default gen_random_uuid(),
  schooljaar text not null references public.schooljaren (schooljaar),
  soort text not null check (soort ~ '^[a-z_]{3,40}$'),
  sleutel text not null unique check (char_length(sleutel) between 3 and 300),
  activiteit_id uuid references public.activiteiten (id),
  klas_id uuid references public.klassen (id),
  leerling_id uuid references public.leerlingen (id),
  gegevens jsonb not null default '{}'::jsonb check (jsonb_typeof(gegevens) = 'object'),
  stand text not null default 'open' check (stand in ('open', 'afgehandeld')),
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  afgehandeld_op timestamptz,
  afgehandeld_door uuid,
  afhandeling text check (afhandeling ~ '^[a-z_]{3,40}$'),
  afhandeling_gegevens jsonb,
  constraint taken_afgehandeld check ((stand = 'afgehandeld') = (afgehandeld_op is not null))
);
create index if not exists taken_open on public.taken (schooljaar, soort) where stand = 'open';
alter table public.taken enable row level security;

-- ---------- Tussenkomsten (8, B81, B104) ----------
create table if not exists public.tussenkomsten (
  id uuid primary key default gen_random_uuid(),
  activiteit_id uuid not null,
  schooljaar text not null,
  wie text not null check (wie = btrim(wie) and char_length(wie) between 1 and 80),
  onderdeel text not null check (onderdeel in ('activiteit', 'vervoer')),
  basis text not null check (basis in ('totaal', 'per_kind')),
  bedrag_cent integer not null check (bedrag_cent > 0),
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar) on delete cascade
);
create index if not exists tussenkomsten_activiteit on public.tussenkomsten (activiteit_id);
alter table public.tussenkomsten enable row level security;

-- Bij een annulering die doorgerekend wordt: wie meebetaalt, bevestigd door de beheerder (B79).
create table if not exists public.annulering_betalers (
  activiteit_id uuid not null,
  leerling_id uuid not null references public.leerlingen (id),
  klas_id uuid not null,
  schooljaar text not null,
  toegevoegd_op timestamptz not null default now(),
  toegevoegd_door uuid,
  primary key (activiteit_id, leerling_id),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar) on delete cascade,
  foreign key (klas_id, schooljaar) references public.klassen (id, schooljaar)
);
alter table public.annulering_betalers enable row level security;

-- ---------- Plafondrekeningen (9, T4) ----------
-- Scherp: per leerling en schooljaar. Minder scherp: per leerling, over de hele lagere schoolloopbaan.
-- Elke facturatieregel hangt aan één rekening en bewaart het plafond dat toen gold.
create table if not exists public.plafondrekeningen (
  id uuid primary key default gen_random_uuid(),
  leerling_id uuid not null references public.leerlingen (id),
  maximumfactuur text not null check (maximumfactuur in ('scherp', 'minder_scherp')),
  schooljaar text references public.schooljaren (schooljaar),
  aangemaakt_op timestamptz not null default now(),
  constraint plafondrekeningen_schooljaar check ((maximumfactuur = 'scherp') = (schooljaar is not null))
);
create unique index if not exists plafondrekeningen_scherp on public.plafondrekeningen (leerling_id, schooljaar) where maximumfactuur = 'scherp';
create unique index if not exists plafondrekeningen_minder_scherp on public.plafondrekeningen (leerling_id) where maximumfactuur = 'minder_scherp';
alter table public.plafondrekeningen enable row level security;

-- Wat Klim-Op vóór de start van de MT al aanrekende voor meerdaagse uitstappen (B107). Gekend of onbekend.
create table if not exists public.beginbedragen (
  leerling_id uuid primary key references public.leerlingen (id),
  gekend boolean not null,
  bedrag_cent integer check (bedrag_cent >= 0),
  bron text check (char_length(btrim(bron)) between 1 and 200),
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  constraint beginbedragen_gekend check (gekend = (bedrag_cent is not null))
);
alter table public.beginbedragen enable row level security;

-- ---------- Facturaties (11, 17.6, T3) ----------
-- Enkel de databankfuncties van fase 2 schrijven hier; de browser nooit rechtstreeks.
create table if not exists public.facturaties (
  id uuid primary key default gen_random_uuid(),
  schooljaar text not null references public.schooljaren (schooljaar),
  maximumfactuur text not null check (maximumfactuur in ('scherp', 'minder_scherp')),
  soort text not null check (soort in ('maand', 'eindafrekening', 'gwp')),
  stand text not null default 'klaar' check (stand in ('klaar', 'gefactureerd', 'geannuleerd', 'ongedaan')),
  operatie uuid not null unique,                         -- elke handeling één keer, ook na dubbel klikken (T3)
  tot_en_met date not null,
  instellingen jsonb not null default '{}'::jsonb check (jsonb_typeof(instellingen) = 'object'),
  totalen jsonb not null default '{}'::jsonb check (jsonb_typeof(totalen) = 'object'),
  -- de momentopname (17.7): de gebruikte invoer en de versie van de rekencode
  invoer jsonb not null default '{}'::jsonb check (jsonb_typeof(invoer) = 'object'),
  rekenversie text not null check (rekenversie ~ '^[0-9]+(\.[0-9]+)*$'),
  klaargezet_op timestamptz not null default now(),
  klaargezet_door uuid,
  gemarkeerd_op timestamptz,
  gemarkeerd_door uuid,
  geannuleerd_op timestamptz,
  geannuleerd_door uuid,
  ongedaan_op timestamptz,
  ongedaan_door uuid,
  ongedaan_reden text check (char_length(btrim(ongedaan_reden)) between 1 and 500),
  unique (id, schooljaar)
);
-- Hoogstens één facturatie klaar per soort en per schooljaar (T3, B132).
create unique index if not exists facturaties_een_klaar on public.facturaties (maximumfactuur, schooljaar) where stand = 'klaar';
alter table public.facturaties enable row level security;

-- De uitkomst per leerling (T7), met de vaste referentie (B68).
create table if not exists public.facturatie_leerlingen (
  facturatie_id uuid not null references public.facturaties (id),
  leerling_id uuid not null references public.leerlingen (id),
  plafondrekening_id uuid not null references public.plafondrekeningen (id),
  referentie text not null check (char_length(referentie) between 1 and 60),
  klas_naam text,
  vertrokken boolean not null default false,
  schoolverlater boolean not null default false,
  bedrag_cent integer not null,
  uitkomst text not null check (uitkomst in ('te_factureren', 'credit', 'credit_blijft_staan', 'onder_minimum', 'niets', 'geblokkeerd')),
  reden text check (char_length(reden) <= 500),
  gemarkeerd boolean,                                    -- leeg tot het markeren; false = toch niet gefactureerd
  primary key (facturatie_id, leerling_id)
);
create index if not exists facturatie_leerlingen_leerling on public.facturatie_leerlingen (leerling_id);
alter table public.facturatie_leerlingen enable row level security;

-- ---------- Correcties (12, F8, T7) ----------
create table if not exists public.correcties (
  id uuid primary key default gen_random_uuid(),
  schooljaar text not null references public.schooljaren (schooljaar),
  maximumfactuur text not null default 'scherp' check (maximumfactuur in ('scherp', 'minder_scherp')),
  herkomst text not null default 'manueel' check (herkomst in ('manueel', 'automatisch')),
  -- een automatische correctie kent haar oorzaak, zodat ze nooit twee keer ontstaat
  oorzaak text check (char_length(oorzaak) between 3 and 300),
  activiteit_id uuid,
  datum date not null,
  reden text not null check (reden = btrim(reden) and char_length(reden) between 1 and 500),   -- voor de ouders
  totaal_cent integer,                                   -- als het bedrag als totaal ingegeven werd
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  unique (id, schooljaar),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar),
  constraint correcties_oorzaak check (herkomst = 'manueel' or oorzaak is not null)
);
create unique index if not exists correcties_oorzaak_uniek on public.correcties (oorzaak) where oorzaak is not null;
create index if not exists correcties_activiteit on public.correcties (activiteit_id);
alter table public.correcties enable row level security;

create table if not exists public.correctie_leerlingen (
  correctie_id uuid not null,
  leerling_id uuid not null references public.leerlingen (id),
  schooljaar text not null,
  bedrag_cent integer not null check (bedrag_cent <> 0),   -- meer dan nul: bijfactureren; minder: crediteren
  -- bij een credit van een meerdaagse (B115): het voorstel en de niet-recupereerbare kosten
  voorstel_cent integer check (voorstel_cent >= 0),
  niet_recupereerbaar_cent integer check (niet_recupereerbaar_cent >= 0),
  niet_recupereerbaar_waarvoor text check (char_length(btrim(niet_recupereerbaar_waarvoor)) between 1 and 200),
  gefactureerd_in uuid references public.facturaties (id),
  primary key (correctie_id, leerling_id),
  foreign key (correctie_id, schooljaar) references public.correcties (id, schooljaar) on delete cascade,
  constraint correctie_leerlingen_waarvoor check (
    coalesce(niet_recupereerbaar_cent, 0) = 0 or niet_recupereerbaar_waarvoor is not null)
);
create index if not exists correctie_leerlingen_leerling on public.correctie_leerlingen (leerling_id);
alter table public.correctie_leerlingen enable row level security;

-- De interne notitie staat apart: enkel beheerders lezen ze (T6).
create table if not exists public.interne_notities (
  correctie_id uuid primary key,
  schooljaar text not null,
  tekst text not null check (tekst = btrim(tekst) and char_length(tekst) between 1 and 1000),
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  foreign key (correctie_id, schooljaar) references public.correcties (id, schooljaar) on delete cascade
);
alter table public.interne_notities enable row level security;

-- De regels van een facturatie: per leerling en per activiteit één detailregel (B85), en daarnaast
-- correcties, de plafondregel en afboekingen (16.8, B138).
create table if not exists public.facturatieregels (
  id uuid primary key default gen_random_uuid(),
  facturatie_id uuid not null,
  leerling_id uuid not null,
  plafondrekening_id uuid not null references public.plafondrekeningen (id),
  soort text not null check (soort in ('activiteit', 'correctie', 'plafond', 'afboeking')),
  activiteit_id uuid references public.activiteiten (id),
  correctie_id uuid references public.correcties (id),
  datum date,
  omschrijving text not null check (char_length(omschrijving) between 1 and 200),
  status_naam text,
  aangerekend boolean,
  bedrag_activiteit_cent integer,
  bedrag_vervoer_cent integer,
  bedrag_cent integer not null,
  plafond_cent integer,                                  -- het plafond dat toen gold (T4)
  vaste_reden text check (char_length(vaste_reden) <= 200),
  drempel_cent integer,                                  -- de gebruikte marge of drempel bij een afboeking (B159)
  leerjaar smallint check (leerjaar between 1 and 6),    -- bij minder scherp: voor "een leerjaar overdoen" (B106)
  foreign key (facturatie_id, leerling_id) references public.facturatie_leerlingen (facturatie_id, leerling_id)
);
create index if not exists facturatieregels_facturatie on public.facturatieregels (facturatie_id, leerling_id);
create index if not exists facturatieregels_rekening on public.facturatieregels (plafondrekening_id);
create index if not exists facturatieregels_activiteit on public.facturatieregels (activiteit_id);
alter table public.facturatieregels enable row level security;

-- "Markering herstellen" voor één leerling komt erbij als nieuwe registratie; de facturatie zelf
-- wijzigt nooit meer (B68).
create table if not exists public.herstelregistraties (
  id uuid primary key default gen_random_uuid(),
  facturatie_id uuid not null,
  leerling_id uuid not null,
  reden text not null check (reden = btrim(reden) and char_length(reden) between 1 and 500),
  hersteld_op timestamptz not null default now(),
  hersteld_door uuid,
  unique (facturatie_id, leerling_id),
  foreign key (facturatie_id, leerling_id) references public.facturatie_leerlingen (facturatie_id, leerling_id)
);
alter table public.herstelregistraties enable row level security;

-- De verdeling van toen (B92): na een facturatie blijft ze gelden, tot "opnieuw verdelen".
create table if not exists public.verdelingen (
  id uuid primary key default gen_random_uuid(),
  activiteit_id uuid not null,
  schooljaar text not null,
  facturatie_id uuid not null references public.facturaties (id),
  volgnummer smallint not null default 1,
  gegevens jsonb not null default '{}'::jsonb check (jsonb_typeof(gegevens) = 'object'),
  vastgelegd_op timestamptz not null default now(),
  vastgelegd_door uuid,
  unique (activiteit_id, volgnummer),
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar)
);
alter table public.verdelingen enable row level security;

create table if not exists public.verdeling_leerlingen (
  verdeling_id uuid not null references public.verdelingen (id),
  leerling_id uuid not null references public.leerlingen (id),
  aangerekend boolean not null,
  prijs_per_kind boolean not null default false,
  bedrag_activiteit_cent integer,
  bedrag_vervoer_cent integer,
  bedrag_cent integer not null,
  primary key (verdeling_id, leerling_id)
);
alter table public.verdeling_leerlingen enable row level security;

-- Het geëxporteerde bestand zelf hoort bij de momentopname (17.7).
create table if not exists public.facturatie_bestanden (
  id uuid primary key default gen_random_uuid(),
  facturatie_id uuid not null references public.facturaties (id),
  soort text not null check (soort in ('csv', 'xlsx', 'pdf')),
  naam text not null check (char_length(naam) between 1 and 200),
  inhoud bytea not null,
  gemaakt_op timestamptz not null default now(),
  gemaakt_door uuid
);
create index if not exists facturatie_bestanden_facturatie on public.facturatie_bestanden (facturatie_id);
alter table public.facturatie_bestanden enable row level security;

-- ---------- Afwijkingen van het minder scherpe plafond (B160, B161) ----------
-- Uitdrukkelijk gemarkeerd en nooit gewist, zodat een inspectie ze terugvindt.
create table if not exists public.afwijkingen (
  id uuid primary key default gen_random_uuid(),
  activiteit_id uuid not null,
  schooljaar text not null,
  reden text not null check (reden = btrim(reden) and char_length(reden) between 1 and 500),
  akkoord_ouders_op date,
  vermelden_voor_ouders boolean not null default false,
  ingetrokken_op timestamptz,
  ingetrokken_door uuid,
  aangemaakt_op timestamptz not null default now(),
  aangemaakt_door uuid,
  bijgewerkt_op timestamptz not null default now(),
  bijgewerkt_door uuid,
  foreign key (activiteit_id, schooljaar) references public.activiteiten (id, schooljaar)
);
alter table public.afwijkingen enable row level security;

create table if not exists public.afwijking_leerlingen (
  afwijking_id uuid not null references public.afwijkingen (id),
  leerling_id uuid not null references public.leerlingen (id),
  primary key (afwijking_id, leerling_id)
);
alter table public.afwijking_leerlingen enable row level security;

-- ---------- Bewaarde rapporten (10.1, B146) ----------
-- De momentopname van wat aan de boekhouding gegeven werd; de stand op het einde is het begin van
-- de volgende periode.
create table if not exists public.bewaarde_rapporten (
  id uuid primary key default gen_random_uuid(),
  soort text not null default 'boekhouding' check (soort in ('boekhouding')),
  maximumfactuur text not null check (maximumfactuur in ('scherp', 'minder_scherp')),
  begindatum date not null,
  peildatum date not null,
  operatie uuid not null unique,
  instellingen jsonb not null default '{}'::jsonb check (jsonb_typeof(instellingen) = 'object'),
  totalen jsonb not null default '{}'::jsonb check (jsonb_typeof(totalen) = 'object'),
  invoer jsonb not null default '{}'::jsonb check (jsonb_typeof(invoer) = 'object'),
  rekenversie text not null check (rekenversie ~ '^[0-9]+(\.[0-9]+)*$'),
  bewaard_op timestamptz not null default now(),
  bewaard_door uuid,
  constraint bewaarde_rapporten_periode check (peildatum >= begindatum)
);
alter table public.bewaarde_rapporten enable row level security;

create table if not exists public.bewaard_rapport_leerlingen (
  rapport_id uuid not null references public.bewaarde_rapporten (id),
  leerling_id uuid not null references public.leerlingen (id),
  schooljaar text not null references public.schooljaren (schooljaar),
  aanrekenbaar_begin_cent integer not null,
  aanrekenbaar_einde_cent integer not null,
  werkelijk_einde_cent integer not null,
  voorlopig_cent integer not null default 0,
  gefactureerd_cent integer not null default 0,
  primary key (rapport_id, leerling_id, schooljaar)
);
alter table public.bewaard_rapport_leerlingen enable row level security;

-- ---------- Jaarafsluitingen (14, B67) ----------
-- De volledige stand van een schooljaar, per leerling en per activiteit, met de rekenversie.
create table if not exists public.jaarafsluitingen (
  id uuid primary key default gen_random_uuid(),
  schooljaar text not null references public.schooljaren (schooljaar),
  rekenversie text not null check (rekenversie ~ '^[0-9]+(\.[0-9]+)*$'),
  controles jsonb not null default '{}'::jsonb check (jsonb_typeof(controles) = 'object'),
  totalen jsonb not null default '{}'::jsonb check (jsonb_typeof(totalen) = 'object'),
  afgesloten_op timestamptz not null default now(),
  afgesloten_door uuid,
  heropend_op timestamptz,
  heropend_door uuid,
  heropend_reden text check (char_length(btrim(heropend_reden)) between 1 and 500)
);
create unique index if not exists jaarafsluitingen_geldend on public.jaarafsluitingen (schooljaar) where heropend_op is null;
alter table public.jaarafsluitingen enable row level security;

create table if not exists public.jaarafsluiting_leerlingen (
  jaarafsluiting_id uuid not null references public.jaarafsluitingen (id),
  leerling_id uuid not null references public.leerlingen (id),
  maximumfactuur text not null check (maximumfactuur in ('scherp', 'minder_scherp')),
  klas_naam text,
  plafond_cent integer,
  werkelijk_cent integer not null,
  aanrekenbaar_cent integer not null,
  school_cent integer not null,
  gefactureerd_cent integer not null default 0,
  voorschotten_cent integer not null default 0,
  primary key (jaarafsluiting_id, leerling_id, maximumfactuur)
);
alter table public.jaarafsluiting_leerlingen enable row level security;

create table if not exists public.jaarafsluiting_regels (
  id uuid primary key default gen_random_uuid(),
  jaarafsluiting_id uuid not null references public.jaarafsluitingen (id),
  leerling_id uuid not null references public.leerlingen (id),
  maximumfactuur text not null check (maximumfactuur in ('scherp', 'minder_scherp')),
  activiteit_id uuid references public.activiteiten (id),
  correctie_id uuid references public.correcties (id),
  datum date,
  omschrijving text not null check (char_length(omschrijving) between 1 and 200),
  klas_naam text,
  status_naam text,
  aangerekend boolean,
  bedrag_activiteit_cent integer,
  bedrag_vervoer_cent integer,
  bedrag_cent integer not null,
  afwijking_plafond boolean not null default false       -- "afwijking van de wettelijke maximumfactuur" (B160)
);
create index if not exists jaarafsluiting_regels_leerling on public.jaarafsluiting_regels (jaarafsluiting_id, leerling_id);
alter table public.jaarafsluiting_regels enable row level security;

-- De activiteit zoals ze toen was: een latere wijziging in de uitstappentool verandert een afgesloten
-- jaar niet meer.
create table if not exists public.jaarafsluiting_activiteiten (
  jaarafsluiting_id uuid not null references public.jaarafsluitingen (id),
  activiteit_id uuid not null references public.activiteiten (id),
  gegevens jsonb not null check (jsonb_typeof(gegevens) = 'object'),
  primary key (jaarafsluiting_id, activiteit_id)
);
alter table public.jaarafsluiting_activiteiten enable row level security;

-- ---------- Back-ups en exports (17.9, B135) ----------
create table if not exists public.backups (
  id uuid primary key default gen_random_uuid(),
  soort text not null check (soort in ('nacht', 'export')),
  gemaakt_op timestamptz not null default now(),
  gemaakt_door uuid,
  gelukt boolean not null,
  pad text check (char_length(pad) <= 300),
  aantallen jsonb,
  melding text check (char_length(melding) <= 500)
);
alter table public.backups enable row level security;

-- ---------- Het logboek (17.5, T9) ----------
-- Enkel toevoegen: niemand kan het wijzigen of wissen, ook de beheerder niet.
create table if not exists public.logboek (
  id bigint generated always as identity primary key,
  op timestamptz not null default clock_timestamp(),
  wie uuid,
  databankrol text,
  transactie bigint not null default txid_current(),
  tabel text not null,
  rij text not null,
  schooljaar text,
  actie text not null check (actie in ('toegevoegd', 'gewijzigd', 'gewist')),
  oud jsonb,
  nieuw jsonb
);
create index if not exists logboek_rij on public.logboek (tabel, rij);
create index if not exists logboek_schooljaar on public.logboek (schooljaar, op);
create index if not exists logboek_op on public.logboek (op);
alter table public.logboek enable row level security;

-- Verbanden die in een kring lopen, komen er na de tabellen bij.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'klaslijsten_bevestiging_fkey') then
    alter table public.klaslijsten
      add constraint klaslijsten_bevestiging_fkey foreign key (bevestiging_id) references public.bevestigingen (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wijzigingen_aanvraag_fkey') then
    alter table public.wijzigingen
      add constraint wijzigingen_aanvraag_fkey foreign key (aanvraag_id) references public.wijzigingsaanvragen (id);
  end if;
end
$$;

-- ============================================================================================
-- 3. Algemene functies
-- ============================================================================================
-- Alle functies staan in het afgeschermde schema mt_intern: de Data API bereikt het niet. Een
-- functie met security definer heeft een vaste search_path en geen rechten voor public of anon
-- (regel 5). De hulpfuncties van de toegang (deel 4) zijn zelf de toegangscontrole; de functies
-- achter een trigger kan niemand oproepen.

-- "Vandaag" in de tijd van Brussel: de databank zelf draait in UTC (17.1).
create or replace function mt_intern.vandaag() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Europe/Brussels')::date
$$;
revoke all on function mt_intern.vandaag() from public;

-- Wie en wanneer, op elke rij met die kolommen. Wie aangemeld is, kan ze niet zelf kiezen; zonder
-- aanmelding (een script, een herstel) blijft staan wat meegegeven werd.
create or replace function mt_intern.stempel() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_wie uuid := auth.uid();
begin
  if tg_op = 'UPDATE' then
    new.aangemaakt_op := old.aangemaakt_op;
    new.aangemaakt_door := old.aangemaakt_door;
    new.bijgewerkt_op := now();
    new.bijgewerkt_door := v_wie;
  elsif v_wie is not null then
    new.aangemaakt_op := now();
    new.aangemaakt_door := v_wie;
    new.bijgewerkt_op := now();
    new.bijgewerkt_door := v_wie;
  end if;
  return new;
end
$$;
revoke all on function mt_intern.stempel() from public;

-- ============================================================================================
-- 4. De toegang: de hulpfuncties (17.2, 17.3, T5, T6)
-- ============================================================================================

-- De tweestapsverificatie, in de databank afgedwongen. Waar als:
--   - het toegangsbewijs van een aangemelde gebruiker komt, met aal2;
--   - de code uit de app (methode totp in amr, niet het vernieuwen van het token) niet in de
--     toekomst ligt en jonger is dan de ingestelde termijn (standaard 14 dagen);
--   - de sessie nog bestaat;
--   - de gebruiker actief is, zijn eerste aanmelding afrondde, geen tijdelijk wachtwoord meer heeft
--     en geen accounthandeling open heeft staan.
-- Ontbrekende of vreemde claims: geen toegang.
create or replace function mt_intern.mt_mfa_ok() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb;
  v_wie uuid;
  v_sessie uuid;
  v_totp numeric;
  v_nu numeric;
  v_dagen integer;
begin
  v_claims := auth.jwt();
  v_wie := auth.uid();
  if v_claims is null or v_wie is null then return false; end if;
  if (v_claims ->> 'role') is distinct from 'authenticated' then return false; end if;
  if (v_claims ->> 'aal') is distinct from 'aal2' then return false; end if;
  if coalesce(v_claims ->> 'is_anonymous', 'false') <> 'false' then return false; end if;
  if jsonb_typeof(v_claims -> 'amr') is distinct from 'array' then return false; end if;

  select max((e.claim ->> 'timestamp')::numeric) into v_totp
    from jsonb_array_elements(v_claims -> 'amr') as e(claim)
   where jsonb_typeof(e.claim) = 'object'
     and e.claim ->> 'method' = 'totp'
     and jsonb_typeof(e.claim -> 'timestamp') = 'number';
  if v_totp is null then return false; end if;

  select i.code_geldig_dagen into v_dagen from public.instellingen i;
  if v_dagen is null then return false; end if;
  v_nu := extract(epoch from now());
  -- niet in de toekomst: één minuut speling voor een klok die verschilt
  if v_totp > v_nu + 60 then return false; end if;
  if v_totp <= v_nu - v_dagen * 86400 then return false; end if;

  v_sessie := (v_claims ->> 'session_id')::uuid;
  if v_sessie is null then return false; end if;
  if not exists (select 1 from auth.sessions s
                  where s.id = v_sessie and s.user_id = v_wie
                    and (s.not_after is null or s.not_after > now())) then
    return false;
  end if;

  return exists (select 1 from public.gebruikers g
                  where g.id = v_wie and g.actief and g.eerste_aanmelding_afgerond
                    and not g.wachtwoord_tijdelijk and g.open_operatie is null);
exception when others then
  return false;
end
$$;
revoke all on function mt_intern.mt_mfa_ok() from public;

-- De rol van wie aangemeld is: beheerder, leerkracht of lezer. Leeg zonder geldige tweestapsverificatie.
create or replace function mt_intern.mt_rol() returns text
language sql stable security definer set search_path = '' as $$
  select g.rol from public.gebruikers g where g.id = auth.uid() and mt_intern.mt_mfa_ok()
$$;
revoke all on function mt_intern.mt_rol() from public;

create or replace function mt_intern.mt_is_beheerder() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(mt_intern.mt_rol() = 'beheerder', false)
$$;
revoke all on function mt_intern.mt_is_beheerder() from public;

-- Beheerder en lezer lezen alles, behalve wat enkel voor beheerders is.
create or replace function mt_intern.mt_leest_alles() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(mt_intern.mt_rol() in ('beheerder', 'lezer'), false)
$$;
revoke all on function mt_intern.mt_leest_alles() from public;

-- De klassen waarvoor een leerkracht nu mag werken: haar klassen van het lopende schooljaar, en die
-- van een schooljaar dat voorbij is zolang daar nog een aanwezigheidslijst openstaat (B171). Een
-- afgesloten schooljaar nooit.
create or replace function mt_intern.mt_mijn_klassen() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(t.klas_id), '{}'::uuid[])
    from public.klastoewijzingen t
    join public.schooljaren s on s.schooljaar = t.schooljaar
   where t.gebruiker_id = auth.uid()
     and (select mt_intern.mt_rol()) = 'leerkracht'
     and (s.stand = 'lopend'
          or (s.stand = 'voorbij'
              and exists (select 1 from public.klaslijsten l where l.klas_id = t.klas_id and l.stand = 'open')))
$$;
revoke all on function mt_intern.mt_mijn_klassen() from public;

-- De leerlingen die in een van die klassen zitten of zaten, of op een deelnemerslijst ervan staan:
-- hun naam heeft een leerkracht nodig voor haar lijsten.
create or replace function mt_intern.mt_mijn_leerlingen() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x.leerling_id), '{}'::uuid[])
    from (select k.leerling_id from public.klasindelingen k
           where k.klas_id = any ((select mt_intern.mt_mijn_klassen())::uuid[])
          union all
          select d.leerling_id from public.deelnemers d
           where d.klas_id = any ((select mt_intern.mt_mijn_klassen())::uuid[])) x
$$;
revoke all on function mt_intern.mt_mijn_leerlingen() from public;

-- De leerlingen die vandaag in een van haar klassen zitten: van hen leest ze de volledige fiche, ook
-- wat in een vroegere klas gebeurde, maar niet de rest van die vroegere klas (T6).
create or replace function mt_intern.mt_mijn_leerlingen_nu() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct k.leerling_id), '{}'::uuid[])
    from public.klasindelingen k
   where k.klas_id = any ((select mt_intern.mt_mijn_klassen())::uuid[])
     and k.van <= mt_intern.vandaag() and mt_intern.vandaag() < k.einde
$$;
revoke all on function mt_intern.mt_mijn_leerlingen_nu() from public;

-- Mag wie aangemeld is voor deze klas werken? Een beheerder altijd, een leerkracht voor haar klassen,
-- een lezer nooit.
create or replace function mt_intern.mt_mag_klas(p_klas uuid, p_schooljaar text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case (select mt_intern.mt_rol())
    when 'beheerder' then true
    when 'leerkracht' then p_klas = any ((select mt_intern.mt_mijn_klassen())::uuid[])
    else false
  end and exists (select 1 from public.klassen k where k.id = p_klas and k.schooljaar = p_schooljaar)
$$;
revoke all on function mt_intern.mt_mag_klas(uuid, text) from public;

-- Mag wie aangemeld is voor deze lijst werken? In een schooljaar dat voorbij is, kan een leerkracht
-- enkel nog bij wat openstaat (B171).
create or replace function mt_intern.mt_mag_lijst(p_activiteit uuid, p_klas uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case (select mt_intern.mt_rol())
    when 'beheerder' then true
    when 'leerkracht' then
      p_klas = any ((select mt_intern.mt_mijn_klassen())::uuid[])
      and exists (select 1 from public.klaslijsten l
                    join public.schooljaren s on s.schooljaar = l.schooljaar
                   where l.activiteit_id = p_activiteit and l.klas_id = p_klas
                     and (s.stand = 'lopend' or l.stand = 'open'))
    else false
  end
$$;
revoke all on function mt_intern.mt_mag_lijst(uuid, uuid) from public;

create or replace function mt_intern.mt_mag_bevestiging(p_bevestiging uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select mt_intern.mt_mag_lijst(b.activiteit_id, b.klas_id)
                     from public.bevestigingen b where b.id = p_bevestiging), false)
$$;
revoke all on function mt_intern.mt_mag_bevestiging(uuid) from public;

create or replace function mt_intern.mt_mag_aanvraag(p_aanvraag uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select mt_intern.mt_mag_lijst(a.activiteit_id, a.klas_id)
                     from public.wijzigingsaanvragen a where a.id = p_aanvraag), false)
$$;
revoke all on function mt_intern.mt_mag_aanvraag(uuid) from public;

-- Een leerkracht leest een correctie als ze over een leerling gaat die nu in haar klas zit.
create or replace function mt_intern.mt_mag_correctie(p_correctie uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case (select mt_intern.mt_rol())
    when 'beheerder' then true
    when 'leerkracht' then exists (
      select 1 from public.correctie_leerlingen c
       where c.correctie_id = p_correctie
         and c.leerling_id = any ((select mt_intern.mt_mijn_leerlingen_nu())::uuid[]))
    else false
  end
$$;
revoke all on function mt_intern.mt_mag_correctie(uuid) from public;

-- ============================================================================================
-- 5. De bewakers van de gegevens
-- ============================================================================================
-- Regels die voor iedereen gelden, ook voor een beheerder en voor een script: ze bewaken wat klopt,
-- niet wie iets mag.

-- Een afgesloten schooljaar is in de databank vergrendeld (14).
create or replace function mt_intern.bewaak_schooljaar() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_jaren text[];
  v_dicht text;
begin
  if tg_op = 'INSERT' then
    v_jaren := array[new.schooljaar];
  elsif tg_op = 'DELETE' then
    v_jaren := array[old.schooljaar];
  else
    v_jaren := array[old.schooljaar, new.schooljaar];
  end if;
  select s.schooljaar into v_dicht from public.schooljaren s
   where s.schooljaar = any (v_jaren) and s.stand = 'afgesloten' limit 1;
  if v_dicht is not null then
    raise exception 'MT: schooljaar % is afgesloten en kan niet meer wijzigen', v_dicht using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_schooljaar() from public;

-- De stand van een schooljaar gaat enkel vooruit, of terug bij een heropening (B132, B144).
create or replace function mt_intern.bewaak_schooljaren() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.stand <> 'in_te_vullen' then
      raise exception 'MT: enkel een schooljaar dat nog in te vullen is, kan gewist worden' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.schooljaar <> old.schooljaar then
    raise exception 'MT: het schooljaar zelf kan niet wijzigen' using errcode = '42501';
  end if;
  if new.stand <> old.stand then
    if not ((old.stand = 'in_te_vullen' and new.stand = 'lopend')
            or (old.stand = 'lopend' and new.stand = 'voorbij')
            or (old.stand = 'voorbij' and new.stand = 'afgesloten')
            or (old.stand = 'afgesloten' and new.stand = 'voorbij')) then
      raise exception 'MT: een schooljaar kan niet van % naar %', old.stand, new.stand using errcode = '42501';
    end if;
    if new.stand = 'lopend' then new.lopend_sinds := now(); end if;
    if new.stand = 'afgesloten' then new.afgesloten_op := now(); end if;
    if old.stand = 'afgesloten' then new.afgesloten_op := null; end if;
  elsif old.stand = 'afgesloten' then
    raise exception 'MT: schooljaar % is afgesloten en kan niet meer wijzigen', old.schooljaar using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_schooljaren() from public;

-- Het leerjaar van een lagere klas leidt de MT zelf af uit het eerste cijfer van de naam: 4A is het
-- 4de leerjaar (B208). Enkel als de beheerder het zelf invulde, blijft dat staan. Kleuter of lager
-- komt uit de groep in de klassenlijst, nooit uit de naam: 1KA en 1instA zijn kleuterklassen (B157).
create or replace function mt_intern.klas_afleiden() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.schooljaar <> old.schooljaar or new.bron_id <> old.bron_id) then
    raise exception 'MT: het schooljaar en de herkomst van een klas kunnen niet wijzigen' using errcode = '42501';
  end if;
  if new.groep <> 'Lager' then
    new.leerjaar := null;
    new.leerjaar_manueel := false;
  elsif not new.leerjaar_manueel then
    new.leerjaar := case when new.naam ~ '^[1-6]' then left(new.naam, 1)::smallint end;
  end if;
  return new;
end
$$;
revoke all on function mt_intern.klas_afleiden() from public;

-- Een naam hoort per schooljaar bij één klas, ook een vroegere naam (B158).
create or replace function mt_intern.klas_namen_bijhouden() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.naam = old.naam then return null; end if;
    update public.klas_namen set huidig = false
     where schooljaar = old.schooljaar and naam = old.naam and klas_id = old.id;
  end if;
  insert into public.klas_namen (schooljaar, naam, klas_id, huidig)
  values (new.schooljaar, new.naam, new.id, true)
  on conflict (schooljaar, naam) do update set huidig = true
    where public.klas_namen.klas_id = excluded.klas_id;
  if not found then
    raise exception 'MT: de naam % is in % al van een andere klas; ook een vroegere naam telt', new.naam, new.schooljaar
      using errcode = '23505';
  end if;
  return null;
end
$$;
revoke all on function mt_intern.klas_namen_bijhouden() from public;

-- Een klas uit de groep Andere heeft geen klasindeling: daar telt de deelnemerslijst (B143).
create or replace function mt_intern.bewaak_klasindeling() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.leerling_id <> old.leerling_id or new.schooljaar <> old.schooljaar) then
    raise exception 'MT: de leerling en het schooljaar van een klasindeling kunnen niet wijzigen' using errcode = '42501';
  end if;
  if not exists (select 1 from public.klassen k where k.id = new.klas_id and k.groep in ('Kleuter', 'Lager')) then
    raise exception 'MT: een klas uit de groep Andere heeft geen klasindeling (B143)' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_klasindeling() from public;

-- Een status die al gebruikt werd, kan niet gewist worden en kan niet meer van "aangerekend"
-- wisselen: voor een andere betekenis maak je een nieuwe status (B73).
create or replace function mt_intern.bewaak_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.soort <> 'afwezig' or old.gebruikt then
      raise exception 'MT: de status % kan niet gewist worden, enkel uitgezet (B73)', old.naam using errcode = '42501';
    end if;
    return old;
  end if;
  if new.soort <> old.soort then
    raise exception 'MT: de soort van een status kan niet wijzigen' using errcode = '42501';
  end if;
  if old.gebruikt then
    if new.aangerekend <> old.aangerekend then
      raise exception 'MT: de status % is al gebruikt; maak een nieuwe status voor een andere betekenis (B73)', old.naam
        using errcode = '42501';
    end if;
    new.gebruikt := true;
  end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_status() from public;

-- Markeert een status als gebruikt, en weigert "aanwezig" bij de afwezigheden: wie aanwezig is,
-- heeft geen rij.
create or replace function mt_intern.status_gebruikt() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_rij jsonb := to_jsonb(new);
  v_status uuid;
  i integer;
begin
  for i in 0 .. tg_nargs - 1 loop
    v_status := nullif(v_rij ->> tg_argv[i], '')::uuid;
    if v_status is not null then
      if tg_table_name = 'afwezigheden'
         and exists (select 1 from public.statussen s where s.id = v_status and s.soort = 'aanwezig') then
        raise exception 'MT: wie aanwezig is, heeft geen rij bij de afwezigheden' using errcode = '23514';
      end if;
      update public.statussen set gebruikt = true where id = v_status and not gebruikt;
    end if;
  end loop;
  return null;
end
$$;
revoke all on function mt_intern.status_gebruikt() from public;

-- Een voorschot ligt vast zodra het aangerekend is (B162). Het laatste kan aanvullen tot het
-- plafond: dan rekent de MT de bedragen bij het aanrekenen, het plafond min de vorige (B145).
create or replace function mt_intern.bewaak_voorschot() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_jaar public.schooljaren%rowtype;
  v_som_kleuter bigint;
  v_som_lager bigint;
begin
  if tg_op <> 'INSERT' then
    if old.aangerekend_op is not null then
      raise exception 'MT: dit voorschot is aangerekend en ligt vast (B162)' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if tg_op = 'UPDATE' then
    if new.schooljaar <> old.schooljaar then
      raise exception 'MT: een voorschot kan niet naar een ander schooljaar' using errcode = '42501';
    end if;
  end if;
  if new.aangerekend_op is null then
    new.aangerekend_door := null;
    new.aangerekend_vastgelegd_op := null;
    if new.vult_aan then
      new.bedrag_kleuter_cent := null;
      new.bedrag_lager_cent := null;
    end if;
    return new;
  end if;
  -- Het voorschot wordt nu aangerekend: wie die dag ingeschreven is, krijgt het.
  select * into v_jaar from public.schooljaren s where s.schooljaar = new.schooljaar;
  if new.aangerekend_op < v_jaar.begint_op or new.aangerekend_op > v_jaar.eindigt_op
     or new.aangerekend_op > mt_intern.vandaag() then
    raise exception 'MT: de datum van het aanrekenen ligt in het schooljaar, en niet in de toekomst' using errcode = '23514';
  end if;
  if new.vult_aan then
    select coalesce(sum(v.bedrag_kleuter_cent), 0), coalesce(sum(v.bedrag_lager_cent), 0)
      into v_som_kleuter, v_som_lager
      from public.voorschotten v where v.schooljaar = new.schooljaar and v.id <> new.id;
    new.bedrag_kleuter_cent := v_jaar.plafond_kleuter_cent - v_som_kleuter;
    new.bedrag_lager_cent := v_jaar.plafond_lager_cent - v_som_lager;
    if new.bedrag_kleuter_cent is null or new.bedrag_lager_cent is null
       or new.bedrag_kleuter_cent < 0 or new.bedrag_lager_cent < 0 then
      raise exception 'MT: dit voorschot kan niet aanvullen tot het plafond: het plafond ontbreekt, of de vorige voorschotten zijn samen al hoger'
        using errcode = '23514';
    end if;
  end if;
  new.aangerekend_door := auth.uid();
  new.aangerekend_vastgelegd_op := now();
  return new;
end
$$;
revoke all on function mt_intern.bewaak_voorschot() from public;

-- De voorschotten zijn samen nooit hoger dan het plafond, en enkel het laatste kan aanvullen (B96, B145).
create or replace function mt_intern.controleer_voorschotten(p_schooljaar text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_kleuter integer;
  v_lager integer;
  v_som_kleuter bigint;
  v_som_lager bigint;
begin
  select s.plafond_kleuter_cent, s.plafond_lager_cent into v_kleuter, v_lager
    from public.schooljaren s where s.schooljaar = p_schooljaar;
  if not found then return; end if;
  select coalesce(sum(v.bedrag_kleuter_cent), 0), coalesce(sum(v.bedrag_lager_cent), 0)
    into v_som_kleuter, v_som_lager
    from public.voorschotten v where v.schooljaar = p_schooljaar;
  if (v_kleuter is not null and v_som_kleuter > v_kleuter) or (v_lager is not null and v_som_lager > v_lager) then
    raise exception 'MT: de voorschotten zijn samen hoger dan het plafond (B96)' using errcode = '23514';
  end if;
  if exists (select 1 from public.voorschotten v
              where v.schooljaar = p_schooljaar and v.vult_aan
                and exists (select 1 from public.voorschotten w
                             where w.schooljaar = v.schooljaar and w.volgnummer > v.volgnummer)) then
    raise exception 'MT: enkel het laatste voorschot kan aanvullen tot het plafond (B145)' using errcode = '23514';
  end if;
end
$$;
revoke all on function mt_intern.controleer_voorschotten(text) from public;

create or replace function mt_intern.na_voorschot() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    perform mt_intern.controleer_voorschotten(old.schooljaar);
  else
    perform mt_intern.controleer_voorschotten(new.schooljaar);
  end if;
  return null;
end
$$;
revoke all on function mt_intern.na_voorschot() from public;

create or replace function mt_intern.na_plafond() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.plafond_kleuter_cent is distinct from old.plafond_kleuter_cent
     or new.plafond_lager_cent is distinct from old.plafond_lager_cent then
    perform mt_intern.controleer_voorschotten(new.schooljaar);
  end if;
  return null;
end
$$;
revoke all on function mt_intern.na_plafond() from public;

-- Nooit de laatste actieve beheerder uitschakelen (17.4).
create or replace function mt_intern.bewaak_gebruikers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_valt_weg boolean;
begin
  if not (old.rol = 'beheerder' and old.actief) then return null; end if;
  if tg_op = 'DELETE' then
    v_valt_weg := true;
  else
    v_valt_weg := new.rol <> 'beheerder' or not new.actief;
  end if;
  if v_valt_weg then
    perform pg_advisory_xact_lock(hashtext('mt_laatste_beheerder'));
    if not exists (select 1 from public.gebruikers g where g.rol = 'beheerder' and g.actief and g.id <> old.id) then
      raise exception 'MT: de laatste actieve beheerder kan niet uitgeschakeld worden (17.4)' using errcode = '42501';
    end if;
  end if;
  return null;
end
$$;
revoke all on function mt_intern.bewaak_gebruikers() from public;

-- Een tarief geldt vanaf een gekozen beurt, nooit voor beurten die al bevestigd zijn (B73). Wie de
-- kost van een bevestigde beurt wil bijsturen, doet dat bij die beurt zelf (F10).
create or replace function mt_intern.bewaak_tarief() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_oud_regel uuid;
  v_oud_vanaf date;
  v_regel uuid;
  v_vanaf date;
  v_tot date;
  i integer;
begin
  if tg_op <> 'INSERT' then
    v_oud_regel := old.kostenregel_id;
    v_oud_vanaf := old.geldig_vanaf;
  end if;
  if tg_op = 'UPDATE' then
    if new.kostenregel_id = old.kostenregel_id and new.geldig_vanaf = old.geldig_vanaf
       and new.bedrag_cent = old.bedrag_cent then
      return new;
    end if;
  end if;
  for i in 1 .. 2 loop
    if i = 1 then
      if tg_op = 'INSERT' then continue; end if;
      v_regel := v_oud_regel;
      v_vanaf := v_oud_vanaf;
    else
      if tg_op = 'DELETE' then continue; end if;
      v_regel := new.kostenregel_id;
      v_vanaf := new.geldig_vanaf;
    end if;
    -- tot vóór het volgende tarief van dezelfde regel
    select min(t.geldig_vanaf) into v_tot from public.tarieven t
     where t.kostenregel_id = v_regel and t.geldig_vanaf > v_vanaf
       and not (t.kostenregel_id is not distinct from v_oud_regel and t.geldig_vanaf is not distinct from v_oud_vanaf);
    if exists (select 1 from public.kostenregels r
                 join public.activiteiten a on a.lopende_activiteit_id = r.lopende_activiteit_id and a.soort = 'beurt'
                 join public.klaslijsten l on l.activiteit_id = a.id and l.stand = 'bevestigd'
                where r.id = v_regel and a.datum_start >= v_vanaf and (v_tot is null or a.datum_start < v_tot)) then
      raise exception 'MT: dit tarief geldt voor een beurt die al bevestigd is (B73). Kies een latere beurt, of pas de kost van die beurt zelf aan.'
        using errcode = '42501';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_tarief() from public;

-- Een kostenregel waarmee al een bevestigde beurt gerekend is, verandert niet meer van soort en
-- kan niet gewist worden (B73).
create or replace function mt_intern.bewaak_kostenregel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.verdeling = old.verdeling and new.onderdeel = old.onderdeel
       and new.lopende_activiteit_id = old.lopende_activiteit_id then
      return new;
    end if;
  end if;
  if exists (select 1 from public.activiteiten a
               join public.klaslijsten l on l.activiteit_id = a.id and l.stand = 'bevestigd'
              where a.lopende_activiteit_id = old.lopende_activiteit_id and a.soort = 'beurt') then
    raise exception 'MT: met deze kostenregel is al een bevestigde beurt gerekend (B73)' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_kostenregel() from public;

-- Een correctie wijzigt tot ze gefactureerd is; daarna enkel met een nieuwe correctie (12).
create or replace function mt_intern.bewaak_correctie() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.correctie_leerlingen c
              where c.correctie_id = old.id and c.gefactureerd_in is not null) then
    raise exception 'MT: deze correctie is gefactureerd; enkel een nieuwe correctie kan ze nog bijsturen (12)'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_correctie() from public;

create or replace function mt_intern.bewaak_correctie_leerling() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.gefactureerd_in is not null then
    if tg_op = 'DELETE' then
      raise exception 'MT: deze correctie is gefactureerd en kan niet gewist worden (12)' using errcode = '42501';
    end if;
    if (to_jsonb(new) - 'gefactureerd_in') is distinct from (to_jsonb(old) - 'gefactureerd_in') then
      raise exception 'MT: deze correctie is gefactureerd; enkel een nieuwe correctie kan ze nog bijsturen (12)'
        using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_correctie_leerling() from public;

-- Een deelnemerslijst bestaat enkel bij een klas uit de groep Andere, en wijzigt enkel zolang de
-- lijst niet bevestigd is (B143).
create or replace function mt_intern.bewaak_deelnemers() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_activiteit uuid;
  v_klas uuid;
begin
  if tg_op = 'DELETE' then
    v_activiteit := old.activiteit_id;
    v_klas := old.klas_id;
  else
    v_activiteit := new.activiteit_id;
    v_klas := new.klas_id;
  end if;
  if not exists (select 1 from public.klaslijsten l
                   join public.klassen k on k.id = l.klas_id
                  where l.activiteit_id = v_activiteit and l.klas_id = v_klas
                    and k.groep = 'Andere' and l.stand = 'open') then
    raise exception 'MT: een deelnemerslijst hoort bij een klas uit de groep Andere, en wijzigt enkel zolang de lijst niet bevestigd is (B143)'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
revoke all on function mt_intern.bewaak_deelnemers() from public;

-- Het logboek: enkel toevoegen (T9).
create or replace function mt_intern.bewaak_logboek() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'MT: het logboek kan niet gewijzigd of gewist worden (17.5)' using errcode = '42501';
end
$$;
revoke all on function mt_intern.bewaak_logboek() from public;

-- Het logboek: wie, wanneer, de oude en de nieuwe waarde. Bij een wijziging enkel wat wijzigde.
-- Het eerste argument noemt de kolommen van de sleutel, het tweede de kolommen die er niet in komen.
create or replace function mt_intern.log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_zonder text[] := coalesce(string_to_array(nullif(tg_argv[1], ''), ','), '{}'::text[]);
  v_stil constant text[] := array['aangemaakt_op', 'aangemaakt_door', 'bijgewerkt_op', 'bijgewerkt_door',
                                  'gewijzigd_op', 'gewijzigd_door', 'revisie'];
  v_oud jsonb;
  v_nieuw jsonb;
  v_bron jsonb;
  v_oud_deel jsonb;
  v_nieuw_deel jsonb;
  v_rij text;
begin
  if tg_op <> 'INSERT' then v_oud := to_jsonb(old) - v_zonder; end if;
  if tg_op <> 'DELETE' then v_nieuw := to_jsonb(new) - v_zonder; end if;
  v_bron := coalesce(v_nieuw, v_oud);
  select string_agg(coalesce(v_bron ->> k.kolom, ''), '/' order by k.nr) into v_rij
    from unnest(string_to_array(tg_argv[0], ',')) with ordinality as k(kolom, nr);
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, v_oud -> n.key), jsonb_object_agg(n.key, n.value)
      into v_oud_deel, v_nieuw_deel
      from jsonb_each(v_nieuw) as n
     where n.value is distinct from (v_oud -> n.key) and n.key <> all (v_stil);
    if v_nieuw_deel is null then return null; end if;   -- niets van belang gewijzigd
    v_oud := v_oud_deel;
    v_nieuw := v_nieuw_deel;
  end if;
  insert into public.logboek (wie, databankrol, tabel, rij, schooljaar, actie, oud, nieuw)
  values (auth.uid(),
          coalesce(nullif(current_setting('role', true), 'none'), session_user::text),
          tg_table_name::text, v_rij, v_bron ->> 'schooljaar',
          case tg_op when 'INSERT' then 'toegevoegd' when 'UPDATE' then 'gewijzigd' else 'gewist' end,
          v_oud, v_nieuw);
  return null;
end
$$;
revoke all on function mt_intern.log() from public;

-- ============================================================================================
-- 6. De regels per tabel (RLS)
-- ============================================================================================
-- Elke tabel krijgt twee regels:
--   mt_tweestaps  beperkend, voor elke handeling: zonder geldige tweestapsverificatie niets;
--   mt_lezen      wie welke rijen leest.
-- De leesregel staat hieronder per tabel, in één lijst, zodat ze in één oogopslag na te kijken is.
--   ieder    elke gebruiker van de MT: gegevens zonder leerlingen, zoals klassen en tarieven
--   alles    beheerder en lezer
--   beheer   enkel een beheerder: accounts, beveiliging, interne notities en het logboek (B158)
-- Een leerkracht leest daarnaast: de leerlingen van haar klassen, de lijsten van haar klassen, en
-- alles van de leerlingen die vandaag in haar klas zitten (T6).

do $$
declare
  r record;
  ieder constant text := '(select mt_intern.mt_rol()) is not null';
  alles constant text := '(select mt_intern.mt_leest_alles())';
  beheer constant text := '(select mt_intern.mt_is_beheerder())';
  mijn_klassen constant text := '((select mt_intern.mt_mijn_klassen())::uuid[])';
  mijn_leerlingen constant text := '((select mt_intern.mt_mijn_leerlingen())::uuid[])';
  nu constant text := '((select mt_intern.mt_mijn_leerlingen_nu())::uuid[])';
  lijst constant text := 'mt_intern.mt_mag_lijst(activiteit_id, klas_id)';
begin
  for r in
    select t.tabel, t.lezen from (values
      -- zonder leerlingen: elke gebruiker van de MT
      ('schooljaren', ieder), ('statussen', ieder), ('klassen', ieder), ('klas_namen', ieder),
      ('lopende_activiteiten', ieder), ('lopende_activiteit_klassen', ieder), ('kostenregels', ieder),
      ('tarieven', ieder), ('activiteiten', ieder), ('beurt_kosten', ieder), ('klaslijsten', ieder),
      ('tussenkomsten', ieder),
      -- beheerder en lezer
      ('voorschotten', alles), ('informat_codes', alles), ('schoolverlaters', alles), ('imports', alles),
      ('taken', alles), ('plafondrekeningen', alles), ('beginbedragen', alles), ('afwijkingen', alles),
      ('afwijking_leerlingen', alles), ('facturaties', alles), ('facturatie_leerlingen', alles),
      ('facturatieregels', alles), ('herstelregistraties', alles), ('verdelingen', alles),
      ('verdeling_leerlingen', alles), ('facturatie_bestanden', alles), ('bewaarde_rapporten', alles),
      ('bewaard_rapport_leerlingen', alles), ('jaarafsluitingen', alles), ('jaarafsluiting_leerlingen', alles),
      ('jaarafsluiting_regels', alles), ('jaarafsluiting_activiteiten', alles),
      -- enkel een beheerder
      ('instellingen', beheer), ('account_operaties', beheer), ('interne_notities', beheer),
      ('logboek', beheer), ('backups', beheer),
      -- een gebruiker leest zijn eigen rij; de beheerder alle
      ('gebruikers', beheer || ' or id = (select auth.uid())'),
      ('klastoewijzingen', beheer || ' or gebruiker_id = (select auth.uid())'),
      ('gebruiker_voorkeuren', 'gebruiker_id = (select auth.uid())'),
      -- een leerkracht: de leerlingen van haar klassen
      ('leerlingen', alles || ' or id = any ' || mijn_leerlingen),
      ('klasindelingen', alles || ' or klas_id = any ' || mijn_klassen || ' or leerling_id = any ' || nu),
      ('annulering_betalers', alles || ' or leerling_id = any ' || mijn_leerlingen),
      -- een leerkracht: de lijsten van haar klassen, en alles van wie vandaag in haar klas zit
      ('afwezigheden', alles || ' or ' || lijst || ' or leerling_id = any ' || nu),
      ('deelname', alles || ' or ' || lijst || ' or leerling_id = any ' || nu),
      ('opmerkingen', alles || ' or ' || lijst || ' or leerling_id = any ' || nu),
      ('deelnemers', alles || ' or ' || lijst || ' or leerling_id = any ' || nu),
      ('wijzigingen', alles || ' or ' || lijst || ' or leerling_id = any ' || nu),
      ('bevestigingen', alles || ' or ' || lijst),
      ('wijzigingsaanvragen', alles || ' or ' || lijst),
      ('bevestiging_leerlingen', alles || ' or mt_intern.mt_mag_bevestiging(bevestiging_id) or leerling_id = any ' || nu),
      ('bevestiging_dagen', alles || ' or mt_intern.mt_mag_bevestiging(bevestiging_id) or leerling_id = any ' || nu),
      ('wijzigingsaanvraag_regels', alles || ' or mt_intern.mt_mag_aanvraag(aanvraag_id)'),
      ('correcties', alles || ' or mt_intern.mt_mag_correctie(id)'),
      ('correctie_leerlingen', alles || ' or leerling_id = any ' || nu)
    ) as t(tabel, lezen)
  loop
    execute format('drop policy if exists mt_tweestaps on public.%I', r.tabel);
    execute format('create policy mt_tweestaps on public.%I as restrictive for all to authenticated '
                   || 'using ((select mt_intern.mt_mfa_ok())) with check ((select mt_intern.mt_mfa_ok()))', r.tabel);
    execute format('drop policy if exists mt_lezen on public.%I', r.tabel);
    execute format('create policy mt_lezen on public.%I for select to authenticated using (%s)', r.tabel, r.lezen);
  end loop;
end
$$;

-- Rechtstreeks schrijven: enkel een beheerder, en enkel in deze beheertabellen. i = toevoegen,
-- u = wijzigen, d = wissen. Welke kolommen, staat bij de rechten in deel 7.
do $$
declare
  r record;
  beheer constant text := '(select mt_intern.mt_is_beheerder())';
begin
  for r in
    select t.tabel, t.wat from (values
      ('voorschotten', 'iud'), ('instellingen', 'u'), ('statussen', 'iud'), ('klassen', 'iu'),
      ('informat_codes', 'iud'), ('leerlingen', 'iu'), ('klasindelingen', 'iud'), ('schoolverlaters', 'iud'),
      ('lopende_activiteiten', 'iud'), ('lopende_activiteit_klassen', 'id'), ('kostenregels', 'iud'),
      ('tarieven', 'iud'), ('activiteiten', 'u'), ('beurt_kosten', 'iud'), ('deelnemers', 'id'),
      ('tussenkomsten', 'iud'), ('annulering_betalers', 'id'), ('correcties', 'iud'),
      ('correctie_leerlingen', 'iud'), ('interne_notities', 'iud'), ('beginbedragen', 'iud')
    ) as t(tabel, wat)
  loop
    execute format('drop policy if exists mt_beheer_toevoegen on public.%I', r.tabel);
    execute format('drop policy if exists mt_beheer_wijzigen on public.%I', r.tabel);
    execute format('drop policy if exists mt_beheer_wissen on public.%I', r.tabel);
    if position('i' in r.wat) > 0 then
      execute format('create policy mt_beheer_toevoegen on public.%I for insert to authenticated with check (%s)', r.tabel, beheer);
    end if;
    if position('u' in r.wat) > 0 then
      execute format('create policy mt_beheer_wijzigen on public.%I for update to authenticated using (%s) with check (%s)', r.tabel, beheer, beheer);
    end if;
    if position('d' in r.wat) > 0 then
      execute format('create policy mt_beheer_wissen on public.%I for delete to authenticated using (%s)', r.tabel, beheer);
    end if;
  end loop;
end
$$;

-- Een schooljaar: aanmaken en wissen enkel zolang het in te vullen is; de stand zelf wijzigt enkel
-- via de databankfuncties (B144, B169).
drop policy if exists mt_beheer_toevoegen on public.schooljaren;
create policy mt_beheer_toevoegen on public.schooljaren for insert to authenticated
  with check ((select mt_intern.mt_is_beheerder()) and stand = 'in_te_vullen');
drop policy if exists mt_beheer_wijzigen on public.schooljaren;
create policy mt_beheer_wijzigen on public.schooljaren for update to authenticated
  using ((select mt_intern.mt_is_beheerder()) and stand <> 'afgesloten')
  with check ((select mt_intern.mt_is_beheerder()));
drop policy if exists mt_beheer_wissen on public.schooljaren;
create policy mt_beheer_wissen on public.schooljaren for delete to authenticated
  using ((select mt_intern.mt_is_beheerder()) and stand = 'in_te_vullen');

-- ============================================================================================
-- 7. De rechten
-- ============================================================================================
-- Eerst alles dicht, ook wat Supabase vroeger vanzelf opende; dan uitdrukkelijk wat mag. anon en
-- service_role krijgen niets: de serverfunctie van de accounts krijgt haar rechten in stap 2.

do $$
declare
  t record;
begin
  for t in
    select n.nspname as schema, c.relname as tabel
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'mt_intern') and c.relkind in ('r', 'S')
  loop
    execute format('revoke all on %I.%I from public, anon, authenticated, service_role', t.schema, t.tabel);
  end loop;
end
$$;

-- Het afgeschermde schema: de regels van deel 6 roepen de hulpfuncties op als authenticated.
grant usage on schema mt_intern to authenticated;
grant execute on function mt_intern.vandaag() to authenticated;
grant execute on function mt_intern.mt_mfa_ok() to authenticated;
grant execute on function mt_intern.mt_rol() to authenticated;
grant execute on function mt_intern.mt_is_beheerder() to authenticated;
grant execute on function mt_intern.mt_leest_alles() to authenticated;
grant execute on function mt_intern.mt_mijn_klassen() to authenticated;
grant execute on function mt_intern.mt_mijn_leerlingen() to authenticated;
grant execute on function mt_intern.mt_mijn_leerlingen_nu() to authenticated;
grant execute on function mt_intern.mt_mag_klas(uuid, text) to authenticated;
grant execute on function mt_intern.mt_mag_lijst(uuid, uuid) to authenticated;
grant execute on function mt_intern.mt_mag_bevestiging(uuid) to authenticated;
grant execute on function mt_intern.mt_mag_aanvraag(uuid) to authenticated;
grant execute on function mt_intern.mt_mag_correctie(uuid) to authenticated;

-- Lezen: het recht op de tabel; welke rijen, beslist mt_lezen.
grant select on table
  public.schooljaren, public.voorschotten, public.instellingen, public.statussen, public.klassen,
  public.klas_namen, public.informat_codes, public.leerlingen, public.klasindelingen,
  public.schoolverlaters, public.gebruikers, public.klastoewijzingen, public.gebruiker_voorkeuren,
  public.account_operaties, public.imports, public.lopende_activiteiten,
  public.lopende_activiteit_klassen, public.kostenregels, public.tarieven, public.activiteiten,
  public.beurt_kosten, public.klaslijsten, public.afwezigheden, public.deelname, public.opmerkingen,
  public.deelnemers, public.bevestigingen, public.bevestiging_leerlingen, public.bevestiging_dagen,
  public.wijzigingen, public.wijzigingsaanvragen, public.wijzigingsaanvraag_regels, public.taken,
  public.tussenkomsten, public.annulering_betalers, public.plafondrekeningen, public.beginbedragen,
  public.facturaties, public.facturatie_leerlingen, public.correcties, public.correctie_leerlingen,
  public.interne_notities, public.facturatieregels, public.herstelregistraties, public.verdelingen,
  public.verdeling_leerlingen, public.facturatie_bestanden, public.afwijkingen,
  public.afwijking_leerlingen, public.bewaarde_rapporten, public.bewaard_rapport_leerlingen,
  public.jaarafsluitingen, public.jaarafsluiting_leerlingen, public.jaarafsluiting_regels,
  public.jaarafsluiting_activiteiten, public.backups, public.logboek
to authenticated;

-- Schrijven, per kolom: enkel wat een beheerder zelf mag invullen. De stand van een schooljaar,
-- "gebruikt" van een status of "gefactureerd in" van een correctie horen daar niet bij.
grant insert (schooljaar, plafond_kleuter_cent, plafond_lager_cent, marge_kleuter_cent, marge_lager_cent,
              minder_scherp_opvolgen, plafond_minder_scherp_cent, gwp_credit_vanaf_cent, gwp_bijbetalen_vanaf_cent,
              voorschotten_gebruiken, minimumbedrag_cent, credit_standaard, prijs_per_kind_afwezigen,
              gratis_zwemjaar_leerjaar, gratis_zwemjaar_toegang_aangerekend, gratis_zwemjaar_bus)
  on table public.schooljaren to authenticated;
grant update (plafond_kleuter_cent, plafond_lager_cent, marge_kleuter_cent, marge_lager_cent,
              minder_scherp_opvolgen, plafond_minder_scherp_cent, gwp_credit_vanaf_cent, gwp_bijbetalen_vanaf_cent,
              voorschotten_gebruiken, minimumbedrag_cent, credit_standaard, prijs_per_kind_afwezigen,
              gratis_zwemjaar_leerjaar, gratis_zwemjaar_toegang_aangerekend, gratis_zwemjaar_bus)
  on table public.schooljaren to authenticated;
grant delete on table public.schooljaren to authenticated;

grant insert (id, schooljaar, volgnummer, bedrag_kleuter_cent, bedrag_lager_cent, vult_aan) on table public.voorschotten to authenticated;
grant update (volgnummer, bedrag_kleuter_cent, bedrag_lager_cent, vult_aan, aangerekend_op) on table public.voorschotten to authenticated;
grant delete on table public.voorschotten to authenticated;

grant update (code_geldig_dagen, afmelden_na_minuten, tijdelijk_wachtwoord_uren, wachtwoord_min_lengte,
              aangemeld_blijven_beheerder, aangemeld_blijven_leerkracht, aangemeld_blijven_lezer,
              reden_afboeking_marge, reden_afboeking_drempel, correctie_suggesties)
  on table public.instellingen to authenticated;

grant insert (id, naam, kleur, aangerekend, volgorde, actief) on table public.statussen to authenticated;
grant update (naam, kleur, aangerekend, volgorde, actief) on table public.statussen to authenticated;
grant delete on table public.statussen to authenticated;

grant insert (id, schooljaar, bron_id, naam, groep, leerjaar, leerjaar_manueel, actief, volgorde) on table public.klassen to authenticated;
grant update (naam, groep, leerjaar, leerjaar_manueel, actief, volgorde) on table public.klassen to authenticated;

grant insert (code, klas_bron_id) on table public.informat_codes to authenticated;
grant update (klas_bron_id) on table public.informat_codes to authenticated;
grant delete on table public.informat_codes to authenticated;

grant insert (id, stamnummer, voornaam, familienaam) on table public.leerlingen to authenticated;
grant update (stamnummer, voornaam, familienaam) on table public.leerlingen to authenticated;

grant insert (id, leerling_id, schooljaar, klas_id, klasnummer, klasnummer_manueel, van, tot) on table public.klasindelingen to authenticated;
grant update (klas_id, klasnummer, klasnummer_manueel, van, tot) on table public.klasindelingen to authenticated;
grant delete on table public.klasindelingen to authenticated;

grant insert (leerling_id, schooljaar, schoolverlater) on table public.schoolverlaters to authenticated;
grant update (schoolverlater) on table public.schoolverlaters to authenticated;
grant delete on table public.schoolverlaters to authenticated;

grant insert (id, schooljaar, naam, zwemmen, iedereen_betaalt, planning) on table public.lopende_activiteiten to authenticated;
grant update (naam, zwemmen, iedereen_betaalt, planning) on table public.lopende_activiteiten to authenticated;
grant delete on table public.lopende_activiteiten to authenticated;

grant insert (lopende_activiteit_id, klas_id, schooljaar) on table public.lopende_activiteit_klassen to authenticated;
grant delete on table public.lopende_activiteit_klassen to authenticated;

grant insert (id, lopende_activiteit_id, schooljaar, omschrijving, verdeling, onderdeel, volgorde) on table public.kostenregels to authenticated;
grant update (omschrijving, verdeling, onderdeel, volgorde) on table public.kostenregels to authenticated;
grant delete on table public.kostenregels to authenticated;

grant insert (kostenregel_id, geldig_vanaf, schooljaar, bedrag_cent) on table public.tarieven to authenticated;
grant update (geldig_vanaf, bedrag_cent) on table public.tarieven to authenticated;
grant delete on table public.tarieven to authenticated;

grant update (afwijking, afwijking_reden, prijs_per_kind_afwezigen, annulering_doorrekenen,
              ging_niet_door, niet_door_activiteit_cent, niet_door_vervoer_cent)
  on table public.activiteiten to authenticated;

grant insert (activiteit_id, kostenregel_id, schooljaar, van_toepassing, bedrag_cent) on table public.beurt_kosten to authenticated;
grant update (van_toepassing, bedrag_cent) on table public.beurt_kosten to authenticated;
grant delete on table public.beurt_kosten to authenticated;

grant insert (activiteit_id, leerling_id, klas_id, schooljaar) on table public.deelnemers to authenticated;
grant delete on table public.deelnemers to authenticated;

grant insert (id, activiteit_id, schooljaar, wie, onderdeel, basis, bedrag_cent) on table public.tussenkomsten to authenticated;
grant update (wie, onderdeel, basis, bedrag_cent) on table public.tussenkomsten to authenticated;
grant delete on table public.tussenkomsten to authenticated;

grant insert (activiteit_id, leerling_id, klas_id, schooljaar) on table public.annulering_betalers to authenticated;
grant delete on table public.annulering_betalers to authenticated;

grant insert (id, schooljaar, maximumfactuur, activiteit_id, datum, reden, totaal_cent) on table public.correcties to authenticated;
grant update (activiteit_id, datum, reden, totaal_cent) on table public.correcties to authenticated;
grant delete on table public.correcties to authenticated;

grant insert (correctie_id, leerling_id, schooljaar, bedrag_cent, voorstel_cent, niet_recupereerbaar_cent, niet_recupereerbaar_waarvoor) on table public.correctie_leerlingen to authenticated;
grant update (bedrag_cent, voorstel_cent, niet_recupereerbaar_cent, niet_recupereerbaar_waarvoor) on table public.correctie_leerlingen to authenticated;
grant delete on table public.correctie_leerlingen to authenticated;

grant insert (correctie_id, schooljaar, tekst) on table public.interne_notities to authenticated;
grant update (tekst) on table public.interne_notities to authenticated;
grant delete on table public.interne_notities to authenticated;

grant insert (leerling_id, gekend, bedrag_cent, bron) on table public.beginbedragen to authenticated;
grant update (gekend, bedrag_cent, bron) on table public.beginbedragen to authenticated;
grant delete on table public.beginbedragen to authenticated;

-- ============================================================================================
-- 8. De triggers en het logboek
-- ============================================================================================

create or replace trigger mt_bewaak before update or delete on public.schooljaren
  for each row execute function mt_intern.bewaak_schooljaren();
drop trigger if exists mt_na_plafond on public.schooljaren;
create constraint trigger mt_na_plafond after update on public.schooljaren
  deferrable initially deferred for each row execute function mt_intern.na_plafond();

create or replace trigger mt_bewaak before insert or update or delete on public.voorschotten
  for each row execute function mt_intern.bewaak_voorschot();
drop trigger if exists mt_na_voorschot on public.voorschotten;
create constraint trigger mt_na_voorschot after insert or update or delete on public.voorschotten
  deferrable initially deferred for each row execute function mt_intern.na_voorschot();

create or replace trigger mt_afleiden before insert or update on public.klassen
  for each row execute function mt_intern.klas_afleiden();
create or replace trigger mt_namen after insert or update of naam on public.klassen
  for each row execute function mt_intern.klas_namen_bijhouden();

create or replace trigger mt_bewaak before insert or update on public.klasindelingen
  for each row execute function mt_intern.bewaak_klasindeling();

create or replace trigger mt_bewaak before update or delete on public.statussen
  for each row execute function mt_intern.bewaak_status();
create or replace trigger mt_status_gebruikt after insert or update on public.afwezigheden
  for each row execute function mt_intern.status_gebruikt('status_id');
create or replace trigger mt_status_gebruikt after insert or update on public.bevestiging_dagen
  for each row execute function mt_intern.status_gebruikt('status_id');
create or replace trigger mt_status_gebruikt after insert or update on public.wijzigingen
  for each row execute function mt_intern.status_gebruikt('oude_status_id', 'nieuwe_status_id');
create or replace trigger mt_status_gebruikt after insert or update on public.wijzigingsaanvraag_regels
  for each row execute function mt_intern.status_gebruikt('oude_status_id', 'nieuwe_status_id');

create or replace trigger mt_bewaak after update or delete on public.gebruikers
  for each row execute function mt_intern.bewaak_gebruikers();

create or replace trigger mt_bewaak before insert or update or delete on public.tarieven
  for each row execute function mt_intern.bewaak_tarief();
create or replace trigger mt_bewaak before update or delete on public.kostenregels
  for each row execute function mt_intern.bewaak_kostenregel();

create or replace trigger mt_bewaak before update or delete on public.correcties
  for each row execute function mt_intern.bewaak_correctie();
create or replace trigger mt_bewaak before update or delete on public.correctie_leerlingen
  for each row execute function mt_intern.bewaak_correctie_leerling();

create or replace trigger mt_bewaak before insert or delete on public.deelnemers
  for each row execute function mt_intern.bewaak_deelnemers();

create or replace trigger mt_bewaak before update or delete on public.logboek
  for each row execute function mt_intern.bewaak_logboek();
create or replace trigger mt_bewaak_leeg before truncate on public.logboek
  for each statement execute function mt_intern.bewaak_logboek();

-- Wie en wanneer: op elke tabel met de vier kolommen.
do $$
declare
  t text;
begin
  for t in
    select c.table_name from information_schema.columns c
     where c.table_schema = 'public'
       and c.column_name in ('aangemaakt_op', 'aangemaakt_door', 'bijgewerkt_op', 'bijgewerkt_door')
     group by c.table_name having count(*) = 4
  loop
    execute format('create or replace trigger mt_stempel before insert or update on public.%I '
                   || 'for each row execute function mt_intern.stempel()', t);
  end loop;
end
$$;

-- Het slot van een afgesloten schooljaar: op elke tabel met een schooljaar. Niet op de momentopnames
-- die over schooljaren heen gaan, en niet op het logboek.
do $$
declare
  t text;
begin
  for t in
    select c.table_name from information_schema.columns c
     where c.table_schema = 'public' and c.column_name = 'schooljaar'
       and c.table_name not in ('schooljaren', 'bewaard_rapport_leerlingen', 'jaarafsluitingen', 'logboek')
  loop
    execute format('create or replace trigger mt_jaarslot before insert or update or delete on public.%I '
                   || 'for each row execute function mt_intern.bewaak_schooljaar()', t);
  end loop;
end
$$;

-- Het logboek (17.5): de tabel, de kolommen van de sleutel, en wat er niet in komt. De momentopnames
-- zelf (de leerlingen van een bevestiging, de regels van een facturatie) zijn al bewijs en wijzigen nooit.
do $$
declare
  r record;
begin
  for r in
    select t.tabel, t.sleutel, t.zonder from (values
      ('schooljaren', 'schooljaar', ''), ('voorschotten', 'id', ''), ('instellingen', 'id', ''),
      ('statussen', 'id', ''), ('klassen', 'id', ''), ('informat_codes', 'code', ''),
      ('leerlingen', 'id', ''), ('klasindelingen', 'id', ''), ('schoolverlaters', 'leerling_id,schooljaar', ''),
      ('gebruikers', 'id', ''), ('klastoewijzingen', 'gebruiker_id,klas_id', ''), ('account_operaties', 'id', ''),
      ('imports', 'id', ''), ('lopende_activiteiten', 'id', ''), ('lopende_activiteit_klassen', 'lopende_activiteit_id,klas_id', ''),
      ('kostenregels', 'id', ''), ('tarieven', 'kostenregel_id,geldig_vanaf', ''), ('activiteiten', 'id', ''),
      ('beurt_kosten', 'activiteit_id,kostenregel_id', ''), ('klaslijsten', 'activiteit_id,klas_id', ''),
      ('afwezigheden', 'activiteit_id,leerling_id,dag', ''), ('deelname', 'activiteit_id,leerling_id', ''),
      ('opmerkingen', 'activiteit_id,leerling_id,soort', ''), ('deelnemers', 'activiteit_id,leerling_id', ''),
      ('bevestigingen', 'id', ''), ('wijzigingen', 'id', ''), ('wijzigingsaanvragen', 'id', ''),
      ('taken', 'id', ''), ('tussenkomsten', 'id', ''), ('annulering_betalers', 'activiteit_id,leerling_id', ''),
      ('correcties', 'id', ''), ('correctie_leerlingen', 'correctie_id,leerling_id', ''),
      ('interne_notities', 'correctie_id', ''), ('beginbedragen', 'leerling_id', ''), ('afwijkingen', 'id', ''),
      ('afwijking_leerlingen', 'afwijking_id,leerling_id', ''), ('facturaties', 'id', 'invoer'),
      ('herstelregistraties', 'id', ''), ('bewaarde_rapporten', 'id', 'invoer'), ('jaarafsluitingen', 'id', '')
    ) as t(tabel, sleutel, zonder)
  loop
    execute format('create or replace trigger mt_log after insert or update or delete on public.%I '
                   || 'for each row execute function mt_intern.log(%L, %L)', r.tabel, r.sleutel, r.zonder);
  end loop;
end
$$;

-- ============================================================================================
-- 9. De basisgegevens
-- ============================================================================================
-- Enkel in een lege tabel: wat de beheerder later aanpast, blijft staan.

insert into public.instellingen (id)
select true where not exists (select 1 from public.instellingen);

-- De statussen bij de start (7). Groen is enkel voor "aanwezig" (B38).
insert into public.statussen (soort, naam, kleur, aangerekend, volgorde)
select v.soort, v.naam, v.kleur, v.aangerekend, v.volgorde
  from (values
    ('aanwezig', 'Aanwezig', 'groen', true, 1),
    ('afwezig', 'Attest', 'blauwgrijs', false, 2),
    ('afwezig', 'Briefje ouders', 'amber', true, 3),
    ('afwezig', 'Ongewettigd afwezig', 'koraal', true, 4),
    ('te_bepalen', 'Nog te bepalen', 'te_bepalen', true, 5)
  ) as v(soort, naam, kleur, aangerekend, volgorde)
 where not exists (select 1 from public.statussen);

insert into mt_intern.scripts (nummer, naam) values (1, '001_basis')
on conflict (nummer) do nothing;
insert into mt_intern.scripts (nummer, naam) values (2, '002_databank')
on conflict (nummer) do update set laatst_op = now(), keren = mt_intern.scripts.keren + 1;

-- ============================================================================================
-- 10. De controles, in dezelfde transactie: lukt er één niet, dan wordt niets bewaard
-- ============================================================================================

do $$
declare
  v_fout text;
  v_schrijfbaar text[];
  v_verwacht constant text[] := array[
    'activiteiten', 'annulering_betalers', 'beginbedragen', 'beurt_kosten', 'correctie_leerlingen', 'correcties',
    'deelnemers', 'informat_codes', 'instellingen', 'interne_notities', 'klasindelingen', 'klassen',
    'kostenregels', 'leerlingen', 'lopende_activiteit_klassen', 'lopende_activiteiten', 'schooljaren',
    'schoolverlaters', 'statussen', 'tarieven', 'tussenkomsten', 'voorschotten'];
begin
  -- Elke tabel: RLS, de regel van de tweestapsverificatie als beperkende regel, en een leesregel.
  select string_agg(c.relname, ', ' order by c.relname) into v_fout
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (not c.relrowsecurity
          or not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'mt_tweestaps'
                           and not p.polpermissive and p.polcmd = '*')
          or not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'mt_lezen' and p.polcmd = 'r'));
  if v_fout is not null then
    raise exception 'MT 002: zonder RLS, zonder de regel van de tweestapsverificatie of zonder leesregel: %', v_fout;
  end if;

  -- anon en service_role: geen enkel recht op een tabel van de MT.
  select string_agg(c.relname, ', ' order by c.relname) into v_fout
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'mt_intern') and c.relkind = 'r'
     and (has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')
          or has_any_column_privilege('anon', c.oid, 'select, insert, update, references')
          or has_table_privilege('service_role', c.oid, 'select, insert, update, delete, truncate, references, trigger')
          or has_any_column_privilege('service_role', c.oid, 'select, insert, update, references'));
  if v_fout is not null then
    raise exception 'MT 002: anon of service_role heeft rechten op: %', v_fout;
  end if;

  -- authenticated schrijft enkel in de beheertabellen.
  select coalesce(array_agg(c.relname::text order by c.relname::text), '{}') into v_schrijfbaar
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'mt_intern') and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'insert, update, delete, truncate, references, trigger')
          or has_any_column_privilege('authenticated', c.oid, 'insert, update, references'));
  if not (v_schrijfbaar @> v_verwacht and v_verwacht @> v_schrijfbaar) then
    raise exception 'MT 002: authenticated kan schrijven in andere tabellen dan verwacht: %', array_to_string(v_schrijfbaar, ', ');
  end if;

  -- Elke regel die schrijven toelaat, eist een beheerder.
  select string_agg(c.relname || '.' || p.polname, ', ') into v_fout
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and p.polpermissive and p.polcmd <> 'r'
     and coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
         not like '%mt_is_beheerder%';
  if v_fout is not null then
    raise exception 'MT 002: een regel laat schrijven toe zonder beheerder: %', v_fout;
  end if;

  -- Functies in mt_intern: security definer enkel met een vaste search_path; niets voor anon.
  select string_agg(p.oid::regprocedure::text, ', ') into v_fout
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'mt_intern'
     and ((p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as c(inst) where c.inst like 'search_path=%'))
          or has_function_privilege('anon', p.oid, 'execute'));
  if v_fout is not null then
    raise exception 'MT 002: functie zonder vaste search_path, of uitvoerbaar voor anon: %', v_fout;
  end if;

  -- De hulpfuncties lezen de sessies van Supabase.
  if not has_table_privilege(current_user, 'auth.sessions', 'select') then
    raise exception 'MT 002: de eigenaar van de functies kan auth.sessions niet lezen';
  end if;

  -- De basisgegevens.
  if (select count(*) from public.instellingen) <> 1
     or (select count(*) from public.statussen where soort = 'aanwezig') <> 1
     or (select count(*) from public.statussen where soort = 'te_bepalen') <> 1 then
    raise exception 'MT 002: de basisgegevens ontbreken';
  end if;
end
$$;

commit;

-- De Data API kent de nieuwe tabellen meteen.
notify pgrst, 'reload schema';

-- Het resultaat: elke regel moet OK tonen.
select c.controle, c.resultaat
from (values
  (1, 'Scripts 001 en 002 geregistreerd',
      (select case when count(*) = 2 then 'OK' else 'FOUT' end from mt_intern.scripts where nummer in (1, 2))),
  (2, 'Tabellen van de MT, elk met RLS',
      (select case when count(*) = 57 and bool_and(c.relrowsecurity) then 'OK: 57 tabellen' else 'FOUT: ' || count(*) || ' tabellen' end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r')),
  (3, 'Tweestapsverificatie als beperkende regel op elke tabel',
      (select case when count(*) = 57 then 'OK' else 'FOUT: ' || count(*) end
         from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and p.polname = 'mt_tweestaps' and not p.polpermissive)),
  (4, 'anon en service_role: geen rechten op tabellen',
      (select case when count(*) = 0 then 'OK' else 'FOUT: ' || count(*) end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'mt_intern') and c.relkind = 'r'
          and (has_table_privilege('anon', c.oid, 'select, insert, update, delete')
               or has_table_privilege('service_role', c.oid, 'select, insert, update, delete')))),
  (5, 'Rechtstreeks schrijven enkel in de 22 beheertabellen',
      (select case when count(*) = 22 then 'OK' else 'FOUT: ' || count(*) end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
               or has_any_column_privilege('authenticated', c.oid, 'insert, update')))),
  (6, 'Het logboek volgt 40 tabellen',
      (select case when count(*) = 40 then 'OK' else 'FOUT: ' || count(*) end
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and t.tgname = 'mt_log' and not t.tgisinternal)),
  (7, 'Basisgegevens: de instellingen en vijf statussen',
      (select case when (select count(*) from public.instellingen) = 1 and count(*) >= 5 then 'OK' else 'FOUT' end
         from public.statussen)),
  (8, 'Enkel de pingfunctie is uitvoerbaar voor anon',
      coalesce('LET OP: ' || (
        select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'mt_intern') and p.proname <> 'mt_ping'
           and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
           and has_function_privilege('anon', p.oid, 'execute')
           and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')), 'OK')),
  (9, 'Realtime staat uit voor de tabellen van de MT',
      (select case when count(*) = 0 then 'OK' else 'LET OP: ' || count(*) || ' tabellen in supabase_realtime' end
         from pg_publication_tables where pubname = 'supabase_realtime' and schemaname in ('public', 'mt_intern')))
) as c(nr, controle, resultaat)
order by c.nr;
