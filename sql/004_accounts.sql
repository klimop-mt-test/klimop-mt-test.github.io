-- MT · sql/004_accounts.sql · versie 0.4.0
-- Stap 2 van fase 1 (64.7 en hoofdstuk 65 van het ontwerpdocument): de accounts. Wat de serverfunctie
-- voor de accounts (functies/mt-accounts) in de databank mag, wat een beheerder aan een gebruiker
-- wijzigt, en de eerste beheerder.
--
-- Zo voer je het uit: Supabase → project mt-test → SQL Editor → New query → dit hele bestand
-- plakken → Run. Onderaan verschijnt een kleine tabel: elke regel moet OK tonen.
--
-- Enkel toevoegend en herhaalbaar: opnieuw uitvoeren mag, zolang er geen later script uitgevoerd is.
-- Alles-of-niets: lukt een controle niet, dan wordt niets bewaard en toont de editor een fout die
-- begint met "MT 004" (17.12).
--
-- Opbouw:
--    1. de volgorde                              5. voor de beheerder
--    2. de toegang, strenger                     6. voor elke gebruiker, en de eerste beheerder
--    3. hulpfuncties                             7. de doorgeefluiken en de rechten
--    4. voor de serverfunctie                    8. de controles
--
-- Hoe een accounthandeling loopt (17.4, T5). Supabase bewaart de wachtwoorden en de app-koppelingen;
-- de MT bewaart in public.gebruikers wie binnen mag. Die twee wijzigen nooit in één keer. Daarom:
--   1. de start, in de databank: wie het vraagt, wordt hier nagekeken, en de toegang van het account
--      wordt meteen geblokkeerd (open_operatie);
--   2. de serverfunctie wijzigt het wachtwoord of de koppeling bij Supabase;
--   3. het einde, in de databank: pas dan krijgt het account zijn nieuwe stand.
-- Loopt het halverwege mis, dan blijft de toegang geblokkeerd tot een beheerder de handeling herhaalt.
--
-- Wie mag wat:
--   - een beheerder start een handeling met zijn eigen toegangsbewijs (account_start): de databank
--     kijkt zelf na dat hij beheerder is, met een verse code. De serverfunctie kan dat niet in zijn
--     plaats beweren;
--   - enkel de serverfunctie (de rol service_role) rondt een handeling af, en enkel een handeling die
--     zo gestart is. Ze krijgt geen enkel recht op een tabel: enkel deze vier functies;
--   - wat geen wachtwoord of koppeling raakt, zoals de naam, de rol en de klassen, wijzigt een
--     beheerder rechtstreeks via een databankfunctie.
--
-- De foutcodes van 003 gelden, met één erbij:
--   MT429  te veel pogingen na elkaar: wacht tien minuten.

begin;

-- ============================================================================================
-- 1. De volgorde
-- ============================================================================================

do $$
declare
  v_laatste integer;
begin
  if to_regclass('mt_intern.scripts') is null then
    raise exception 'MT 004: voer eerst sql/003_functies.sql uit';
  end if;
  select max(nummer) into v_laatste from mt_intern.scripts;
  if v_laatste is null or v_laatste < 3 then
    raise exception 'MT 004: voer eerst sql/003_functies.sql uit';
  end if;
  if v_laatste > 4 then
    raise exception 'MT 004: script % is al uitgevoerd. Voer 004 niet opnieuw uit.', v_laatste;
  end if;
end
$$;

-- ============================================================================================
-- 2. De toegang, strenger (17.2, T5)
-- ============================================================================================

-- De tweestapsverificatie (vervangt de versie van 002). Twee voorwaarden erbij:
--   - de sessie begon met het wachtwoord. Supabase kan ook aanmelden met een link of een code in een
--     mail; zo'n sessie telt in de MT niet, ook niet met een code uit de app erbij (B5);
--   - de app-koppeling staat niet op "opnieuw te koppelen". Wist een beheerder de koppeling, dan
--     toont de databank meteen niets meer, ook aan een sessie die nog liep.
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

  if not exists (select 1 from jsonb_array_elements(v_claims -> 'amr') as e(claim)
                  where jsonb_typeof(e.claim) = 'object' and e.claim ->> 'method' = 'password') then
    return false;
  end if;

  select i.code_geldig_dagen into v_dagen from public.instellingen i;
  if v_dagen is null then return false; end if;
  v_nu := extract(epoch from now());
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
                    and not g.wachtwoord_tijdelijk and not g.app_koppelen and g.open_operatie is null);
exception when others then
  return false;
end
$$;
revoke all on function mt_intern.mt_mfa_ok() from public;
grant execute on function mt_intern.mt_mfa_ok() to authenticated;

-- ============================================================================================
-- 3. Hulpfuncties
-- ============================================================================================
-- Geen enkele hulpfunctie krijgt rechten: enkel de functies van dit script roepen ze op.

-- De toegangscontrole van een functie voor de serverfunctie: de eerste regel. Enkel de rol
-- service_role komt verder. Wie het account is, heeft de serverfunctie zelf nagekeken bij Supabase.
create or replace function mt_intern.eis_server() returns void
language plpgsql stable set search_path = '' as $$
begin
  if current_setting('role', true) is distinct from 'service_role' then
    raise exception 'MT: enkel voor de serverfunctie van de accounts' using errcode = '42501';
  end if;
end
$$;
revoke all on function mt_intern.eis_server() from public;

-- Herhaalde pogingen worden beperkt (17.4): per persoon een aantal handelingen per tien minuten.
create or replace function mt_intern.eis_tempo(p_door uuid, p_max integer) returns void
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.account_operaties o
       where o.door = p_door and o.begonnen_op > now() - interval '10 minutes') >= p_max then
    raise exception 'MT: te veel pogingen na elkaar. Wacht tien minuten en probeer het opnieuw.' using errcode = 'MT429';
  end if;
end
$$;
revoke all on function mt_intern.eis_tempo(uuid, integer) from public;

-- De stand van een account, voor de begin- en eindstand van een handeling. Nooit een wachtwoord,
-- een toegangsbewijs of een sleutel van de app: die staan niet in de MT.
create or replace function mt_intern.account_beeld(p_gebruiker uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('naam', g.naam, 'email', g.email, 'rol', g.rol, 'actief', g.actief,
           'wachtwoord_tijdelijk', g.wachtwoord_tijdelijk, 'tijdelijk_tot', g.tijdelijk_tot,
           'eerste_aanmelding_afgerond', g.eerste_aanmelding_afgerond, 'app_koppelen', g.app_koppelen)
    from public.gebruikers g where g.id = p_gebruiker
$$;
revoke all on function mt_intern.account_beeld(uuid) from public;

-- Wat de pagina nodig heeft om aan te melden en af te melden (15). "Aangemeld blijven" per rol (B148).
create or replace function mt_intern.account_instellingen(p_rol text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
           'afmelden_na_minuten', i.afmelden_na_minuten, 'code_geldig_dagen', i.code_geldig_dagen,
           'wachtwoord_min_lengte', i.wachtwoord_min_lengte, 'tijdelijk_wachtwoord_uren', i.tijdelijk_wachtwoord_uren,
           'aangemeld_blijven', case p_rol when 'beheerder' then i.aangemeld_blijven_beheerder
                                           when 'leerkracht' then i.aangemeld_blijven_leerkracht
                                           when 'lezer' then i.aangemeld_blijven_lezer
                                           else false end)
    from public.instellingen i
$$;
revoke all on function mt_intern.account_instellingen(text) from public;

-- Een eigen handeling die bleef hangen, bv. omdat de verbinding wegviel terwijl iemand zijn
-- wachtwoord koos, vervalt na drie minuten: langer leeft een oproep van de serverfunctie niet. Het
-- account houdt zijn stand van vóór de handeling. Een handeling van een beheerder vervalt nooit
-- vanzelf: die herhaalt de beheerder.
create or replace function mt_intern.account_opruimen(p_gebruiker uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_op public.account_operaties;
begin
  select o.* into v_op from public.gebruikers g join public.account_operaties o on o.id = g.open_operatie
   where g.id = p_gebruiker;
  if found and v_op.soort = 'wachtwoord_kiezen' and v_op.afgerond_op is null
     and v_op.begonnen_op < now() - interval '3 minutes' then
    update public.account_operaties o set afgerond_op = now(), resultaat = 'mislukt',
           melding = 'Niet afgerond: vervallen na drie minuten.'
     where o.id = v_op.id;
    update public.gebruikers g set open_operatie = null where g.id = p_gebruiker;
  end if;
end
$$;
revoke all on function mt_intern.account_opruimen(uuid) from public;

-- Een e-mailadres netjes gezet en nagekeken; leeg als het niet klopt.
create or replace function mt_intern.email_netjes(p_email text) returns text
language sql immutable set search_path = '' as $$
  select case when x.e ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and char_length(x.e) <= 254 then x.e end
    from (select lower(btrim(coalesce(p_email, ''))) as e) x
$$;
revoke all on function mt_intern.email_netjes(text) from public;

-- ============================================================================================
-- 4. Voor de serverfunctie (17.4, T5)
-- ============================================================================================
-- Vier functies, enkel uitvoerbaar voor service_role, elk met eis_server() als eerste regel.

-- De stand van het eigen account, voor wie aanmeldt. Met enkel een wachtwoord toont de databank
-- niets (17.2); de pagina moet toch weten welke stap volgt: een eigen wachtwoord kiezen, de app
-- koppelen, of de code. De serverfunctie vraagt het hier, enkel voor wie ze zelf nakeek.
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
      'bezig', v_g.open_operatie is not null),
    'instellingen', mt_intern.account_instellingen(v_g.rol));
end
$$;
revoke all on function mt_intern.account_stand(uuid) from public;

-- De start van een eigen handeling: een eigen wachtwoord kiezen bij een tijdelijk wachtwoord. Met
-- enkel het wachtwoord (aal1) volstaat, want de app is dan vaak nog niet gekoppeld (T5). De termijn
-- van het tijdelijke wachtwoord wordt hier nagegaan, met de tijd van de databank.
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
  if v_g.open_operatie is not null then
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

-- Het einde van een handeling. Wat er wijzigt, volgt uit de handeling zoals ze gestart is: de soort
-- en het plan staan in de databank, en komen niet van de serverfunctie. Die meldt enkel of het bij
-- Supabase lukte, en bij een nieuw account welk account Supabase aanmaakte.
--   gelukt   het account krijgt zijn nieuwe stand, en de blokkering gaat weg;
--   mislukt  de stand blijft. Raakte de handeling een wachtwoord of een koppeling, dan blijft ook de
--            blokkering, tot een beheerder de handeling herhaalt (17.4).
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
begin
  perform mt_intern.eis_server();
  select * into v_op from public.account_operaties o where o.id = p_operatie for update;
  if not found or p_gelukt is null then
    raise exception 'MT: deze handeling bestaat niet' using errcode = '22023';
  end if;
  if v_op.afgerond_op is not null then
    raise exception 'MT: deze handeling is al afgerond of vervangen' using errcode = 'MT409';
  end if;
  v_plan := coalesce(v_op.beginstand -> 'plan', '{}'::jsonb);
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
    return jsonb_build_object('ok', false, 'gebruiker', v_id,
                              'geblokkeerd', v_op.soort in ('tijdelijk_wachtwoord', 'uitschakelen', 'inschakelen'));
  end if;

  select i.tijdelijk_wachtwoord_uren into v_uren from public.instellingen i;
  v_tot := now() + make_interval(hours => v_uren);

  if v_op.soort = 'aanmaken' then
    v_id := (coalesce(p_gegevens, '{}'::jsonb) ->> 'gebruiker')::uuid;
    if v_id is null or not exists (select 1 from auth.users u where u.id = v_id and lower(u.email) = v_plan ->> 'email') then
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
           app_koppelen = g.app_koppelen or coalesce(v_plan -> 'app_wissen' = 'true'::jsonb, false),
           open_operatie = null
     where g.id = v_id;
  elsif v_op.soort = 'uitschakelen' then
    v_tot := now();
    update public.gebruikers g set actief = false, wachtwoord_tijdelijk = true, tijdelijk_tot = v_tot, open_operatie = null
     where g.id = v_id;
  elsif v_op.soort = 'inschakelen' then
    update public.gebruikers g set actief = true, wachtwoord_tijdelijk = true, tijdelijk_tot = v_tot,
           app_koppelen = g.app_koppelen or coalesce(v_plan -> 'app_wissen' = 'true'::jsonb, false),
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
         eindstand = jsonb_build_object('account', mt_intern.account_beeld(v_id))
   where o.id = p_operatie;
  return jsonb_build_object('ok', true, 'gebruiker', v_id, 'tijdelijk_tot', v_tot);
end
$$;
revoke all on function mt_intern.account_klaar(uuid, boolean, jsonb, text) from public;

-- De eerste aanmelding of een nieuwe koppeling afronden. De serverfunctie keek na dat de sessie een
-- code uit de app heeft, en dat die app bij Supabase echt gekoppeld is. Vanaf hier toont de databank
-- haar gegevens. Herhalen mag: wat al afgerond is, blijft zo.
create or replace function mt_intern.account_afgerond(p_gebruiker uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_g public.gebruikers;
  v_eerst jsonb;
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
  if v_g.open_operatie is not null then
    raise exception 'MT: er loopt nog een wijziging aan dit account. Probeer het over enkele minuten opnieuw.' using errcode = 'MT409';
  end if;
  if v_g.eerste_aanmelding_afgerond and not v_g.app_koppelen then
    return jsonb_build_object('ok', true, 'al_afgerond', true);
  end if;
  perform mt_intern.eis_tempo(p_gebruiker, 10);
  v_eerst := mt_intern.account_beeld(p_gebruiker);
  update public.gebruikers g set eerste_aanmelding_afgerond = true, app_koppelen = false where g.id = p_gebruiker;
  insert into public.account_operaties (id, soort, door, voor, beginstand, afgerond_op, eindstand, resultaat)
  values (gen_random_uuid(), 'afronden', p_gebruiker, p_gebruiker, jsonb_build_object('account', v_eerst), now(),
          jsonb_build_object('account', mt_intern.account_beeld(p_gebruiker)), 'gelukt');
  return jsonb_build_object('ok', true, 'al_afgerond', false);
end
$$;
revoke all on function mt_intern.account_afgerond(uuid) from public;

-- ============================================================================================
-- 5. Voor de beheerder (3, 15, 17.4, B25, B165)
-- ============================================================================================

-- De start van een accounthandeling. De serverfunctie roept dit op met het toegangsbewijs van de
-- beheerder zelf: de databank kijkt dus zelf na dat hij beheerder is, met een verse code (T5).
--   aanmaken              een nieuw account: naam, e-mailadres en rol
--   tijdelijk_wachtwoord  een nieuw tijdelijk wachtwoord; met app_wissen ook de app-koppeling opnieuw
--   uitschakelen          het account kan niet meer aanmelden
--   inschakelen           weer wel, met een nieuw tijdelijk wachtwoord
--   email_wijzigen        een ander e-mailadres om aan te melden
-- Nooit op het eigen account: zo blijft er altijd een beheerder die kan aanmelden, en zet de ene
-- beheerder de koppeling van de andere opnieuw (17.4). De toegang van het account wordt hier al
-- geblokkeerd, vóór de serverfunctie iets bij Supabase wijzigt.
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
begin
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
    v_plan := jsonb_build_object('naam', v_naam, 'email', v_email, 'rol', v_in ->> 'rol');
    v_uit := jsonb_build_object('email', v_email);
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
    if p_soort = 'tijdelijk_wachtwoord' then
      if not v_g.actief then
        raise exception 'MT: dit account is uitgeschakeld. Schakel het eerst weer in.' using errcode = 'MT422';
      end if;
      v_plan := jsonb_build_object('app_wissen', coalesce(v_in -> 'app_wissen' = 'true'::jsonb, false));
    elsif p_soort = 'inschakelen' then
      if v_g.actief then
        raise exception 'MT: dit account is al actief' using errcode = 'MT422';
      end if;
      v_plan := jsonb_build_object('app_wissen', coalesce(v_in -> 'app_wissen' = 'true'::jsonb, false));
    elsif p_soort = 'email_wijzigen' then
      v_email := mt_intern.email_netjes(v_in ->> 'email');
      if v_email is null then
        raise exception 'MT: dit is geen geldig e-mailadres' using errcode = 'MT422';
      end if;
      if exists (select 1 from public.gebruikers g where g.email = v_email) then
        raise exception 'MT: er bestaat al een gebruiker met dit e-mailadres' using errcode = 'MT422';
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
           actief = case when p_soort = 'uitschakelen' then false else g.actief end
     where g.id = p_voor;
  end if;
  return v_uit || jsonb_build_object('operatie', p_operatie, 'soort', p_soort,
                                     'uren', (select i.tijdelijk_wachtwoord_uren from public.instellingen i));
end
$$;
revoke all on function mt_intern.account_start(uuid, text, uuid, jsonb) from public;

-- De naam en de rol van een gebruiker. Dat raakt geen wachtwoord of koppeling, en loopt dus niet via
-- de serverfunctie. De eigen rol wijzigt een beheerder niet zelf; de databank bewaakt daarnaast dat
-- de laatste actieve beheerder blijft (002).
create or replace function mt_intern.gebruiker_wijzigen(p_gebruiker uuid, p_naam text, p_rol text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_g public.gebruikers;
  v_naam text := btrim(coalesce(p_naam, ''));
begin
  v_rol := mt_intern.eis_rol('beheerder');
  select * into v_g from public.gebruikers g where g.id = p_gebruiker for update;
  if not found then
    raise exception 'MT: dit account bestaat niet in de MT' using errcode = 'MT422';
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
  update public.gebruikers g set naam = v_naam, rol = p_rol where g.id = p_gebruiker;
  return jsonb_build_object('gebruiker', p_gebruiker, 'naam', v_naam, 'rol', p_rol);
end
$$;
revoke all on function mt_intern.gebruiker_wijzigen(uuid, text, text) from public;

-- De klassen van een leerkracht in één schooljaar: de lijst vervangt wat er stond (3, B126, B170).
-- Eén klas of een heel leerjaar: een rij per klas. Een afgesloten schooljaar wijzigt niet meer.
create or replace function mt_intern.klassen_toewijzen(p_gebruiker uuid, p_schooljaar text, p_klassen uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rol text;
  v_g public.gebruikers;
  v_stand text;
  v_klassen uuid[];
begin
  v_rol := mt_intern.eis_rol('beheerder');
  select * into v_g from public.gebruikers g where g.id = p_gebruiker for update;
  if not found then
    raise exception 'MT: dit account bestaat niet in de MT' using errcode = 'MT422';
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
  return jsonb_build_object('gebruiker', p_gebruiker, 'schooljaar', p_schooljaar, 'klassen', to_jsonb(v_klassen));
end
$$;
revoke all on function mt_intern.klassen_toewijzen(uuid, text, uuid[]) from public;

-- ============================================================================================
-- 6. Voor elke gebruiker, en de eerste beheerder
-- ============================================================================================

-- Het eigen account na een geslaagde aanmelding: de naam, de rol, de klassen van het lopende
-- schooljaar, en wat de pagina nodig heeft om af te melden (15). Dit is de eerste oproep van elke
-- sessie: slaagt ze, dan is de tweestapsverificatie in orde.
create or replace function mt_intern.mijn_account() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rol text;
  v_g public.gebruikers;
begin
  v_rol := mt_intern.eis_rol('beheerder', 'leerkracht', 'lezer');
  select * into v_g from public.gebruikers g where g.id = auth.uid();
  return jsonb_build_object(
    'id', v_g.id, 'naam', v_g.naam, 'email', v_g.email, 'rol', v_g.rol,
    'schooljaar', (select s.schooljaar from public.schooljaren s where s.stand = 'lopend'),
    'klassen', coalesce((
      select jsonb_agg(jsonb_build_object('id', k.id, 'naam', k.naam) order by k.volgorde, k.naam)
        from public.klastoewijzingen t
        join public.klassen k on k.id = t.klas_id
        join public.schooljaren s on s.schooljaar = t.schooljaar
       where t.gebruiker_id = v_g.id and s.stand = 'lopend' and v_g.rol = 'leerkracht'), '[]'::jsonb),
    'instellingen', mt_intern.account_instellingen(v_g.rol));
end
$$;
revoke all on function mt_intern.mijn_account() from public;

-- De eerste beheerder. In de MT maakt een beheerder de accounts aan, maar de eerste beheerder kan
-- zichzelf niet aanmaken. Eén keer, in de SQL Editor, na het aanmaken van het account in het
-- dashboard (Authentication → Users → Add user):
--     select mt_intern.eerste_beheerder('voornaam.familienaam@klimopvilvoorde.be', 'Voornaam Familienaam');
-- Het wachtwoord uit het dashboard geldt als tijdelijk wachtwoord: bij de eerste aanmelding kiest de
-- beheerder een eigen wachtwoord en koppelt hij zijn app, zoals iedereen. Werkt enkel zolang de MT
-- nog geen enkele gebruiker heeft, en is niet bereikbaar via de Data API.
create or replace function mt_intern.eerste_beheerder(p_email text, p_naam text) returns text
language plpgsql set search_path = '' as $$
declare
  v_email text := mt_intern.email_netjes(p_email);
  v_naam text := btrim(coalesce(p_naam, ''));
  v_id uuid;
  v_n integer;
  v_uren integer;
begin
  if exists (select 1 from public.gebruikers) then
    raise exception 'MT: er is al een gebruiker in de MT. Verdere accounts maak je in de MT zelf, bij Gebruikers.';
  end if;
  if v_email is null or char_length(v_naam) not between 1 and 80 then
    raise exception 'MT: geef een geldig e-mailadres en een naam van hoogstens 80 tekens';
  end if;
  select count(*) into v_n from auth.users u where lower(u.email) = v_email;
  if v_n <> 1 then
    raise exception 'MT: geen account met dit e-mailadres. Maak het eerst aan in het dashboard: Authentication → Users → Add user.';
  end if;
  select u.id into v_id from auth.users u where lower(u.email) = v_email;
  select i.tijdelijk_wachtwoord_uren into v_uren from public.instellingen i;
  insert into public.gebruikers (id, naam, email, rol, actief, wachtwoord_tijdelijk, tijdelijk_tot,
                                 eerste_aanmelding_afgerond, app_koppelen)
  values (v_id, v_naam, v_email, 'beheerder', true, true, now() + make_interval(hours => v_uren), false, true);
  return 'OK: ' || v_naam || ' is de eerste beheerder. Meld binnen ' || v_uren || ' uur aan in de MT, met het wachtwoord uit het dashboard.';
end
$$;
revoke all on function mt_intern.eerste_beheerder(text, text) from public;

-- ============================================================================================
-- 7. De doorgeefluiken en de rechten
-- ============================================================================================
-- Zoals in 003: de Data API bereikt enkel public, en daar staat per functie een doorgeefluik dat
-- zelf niets omzeilt. Vier functies zijn voor de pagina (authenticated), vier voor de serverfunctie
-- (service_role). De serverfunctie krijgt geen enkel recht op een tabel.

grant usage on schema mt_intern to service_role;

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
         'account_start', 'gebruiker_wijzigen', 'klassen_toewijzen', 'mijn_account',
         'account_stand', 'account_eigen_start', 'account_klaar', 'account_afgerond'])
  loop
    v_voor := case when r.proname in ('account_stand', 'account_eigen_start', 'account_klaar', 'account_afgerond')
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

-- De controle op de functies (vervangt de versie van 003): geeft wat niet klopt, of niets.
--   - een functie die een gebruiker kan oproepen en RLS omzeilt, begint met de toegangscontrole;
--   - een functie voor de serverfunctie begint met eis_server();
--   - in public staat enkel een doorgeefluik;
--   - anon voert niets uit, behalve de ping;
--   - service_role voert enkel de vier functies van de serverfunctie uit, en authenticated net die niet.
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
      select p.oid::regprocedure::text || ' begint niet met de controle op de serverfunctie'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'mt_intern' and p.prorettype <> 'trigger'::regtype
         and has_function_privilege('service_role', p.oid, 'execute')
         and coalesce(substring(p.prosrc from '\mbegin\M(.*)$'), '') !~ '^\s+perform\s+mt_intern\.eis_server\(\)'
      union all
      select p.oid::regprocedure::text || ' in public is geen doorgeefluik'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
         and (p.prosecdef
              or p.prosrc !~ ('^\s*select mt_intern\.' || substr(p.proname, 4) || '\((\$[0-9]+(, \$[0-9]+)*)?\)\s*$'))
      union all
      select p.oid::regprocedure::text || ' is uitvoerbaar voor anon'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where ((n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping') or n.nspname = 'mt_intern')
         and p.prorettype <> 'trigger'::regtype
         and has_function_privilege('anon', p.oid, 'execute')
      union all
      select p.oid::regprocedure::text || ' is uitvoerbaar voor service_role'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where ((n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping') or n.nspname = 'mt_intern')
         and p.prorettype <> 'trigger'::regtype
         and has_function_privilege('service_role', p.oid, 'execute')
         and (case when n.nspname = 'public' then substr(p.proname, 4) else p.proname::text end)
             not in ('account_stand', 'account_eigen_start', 'account_klaar', 'account_afgerond')
      union all
      select p.oid::regprocedure::text || ' is voor de serverfunctie, maar ook uitvoerbaar voor authenticated'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where ((n.nspname = 'public' and p.proname like 'mt\_%') or n.nspname = 'mt_intern')
         and has_function_privilege('authenticated', p.oid, 'execute')
         and (case when n.nspname = 'public' then substr(p.proname, 4) else p.proname::text end)
             in ('account_stand', 'account_eigen_start', 'account_klaar', 'account_afgerond')
    ) x
$$;
revoke all on function mt_intern.controleer_functies() from public;

insert into mt_intern.scripts (nummer, naam) values (4, '004_accounts')
on conflict (nummer) do update set laatst_op = now(), keren = mt_intern.scripts.keren + 1;

-- ============================================================================================
-- 8. De controles, in dezelfde transactie: lukt er één niet, dan wordt niets bewaard
-- ============================================================================================

do $$
declare
  v_fout text;
  v_n integer;
begin
  v_fout := mt_intern.controleer_functies();
  if v_fout is not null then
    raise exception 'MT 004: %', v_fout;
  end if;

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
     and has_function_privilege('authenticated', p.oid, 'execute');
  if v_n <> 25 then
    raise exception 'MT 004: % doorgeefluiken voor de pagina in plaats van 25', v_n;
  end if;

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
     and has_function_privilege('service_role', p.oid, 'execute');
  if v_n <> 4 then
    raise exception 'MT 004: % doorgeefluiken voor de serverfunctie in plaats van 4', v_n;
  end if;

  -- De serverfunctie: geen enkel recht op een tabel of een reeks van de MT.
  select string_agg(c.relname, ', ' order by c.relname) into v_fout
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'mt_intern') and c.relkind in ('r', 'S')
     and (has_table_privilege('service_role', c.oid, 'select, insert, update, delete, truncate, references, trigger')
          or has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')
          or (c.relkind = 'r' and (has_any_column_privilege('service_role', c.oid, 'select, insert, update, references')
                                   or has_any_column_privilege('anon', c.oid, 'select, insert, update, references'))));
  if v_fout is not null then
    raise exception 'MT 004: anon of service_role heeft rechten op: %', v_fout;
  end if;

  -- De eerste beheerder: enkel via de SQL Editor.
  if has_function_privilege('authenticated', 'mt_intern.eerste_beheerder(text, text)', 'execute')
     or has_function_privilege('service_role', 'mt_intern.eerste_beheerder(text, text)', 'execute')
     or has_function_privilege('anon', 'mt_intern.eerste_beheerder(text, text)', 'execute') then
    raise exception 'MT 004: de eerste beheerder is bereikbaar via de Data API';
  end if;

  -- De tweestapsverificatie is de strengere versie.
  select p.prosrc into v_fout from pg_proc p where p.oid = 'mt_intern.mt_mfa_ok()'::regprocedure;
  if v_fout not like '%''password''%' or v_fout not like '%not g.app_koppelen%' then
    raise exception 'MT 004: de tweestapsverificatie is niet de strengere versie';
  end if;

  -- Wat 002 vastlegde, geldt nog: authenticated schrijft enkel in de 22 beheertabellen.
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
          or has_any_column_privilege('authenticated', c.oid, 'insert, update'));
  if v_n <> 22 then
    raise exception 'MT 004: authenticated kan schrijven in % tabellen in plaats van 22', v_n;
  end if;
end
$$;

commit;

-- De Data API kent de nieuwe functies meteen.
notify pgrst, 'reload schema';

-- Het resultaat: elke regel moet OK tonen.
select c.controle, c.resultaat
from (values
  (1, 'Scripts 001 tot 004 geregistreerd',
      (select case when count(*) = 4 then 'OK' else 'FOUT' end from mt_intern.scripts where nummer in (1, 2, 3, 4))),
  (2, 'Tweestapsverificatie: enkel na een wachtwoord, en met een gekoppelde app',
      (select case when p.prosrc like '%''password''%' and p.prosrc like '%not g.app_koppelen%' then 'OK' else 'FOUT' end
         from pg_proc p where p.oid = 'mt_intern.mt_mfa_ok()'::regprocedure)),
  (3, 'Functies voor de pagina, elk met een doorgeefluik',
      (select case when count(*) = 25 then 'OK: 25 functies' else 'FOUT: ' || count(*) end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
          and has_function_privilege('authenticated', p.oid, 'execute'))),
  (4, 'Functies voor de serverfunctie van de accounts',
      (select case when count(*) = 4 then 'OK: 4 functies' else 'FOUT: ' || count(*) end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'mt\_%' and p.proname <> 'mt_ping'
          and has_function_privilege('service_role', p.oid, 'execute'))),
  (5, 'Elke functie begint met haar toegangscontrole',
      coalesce('FOUT: ' || mt_intern.controleer_functies(), 'OK')),
  (6, 'anon: enkel de pingfunctie',
      (select case when count(*) = 0 then 'OK' else 'FOUT: ' || count(*) end
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'mt_intern') and p.proname <> 'mt_ping'
          and p.prorettype <> 'trigger'::regtype
          and has_function_privilege('anon', p.oid, 'execute')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'))),
  (7, 'De serverfunctie: geen rechten op tabellen',
      (select case when count(*) = 0 then 'OK' else 'FOUT: ' || count(*) end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'mt_intern') and c.relkind = 'r'
          and has_table_privilege('service_role', c.oid, 'select, insert, update, delete'))),
  (8, 'De eerste beheerder: enkel via de SQL Editor',
      case when has_function_privilege('authenticated', 'mt_intern.eerste_beheerder(text, text)', 'execute')
             or has_function_privilege('service_role', 'mt_intern.eerste_beheerder(text, text)', 'execute')
           then 'FOUT' else 'OK' end),
  (9, 'Rechtstreeks schrijven nog altijd enkel in de 22 beheertabellen',
      (select case when count(*) = 22 then 'OK' else 'FOUT: ' || count(*) end
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and (has_table_privilege('authenticated', c.oid, 'insert, update, delete')
               or has_any_column_privilege('authenticated', c.oid, 'insert, update'))))
) as c(nr, controle, resultaat)
order by c.nr;
