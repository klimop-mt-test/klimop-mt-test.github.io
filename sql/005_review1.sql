-- MT · sql/005_review1.sql · versie 0.6.0
-- De correcties uit review 1 (hoofdstuk 69 van het ontwerpdocument): wat Astra en Opus 5.5 vonden in
-- de toegang, de accounts en de databankfuncties, vóór er schermen met leerlingen op komen.
--
-- Zo voer je het uit: Supabase → project mt-test → SQL Editor → New query → dit hele bestand
-- plakken → Run. Onderaan verschijnt een kleine tabel: elke regel moet OK tonen. "LET OP" is geen
-- fout: de regel zegt wat je nog doet.
--
-- Enkel toevoegend en herhaalbaar: opnieuw uitvoeren mag, zolang er geen later script uitgevoerd is.
-- Alles-of-niets: lukt een controle niet, dan wordt niets bewaard en toont de editor een fout die
-- begint met "MT 005" (17.12).
--
-- Opbouw:
--    1. de volgorde                              6. voor de beheerder
--    2. standaardrechten                         7. uitstappen, en een beurt die niet doorging
--    3. de gebruikers: vier kolommen erbij       8. de noodbeheerder
--    4. de toegang, gebonden aan de sessie       9. de doorgeefluiken, de rechten en de controle
--    5. voor de serverfunctie                   10. de controles
--
-- Wat er wijzigt, en waarom:
--   - Een reset die begonnen is, blijft gelden tot hij gelukt is (B2). Een account dat een nieuw
--     wachtwoord of een nieuwe app-koppeling moet krijgen, draagt dat zelf (herstel_wachtwoord,
--     herstel_app). Geen andere handeling heft dat op, en een nieuwe poging wordt enkel strenger.
--   - De tweestapsverificatie leest de sessie in de databank, niet het toegangsbewijs (I8, O7): de
--     sessie staat bij Supabase nu op twee stappen, met de app die bij de eerste aanmelding of na
--     een reset gekoppeld werd. Een app die iemand er later zelf bij koppelt, telt nooit.
--   - Een account aanmaken: één keer per adres, en nooit over een account van een bestaande
--     gebruiker heen (I1, O2). Het einde van een handeling is herhaalbaar (I2).
--   - Eén accounthandeling tegelijk voor de hele MT (I3), en naam, rol en klassen wijzigen enkel
--     vanaf de stand die het scherm toonde (I7).
--   - De uitstappen bijwerken doet enkel nog de serverfunctie die de uitstappentool zelf leest
--     (B212): de browser meldt niets meer. Een andere datum wist of verschuift nooit afwezigheden,
--     en een oudere melding draait een nieuwere niet terug (B1, O1).
--   - Zodra de beheerder de kosten invulde van een beurt die niet doorging, wijzigt enkel de
--     beheerder ze nog (B213, O4).
--   - Een noodbeheerder, voor als geen enkele beheerder nog kan aanmelden (B214).

begin;

-- ============================================================================================
-- 1. De volgorde
-- ============================================================================================

do $$
declare
  v_laatste integer;
begin
  if to_regclass('mt_intern.scripts') is null then
    raise exception 'MT 005: voer eerst sql/004_accounts.sql uit';
  end if;
  select max(nummer) into v_laatste from mt_intern.scripts;
  if v_laatste is null or v_laatste < 4 then
    raise exception 'MT 005: voer eerst sql/004_accounts.sql uit';
  end if;
  if v_laatste > 5 then
    raise exception 'MT 005: script % is al uitgevoerd. Voer 005 niet opnieuw uit.', v_laatste;
  end if;
  -- De tweestapsverificatie leest voortaan de sessie zelf: dat moet de eigenaar van de functies kunnen.
  if to_regclass('auth.mfa_amr_claims') is null or to_regclass('auth.mfa_factors') is null
     or not has_table_privilege(current_user, 'auth.sessions', 'select')
     or not has_table_privilege(current_user, 'auth.mfa_amr_claims', 'select')
     or not has_table_privilege(current_user, 'auth.mfa_factors', 'select')
     or not has_table_privilege(current_user, 'auth.users', 'select') then
    raise exception 'MT 005: de eigenaar van de functies kan de sessies en de app-koppelingen van Supabase niet lezen';
  end if;
  if not exists (select 1 from pg_attribute a where a.attrelid = 'auth.sessions'::regclass and a.attname = 'aal' and not a.attisdropped)
     or not exists (select 1 from pg_attribute a where a.attrelid = 'auth.sessions'::regclass and a.attname = 'factor_id' and not a.attisdropped) then
    raise exception 'MT 005: auth.sessions heeft niet de kolommen aal en factor_id';
  end if;
end
$$;

-- ============================================================================================
-- 2. Standaardrechten (O8)
-- ============================================================================================
-- 001 nam de standaardrechten in public af voor anon en authenticated. Ook service_role krijgt
-- voortaan niets vanzelf: elke tabel en functie krijgt haar rechten uitdrukkelijk (17.3).

alter default privileges for role postgres in schema public revoke all on tables from service_role;
alter default privileges for role postgres in schema public revoke all on sequences from service_role;
alter default privileges for role postgres in schema public revoke all on functions from service_role;

-- ============================================================================================
-- 3. De gebruikers: vier kolommen erbij
-- ============================================================================================

-- revisie            gaat omhoog bij elke wijziging aan naam, rol of klassen (I7)
-- herstel_wachtwoord er begon een handeling die het wachtwoord vervangt, en ze is nog niet gelukt (B2)
-- herstel_app        er werd gevraagd de app opnieuw te koppelen, en dat is nog niet gelukt (B2)
-- app_factor         de app-koppeling bij Supabase die voor dit account telt (I8)
alter table public.gebruikers add column if not exists revisie bigint not null default 1;
alter table public.gebruikers add column if not exists herstel_wachtwoord boolean not null default false;
alter table public.gebruikers add column if not exists herstel_app boolean not null default false;
alter table public.gebruikers add column if not exists app_factor uuid;

-- Wat er al stond. Een handeling aan een wachtwoord die niet gelukt is, blijft een herstel.
update public.gebruikers g
   set herstel_wachtwoord = true,
       herstel_app = g.herstel_app or coalesce(o.beginstand -> 'plan' -> 'app_wissen' = 'true'::jsonb, false)
  from public.account_operaties o
 where o.id = g.open_operatie and o.soort in ('tijdelijk_wachtwoord', 'inschakelen', 'uitschakelen')
   and o.resultaat is distinct from 'gelukt' and not g.herstel_wachtwoord;

-- Wie al volledig aangemeld is, houdt zijn app: de gekoppelde app bij Supabase wordt de app die telt.
update public.gebruikers g
   set app_factor = (select f.id from auth.mfa_factors f
                      where f.user_id = g.id and f.status::text = 'verified' and f.factor_type::text = 'totp'
                      order by f.updated_at desc nulls last, f.id limit 1)
 where g.app_factor is null and g.eerste_aanmelding_afgerond and not g.app_koppelen;

-- Staat er bij Supabase geen gekoppelde app, terwijl de MT dacht van wel, dan stelt een beheerder
-- het account opnieuw in: met enkel het wachtwoord koppelt niemand zelf een nieuwe app.
update public.gebruikers g
   set herstel_wachtwoord = true, herstel_app = true
 where g.app_factor is null and g.eerste_aanmelding_afgerond and not g.app_koppelen;

-- Een account wordt maar één keer tegelijk aangemaakt per adres (I1). Wat van vroeger bleef hangen,
-- wordt eerst afgesloten.
update public.account_operaties o
   set afgerond_op = now(), resultaat = 'hersteld', melding = 'Niet afgerond: afgesloten door script 005.'
 where o.soort = 'aanmaken' and o.afgerond_op is null and o.begonnen_op < now() - interval '3 minutes';
create unique index if not exists account_operaties_aanmaken_open
  on public.account_operaties ((beginstand -> 'plan' ->> 'email'))
  where soort = 'aanmaken' and afgerond_op is null;

-- ============================================================================================
-- 4. De toegang, gebonden aan de sessie (17.2, T5, I8, O7)
-- ============================================================================================

-- De tweestapsverificatie (vervangt de versie van 004). Het toegangsbewijs zegt enkel nog wie het
-- is en welke sessie; al de rest leest de databank bij Supabase zelf, op het moment van de vraag:
--   - de sessie bestaat nog, en staat op twee stappen (aal2);
--   - ze begon met het wachtwoord, en kreeg een code uit de app, hoogstens zoveel dagen geleden;
--   - die code kwam uit de app die voor dit account telt (app_factor): de app van de eerste
--     aanmelding, of van na een reset door een beheerder. Een app die iemand er later zelf bij
--     koppelt, bv. met een sessie op een gestolen toestel, telt niet;
--   - het account is actief, volledig aangemeld, en er loopt geen handeling of herstel.
-- Ontbreekt er iets, of loopt er iets mis: geen toegang.
create or replace function mt_intern.mt_mfa_ok() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb;
  v_wie uuid;
  v_sessie uuid;
  v_factor uuid;
  v_code timestamptz;
  v_dagen integer;
begin
  v_claims := auth.jwt();
  v_wie := auth.uid();
  if v_claims is null or v_wie is null then return false; end if;
  if (v_claims ->> 'role') is distinct from 'authenticated' then return false; end if;
  if (v_claims ->> 'aal') is distinct from 'aal2' then return false; end if;
  if coalesce(v_claims ->> 'is_anonymous', 'false') <> 'false' then return false; end if;
  v_sessie := (v_claims ->> 'session_id')::uuid;
  if v_sessie is null then return false; end if;

  select s.factor_id into v_factor from auth.sessions s
   where s.id = v_sessie and s.user_id = v_wie and s.aal::text = 'aal2'
     and (s.not_after is null or s.not_after > now());
  if not found or v_factor is null then return false; end if;

  if not exists (select 1 from auth.mfa_amr_claims a
                  where a.session_id = v_sessie and a.authentication_method = 'password') then
    return false;
  end if;
  select a.updated_at into v_code from auth.mfa_amr_claims a
   where a.session_id = v_sessie and a.authentication_method = 'totp';
  if v_code is null then return false; end if;

  select i.code_geldig_dagen into v_dagen from public.instellingen i;
  if v_dagen is null then return false; end if;
  if v_code > now() + interval '60 seconds' then return false; end if;
  if v_code <= now() - make_interval(secs => v_dagen * 86400.0) then return false; end if;

  return exists (select 1 from public.gebruikers g
                  where g.id = v_wie and g.actief and g.eerste_aanmelding_afgerond
                    and not g.wachtwoord_tijdelijk and not g.app_koppelen and g.open_operatie is null
                    and not g.herstel_wachtwoord and not g.herstel_app
                    and g.app_factor = v_factor);
exception when others then
  return false;
end
$$;
revoke all on function mt_intern.mt_mfa_ok() from public;
grant execute on function mt_intern.mt_mfa_ok() to authenticated;

-- ============================================================================================
-- 5. Voor de serverfunctie (17.4, T5)
-- ============================================================================================

-- De stand van het eigen account, voor wie aanmeldt. "bezig" geldt ook zolang een herstel loopt.
create or replace function mt_intern.account_stand(p_gebruiker uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_g public.gebruikers;
begin
  perform mt_intern.eis_server();
  perform 1 from public.gebruikers g where g.id = p_gebruiker for update;
  if not found then
    return jsonb_build_object('bekend', false, 'instellingen', mt_intern.account_instellingen(null));
  end if;
  perform mt_intern.account_opruimen(p_gebruiker);
  select * into v_g from public.gebruikers g where g.id = p_gebruiker;
  return jsonb_build_object(
    'bekend', true,
    'account', jsonb_build_object(
      'id', v_g.id, 'naam', v_g.naam, 'rol', v_g.rol, 'actief', v_g.actief,
      'wachtwoord_tijdelijk', v_g.wachtwoord_tijdelijk,
      'tijdelijk_verlopen', v_g.wachtwoord_tijdelijk and (v_g.tijdelijk_tot is null or v_g.tijdelijk_tot <= now()),
      'tijdelijk_tot', v_g.tijdelijk_tot,
      'eerste_aanmelding_afgerond', v_g.eerste_aanmelding_afgerond,
      'app_koppelen', v_g.app_koppelen,
      'bezig', v_g.open_operatie is not null or v_g.herstel_wachtwoord or v_g.herstel_app),
    'instellingen', mt_intern.account_instellingen(v_g.rol));
end
$$;
revoke all on function mt_intern.account_stand(uuid) from public;

-- De start van een eigen handeling: een eigen wachtwoord kiezen. Niet zolang een herstel loopt.
create or replace function mt_intern.account_eigen_start(p_operatie uuid, p_soort text, p_gebruiker uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_g public.gebruikers;
begin
  perform mt_intern.eis_server();
  if p_operatie is null or p_soort is distinct from 'wachtwoord_kiezen' then
    raise exception 'MT: deze accounthandeling bestaat niet' using errcode = '22023';
  end if;
  perform 1 from public.gebruikers g where g.id = p_gebruiker for update;
  if not found then
    raise exception 'MT: dit account heeft geen toegang tot de MT' using errcode = '42501';
  end if;
  perform mt_intern.account_opruimen(p_gebruiker);
  select * into v_g from public.gebruikers g where g.id = p_gebruiker;
  if not v_g.actief then
    raise exception 'MT: dit account is uitgeschakeld' using errcode = 'MT422';
  end if;
  if v_g.open_operatie is not null or v_g.herstel_wachtwoord or v_g.herstel_app then
    raise exception 'MT: er loopt nog een wijziging aan dit account. Probeer het over enkele minuten opnieuw.' using errcode = 'MT409';
  end if;
  if not v_g.wachtwoord_tijdelijk then
    raise exception 'MT: dit account heeft geen tijdelijk wachtwoord' using errcode = 'MT422';
  end if;
  if v_g.tijdelijk_tot is null or v_g.tijdelijk_tot <= now() then
    raise exception 'MT: je tijdelijke wachtwoord is verlopen. Vraag een nieuw aan de beheerder of het secretariaat.' using errcode = 'MT422';
  end if;
  perform mt_intern.eis_tempo(p_gebruiker, 10);
  begin
    insert into public.account_operaties (id, soort, door, voor, beginstand)
    values (p_operatie, p_soort, p_gebruiker, p_gebruiker, jsonb_build_object('account', mt_intern.account_beeld(p_gebruiker)));
  exception when unique_violation then
    raise exception 'MT: deze handeling is al gestart' using errcode = 'MT409';
  end;
  update public.gebruikers g set open_operatie = p_operatie where g.id = p_gebruiker;
  return jsonb_build_object('operatie', p_operatie, 'gebruiker', p_gebruiker, 'email', v_g.email,
                            'wachtwoord_min_lengte', (select i.wachtwoord_min_lengte from public.instellingen i));
end
$$;
revoke all on function mt_intern.account_eigen_start(uuid, text, uuid) from public;

-- Het einde van een handeling. Wat er wijzigt, volgt uit de handeling zoals ze gestart is.
--   gelukt    het account krijgt zijn nieuwe stand. Verving de handeling het wachtwoord, dan is dat
--             herstel rond; wiste ze ook de app, dan dat herstel ook.
--   mislukt   de stand blijft, en een herstel blijft gelden: enkel een handeling die het wachtwoord
--             echt vervangt, heft het op (B2).
-- Herhalen mag (I2): ging het antwoord verloren, dan geeft dezelfde melding hetzelfde antwoord.
-- Een andere melding over een handeling die al afgerond is, blijft een conflict.
create or replace function mt_intern.account_klaar(p_operatie uuid, p_gelukt boolean,
                                                   p_gegevens jsonb default '{}'::jsonb, p_melding text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_op public.account_operaties;
  v_plan jsonb;
  v_uren integer;
  v_id uuid;
  v_tot timestamptz;
  v_open uuid;
  v_wist boolean;
  v_blokkeert boolean;
begin
  perform mt_intern.eis_server();
  select * into v_op from public.account_operaties o where o.id = p_operatie for update;
  if not found or p_gelukt is null then
    raise exception 'MT: deze handeling bestaat niet' using errcode = '22023';
  end if;
  v_plan := coalesce(v_op.beginstand -> 'plan', '{}'::jsonb);
  v_blokkeert := v_op.soort in ('tijdelijk_wachtwoord', 'uitschakelen', 'inschakelen');
  if v_op.afgerond_op is not null then
    if v_op.resultaat = 'gelukt' and p_gelukt
       and (v_op.soort <> 'aanmaken' or lower(coalesce(p_gegevens, '{}'::jsonb) ->> 'gebruiker') = v_op.voor::text) then
      return jsonb_build_object('ok', true, 'gebruiker', v_op.voor, 'tijdelijk_tot', v_op.eindstand -> 'tijdelijk_tot', 'herhaald', true);
    end if;
    if v_op.resultaat = 'mislukt' and not p_gelukt then
      return jsonb_build_object('ok', false, 'gebruiker', v_op.voor, 'geblokkeerd', v_blokkeert, 'herhaald', true);
    end if;
    raise exception 'MT: deze handeling is al afgerond of vervangen' using errcode = 'MT409';
  end if;
  v_id := v_op.voor;
  if v_id is not null then
    select g.open_operatie into v_open from public.gebruikers g where g.id = v_id for update;
    if v_open is distinct from p_operatie then
      raise exception 'MT: deze handeling is vervangen door een nieuwe' using errcode = 'MT409';
    end if;
  end if;

  if not p_gelukt then
    update public.account_operaties o set afgerond_op = now(), resultaat = 'mislukt',
           melding = left(coalesce(nullif(btrim(p_melding), ''), 'Mislukt.'), 500)
     where o.id = p_operatie;
    if v_op.soort in ('wachtwoord_kiezen', 'email_wijzigen') then
      update public.gebruikers g set open_operatie = null where g.id = v_id;
    end if;
    return jsonb_build_object('ok', false, 'gebruiker', v_id, 'geblokkeerd', v_blokkeert);
  end if;

  select i.tijdelijk_wachtwoord_uren into v_uren from public.instellingen i;
  v_tot := now() + make_interval(hours => v_uren);
  v_wist := coalesce(v_plan -> 'app_wissen' = 'true'::jsonb, false);

  if v_op.soort = 'aanmaken' then
    v_id := (coalesce(p_gegevens, '{}'::jsonb) ->> 'gebruiker')::uuid;
    if v_id is null or not exists (select 1 from auth.users u where u.id = v_id and lower(u.email) = v_plan ->> 'email') then
      raise exception 'MT: het account bij Supabase klopt niet met de aanvraag' using errcode = 'MT422';
    end if;
    -- Stond er bij de start al een los account met dit adres, dan is het dat account, en geen ander.
    if (v_plan ->> 'bestaand') is not null and (v_plan ->> 'bestaand') <> v_id::text then
      raise exception 'MT: het account bij Supabase klopt niet met de aanvraag' using errcode = 'MT422';
    end if;
    begin
      insert into public.gebruikers (id, naam, email, rol, actief, wachtwoord_tijdelijk, tijdelijk_tot,
                                     eerste_aanmelding_afgerond, app_koppelen, aangemaakt_door, bijgewerkt_door)
      values (v_id, v_plan ->> 'naam', v_plan ->> 'email', v_plan ->> 'rol', true, true, v_tot, false, true, v_op.door, v_op.door);
    exception when unique_violation then
      raise exception 'MT: dit account of dit e-mailadres bestaat al in de MT' using errcode = 'MT422';
    end;
  elsif v_op.soort = 'tijdelijk_wachtwoord' then
    update public.gebruikers g set wachtwoord_tijdelijk = true, tijdelijk_tot = v_tot,
           app_koppelen = g.app_koppelen or v_wist,
           app_factor = case when v_wist then null else g.app_factor end,
           herstel_wachtwoord = false,
           herstel_app = case when v_wist then false else g.herstel_app end,
           open_operatie = null
     where g.id = v_id;
  elsif v_op.soort = 'uitschakelen' then
    v_tot := now();
    update public.gebruikers g set actief = false, wachtwoord_tijdelijk = true, tijdelijk_tot = v_tot,
           herstel_wachtwoord = false, open_operatie = null
     where g.id = v_id;
  elsif v_op.soort = 'inschakelen' then
    update public.gebruikers g set actief = true, wachtwoord_tijdelijk = true, tijdelijk_tot = v_tot,
           app_koppelen = g.app_koppelen or v_wist,
           app_factor = case when v_wist then null else g.app_factor end,
           herstel_wachtwoord = false,
           herstel_app = case when v_wist then false else g.herstel_app end,
           open_operatie = null
     where g.id = v_id;
  elsif v_op.soort = 'email_wijzigen' then
    v_tot := null;
    begin
      update public.gebruikers g set email = v_plan ->> 'email', open_operatie = null where g.id = v_id;
    exception when unique_violation then
      raise exception 'MT: er bestaat intussen een gebruiker met dit e-mailadres' using errcode = 'MT409';
    end;
  elsif v_op.soort = 'wachtwoord_kiezen' then
    v_tot := null;
    update public.gebruikers g set wachtwoord_tijdelijk = false, tijdelijk_tot = null, open_operatie = null
     where g.id = v_id;
  else
    raise exception 'MT: deze handeling rondt de serverfunctie niet af' using errcode = '22023';
  end if;

  update public.account_operaties o set voor = v_id, afgerond_op = now(), resultaat = 'gelukt', melding = null,
         eindstand = jsonb_build_object('account', mt_intern.account_beeld(v_id), 'tijdelijk_tot', v_tot)
   where o.id = p_operatie;
  return jsonb_build_object('ok', true, 'gebruiker', v_id, 'tijdelijk_tot', v_tot);
end
$$;
revoke all on function mt_intern.account_klaar(uuid, boolean, jsonb, text) from public;

-- De eerste aanmelding of een nieuwe koppeling afronden. De serverfunctie geeft de sessie door van
-- wie aanmeldt; de databank leest zelf bij Supabase met welke app die sessie haar code gaf, en kijkt
-- na dat het een gekoppelde app van dit account is. Die app telt voortaan (I8). Wat al afgerond is,
-- blijft zo: een andere app wordt nooit stil de app van het account.
drop function if exists public.mt_account_afgerond(uuid);
drop function if exists mt_intern.account_afgerond(uuid);
create or replace function mt_intern.account_afgerond(p_gebruiker uuid, p_sessie uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_g public.gebruikers;
  v_eerst jsonb;
  v_factor uuid;
begin
  perform mt_intern.eis_server();
  select * into v_g from public.gebruikers g where g.id = p_gebruiker for update;
  if not found then
    raise exception 'MT: dit account heeft geen toegang tot de MT' using errcode = '42501';
  end if;
  if not v_g.actief then
    raise exception 'MT: dit account is uitgeschakeld' using errcode = 'MT422';
  end if;
  if v_g.wachtwoord_tijdelijk then
    raise exception 'MT: kies eerst je eigen wachtwoord' using errcode = 'MT422';
  end if;
  if v_g.open_operatie is not null or v_g.herstel_wachtwoord or v_g.herstel_app then
    raise exception 'MT: er loopt nog een wijziging aan dit account. Probeer het over enkele minuten opnieuw.' using errcode = 'MT409';
  end if;
  if v_g.eerste_aanmelding_afgerond and not v_g.app_koppelen then
    return jsonb_build_object('ok', true, 'al_afgerond', true);
  end if;
  select s.factor_id into v_factor from auth.sessions s
   where s.id = p_sessie and s.user_id = p_gebruiker and s.aal::text = 'aal2'
     and (s.not_after is null or s.not_after > now());
  if v_factor is null
     or not exists (select 1 from auth.mfa_factors f
                     where f.id = v_factor and f.user_id = p_gebruiker
                       and f.status::text = 'verified' and f.factor_type::text = 'totp') then
    raise exception 'MT: je authenticator-app is nog niet gekoppeld' using errcode = 'MT422';
  end if;
  perform mt_intern.eis_tempo(p_gebruiker, 10);
  v_eerst := mt_intern.account_beeld(p_gebruiker);
  update public.gebruikers g set eerste_aanmelding_afgerond = true, app_koppelen = false, app_factor = v_factor
   where g.id = p_gebruiker;
  insert into public.account_operaties (id, soort, door, voor, beginstand, afgerond_op, eindstand, resultaat)
  values (gen_random_uuid(), 'afronden', p_gebruiker, p_gebruiker, jsonb_build_object('account', v_eerst), now(),
          jsonb_build_object('account', mt_intern.account_beeld(p_gebruiker)), 'gelukt');
  return jsonb_build_object('ok', true, 'al_afgerond', false);
end
$$;
revoke all on function mt_intern.account_afgerond(uuid, uuid) from public;

-- ============================================================================================
-- 6. Voor de beheerder (3, 15, 17.4, B25, B165)
-- ============================================================================================

-- De start van een accounthandeling (vervangt de versie van 004).
--   - Eén accounthandeling tegelijk voor de hele MT. Na het wachten wordt opnieuw nagekeken wie het
--     vraagt: twee beheerders die elkaar op hetzelfde moment een nieuw wachtwoord geven, kunnen zo
--     niet allebei slagen (I3). Wie een handeling start, blijft dus altijd zelf bruikbaar.
--   - aanmaken: het adres mag bij Supabase niet van een gebruiker van de MT zijn, en wordt maar één
--     keer tegelijk aangemaakt. Staat er bij Supabase al een los account met dit adres, bv. van een
--     poging die strandde, dan komt het in het plan: enkel dat account mag de serverfunctie overnemen.
--   - een nieuw wachtwoord, uitschakelen, inschakelen: het account draagt vanaf hier een herstel,
--     tot een handeling die het wachtwoord vervangt echt gelukt is. Moest de app opnieuw gekoppeld
--     worden, dan blijft dat zo, ook als de nieuwe poging het niet vraagt (B2).
--   - een ander e-mailadres: het adres mag ook bij Supabase van niemand anders zijn (O18). Hetzelfde
--     adres opnieuw instellen kan enkel als het bij Supabase afwijkt: zo herstel je een wijziging
--     die halverwege strandde.
create or replace function mt_intern.account_start(p_operatie uuid, p_soort text, p_voor uuid default null,
                                                   p_gegevens jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_wie uuid := auth.uid();
  v_g public.gebruikers;
  v_oud public.account_operaties;
  v_in jsonb := coalesce(p_gegevens, '{}'::jsonb);
  v_plan jsonb := '{}'::jsonb;
  v_uit jsonb;
  v_email text;
  v_naam text;
  v_bestaand uuid[];
  v_wis boolean;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  perform pg_advisory_xact_lock(hashtext('mt_accounts'));
  v_rol := mt_intern.eis_rol('beheerder');
  if p_operatie is null or p_soort is null or jsonb_typeof(v_in) <> 'object'
     or p_soort not in ('aanmaken', 'tijdelijk_wachtwoord', 'uitschakelen', 'inschakelen', 'email_wijzigen')
     or (p_soort = 'aanmaken') <> (p_voor is null) then
    raise exception 'MT: deze accounthandeling klopt niet' using errcode = '22023';
  end if;
  perform mt_intern.eis_tempo(v_wie, 120);

  if p_soort = 'aanmaken' then
    v_naam := btrim(coalesce(v_in ->> 'naam', ''));
    v_email := mt_intern.email_netjes(v_in ->> 'email');
    if char_length(v_naam) not between 1 and 80 then
      raise exception 'MT: vul een naam in, van hoogstens 80 tekens' using errcode = 'MT422';
    end if;
    if v_email is null then
      raise exception 'MT: dit is geen geldig e-mailadres' using errcode = 'MT422';
    end if;
    if (v_in ->> 'rol') is null or (v_in ->> 'rol') not in ('beheerder', 'leerkracht', 'lezer') then
      raise exception 'MT: kies een rol: beheerder, leerkracht of lezer' using errcode = 'MT422';
    end if;
    if exists (select 1 from public.gebruikers g where g.email = v_email) then
      raise exception 'MT: er bestaat al een gebruiker met dit e-mailadres' using errcode = 'MT422';
    end if;
    select array_agg(u.id order by u.id) into v_bestaand from auth.users u where lower(u.email) = v_email;
    if cardinality(v_bestaand) > 1 then
      raise exception 'MT: bij Supabase bestaan meerdere accounts met dit e-mailadres. Kijk het na in het dashboard.' using errcode = 'MT422';
    end if;
    if cardinality(v_bestaand) = 1 and exists (select 1 from public.gebruikers g where g.id = v_bestaand[1]) then
      raise exception 'MT: bij Supabase hoort dit e-mailadres al bij een gebruiker van de MT. Kijk in de lijst welk account "Adres wijkt af" toont.' using errcode = 'MT422';
    end if;
    select * into v_oud from public.account_operaties o
     where o.soort = 'aanmaken' and o.afgerond_op is null and o.beginstand -> 'plan' ->> 'email' = v_email
     for update;
    if found then
      if v_oud.begonnen_op > now() - interval '3 minutes' then
        raise exception 'MT: dit account wordt al aangemaakt. Probeer het over enkele minuten opnieuw.' using errcode = 'MT409';
      end if;
      update public.account_operaties o set afgerond_op = now(), resultaat = 'hersteld',
             melding = 'Niet afgerond: vervangen door een nieuwe handeling.'
       where o.id = v_oud.id;
    end if;
    v_plan := jsonb_build_object('naam', v_naam, 'email', v_email, 'rol', v_in ->> 'rol')
              || case when cardinality(v_bestaand) = 1 then jsonb_build_object('bestaand', v_bestaand[1]) else '{}'::jsonb end;
    v_uit := jsonb_build_object('email', v_email, 'bestaand', v_plan -> 'bestaand');
  else
    select * into v_g from public.gebruikers g where g.id = p_voor for update;
    if not found then
      raise exception 'MT: dit account bestaat niet in de MT' using errcode = 'MT422';
    end if;
    if p_voor = v_wie then
      raise exception 'MT: je eigen account wijzig je niet zelf. Vraag het aan de andere beheerder.' using errcode = 'MT422';
    end if;
    if v_g.open_operatie is not null then
      select * into v_oud from public.account_operaties o where o.id = v_g.open_operatie;
      if found and v_oud.afgerond_op is null then
        if v_oud.begonnen_op > now() - interval '3 minutes' then
          raise exception 'MT: er loopt al een wijziging aan dit account. Probeer het over enkele minuten opnieuw.' using errcode = 'MT409';
        end if;
        update public.account_operaties o set afgerond_op = now(), resultaat = 'hersteld',
               melding = 'Niet afgerond: vervangen door een nieuwe handeling.'
         where o.id = v_oud.id;
      end if;
    end if;
    v_wis := coalesce(v_in -> 'app_wissen' = 'true'::jsonb, false) or v_g.herstel_app;
    if p_soort = 'tijdelijk_wachtwoord' then
      if not v_g.actief then
        raise exception 'MT: dit account is uitgeschakeld. Schakel het eerst weer in.' using errcode = 'MT422';
      end if;
      v_plan := jsonb_build_object('app_wissen', v_wis);
    elsif p_soort = 'inschakelen' then
      if v_g.actief then
        raise exception 'MT: dit account is al actief' using errcode = 'MT422';
      end if;
      v_plan := jsonb_build_object('app_wissen', v_wis);
    elsif p_soort = 'email_wijzigen' then
      v_email := mt_intern.email_netjes(v_in ->> 'email');
      if v_email is null then
        raise exception 'MT: dit is geen geldig e-mailadres' using errcode = 'MT422';
      end if;
      if exists (select 1 from public.gebruikers g where g.email = v_email and g.id <> p_voor) then
        raise exception 'MT: er bestaat al een gebruiker met dit e-mailadres' using errcode = 'MT422';
      end if;
      if exists (select 1 from auth.users u where lower(u.email) = v_email and u.id <> p_voor) then
        raise exception 'MT: bij Supabase bestaat al een account met dit e-mailadres' using errcode = 'MT422';
      end if;
      if v_email = v_g.email and exists (select 1 from auth.users u where u.id = p_voor and lower(u.email) = v_email) then
        raise exception 'MT: dit is al het e-mailadres van dit account' using errcode = 'MT422';
      end if;
      v_plan := jsonb_build_object('email', v_email);
    end if;
    v_uit := jsonb_build_object('gebruiker', v_g.id, 'email', v_g.email, 'actief', v_g.actief) || v_plan
             || case when p_soort = 'email_wijzigen' then jsonb_build_object('email', v_g.email, 'email_nieuw', v_email) else '{}'::jsonb end;
  end if;

  begin
    insert into public.account_operaties (id, soort, door, voor, beginstand)
    values (p_operatie, p_soort, v_wie, p_voor, jsonb_build_object('plan', v_plan, 'account', mt_intern.account_beeld(p_voor)));
  exception when unique_violation then
    raise exception 'MT: deze handeling is al gestart' using errcode = 'MT409';
  end;

  if p_voor is not null then
    update public.gebruikers g set open_operatie = p_operatie,
           actief = case when p_soort = 'uitschakelen' then false else g.actief end,
           herstel_wachtwoord = g.herstel_wachtwoord or p_soort in ('tijdelijk_wachtwoord', 'inschakelen', 'uitschakelen'),
           herstel_app = g.herstel_app or coalesce(v_plan -> 'app_wissen' = 'true'::jsonb, false)
     where g.id = p_voor;
  end if;
  return v_uit || jsonb_build_object('operatie', p_operatie, 'soort', p_soort,
                                     'uren', (select i.tijdelijk_wachtwoord_uren from public.instellingen i));
end
$$;
revoke all on function mt_intern.account_start(uuid, text, uuid, jsonb) from public;

-- De naam en de rol van een gebruiker (vervangt de versie van 004). p_revisie is de revisie die het
-- scherm toonde: wijzigde iemand anders de gebruiker intussen, dan gebeurt er niets (MT409). Zo
-- schrijft een venster dat al even openstond, nooit stil een oude rol terug (I7).
drop function if exists public.mt_gebruiker_wijzigen(uuid, text, text);
drop function if exists mt_intern.gebruiker_wijzigen(uuid, text, text);
create or replace function mt_intern.gebruiker_wijzigen(p_gebruiker uuid, p_naam text, p_rol text, p_revisie bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_g public.gebruikers;
  v_naam text := btrim(coalesce(p_naam, ''));
  v_revisie bigint;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  perform pg_advisory_xact_lock(hashtext('mt_accounts'));
  v_rol := mt_intern.eis_rol('beheerder');
  select * into v_g from public.gebruikers g where g.id = p_gebruiker for update;
  if not found then
    raise exception 'MT: dit account bestaat niet in de MT' using errcode = 'MT422';
  end if;
  if p_revisie is null or p_revisie <> v_g.revisie then
    raise exception 'MT: iemand wijzigde deze gebruiker intussen. Kijk opnieuw na; er is niets bewaard.' using errcode = 'MT409';
  end if;
  if char_length(v_naam) not between 1 and 80 then
    raise exception 'MT: vul een naam in, van hoogstens 80 tekens' using errcode = 'MT422';
  end if;
  if p_rol is null or p_rol not in ('beheerder', 'leerkracht', 'lezer') then
    raise exception 'MT: kies een rol: beheerder, leerkracht of lezer' using errcode = 'MT422';
  end if;
  if p_rol <> v_g.rol and p_gebruiker = auth.uid() then
    raise exception 'MT: je eigen rol wijzig je niet zelf. Vraag het aan de andere beheerder.' using errcode = 'MT422';
  end if;
  update public.gebruikers g set naam = v_naam, rol = p_rol, revisie = g.revisie + 1 where g.id = p_gebruiker
  returning g.revisie into v_revisie;
  return jsonb_build_object('gebruiker', p_gebruiker, 'naam', v_naam, 'rol', p_rol, 'revisie', v_revisie);
end
$$;
revoke all on function mt_intern.gebruiker_wijzigen(uuid, text, text, bigint) from public;

-- De klassen van een leerkracht in één schooljaar (vervangt de versie van 004), ook enkel vanaf de
-- revisie die het scherm toonde (I7).
drop function if exists public.mt_klassen_toewijzen(uuid, text, uuid[]);
drop function if exists mt_intern.klassen_toewijzen(uuid, text, uuid[]);
create or replace function mt_intern.klassen_toewijzen(p_gebruiker uuid, p_schooljaar text, p_klassen uuid[], p_revisie bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_g public.gebruikers;
  v_stand text;
  v_klassen uuid[];
  v_revisie bigint;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  select * into v_g from public.gebruikers g where g.id = p_gebruiker for update;
  if not found then
    raise exception 'MT: dit account bestaat niet in de MT' using errcode = 'MT422';
  end if;
  if p_revisie is null or p_revisie <> v_g.revisie then
    raise exception 'MT: iemand wijzigde deze gebruiker intussen. Kijk opnieuw na; er is niets bewaard.' using errcode = 'MT409';
  end if;
  if v_g.rol <> 'leerkracht' then
    raise exception 'MT: enkel een leerkracht heeft klassen' using errcode = 'MT422';
  end if;
  select s.stand into v_stand from public.schooljaren s where s.schooljaar = p_schooljaar;
  if v_stand is null then
    raise exception 'MT: dit schooljaar bestaat niet' using errcode = '22023';
  end if;
  if v_stand = 'afgesloten' then
    raise exception 'MT: schooljaar % is afgesloten en kan niet meer wijzigen', p_schooljaar using errcode = 'MT422';
  end if;
  select coalesce(array_agg(distinct x.klas), '{}'::uuid[]) into v_klassen from unnest(coalesce(p_klassen, '{}'::uuid[])) as x(klas);
  if exists (select 1 from unnest(v_klassen) as x(klas)
              where x.klas is null
                 or not exists (select 1 from public.klassen k where k.id = x.klas and k.schooljaar = p_schooljaar)) then
    raise exception 'MT: een klas hoort niet bij schooljaar %', p_schooljaar using errcode = 'MT422';
  end if;
  delete from public.klastoewijzingen t
   where t.gebruiker_id = p_gebruiker and t.schooljaar = p_schooljaar and t.klas_id <> all (v_klassen);
  insert into public.klastoewijzingen (gebruiker_id, klas_id, schooljaar, aangemaakt_door)
  select p_gebruiker, x.klas, p_schooljaar, auth.uid() from unnest(v_klassen) as x(klas)
  on conflict (gebruiker_id, klas_id) do nothing;
  update public.gebruikers g set revisie = g.revisie + 1 where g.id = p_gebruiker returning g.revisie into v_revisie;
  return jsonb_build_object('gebruiker', p_gebruiker, 'schooljaar', p_schooljaar, 'klassen', to_jsonb(v_klassen), 'revisie', v_revisie);
end
$$;
revoke all on function mt_intern.klassen_toewijzen(uuid, text, uuid[], bigint) from public;

-- Accounts waarvan het e-mailadres bij Supabase verschilt van dat in de MT, bv. na een wijziging
-- die halverwege strandde, of een wijziging in het dashboard (O2). Het scherm Gebruikers toont ze
-- als "Adres wijkt af", met de weg om het recht te zetten.
create or replace function mt_intern.account_afwijkingen() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rol text;
begin
  v_rol := mt_intern.eis_rol('beheerder');
  return coalesce((select jsonb_agg(g.id order by g.id) from public.gebruikers g
                    where not exists (select 1 from auth.users u where u.id = g.id and lower(u.email) = g.email)), '[]'::jsonb);
end
$$;
revoke all on function mt_intern.account_afwijkingen() from public;

-- ============================================================================================
-- 7. Uitstappen uit de uitstappentool, en een beurt die niet doorging (4, B14, B67, B212, B213)
-- ============================================================================================
-- De uitstappentool leest voortaan een serverfunctie, niet de browser (B212): wat hier binnenkomt,
-- is wat de bron zegt, en niet wat een sessie meldt. Die serverfunctie volgt in stap 3; tot dan
-- roept niemand deze functie op.

-- Eén uitstap verwerken (vervangt de versie van 003). Drie regels erbij:
--   - een melding die ouder is dan wat de MT al verwerkte, wordt overgeslagen;
--   - een melding uit de toekomst is ongeldig;
--   - bij een andere datum verschuift of wist de MT nooit afwezigheden. Zijn er al afwezigheden
--     ingegeven, dan wacht de datum, met een taak voor de beheerder: hij neemt de datum bewust over
--     ("Datum overnemen", stap 5). Tot dan houdt de MT de datum en de versie van toen.
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
     or v_gewijzigd > now() + interval '5 minutes' then
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

  -- Ouder dan wat de MT al verwerkte: een trage of herhaalde lezing draait niets terug.
  if v_gewijzigd < v_act.bron_gewijzigd_op then
    return jsonb_build_object('wat', 'ouder', 'uitstap', v_id);
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
  return jsonb_build_object('wat', v_wat, 'uitstap', v_id, 'onbekend', to_jsonb(v_onbekend));
end
$$;
revoke all on function mt_intern.uitstap_bijwerken(jsonb) from public;

-- De uitstappen bijwerken (vervangt de versie van 003): enkel nog de serverfunctie, die de
-- uitstappentool zelf leest (B212). p_alle_ids is de volledige lijst van id's in de uitstappentool:
-- wat daar niet meer in staat, is "niet gevonden". Een lege lijst terwijl de MT uitstappen kent,
-- is een fout, geen resultaat (17.3).
create or replace function mt_intern.uitstappen_bijwerken(p_uitstappen jsonb, p_alle_ids text[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_r jsonb;
  v_tel jsonb := jsonb_build_object('nieuw', 0, 'gewijzigd', 0, 'weg', 0, 'ongewijzigd', 0, 'ongeldig', 0, 'buiten', 0, 'geen', 0,
                                    'gesloten', 0, 'ouder', 0);
  v_onbekend jsonb := '[]'::jsonb;
  v_wacht jsonb := '[]'::jsonb;
  v_weg integer := 0;
  u record;
  r record;
begin
  perform mt_intern.eis_server();
  if p_uitstappen is null or jsonb_typeof(p_uitstappen) <> 'array' or jsonb_array_length(p_uitstappen) > 5000 then
    raise exception 'MT: de lijst van uitstappen klopt niet' using errcode = '22023';
  end if;
  -- één lezing tegelijk: twee lezingen die elkaar kruisen, maken een uitstap maar één keer aan
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

  if p_alle_ids is not null then
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

-- "Deze beurt ging niet door" (vervangt de versie van 003; B149, B176, B213). Wie de aanwezigheden
-- ingeeft, duidt het aan, voor alle klassen van de beurt. Zodra de beheerder de kosten invulde,
-- wijzigt enkel de beheerder de beurt nog: een leerkracht wist zo nooit bedragen (O4).
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
  if v_rol <> 'beheerder' and v_act.ging_niet_door = 'school'
     and (v_act.niet_door_activiteit_cent is not null or v_act.niet_door_vervoer_cent is not null) then
    if p_wie is distinct from 'school' then
      raise exception 'MT: de beheerder vulde de kosten van deze beurt al in. Enkel de beheerder wijzigt ze nog.' using errcode = 'MT422';
    end if;
    return jsonb_build_object('ging_niet_door', 'school',
                              'kosten_te_bekijken', v_act.niet_door_activiteit_cent is null or v_act.niet_door_vervoer_cent is null);
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
-- 8. De noodbeheerder (B214)
-- ============================================================================================

-- Voor als geen enkele beheerder nog kan aanmelden, bv. omdat beide hun gsm kwijt zijn. Zoals de
-- eerste beheerder, maar ook als er al gebruikers zijn. Eén keer, in de SQL Editor, na het aanmaken
-- van een nieuw account in het dashboard (Authentication → Users → Add user, met "Auto Confirm User"):
--     select mt_intern.noodbeheerder('nood.beheerder@klimopvilvoorde.be', 'Noodbeheerder');
-- Het adres mag van geen bestaande gebruiker van de MT zijn, en hoeft niet te bestaan: er gaan geen
-- mails naartoe. De noodbeheerder meldt aan met het wachtwoord uit het dashboard, kiest een eigen
-- wachtwoord en koppelt een app, zoals iedereen. Daarna geeft hij de andere beheerders een nieuw
-- tijdelijk wachtwoord in de MT zelf, en schakelt een van hen de noodbeheerder weer uit.
-- Niet bereikbaar via de Data API. Wat hier gebeurt, staat in het register en in het logboek.
create or replace function mt_intern.noodbeheerder(p_email text, p_naam text) returns text
language plpgsql set search_path = '' as $$
declare
  v_email text := mt_intern.email_netjes(p_email);
  v_naam text := btrim(coalesce(p_naam, ''));
  v_id uuid;
  v_n integer;
  v_uren integer;
begin
  if not exists (select 1 from public.gebruikers) then
    raise exception 'MT: de MT heeft nog geen gebruikers. Gebruik mt_intern.eerste_beheerder.';
  end if;
  if v_email is null or char_length(v_naam) not between 1 and 80 then
    raise exception 'MT: geef een geldig e-mailadres en een naam van hoogstens 80 tekens';
  end if;
  select count(*) into v_n from auth.users u where lower(u.email) = v_email;
  if v_n <> 1 then
    raise exception 'MT: geen account met dit e-mailadres. Maak het eerst aan in het dashboard: Authentication → Users → Add user.';
  end if;
  select u.id into v_id from auth.users u where lower(u.email) = v_email;
  if exists (select 1 from public.gebruikers g where g.id = v_id or g.email = v_email) then
    raise exception 'MT: dit adres is al van een gebruiker van de MT. Maak in het dashboard een nieuw account aan, met een ander adres.';
  end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = v_id) then
    raise exception 'MT: dit account heeft al een app-koppeling. Maak in het dashboard een nieuw account aan.';
  end if;
  select i.tijdelijk_wachtwoord_uren into v_uren from public.instellingen i;
  insert into public.gebruikers (id, naam, email, rol, actief, wachtwoord_tijdelijk, tijdelijk_tot,
                                 eerste_aanmelding_afgerond, app_koppelen)
  values (v_id, v_naam, v_email, 'beheerder', true, true, now() + make_interval(hours => v_uren), false, true);
  insert into public.account_operaties (id, soort, door, voor, beginstand, afgerond_op, eindstand, resultaat, melding)
  values (gen_random_uuid(), 'noodbeheerder', null, v_id, jsonb_build_object('plan', jsonb_build_object('naam', v_naam, 'email', v_email, 'rol', 'beheerder')),
          now(), jsonb_build_object('account', mt_intern.account_beeld(v_id)), 'gelukt', 'Noodbeheerder, aangemaakt in de SQL Editor.');
  return 'OK: ' || v_naam || ' is noodbeheerder. Meld binnen ' || v_uren || ' uur aan in de MT, met het wachtwoord uit het dashboard.';
end
$$;
revoke all on function mt_intern.noodbeheerder(text, text) from public;

-- ============================================================================================
-- 9. De doorgeefluiken, de rechten en de controle op de functies
-- ============================================================================================
-- Zoals in 003 en 004. De uitstappen bijwerken verhuist van de pagina naar de serverfunctie; de
-- afwijkende adressen komen erbij voor de pagina. Samen: 25 voor de pagina, 5 voor de serverfunctie.

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
       and p.proname = any (array[
         'account_start', 'gebruiker_wijzigen', 'klassen_toewijzen', 'account_afwijkingen', 'beurt_ging_niet_door',
         'account_stand', 'account_eigen_start', 'account_klaar', 'account_afgerond', 'uitstappen_bijwerken'])
  loop
    v_voor := case when r.proname in ('account_stand', 'account_eigen_start', 'account_klaar', 'account_afgerond', 'uitstappen_bijwerken')
                   then 'service_role' else 'authenticated' end;
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

-- De controle op de functies (vervangt de versie van 004): geeft wat niet klopt, of niets. Ze keurt
-- af wat niet uitdrukkelijk mag (O6), met de namen erbij:
--   - in public staat enkel de ping en een doorgeefluik van de lijst, elk één keer en voor zijn rol;
--   - in mt_intern voert een rol van de API enkel uit wat op een lijst staat: de functies voor de pagina
--     en voor de serverfunctie, de hulpfuncties van de toegang, en de dag van vandaag;
--   - een functie voor de pagina begint met eis_rol(…), een functie voor de serverfunctie met eis_server();
--   - elke functie die RLS omzeilt, heeft een lege search_path;
--   - een functie die een gebruiker kan oproepen, leest niets vóór de toegangscontrole (geen select in
--     de declare), en vangt een geweigerde toegang nooit op;
--   - in public staat geen view: een view omzeilt RLS.
-- Welke rol een functie eist, gaat de proef na.
create or replace function mt_intern.controleer_functies() returns text
language sql stable set search_path = '' as $$
  with pagina(naam) as (values
         ('status_bewaren'), ('deelname_bewaren'), ('opmerking_bewaren'), ('bevestigen'), ('heropenen'),
         ('wijziging_aanvragen'), ('aanvraag_intrekken'), ('aanvraag_behandelen'), ('was_hij_mee'), ('taak_afhandelen'),
         ('klassen_bijwerken'), ('schooljaar_bevestigen'), ('leerlingen_doorvoeren'), ('lopende_activiteiten_aanmaken'),
         ('lopende_activiteit_behandelen'), ('beurten_plannen'), ('beurt_ging_niet_door'), ('lijst_totalen'),
         ('gebruikers_namen'), ('voorkeuren_bewaren'),
         ('account_start'), ('gebruiker_wijzigen'), ('klassen_toewijzen'), ('mijn_account'), ('account_afwijkingen')),
       server(naam) as (values
         ('account_stand'), ('account_eigen_start'), ('account_klaar'), ('account_afgerond'), ('uitstappen_bijwerken')),
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

insert into mt_intern.scripts (nummer, naam) values (5, '005_review1')
on conflict (nummer) do update set laatst_op = now(), keren = mt_intern.scripts.keren + 1;

-- ============================================================================================
-- 10. De controles, in dezelfde transactie: lukt er één niet, dan wordt niets bewaard
-- ============================================================================================

do $$
declare
  v_fout text;
  v_n integer;
begin
  v_fout := mt_intern.controleer_functies();
  if v_fout is not null then
    raise exception 'MT 005: %', v_fout;
  end if;

  -- De serverfunctie, anon en "iedereen": geen enkel recht op een tabel, een kolom of een reeks van de MT.
  -- Gelezen uit de rechten zelf, zodat ook een recht dat een latere versie van Postgres toevoegt, meetelt.
  select string_agg(distinct c.relname::text, ', ' order by c.relname::text) into v_fout
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'mt_intern') and c.relkind in ('r', 'p', 'S')
     and (exists (select 1 from aclexplode(c.relacl) a
                   where a.grantee in (0, 'anon'::regrole::oid, 'service_role'::regrole::oid))
          or exists (select 1 from pg_attribute k, aclexplode(k.attacl) a
                      where k.attrelid = c.oid and k.attnum > 0 and not k.attisdropped
                        and a.grantee in (0, 'anon'::regrole::oid, 'service_role'::regrole::oid)));
  if v_fout is not null then
    raise exception 'MT 005: anon of service_role heeft rechten op: %', v_fout;
  end if;

  -- Een nieuwe tabel of functie is niet vanzelf open voor een rol van de API (O8).
  create table public.mt_proef_rechten (id integer);
  create function public.mt_proef_rechten() returns integer language sql as $f$ select 1 $f$;
  if exists (select 1 from pg_class c, aclexplode(c.relacl) a
              where c.oid = 'public.mt_proef_rechten'::regclass
                and a.grantee in (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid, 'service_role'::regrole::oid))
     or has_function_privilege('service_role', 'public.mt_proef_rechten()', 'execute')
     or has_function_privilege('authenticated', 'public.mt_proef_rechten()', 'execute')
     or has_function_privilege('anon', 'public.mt_proef_rechten()', 'execute') then
    raise exception 'MT 005: nieuwe tabellen of functies zijn nog vanzelf open voor een rol van de API';
  end if;
  drop function public.mt_proef_rechten();
  drop table public.mt_proef_rechten;

  -- De eerste beheerder en de noodbeheerder: enkel via de SQL Editor.
  if has_function_privilege('authenticated', 'mt_intern.eerste_beheerder(text, text)', 'execute')
     or has_function_privilege('service_role', 'mt_intern.eerste_beheerder(text, text)', 'execute')
     or has_function_privilege('anon', 'mt_intern.eerste_beheerder(text, text)', 'execute')
     or has_function_privilege('authenticated', 'mt_intern.noodbeheerder(text, text)', 'execute')
     or has_function_privilege('service_role', 'mt_intern.noodbeheerder(text, text)', 'execute')
     or has_function_privilege('anon', 'mt_intern.noodbeheerder(text, text)', 'execute') then
    raise exception 'MT 005: de eerste beheerder of de noodbeheerder is bereikbaar via de Data API';
  end if;

  -- De tweestapsverificatie leest de sessie in de databank, en is gebonden aan de app van het account.
  select p.prosrc into v_fout from pg_proc p where p.oid = 'mt_intern.mt_mfa_ok()'::regprocedure;
  if v_fout not like '%auth.mfa_amr_claims%' or v_fout not like '%g.app_factor = v_factor%'
     or v_fout not like '%not g.herstel_wachtwoord%' or v_fout not like '%not g.app_koppelen%' then
    raise exception 'MT 005: de tweestapsverificatie is niet de versie van 005';
  end if;

  -- De uitstappen bijwerken: niet meer voor de pagina.
  if has_function_privilege('authenticated', 'public.mt_uitstappen_bijwerken(jsonb, text[])', 'execute')
     or has_function_privilege('authenticated', 'mt_intern.uitstappen_bijwerken(jsonb, text[])', 'execute') then
    raise exception 'MT 005: de pagina kan de uitstappen nog bijwerken';
  end if;

  -- Wat 002 vastlegde, geldt nog: authenticated schrijft enkel in de 22 beheertabellen.
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
          or has_any_column_privilege('authenticated', c.oid, 'insert, update'));
  if v_n <> 22 then
    raise exception 'MT 005: authenticated kan schrijven in % tabellen in plaats van 22', v_n;
  end if;
end
$$;

commit;

-- De Data API kent de nieuwe functies meteen.
notify pgrst, 'reload schema';

-- Het resultaat: elke regel moet OK tonen. "LET OP" is geen fout, maar zegt wat je nog doet.
select c.controle, c.resultaat
from (values
  (1, 'Scripts 001 tot 005 geregistreerd',
      (select case when count(*) = 5 then 'OK' else 'FOUT' end from mt_intern.scripts where nummer in (1, 2, 3, 4, 5))),
  (2, 'Tweestapsverificatie: de sessie en de app van het account, gelezen in de databank',
      (select case when p.prosrc like '%auth.mfa_amr_claims%' and p.prosrc like '%g.app_factor = v_factor%' then 'OK' else 'FOUT' end
         from pg_proc p where p.oid = 'mt_intern.mt_mfa_ok()'::regprocedure)),
  (3, 'Functies voor de pagina, elk met een doorgeefluik',
      (select case when count(*) = 25 then 'OK: 25 functies' else 'FOUT: ' || count(*) end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
          and has_function_privilege('authenticated', p.oid, 'execute'))),
  (4, 'Functies voor de serverfuncties',
      (select case when count(*) = 5 then 'OK: 5 functies' else 'FOUT: ' || count(*) end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
          and has_function_privilege('service_role', p.oid, 'execute'))),
  (5, 'Elke functie staat op de lijst en begint met haar toegangscontrole',
      coalesce('FOUT: ' || mt_intern.controleer_functies(), 'OK')),
  (6, 'De uitstappen bijwerken: enkel nog de serverfunctie',
      case when has_function_privilege('authenticated', 'public.mt_uitstappen_bijwerken(jsonb, text[])', 'execute') then 'FOUT' else 'OK' end),
  (7, 'De serverfunctie: geen rechten op tabellen, ook niet vanzelf',
      (select case when count(*) = 0 then 'OK' else 'FOUT: ' || count(*) end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'mt_intern') and c.relkind in ('r', 'p', 'S')
          and exists (select 1 from aclexplode(c.relacl) a where a.grantee in (0, 'anon'::regrole::oid, 'service_role'::regrole::oid)))),
  (8, 'De eerste beheerder en de noodbeheerder: enkel via de SQL Editor',
      case when has_function_privilege('authenticated', 'mt_intern.noodbeheerder(text, text)', 'execute')
             or has_function_privilege('service_role', 'mt_intern.noodbeheerder(text, text)', 'execute')
             or has_function_privilege('authenticated', 'mt_intern.eerste_beheerder(text, text)', 'execute')
             or has_function_privilege('service_role', 'mt_intern.eerste_beheerder(text, text)', 'execute')
           then 'FOUT' else 'OK' end),
  (9, 'Rechtstreeks schrijven nog altijd enkel in de 22 beheertabellen',
      (select case when count(*) = 22 then 'OK' else 'FOUT: ' || count(*) end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
               or has_any_column_privilege('authenticated', c.oid, 'insert, update')))),
  (10, 'Elke gebruiker die al aangemeld was, houdt zijn app',
      (select case when count(*) = 0 then 'OK'
                   else 'LET OP: ' || count(*) || ' account(s) zonder gekoppelde app bij Supabase. Geef ze in de MT een nieuw tijdelijk wachtwoord.' end
         from public.gebruikers g where g.herstel_app and g.open_operatie is null))
) as c(nr, controle, resultaat)
order by c.nr;
