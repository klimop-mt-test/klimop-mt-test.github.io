// MT · tests/databank_test.js
// De databanktest (17.12): de SQL-scripts op een nagebootste Supabase, en de proef die per rol nagaat
// wat mag en wat niet. Ze start een eigen, tijdelijke Postgres en ruimt die daarna weer op.
//
//   1. tests/databank/supabase.sql: de rollen, het auth-schema en de oude standaardrechten van Supabase;
//   2. elk script van sql/, op volgorde, als de rol postgres, zoals de SQL Editor van Supabase;
//   3. het laatste script nog eens: herhaalbaar, met dezelfde uitkomst;
//   4. elk ouder script nog eens: dat moet geweigerd worden, want het zou rechten terugzetten;
//   5. tests/databank/proef.sql, in UTC en in de tijd van Brussel;
//   6. de wedloop: twee verbindingen tegelijk, voor wat één verbinding niet kan tonen (review 1);
//   7. de adapter en de databank samen: wat de echte adapter (code/adapter.js) uit rijen van de
//      uitstappentool maakt, verwerkt de echte databankfunctie, in delen zoals de serverfunctie (B212);
//   8. de serverfunctie en de databank samen: hele verzoeken door de echte behandelaar van
//      functies/mt-uitstappen, waarbij de echte databank uitvoert wat hij vraagt (review 2: R11).
//
// Daarna, in een tweede test: de bewust ingebouwde fouten van tests/databank/fouten.js. Een controle
// bewijst pas iets als ze ook afgaat wanneer het misloopt. Elke fout wordt apart in haar SQL-script
// gezet, op een eigen kopie van de nagebootste Supabase; de controle van het script of de proef moet
// ze vinden.
//
// Draait enkel met MT_DATABANK=1 en de nodige rechten:
//   MT_DATABANK=1 deno test --allow-read --allow-write --allow-env --allow-run --no-prompt tests/databank_test.js
// Zonder die instelling staat de test op "ignored", zodat de gewone tests niets extra vragen.
// MT_PG_BIN wijst naar de map met initdb, pg_ctl en psql; anders zoekt de test in /usr/lib/postgresql.

import assert from "node:assert/strict";
import { bericht } from "../code/adapter.js";
import { maakBehandelaar, PAGINA, UITSTAPPENTOOL } from "../functies/mt-uitstappen/index.ts";
import { FOUTEN } from "./databank/fouten.js";
import { lees, MAP, sqlScripts } from "./hulp.js";

function instelling(naam) {
  try {
    return Deno.env.get(naam) ?? null;
  } catch {
    return null;
  }
}

const AAN = instelling("MT_DATABANK") === "1";
const POORT = "54329";
const POORT_FOUTEN = "54331";
/**
 * De tijdelijke Postgres hoeft niets te overleven: hij schrijft niet telkens naar de schijf. Dat maakt de
 * test korter, vooral de honderden kopieën voor de ingebouwde fouten. Aan wat de databank doet, wijzigt het niets.
 */
const SNEL = "-c fsync=off -c synchronous_commit=off -c full_page_writes=off";

/** De map met de programma's van Postgres: de hoogste versie die er staat. */
function zoekPostgres() {
  const vast = instelling("MT_PG_BIN");
  if (vast) return vast;
  let beste = null;
  try {
    for (const item of Deno.readDirSync("/usr/lib/postgresql")) {
      const versie = Number(item.name);
      if (item.isDirectory && Number.isFinite(versie) && (!beste || versie > beste.versie)) {
        beste = { versie, pad: "/usr/lib/postgresql/" + item.name + "/bin" };
      }
    }
  } catch {
    // geen Postgres op de gewone plaats
  }
  return beste ? beste.pad : null;
}

async function doe(programma, args, { env, stil = false } = {}) {
  const opties = { args, env, stdin: "null", stdout: stil ? "null" : "piped", stderr: stil ? "null" : "piped" };
  const uit = await new Deno.Command(programma, opties).output();
  const tekst = new TextDecoder();
  return { code: uit.code, uit: stil ? "" : tekst.decode(uit.stdout), fout: stil ? "" : tekst.decode(uit.stderr) };
}

const pad = (bestand) => decodeURIComponent(new URL(bestand, MAP).pathname);
/** Zoveel ingebouwde fouten tegelijk; de rekenaar van GitHub heeft vier kernen. */
const GELIJK = Math.max(1, Number(instelling("MT_FOUTEN_GELIJK") || "4") || 1);
/** Om bij het bouwen enkel de fouten van bepaalde scripts te draaien, bv. MT_FOUTEN_SCRIPT=002 of 003,004. Leeg: alle. */
const ENKEL = instelling("MT_FOUTEN_SCRIPT");

/**
 * De wedloop (review 1: I3 en I1): twee verbindingen tegelijk, zoals twee beheerders of twee tabbladen.
 * De proef loopt in één verbinding en ziet dit niet. Elke verbinding meldt aan als de rol authenticator,
 * zoals de Data API, met de tijdslimieten van het echte project.
 *   1. beheerder A geeft B een nieuw wachtwoord, en op hetzelfde moment B aan A: precies één van beide
 *      lukt, en precies één account is daarna geblokkeerd. Wie een handeling start, blijft zelf bruikbaar;
 *   2. hetzelfde adres wordt twee keer tegelijk aangemaakt: precies één start lukt;
 *   3. terwijl de uitstappen bijgewerkt worden, geeft iemand bij dezelfde activiteit iets in: dat wacht
 *      niet op het bijwerken (review 2: R2-11);
 *   4. terwijl een lezing van de uitstappentool bezig is, start een beheerder een schooljaar: de start
 *      wacht tot het deel klaar is, en breekt de lezing dan af (stap 4a, sql/007_schooljaar.sql).
 * voer(gebruiker, sql) voert SQL uit op de databank. Geeft null als alles klopt, anders wat misliep.
 */
async function wedloop(voer) {
  const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  const [a, b, x] = [id(9001), id(9002), id(9003)];
  const opzet = await voer("supabase_admin", `
    insert into auth.users (id, email) values ('${a}', 'wedloop-a@voorbeeld.test'), ('${b}', 'wedloop-b@voorbeeld.test'), ('${x}', 'wedloop-x@voorbeeld.test');
    insert into auth.mfa_factors (id, user_id, factor_type, status) select id, id, 'totp', 'verified' from auth.users where email like 'wedloop-%';
    insert into auth.sessions (id, user_id, aal, factor_id) select id, id, 'aal2', id from auth.users where email like 'wedloop-%';
    insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method)
      select u.id, now(), now(), m.methode from auth.users u, (values ('password'), ('totp')) as m(methode) where u.email like 'wedloop-%';
    insert into public.gebruikers (id, naam, email, rol, actief, wachtwoord_tijdelijk, eerste_aanmelding_afgerond, app_koppelen, app_factor)
      select id, 'Wedloop ' || right(email, 16), email, 'beheerder', true, false, true, false, id from auth.users where email like 'wedloop-%';`);
  if (opzet.code !== 0) return "de opzet van de wedloop mislukte: " + opzet.fout;
  const start = (wie, operatie, soort, voor, gegevens, slaap) => `
    begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: wie, role: "authenticated", aal: "aal2", session_id: wie })}', true);
    set local role authenticated;
    select public.mt_account_start('${id(operatie)}', '${soort}', ${voor ? "'" + voor + "'" : "null"}, '${JSON.stringify(gegevens)}');
    select pg_sleep(${slaap});
    commit;`;
  const samen = async (eerste, tweede) => {
    const r1 = voer("authenticator", eerste);
    await new Promise((klaar) => setTimeout(klaar, 500));
    const r2 = voer("authenticator", tweede);
    return [await r1, await r2];
  };
  const tel = async (sql) => Number((await voer("supabase_admin", sql)).uit.trim());

  const [ra, rb] = await samen(start(a, 9101, "tijdelijk_wachtwoord", b, {}, 1.5), start(b, 9102, "tijdelijk_wachtwoord", a, {}, 0));
  const gelukt = [ra, rb].filter((r) => r.code === 0).length;
  const geblokkeerd = await tel(`select count(*) from public.gebruikers where id in ('${a}', '${b}') and (open_operatie is not null or herstel_wachtwoord)`);
  if (gelukt !== 1 || geblokkeerd !== 1) {
    return "twee beheerders gaven elkaar tegelijk een nieuw wachtwoord: " + gelukt + " starts lukten en " + geblokkeerd + " accounts zijn geblokkeerd (verwacht: 1 en 1)";
  }
  if (!/42501|geen rechten/.test(ra.fout + rb.fout)) return "de tweede start werd niet geweigerd wegens geen rechten: " + ra.fout + rb.fout;

  const nieuw = { naam: "Wedloop Nieuw", email: "wedloop-nieuw@voorbeeld.test", rol: "lezer" };
  const [rc, rd] = await samen(start(x, 9103, "aanmaken", null, nieuw, 1.5), start(x, 9104, "aanmaken", null, nieuw, 0));
  const starts = [rc, rd].filter((r) => r.code === 0).length;
  const open = await tel(`select count(*) from public.account_operaties where soort = 'aanmaken' and afgerond_op is null and beginstand -> 'plan' ->> 'email' = '${nieuw.email}'`);
  if (starts !== 1 || open !== 1) return "hetzelfde adres werd twee keer tegelijk aangemaakt: " + starts + " starts lukten, " + open + " staan open (verwacht: 1 en 1)";

  // 3. Het slot bij het bijwerken (R2-11). Een lezing verwerkt een uitstap en houdt haar transactie nog even open;
  //    intussen komt er een tussenkomst bij voor dezelfde activiteit. Die mag niet wachten tot het bijwerken klaar is.
  const jaar = await voer("supabase_admin", `
    insert into public.schooljaren (schooljaar, stand, plafond_kleuter_cent, plafond_lager_cent, marge_kleuter_cent, marge_lager_cent)
    values ('2026-2027', 'lopend', 5500, 11000, 200, 400) on conflict (schooljaar) do nothing;`);
  if (jaar.code !== 0) return "de opzet voor het slot mislukte: " + jaar.fout;
  const uitstap = JSON.stringify([{ id: "w-slot", gewijzigd: "2026-11-10T08:00:00Z", datumStart: "2026-11-20", type: "dag", categorie: "uitstap", verwijderd: false, planStatus: "bevestigd", klassen: [] }]);
  const lezing = (slaap) => `
    begin;
    select set_config('request.jwt.claims', '{"role":"service_role"}', true);
    set local role service_role;
    do $$
    declare n bigint;
    begin
      n := (public.mt_lezing_start(null) ->> 'lezing')::bigint;
      perform public.mt_uitstappen_bijwerken(n, '${uitstap}'::jsonb, null, null);
      perform pg_sleep(${slaap});
      perform public.mt_lezing_stop(n, 'wedloop');
    end $$;
    commit;`;
  const eerst = await voer("authenticator", lezing(0));
  if (eerst.code !== 0) return "de uitstap voor het slot ontstond niet: " + eerst.fout;
  const bezig = voer("authenticator", lezing(1.5));
  await new Promise((klaar) => setTimeout(klaar, 500));
  const ingeven = await voer("supabase_admin", `
    set lock_timeout = '700ms';
    insert into public.tussenkomsten (activiteit_id, schooljaar, wie, onderdeel, basis, bedrag_cent)
    select a.id, a.schooljaar, 'Wedloop', 'activiteit', 'totaal', 100 from public.activiteiten a where a.uitstap_id = 'w-slot';`);
  const klaar = await bezig;
  // Opruimen: de volgende stap van de test begint met een lege MT.
  const opruimen = await voer("supabase_admin", `
    set session_replication_role = replica;
    delete from public.tussenkomsten where wie = 'Wedloop';
    delete from public.activiteiten where uitstap_id = 'w-slot';
    delete from mt_intern.lezingen;`);
  if (klaar.code !== 0) return "het bijwerken tijdens het ingeven mislukte: " + klaar.fout;
  if (opruimen.code !== 0) return "het opruimen na het slot mislukte: " + opruimen.fout;
  if (ingeven.code !== 0) return "een tussenkomst ingeven terwijl de uitstappen bijgewerkt worden, moest wachten: " + ingeven.fout.trim();

  // 4. Een schooljaar starten terwijl een lezing bezig is (stap 4a). De lezing kreeg haar nummer en gaf een deel
  //    door, in een transactie die nog openstaat: zonder het slot van de lezingen ziet de start haar niet, en loopt
  //    ze daarna gewoon door, met wat ze vóór de start las. Met het slot wacht de start, en breekt ze de lezing af.
  //    Het schooljaar van de vorige stap gaat even terug naar "in te vullen": zo kan het starten, op elke dag.
  const terug = await voer("supabase_admin", `
    set session_replication_role = replica;
    update public.schooljaren set stand = 'in_te_vullen', lopend_sinds = null where schooljaar = '2026-2027';`);
  if (terug.code !== 0) return "de opzet voor de start van een schooljaar mislukte: " + terug.fout;
  const leest = voer("authenticator", `
    begin;
    select set_config('request.jwt.claims', '{"role":"service_role"}', true);
    set local role service_role;
    do $$
    declare n bigint;
    begin
      n := (public.mt_lezing_start(null) ->> 'lezing')::bigint;
      perform public.mt_uitstappen_bijwerken(n, '[]'::jsonb, null, null);
      perform pg_sleep(1.5);
    end $$;
    commit;`);
  await new Promise((klaar) => setTimeout(klaar, 500));
  const gestart = await voer("authenticator", `
    begin;
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: x, role: "authenticated", aal: "aal2", session_id: x })}', true);
    set local role authenticated;
    select public.mt_schooljaar_bevestigen('2026-2027');
    commit;`);
  const gelezen = await leest;
  const lezingen = await voer("supabase_admin", `select coalesce(string_agg(stand || ':' || coalesce(reden, ''), ', ' order by nummer), 'geen') from mt_intern.lezingen;`);
  const jaarNa = await voer("supabase_admin", `select stand from public.schooljaren where schooljaar = '2026-2027';`);
  const opruimen4 = await voer("supabase_admin", `delete from mt_intern.lezingen;`);
  if (gelezen.code !== 0) return "de lezing tijdens de start van een schooljaar mislukte: " + gelezen.fout;
  if (gestart.code !== 0) return "een schooljaar starten terwijl een lezing bezig is, mislukte: " + gestart.fout;
  if (opruimen4.code !== 0) return "het opruimen na de start van een schooljaar mislukte: " + opruimen4.fout;
  if (jaarNa.uit.trim() !== "lopend") return "na de start is het schooljaar niet lopend: " + jaarNa.uit.trim();
  if (lezingen.uit.trim() !== "afgebroken:een nieuw schooljaar is gestart") {
    return "een schooljaar starten terwijl een lezing bezig is: de lezing is niet afgebroken (" + lezingen.uit.trim() + ")";
  }
  return null;
}

/**
 * De adapter en de databank passen op elkaar (stap 3, B212). De serverfunctie mt-uitstappen geeft door
 * wat adapter.js klaarzet; hier gaat precies dat bericht, van de echte adapter, naar de echte
 * databankfunctie, als de rol van de serverfunctie en in delen zoals zij het doet.
 * voer(gebruiker, sql) voert SQL uit op de databank. Geeft null als alles klopt, anders wat misliep.
 */
async function adapterEnDatabank(voer) {
  const rij = (id, trip, gewijzigd = "2026-11-10T08:00:00.123456+00:00") => ({ id, updated_at: gewijzigd, trip });
  const b = bericht([
    rij("u-dag", { v: 2, datumStart: "2026-11-20", klassen: ["4A", "4B"], planStatus: "bevestigd", activiteit: "Uitstap" }),
    rij("u-gwp", { v: 2, type: "meerdaags", datumStart: "2026-09-23", datumEind: "2026-09-25", klassen: ["6A"], planStatus: "bevestigd" }),
    rij("u-aanvraag", { datumStart: "2026-12-03", klassen: ["1KA"], planStatus: "aangevraagd" }),
    rij("u-geannuleerd", { v: 1, datumStart: "2026-12-04", klassen: ["2A"], planStatus: "geannuleerd", annulering: { metKosten: "wel", kosten: 20 } }),
    rij("u-nascholing", { v: 2, categorie: "nascholing", datumStart: "2026-12-05", klassen: ["4A"], planStatus: "bevestigd" }),
    rij("u-prullenbak", { v: 2, datumStart: "2026-12-06", klassen: ["4A"], planStatus: "bevestigd", verwijderdOp: "2026-11-01T10:00:00.000Z" }),
    rij("u-geen-datum", { v: 2, datumStart: "2026-02-30", klassen: ["4A"], planStatus: "bevestigd" }),
    rij("u-onbekende-klas", { v: 2, datumStart: "2026-12-08", klassen: ["4A", "Zonneklas", "", null], planStatus: "bevestigd" }),
    rij("u-vorig-jaar", { v: 2, datumStart: "2026-03-10", klassen: ["3A"], planStatus: "bevestigd" }),
    rij("u-ver-weg", { v: 2, datumStart: "2031-03-10", klassen: ["3A"], planStatus: "bevestigd" }),
    rij("u-nieuw-schema", { v: 3, datumStart: "2026-12-09", klassen: ["4A"], planStatus: "bevestigd" }),
    rij("u-geen-lijst", { v: 2, datumStart: "2026-12-10", klassen: "4A", planStatus: "iets" }),
  ]);
  const tekst = (waarde) => "'" + String(waarde).replace(/'/g, "''") + "'";
  const opzet = await voer("supabase_admin", `
    insert into public.schooljaren (schooljaar, stand, plafond_kleuter_cent, plafond_lager_cent, marge_kleuter_cent, marge_lager_cent)
    values ('2025-2026', 'voorbij', 5500, 11000, 200, 400), ('2026-2027', 'lopend', 5500, 11000, 200, 400)
    on conflict (schooljaar) do nothing;
    select mt_intern.klassen_toepassen(j, ${tekst(JSON.stringify(["1KA", "2A", "3A", "4A", "4B", "6A"].map((naam, i) => ({ id: "k" + i, naam, groep: naam === "1KA" ? "Kleuter" : "Lager" }))))}::jsonb)
      from (values ('2025-2026'), ('2026-2027')) as x(j);`);
  if (opzet.code !== 0) return "de opzet voor de adapter mislukte: " + opzet.fout;

  /** Eén oproep, zoals de serverfunctie: als de rol service_role, via de rol van de Data API. */
  const roep = async (sql, rol = "service_role") => {
    const r = await voer("authenticator", `
      begin;
      select set_config('request.jwt.claims', '${JSON.stringify({ role: rol })}', true);
      set local role ${rol};
      ${sql}
      commit;`);
    if (r.code !== 0) return { fout: r.fout };
    // De eerste regel is wat set_config teruggeeft; het antwoord van de functie is de laatste.
    const regel = r.uit.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
    return regel ? JSON.parse(regel) : { fout: "geen antwoord: " + r.uit };
  };
  /** Een lezing starten (006). Tussen twee lezingen van de test liggen geen dertig seconden: de test zet de klok twee minuten verder. */
  const start = async () => {
    await voer("supabase_admin", "update mt_intern.lezingen set begonnen_op = begonnen_op - interval '2 minutes', klaar_op = klaar_op - interval '2 minutes';");
    return roep("select public.mt_lezing_start(null);");
  };
  const deel = (lezing, uitstappen, ids, rol = "service_role") => roep(
    `select public.mt_uitstappen_bijwerken(${Number(lezing)}, ${tekst(JSON.stringify(uitstappen))}::jsonb, ${ids === null ? "null" : "array[" + ids.map(tekst).join(", ") + "]::text[]"}, ${ids === null ? "null" : "'{}'::jsonb"});`, rol);
  /** Eén lezing in één deel. */
  const stuur = async (uitstappen, ids) => {
    const s = await start();
    if (s.fout || s.wat !== "nieuw") return { fout: "de lezing startte niet: " + JSON.stringify(s) };
    return deel(s.lezing, uitstappen, ids);
  };
  const tellers = (r) => ["nieuw", "gewijzigd", "weg", "ongewijzigd", "ongeldig", "buiten", "geen", "gesloten", "niet_gevonden"].map((naam) => naam + " " + r[naam]).join(", ");

  // De eerste lezing: zeven uitstappen komen in de MT.
  const eerste = await stuur(b.uitstappen, b.alleIds);
  if (eerste.fout) return "de databank weigert het bericht van de adapter: " + eerste.fout;
  if (tellers(eerste) !== "nieuw 7, gewijzigd 0, weg 0, ongewijzigd 0, ongeldig 1, buiten 1, geen 2, gesloten 0, niet_gevonden 0") return "de eerste lezing gaf: " + tellers(eerste);
  const onbekend = eerste.onbekende_klassen;
  if (!Array.isArray(onbekend) || onbekend.length !== 1 || onbekend[0].uitstap !== "u-onbekende-klas" || JSON.stringify(onbekend[0].klassen) !== '["Zonneklas"]') {
    return "de onbekende klassen: " + JSON.stringify(onbekend);
  }
  const stand = await voer("supabase_admin", `
    select string_agg(a.uitstap_id || ' ' || a.schooljaar || ' ' || a.bron_plan || ' ' || a.datum_start || ' ' || a.datum_eind || ' ' || a.meerdaags || ' '
             || to_char(a.bron_gewijzigd_op at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || ' ['
             || coalesce((select string_agg(k.naam, ',' order by k.naam) from public.klaslijsten l join public.klassen k on k.id = l.klas_id where l.activiteit_id = a.id), '') || ']', '; ' order by a.uitstap_id)
      from public.activiteiten a;`);
  const verwacht = [
    "u-aanvraag 2026-2027 aangevraagd 2026-12-03 2026-12-03 false 2026-11-10T08:00:00.123456 [1KA]",
    "u-dag 2026-2027 bevestigd 2026-11-20 2026-11-20 false 2026-11-10T08:00:00.123456 [4A,4B]",
    "u-geannuleerd 2026-2027 geannuleerd 2026-12-04 2026-12-04 false 2026-11-10T08:00:00.123456 [2A]",
    "u-geen-lijst 2026-2027 aangevraagd 2026-12-10 2026-12-10 false 2026-11-10T08:00:00.123456 []",
    "u-gwp 2026-2027 bevestigd 2026-09-23 2026-09-25 true 2026-11-10T08:00:00.123456 [6A]",
    "u-onbekende-klas 2026-2027 bevestigd 2026-12-08 2026-12-08 false 2026-11-10T08:00:00.123456 [4A]",
    "u-vorig-jaar 2025-2026 bevestigd 2026-03-10 2026-03-10 false 2026-11-10T08:00:00.123456 [3A]",
  ].join("; ");
  if (stand.code !== 0 || stand.uit.trim() !== verwacht) return "in de MT staat na de eerste lezing:\n" + stand.uit.trim() + "\nverwacht:\n" + verwacht + "\n" + stand.fout;

  // Een tweede lezing wijzigt niets.
  const tweede = await stuur(b.uitstappen, b.alleIds);
  if (tweede.fout || tellers(tweede) !== "nieuw 0, gewijzigd 0, weg 0, ongewijzigd 7, ongeldig 1, buiten 1, geen 2, gesloten 0, niet_gevonden 0") return "de tweede lezing gaf: " + (tweede.fout || tellers(tweede));

  // In delen, zoals de serverfunctie: enkel het laatste deel draagt de lijst van id's. u-dag staat er niet meer in.
  const derde = await start();
  if (derde.fout || derde.wat !== "nieuw") return "de derde lezing startte niet: " + JSON.stringify(derde);
  const deel1 = await deel(derde.lezing, b.uitstappen.slice(0, 6), null);
  if (deel1.fout || deel1.niet_gevonden !== 0 || "uitkomst" in deel1) return "het eerste deel, zonder lijst van id's: " + (deel1.fout || tellers(deel1));
  const deel2 = await deel(derde.lezing, b.uitstappen.slice(6), b.alleIds.filter((id) => id !== "u-dag"));
  if (deel2.fout || deel2.niet_gevonden !== 1) return "het laatste deel, met de lijst van id's: " + (deel2.fout || tellers(deel2));
  // De uitkomst van de lezing telt beide delen samen.
  const samen = deel2.uitkomst && deel2.uitkomst.uitstappen;
  if (!samen || samen.ongewijzigd !== 7 || samen.ongeldig !== 1 || samen.buiten !== 1 || samen.geen !== 2 || samen.niet_gevonden !== 1) {
    return "de uitkomst van een lezing in twee delen: " + JSON.stringify(deel2.uitkomst);
  }
  // Wie meteen daarna vraagt, krijgt die uitkomst terug, zonder nieuwe lezing.
  const recent = await roep("select public.mt_lezing_start(null);");
  if (recent.wat !== "recent" || !recent.uitkomst || recent.uitkomst.lezing !== derde.lezing) return "een vraag binnen de dertig seconden: " + JSON.stringify(recent);
  const weg = await voer("supabase_admin", "select string_agg(uitstap_id, ',' order by uitstap_id) from public.activiteiten where bron_stand = 'niet_gevonden';");
  if (weg.uit.trim() !== "u-dag") return "niet meer gevonden: " + weg.uit.trim() + " (verwacht: u-dag)";

  // Enkel de serverfunctie mag dit: een gewone gebruiker wordt geweigerd.
  const gewoon = await deel(derde.lezing, b.uitstappen, b.alleIds, "authenticated");
  if (!gewoon.fout || !/permission denied|42501/.test(gewoon.fout)) return "een gewone gebruiker werd niet geweigerd: " + JSON.stringify(gewoon);
  const gewoonStart = await roep("select public.mt_lezing_start(null);", "authenticated");
  if (!gewoonStart.fout || !/permission denied|42501/.test(gewoonStart.fout)) return "een gewone gebruiker startte een lezing: " + JSON.stringify(gewoonStart);
  return null;
}

// ---- stap 8: begin ----
/**
 * De echte serverfunctie tegen de echte databank (review 2: R11). Tot hier keek elke test één kant na:
 * de serverfunctie tegen een nagebootste databank (tests/uitstapfunctie_test.js), en de databank met
 * berichten die de test zelf opstelde. Hier loopt een heel verzoek door de echte behandelaar van
 * functies/mt-uitstappen/index.ts, en al wat hij aan de databank vraagt, voert de echte databank uit.
 *
 * Wat nagebootst is: het netwerk. Een vraag aan de Data API van het eigen project wordt dezelfde vraag
 * aan de databank, zoals PostgREST ze stelt: als de rol van de Data API, met de rol en de gegevens van
 * het toegangsbewijs, en met het bericht omgezet volgens de soorten van de parameters (json_to_record).
 * De secret key wordt de rol service_role; een toegangsbewijs wordt de rol authenticated met de id van
 * die gebruiker. Gebruikt de functie de verkeerde sleutel, dan weigert de databank zelf. De
 * uitstappentool is een lijst in het geheugen, die bladert op id zoals de Data API.
 *
 * De gevallen: een lezer leest; een tweede vraag binnen de dertig seconden; een beheerder, met de
 * klassen; twee lezingen die elkaar kruisen, waarbij de oudste niets meer mag wijzigen; de rem (B225),
 * hersteld en bevestigd; de uitstappentool die niet antwoordt; en een lange lijst, in bladzijden gelezen
 * en in delen doorgegeven.
 * voer(gebruiker, sql, uitvoerig) voert SQL uit op de databank; met uitvoerig staat de code van een fout
 * in de melding. Geeft null als alles klopt, anders wat misliep.
 */
async function functieEnDatabank(voer) {
  const URL_MT = Object.keys(PAGINA)[0];
  const OORSPRONG = PAGINA[URL_MT];
  const PUBLIEK = "sb_publishable_voorbeeld";
  const GEHEIM = ["sb", "secret", "enkelvoordetest"].join("_");
  const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  const [beheerder, lezer] = [id(9201), id(9202)];
  const b64 = (t) => btoa(t).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const bewijs = (wie) => b64('{"alg":"ES256"}') + "." + b64(JSON.stringify({ sub: wie })) + "." + b64("handtekening");
  const sessies = new Map([[bewijs(beheerder), beheerder], [bewijs(lezer), lezer]]);
  const tekst = (waarde) => "'" + String(waarde).replace(/'/g, "''") + "'";
  const json = (status, lichaam, koppen = {}) => new Response(JSON.stringify(lichaam), { status, headers: { "Content-Type": "application/json", ...koppen } });
  /** Eén waarde uit de databank, als de eigenaar: om na te kijken wat er nu staat. */
  const een = async (sql) => {
    const r = await voer("supabase_admin", sql);
    return r.code === 0 ? r.uit.trim() : "FOUT: " + r.fout.trim();
  };

  // ---------- De opzet: een lege MT, twee gebruikers, twee schooljaren en zes klassen ----------
  const klassen = ["1KA", "2A", "3A", "4A", "4B", "6A"].map((naam, i) => ({ id: "k" + i, naam, groep: naam === "1KA" ? "Kleuter" : "Lager" }));
  const opzet = await voer("supabase_admin", `
    set client_min_messages = warning;
    truncate table public.activiteiten cascade;
    delete from mt_intern.lezingen;
    insert into auth.users (id, email) values ('${beheerder}', 'functie-b@voorbeeld.test'), ('${lezer}', 'functie-l@voorbeeld.test');
    insert into auth.mfa_factors (id, user_id, factor_type, status) select id, id, 'totp', 'verified' from auth.users where email like 'functie-%';
    insert into auth.sessions (id, user_id, aal, factor_id) select id, id, 'aal2', id from auth.users where email like 'functie-%';
    insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method)
      select u.id, now(), now(), m.methode from auth.users u, (values ('password'), ('totp')) as m(methode) where u.email like 'functie-%';
    insert into public.gebruikers (id, naam, email, rol, actief, wachtwoord_tijdelijk, eerste_aanmelding_afgerond, app_koppelen, app_factor)
      select id, 'Functie ' || left(email, 9), email, case when email like 'functie-b@%' then 'beheerder' else 'lezer' end, true, false, true, false, id
        from auth.users where email like 'functie-%';
    insert into public.schooljaren (schooljaar, stand, plafond_kleuter_cent, plafond_lager_cent, marge_kleuter_cent, marge_lager_cent)
    values ('2025-2026', 'voorbij', 5500, 11000, 200, 400), ('2026-2027', 'lopend', 5500, 11000, 200, 400)
    on conflict (schooljaar) do nothing;
    select mt_intern.klassen_toepassen(j, ${tekst(JSON.stringify(klassen))}::jsonb) from (values ('2025-2026'), ('2026-2027')) as x(j);`);
  if (opzet.code !== 0) return "de opzet voor de serverfunctie mislukte: " + opzet.fout;

  // ---------- De Data API van het eigen project, op de echte databank ----------
  const parameters = new Map();
  const oproepen = [];
  /** Eén databankfunctie, zoals PostgREST ze oproept. Geeft het antwoord zoals de Data API het geeft. */
  async function dataApi(naam, lichaam, sleutel, drager) {
    let claims = null;
    if (sleutel === GEHEIM && drager === GEHEIM) claims = { role: "service_role" };
    else if (sleutel === PUBLIEK && sessies.has(drager)) claims = { sub: sessies.get(drager), role: "authenticated", aal: "aal2", session_id: sessies.get(drager) };
    if (claims === null) return json(401, { code: "PGRST301", message: "JWT expired" });
    oproepen.push({ naam, rol: claims.role, lichaam });
    if (!parameters.has(naam)) {
      const r = await voer("supabase_admin", `
        select '[' || pg_get_function_identity_arguments(p.oid) || ']' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = ${tekst(naam)};`);
      const regels = r.uit.split("\n").map((l) => l.trim()).filter((l) => l !== "");
      parameters.set(naam, r.code === 0 && regels.length === 1 ? regels[0].slice(1, -1) : null);
    }
    const lijst = parameters.get(naam);
    const namen = lijst ? lijst.split(", ").map((deel) => deel.split(" ")[0]) : [];
    const gegeven = Object.keys(lichaam);
    if (lijst === null || !gegeven.every((sleutelnaam) => namen.includes(sleutelnaam))) {
      return json(404, { code: "PGRST202", message: "Could not find the function public." + naam + " in the schema cache" });
    }
    const vraag = gegeven.length
      ? `select public.${naam}(${gegeven.map((p) => p + " := _." + p).join(", ")}) from json_to_record(${tekst(JSON.stringify(lichaam))}::json) as _(${lijst});`
      : `select public.${naam}();`;
    const r = await voer("authenticator", `
      begin;
      set local request.jwt.claims = ${tekst(JSON.stringify(claims))};
      set local role ${claims.role};
      ${vraag}
      commit;`, true);
    if (r.code !== 0) {
      // De code van de fout beslist in de serverfunctie; de status doet er enkel toe bij 401 en 404.
      const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)$/m.exec(r.fout);
      const code = m ? m[1] : "XX000";
      return json(code === "42501" ? 403 : code === "42883" ? 404 : 400, { code, message: m ? m[2] : r.fout.trim(), details: null, hint: null });
    }
    const regels = r.uit.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    return new Response(regels.length ? regels[regels.length - 1] : "null", { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // ---------- De uitstappentool: een lijst in het geheugen ----------
  const bron = { uitstappen: [], instellingen: [], verzoeken: 0, stuk: false, poort: null, aangekomen: null, maxRijen: null, metBewijs: 0 };
  const rij = (nr, datumStart, namen, extra = {}) => ({ id: nr, updated_at: "2026-11-01T08:00:00+00:00", trip: { v: 2, datumStart, klassen: namen, planStatus: "bevestigd", ...extra } });
  bron.uitstappen = [
    rij("f-01", "2026-11-20", ["4A", "4B"]),
    rij("f-02", "2026-09-23", ["6A"], { type: "meerdaags", datumEind: "2026-09-25" }),
    rij("f-03", "2026-12-03", ["1KA"], { planStatus: "aangevraagd" }),
    rij("f-04", "2026-12-04", ["2A"]),
    rij("f-05", "2026-12-08", ["4A", "5A"]),
    rij("f-06", "2027-01-12", ["3A"]),
    rij("f-07", "2027-02-02", ["3A"]),
    rij("f-08", "2027-03-02", ["6A"]),
    // een datum die een lijst is: onbruikbaar, de MT neemt de rij niet over en struikelt er niet over (R13)
    rij("f-09", ["2026-12-01"], ["4A"]),
    // een schema dat de MT nog niet kent
    rij("f-10", "2026-12-09", ["4A"], { v: 3 }),
    rij("f-11", "2026-12-05", ["4A"], { categorie: "nascholing" }),
    // geen object: voor de MT een uitstap zonder datum, dus ongeldig
    { id: "f-12", updated_at: "2026-11-01T08:00:00+00:00", trip: "kapot" },
  ];
  bron.instellingen = [{ id: "klimop", data: { klassen: [...klassen, { id: "k6", naam: "5A", groep: "Lager" }] } }];
  const weg = ["f-01", "f-02", "f-03", "f-04", "f-06", "f-07"];

  /** Een vraag aan de uitstappentool: op id, verder vanaf de laatste id, met het aantal dat nog volgt. */
  function uitDeBron(url) {
    const tabel = url.pathname.replace("/rest/v1/", "");
    if (tabel !== "uitstappen" && tabel !== "instellingen") return json(404, { message: "bestaat niet" });
    if (url.searchParams.get("order") !== "id.asc" || url.searchParams.has("offset")) return json(400, { message: "de nabootsing leest enkel op id, zonder verschuiving" });
    let rijen = [...bron[tabel]].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const filter of url.searchParams.getAll("id")) {
      if (filter.startsWith("eq.")) rijen = rijen.filter((r) => r.id === filter.slice(3));
      else if (filter.startsWith("gt.")) rijen = rijen.filter((r) => r.id > filter.slice(3));
      else return json(400, { message: "onbekende filter" });
    }
    const stuk = rijen.slice(0, Math.min(Number(url.searchParams.get("limit")), bron.maxRijen ?? Infinity)).map((r) => {
      const uit = {};
      for (const kolom of url.searchParams.get("select").split(",")) {
        const m = /^(\w+):trip->(\w+)$/.exec(kolom);
        if (m) uit[m[1]] = r.trip !== null && typeof r.trip === "object" && !Array.isArray(r.trip) && r.trip[m[2]] !== undefined ? r.trip[m[2]] : null;
        else uit[kolom] = r[kolom] === undefined ? null : r[kolom];
      }
      return uit;
    });
    return json(stuk.length < rijen.length ? 206 : 200, stuk, { "content-range": (stuk.length ? "0-" + (stuk.length - 1) : "*") + "/" + rijen.length });
  }

  // ---------- Het netwerk van de serverfunctie ----------
  const haal = async (adres, opties) => {
    const url = new URL(adres);
    const koppen = new Headers(opties.headers);
    if (url.origin === UITSTAPPENTOOL.url) {
      bron.verzoeken++;
      if (koppen.has("Authorization")) bron.metBewijs++;
      if (koppen.get("apikey") !== UITSTAPPENTOOL.sleutel) return json(401, { message: "Invalid API key" });
      if (bron.stuk) throw new TypeError("geen netwerk");
      // Het antwoord is de stand van nu. Wacht de lezing daarna, dan draagt ze een oude stand mee.
      const antwoord = uitDeBron(url);
      if (bron.poort !== null && url.pathname === "/rest/v1/uitstappen") {
        const poort = bron.poort;
        bron.poort = null;
        bron.aangekomen();
        await poort;
      }
      return antwoord;
    }
    if (url.origin !== URL_MT) throw new TypeError("onbekend adres: " + adres);
    const sleutel = koppen.get("apikey");
    const drager = (koppen.get("Authorization") ?? "").replace(/^Bearer /, "");
    if (url.pathname === "/auth/v1/user") {
      return sleutel === PUBLIEK && sessies.has(drager)
        ? json(200, { id: sessies.get(drager), email: "functie@voorbeeld.test" })
        : json(403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" });
    }
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);
    if (!m || opties.method !== "POST") return json(404, { code: "PGRST202", message: "bestaat niet" });
    return dataApi(m[1], opties.body ? JSON.parse(opties.body) : {}, sleutel, drager);
  };

  const logboek = [];
  const behandel = maakBehandelaar({ url: URL_MT, publiek: PUBLIEK, geheim: GEHEIM, haal, meld: (regel) => logboek.push(regel), nu: () => Date.now() });
  /** Eén verzoek van de pagina, met het toegangsbewijs van die gebruiker. */
  const vraag = async (wie) => {
    const antwoord = await behandel(new Request(URL_MT + "/functions/v1/mt-uitstappen", {
      method: "POST",
      headers: { Origin: OORSPRONG, Authorization: "Bearer " + bewijs(wie), "Content-Type": "application/json" },
      body: JSON.stringify({ actie: "bijwerken" }),
    }));
    const ruw = await antwoord.text();
    return { status: antwoord.status, ruw, ...JSON.parse(ruw) };
  };
  /** Twee minuten later, voor de databank: voorbij de rust van dertig seconden en de minuut van een lezing die bezig is. */
  const later = () => voer("supabase_admin", "update mt_intern.lezingen set begonnen_op = begonnen_op - interval '2 minutes', klaar_op = klaar_op - interval '2 minutes';");
  const tellers = (u) => u === null || typeof u !== "object" ? String(u)
    : ["nieuw", "gewijzigd", "weg", "ongewijzigd", "ongeldig", "buiten", "geen", "gesloten", "niet_gevonden", "tegengehouden"].map((naam) => naam + " " + u[naam]).join(", ");
  const kort = (r) => JSON.stringify({ ...r, ruw: undefined, overzicht: undefined });
  const lezingen = () => een("select string_agg(l.stand || ':' || coalesce(l.reden, ''), ', ' order by l.nummer) from mt_intern.lezingen l;");
  const standen = () => een("select string_agg(a.uitstap_id || ' ' || a.bron_stand, ', ' order by a.uitstap_id) from public.activiteiten a where a.uitstap_id like 'f-%';");

  // ---------- 1. Een lezer leest: de uitstappen komen in de MT, de klassen blijven wat ze waren ----------
  const eerste = await vraag(lezer);
  if (eerste.status !== 200 || eerste.ok !== true || eerste.stand !== "klaar" || !Number.isInteger(eerste.lezing)) return "de eerste lezing: " + kort(eerste);
  if (tellers(eerste.uitstappen) !== "nieuw 8, gewijzigd 0, weg 0, ongewijzigd 0, ongeldig 1, buiten 0, geen 1, gesloten 0, niet_gevonden 0, tegengehouden 0") return "de eerste lezing telde: " + tellers(eerste.uitstappen);
  if (JSON.stringify(eerste.gelezen) !== '{"klassen":null,"uitstappen":12}' || eerste.klassen !== null) return "de eerste lezing, van een lezer, las de klassen: " + kort(eerste);
  if (JSON.stringify(eerste.onbekende_klassen) !== '[{"klassen":["5A"],"uitstap":"f-05","schooljaar":"2026-2027"}]') return "de onbekende klassen, met hun schooljaar: " + JSON.stringify(eerste.onbekende_klassen);
  if (JSON.stringify(eerste.onbruikbaar) !== '["f-09"]' || JSON.stringify(eerste.onbekende_versie) !== '["f-10"]') return "wat de MT niet kon overnemen: " + kort(eerste);
  if (eerste.verdwenen_taak !== null || JSON.stringify(eerste.verdwenen) !== "[]" || JSON.stringify(eerste.wacht) !== "[]") return "de eerste lezing hield iets tegen: " + kort(eerste);
  if (typeof eerste.klaar_op !== "string" || Number.isNaN(Date.parse(eerste.klaar_op)) || !Number.isInteger(eerste.duur_ms) || eerste.duur_ms < 0) return "de eerste lezing zegt niet wanneer ze klaar was: " + kort(eerste);
  if (eerste.overzicht === null || typeof eerste.overzicht !== "object" || eerste.overzicht.onbruikbaar !== 1 || eerste.overzicht.onbekendeVersie !== 1) return "het overzicht van de eerste lezing: " + JSON.stringify(eerste.overzicht);
  const inDeMT = await een(`
    select string_agg(a.uitstap_id || ' ' || a.schooljaar || ' ' || a.bron_plan || ' ' || a.datum_start || ' ' || a.datum_eind || ' ['
             || coalesce((select string_agg(k.naam, ',' order by k.naam) from public.klaslijsten l join public.klassen k on k.id = l.klas_id where l.activiteit_id = a.id), '') || ']', '; ' order by a.uitstap_id)
      from public.activiteiten a;`);
  const verwacht = [
    "f-01 2026-2027 bevestigd 2026-11-20 2026-11-20 [4A,4B]",
    "f-02 2026-2027 bevestigd 2026-09-23 2026-09-25 [6A]",
    "f-03 2026-2027 aangevraagd 2026-12-03 2026-12-03 [1KA]",
    "f-04 2026-2027 bevestigd 2026-12-04 2026-12-04 [2A]",
    "f-05 2026-2027 bevestigd 2026-12-08 2026-12-08 [4A]",
    "f-06 2026-2027 bevestigd 2027-01-12 2027-01-12 [3A]",
    "f-07 2026-2027 bevestigd 2027-02-02 2027-02-02 [3A]",
    "f-08 2026-2027 bevestigd 2027-03-02 2027-03-02 [6A]",
  ].join("; ");
  if (inDeMT !== verwacht) return "in de MT staat na de eerste lezing:\n" + inDeMT + "\nverwacht:\n" + verwacht;
  const wieLas = await een("select l.nummer || ' ' || l.stand || ' ' || l.door from mt_intern.lezingen l;");
  if (wieLas !== eerste.lezing + " klaar " + lezer) return "de lezing in de databank: " + wieLas;

  // ---------- 2. Binnen de dertig seconden: dezelfde uitkomst, zonder te lezen, ook voor een beheerder ----------
  const verzoekenVoor = bron.verzoeken;
  const tweede = await vraag(beheerder);
  if (tweede.status !== 200 || tweede.stand !== "recent" || tweede.lezing !== eerste.lezing || tellers(tweede.uitstappen) !== tellers(eerste.uitstappen)) return "een vraag binnen de dertig seconden: " + kort(tweede);
  if (bron.verzoeken !== verzoekenVoor) return "een vraag binnen de dertig seconden las de uitstappentool toch";
  if (await een("select count(*) from public.klassen where naam = '5A';") !== "0") return "een vraag binnen de dertig seconden werkte de klassen bij";

  // ---------- 3. Later leest een beheerder: eerst de klassen, met zijn eigen toegangsbewijs, dan de uitstappen ----------
  await later();
  const derde = await vraag(beheerder);
  if (derde.status !== 200 || derde.stand !== "klaar" || derde.lezing <= eerste.lezing) return "de lezing van de beheerder: " + kort(derde);
  if (JSON.stringify(derde.klassen) !== '{"ok":true,"nieuw":1,"uitgezet":0,"gewijzigd":0,"schooljaar":"2026-2027"}' || JSON.stringify(derde.gelezen) !== '{"klassen":7,"uitstappen":12}') return "de klassen bij de beheerder: " + kort(derde);
  // Klas 5A bestaat nu: de uitstap die ze noemde, krijgt haar lijst erbij.
  if (tellers(derde.uitstappen) !== "nieuw 0, gewijzigd 1, weg 0, ongewijzigd 7, ongeldig 1, buiten 0, geen 1, gesloten 0, niet_gevonden 0, tegengehouden 0") return "de lezing van de beheerder telde: " + tellers(derde.uitstappen);
  if (JSON.stringify(derde.onbekende_klassen) !== "[]") return "klas 5A bleef onbekend: " + JSON.stringify(derde.onbekende_klassen);
  const lijst5A = await een("select string_agg(k.naam, ',' order by k.naam) from public.klaslijsten l join public.klassen k on k.id = l.klas_id join public.activiteiten a on a.id = l.activiteit_id where a.uitstap_id = 'f-05';");
  if (lijst5A !== "4A,5A") return "de lijsten van de uitstap met klas 5A: " + lijst5A;

  // ---------- 4. Twee lezingen kruisen elkaar: de oudste mag niets meer wijzigen (R03) ----------
  // De trage lezing krijgt haar nummer en leest de uitstappentool; haar antwoord blijft onderweg hangen.
  await later();
  let open;
  const poort = new Promise((klaar) => { open = klaar; });
  const aangekomen = new Promise((klaar) => { bron.aangekomen = klaar; });
  bron.poort = poort;
  const trage = vraag(lezer);
  await aangekomen;
  // Meer dan een minuut later: de uitstap schuift op in de uitstappentool, en een nieuwe lezing neemt het over.
  await later();
  bron.uitstappen.find((r) => r.id === "f-01").trip.datumStart = "2026-11-27";
  bron.uitstappen.find((r) => r.id === "f-01").updated_at = "2026-11-10T08:00:00+00:00";
  const snelle = await vraag(beheerder);
  if (snelle.status !== 200 || snelle.stand !== "klaar" || tellers(snelle.uitstappen) !== "nieuw 0, gewijzigd 1, weg 0, ongewijzigd 7, ongeldig 1, buiten 0, geen 1, gesloten 0, niet_gevonden 0, tegengehouden 0") return "de nieuwe lezing, terwijl een oudere nog onderweg was: " + kort(snelle);
  // Nu pas komt het antwoord van de trage lezing aan, met de oude datum.
  open();
  const ingehaald = await trage;
  if (ingehaald.status !== 409 || ingehaald.ok !== false || ingehaald.code !== "ingehaald" || ingehaald.deels !== false) return "de ingehaalde lezing: " + kort(ingehaald);
  const datum = await een("select a.datum_start || ' ' || to_char(a.bron_gewijzigd_op at time zone 'UTC', 'YYYY-MM-DD') from public.activiteiten a where a.uitstap_id = 'f-01';");
  if (datum !== "2026-11-27 2026-11-10") return "een ingehaalde lezing zette de oude datum terug: " + datum;
  if (await lezingen() !== "klaar:, klaar:, afgebroken:geen einde binnen de tijd, klaar:") return "de lezingen na het kruisen: " + await lezingen();

  // ---------- 5. De rem (B225): zes uitstappen verdwijnen in één lezing ----------
  const alles = bron.uitstappen;
  bron.uitstappen = alles.filter((r) => !weg.includes(r.id));
  await later();
  const rem = await vraag(lezer);
  if (rem.status !== 200 || rem.stand !== "klaar" || tellers(rem.uitstappen) !== "nieuw 0, gewijzigd 0, weg 0, ongewijzigd 2, ongeldig 1, buiten 0, geen 1, gesloten 0, niet_gevonden 0, tegengehouden 6") return "de rem: " + kort(rem);
  const lijstRem = [
    { tot: "2026-09-25", van: "2026-09-23", klassen: ["6A"], uitstap: "f-02" },
    { tot: "2026-11-27", van: "2026-11-27", klassen: ["4A", "4B"], uitstap: "f-01" },
    { tot: "2026-12-03", van: "2026-12-03", klassen: ["1KA"], uitstap: "f-03" },
    { tot: "2026-12-04", van: "2026-12-04", klassen: ["2A"], uitstap: "f-04" },
    { tot: "2027-01-12", van: "2027-01-12", klassen: ["3A"], uitstap: "f-06" },
    { tot: "2027-02-02", van: "2027-02-02", klassen: ["3A"], uitstap: "f-07" },
  ];
  if (typeof rem.verdwenen_taak !== "string" || JSON.stringify(rem.verdwenen) !== JSON.stringify(lijstRem)) return "de rem zegt niet welke uitstappen ze tegenhield: " + kort(rem);
  if (await standen() !== ["f-01", "f-02", "f-03", "f-04", "f-05", "f-06", "f-07", "f-08"].map((u) => u + " actief").join(", ")) return "de rem liet toch uitstappen verdwijnen: " + await standen();
  const taken = () => een("select string_agg(t.stand || ':' || coalesce(t.afhandeling, ''), ', ' order by t.aangemaakt_op, t.id) from public.taken t where t.soort = 'veel_verdwenen';");
  if (await taken() !== "open:") return "de taak van de rem: " + await taken();

  // De uitstappen staan er weer: de taak sluit vanzelf.
  bron.uitstappen = alles;
  await later();
  const hersteld = await vraag(lezer);
  if (hersteld.status !== 200 || hersteld.verdwenen_taak !== null || tellers(hersteld.uitstappen) !== "nieuw 0, gewijzigd 0, weg 0, ongewijzigd 8, ongeldig 1, buiten 0, geen 1, gesloten 0, niet_gevonden 0, tegengehouden 0") return "de uitstappen kwamen terug: " + kort(hersteld);
  if (await taken() !== "afgehandeld:hersteld") return "de taak van de rem, nadat de uitstappen terugkwamen: " + await taken();

  // Ze verdwijnen opnieuw, en nu zijn ze echt weg: enkel een beheerder bevestigt, en enkel met het aantal dat hij zag.
  bron.uitstappen = alles.filter((r) => !weg.includes(r.id));
  await later();
  const opnieuw = await vraag(lezer);
  if (opnieuw.status !== 200 || opnieuw.uitstappen.tegengehouden !== 6 || typeof opnieuw.verdwenen_taak !== "string" || opnieuw.verdwenen_taak === rem.verdwenen_taak) return "de rem, een tweede keer: " + kort(opnieuw);
  const bevestig = async (wie, aantal) => {
    const antwoord = await dataApi("mt_verdwenen_bevestigen", { p_taak: opnieuw.verdwenen_taak, p_aantal: aantal }, PUBLIEK, bewijs(wie));
    return { status: antwoord.status, ...JSON.parse(await antwoord.text()) };
  };
  const anderAantal = await bevestig(beheerder, 5);
  if (anderAantal.code !== "MT409") return "bevestigen met een ander aantal dan de taak telt: " + JSON.stringify(anderAantal);
  const doorLezer = await bevestig(lezer, 6);
  if (doorLezer.code !== "42501") return "een lezer bevestigde dat de uitstappen weg zijn: " + JSON.stringify(doorLezer);
  if (await standen() !== ["f-01", "f-02", "f-03", "f-04", "f-05", "f-06", "f-07", "f-08"].map((u) => u + " actief").join(", ")) return "een geweigerde bevestiging wijzigde toch iets: " + await standen();
  const bevestigd = await bevestig(beheerder, 6);
  if (bevestigd.status !== 200 || bevestigd.niet_gevonden !== 6) return "de beheerder bevestigt: " + JSON.stringify(bevestigd);
  if (await standen() !== ["f-01", "f-02", "f-03", "f-04", "f-05", "f-06", "f-07", "f-08"].map((u) => u + (weg.includes(u) ? " niet_gevonden" : " actief")).join(", ")) return "na de bevestiging: " + await standen();
  if (await taken() !== "afgehandeld:hersteld, afgehandeld:bevestigd") return "de taken van de rem na de bevestiging: " + await taken();
  // Wat de laatste lezing toonde, klopt niet meer: de volgende vraag leest meteen opnieuw, ook binnen de dertig seconden.
  const naBevestigen = await vraag(lezer);
  if (naBevestigen.status !== 200 || naBevestigen.stand !== "klaar" || naBevestigen.lezing <= opnieuw.lezing || naBevestigen.verdwenen_taak !== null
      || tellers(naBevestigen.uitstappen) !== "nieuw 0, gewijzigd 0, weg 0, ongewijzigd 2, ongeldig 1, buiten 0, geen 1, gesloten 0, niet_gevonden 0, tegengehouden 0") return "de lezing na de bevestiging: " + kort(naBevestigen);

  // ---------- 6. De uitstappentool antwoordt niet: niets gewijzigd, en de volgende lezing wacht geen minuut ----------
  await later();
  bron.stuk = true;
  const stil = await vraag(lezer);
  if (stil.status !== 503 || stil.code !== "bron" || stil.deels !== false) return "de uitstappentool antwoordt niet: " + kort(stil);
  if (!(await lezingen()).endsWith(", afgebroken:bron")) return "een lezing die strandde, staat niet als afgebroken in de databank: " + await lezingen();
  bron.stuk = false;
  const daarna = await vraag(lezer);
  if (daarna.status !== 200 || daarna.stand !== "klaar" || daarna.lezing <= naBevestigen.lezing) return "de lezing na een gestrande lezing: " + kort(daarna);

  // ---------- 7. Een lange lijst: in bladzijden gelezen, in delen doorgegeven, in één uitkomst geteld ----------
  for (let n = 1; n <= 501; n++) bron.uitstappen.push(rij("g-" + String(n).padStart(4, "0"), "2027-04-" + String(1 + (n % 28)).padStart(2, "0"), ["4A"]));
  bron.maxRijen = 200;
  const oproepenVoor = oproepen.length;
  await later();
  const lang = await vraag(lezer);
  if (lang.status !== 200 || lang.stand !== "klaar" || tellers(lang.uitstappen) !== "nieuw 501, gewijzigd 0, weg 0, ongewijzigd 2, ongeldig 1, buiten 0, geen 1, gesloten 0, niet_gevonden 0, tegengehouden 0") return "de lange lijst: " + kort(lang);
  if (lang.gelezen.uitstappen !== 507) return "de lange lijst is niet volledig gelezen: " + JSON.stringify(lang.gelezen);
  const delen = oproepen.slice(oproepenVoor).filter((o) => o.naam === "mt_uitstappen_bijwerken");
  if (delen.length !== 2 || delen[0].lichaam.p_uitstappen.length !== 500 || delen[0].lichaam.p_alle_ids !== null || delen[0].lichaam.p_uitkomst !== null
      || delen[1].lichaam.p_uitstappen.length !== 5 || delen[1].lichaam.p_alle_ids.length !== 507) return "de lange lijst ging niet in twee delen naar de databank";
  if (await een("select count(*) from public.activiteiten where uitstap_id like 'g-%' and bron_stand = 'actief';") !== "501") return "de lange lijst staat niet volledig in de MT";

  // ---------- Wie wat mocht: de databank weigerde niets, dus elke sleutel ging naar de juiste functie ----------
  const metRol = (rol) => [...new Set(oproepen.filter((o) => o.rol === rol).map((o) => o.naam))].sort().join(",");
  if (metRol("service_role") !== "mt_lezing_start,mt_lezing_stop,mt_uitstappen_bijwerken") return "met de secret key riep de serverfunctie op: " + metRol("service_role");
  if (metRol("authenticated") !== "mt_klassen_bijwerken,mt_mijn_account,mt_verdwenen_bevestigen") return "met een toegangsbewijs werd opgeroepen: " + metRol("authenticated");
  if (bron.metBewijs !== 0) return "naar de uitstappentool ging een toegangsbewijs mee";
  if (logboek.some((regel) => JSON.stringify(regel).includes(GEHEIM)) || [eerste, tweede, derde, snelle, ingehaald, rem, stil, lang].some((r) => r.ruw.includes(GEHEIM))) return "de secret key staat in een antwoord of in het logboek";
  return null;
}
// ---- stap 8: einde ----

Deno.test({
  name: "databank: de scripts op een nagebootste Supabase, herhaalbaar, en de proef in UTC en in Brussel",
  ignore: !AAN,
  async fn() {
    const bin = zoekPostgres();
    assert.ok(bin, "geen Postgres gevonden: zet MT_PG_BIN op de map met initdb, pg_ctl en psql");
    const scripts = sqlScripts();
    assert.ok(scripts.length >= 2, "te weinig scripts in sql/");

    const map = await Deno.makeTempDir({ prefix: "mt-pg-" });
    const gegevens = map + "/gegevens";
    const psql = (gebruiker, bestand, tijdzone = "UTC") =>
      doe(bin + "/psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", map, "-p", POORT, "-U", gebruiker, "-d", "postgres", "-f", pad(bestand)], {
        env: { PGTZ: tijdzone },
      });
    const lukt = (r, wat) => assert.equal(r.code, 0, wat + " mislukte:\n" + r.fout + "\n" + r.uit);

    try {
      lukt(await doe(bin + "/initdb", ["-D", gegevens, "-U", "supabase_admin", "-A", "trust", "-E", "UTF8", "--locale=C.UTF-8"]), "initdb");
      const start = await doe(
        bin + "/pg_ctl",
        ["-D", gegevens, "-w", "-l", map + "/log", "-o", `-p ${POORT} -c listen_addresses='' -c unix_socket_directories='${map}' ${SNEL}`, "start"],
        { stil: true },
      );
      assert.equal(start.code, 0, "Postgres start niet: zie " + map + "/log");

      // 1. De nabootsing van Supabase, als de superuser van de cluster.
      lukt(await psql("supabase_admin", "tests/databank/supabase.sql"), "tests/databank/supabase.sql");

      // 2. Elk script op volgorde, als de rol postgres. Geen enkele controle mag FOUT tonen.
      for (const script of scripts) {
        const r = await psql("postgres", script);
        lukt(r, script);
        assert.doesNotMatch(r.uit, /FOUT/, script + ": een controle toont FOUT:\n" + r.uit);
        assert.match(r.uit, /\bOK\b/, script + " toont geen controles:\n" + r.uit);
      }

      // 3. Het laatste script is herhaalbaar, met dezelfde uitkomst.
      const laatste = scripts[scripts.length - 1];
      const eerste = await psql("postgres", laatste);
      lukt(eerste, laatste + ", een tweede keer");
      const tweede = await psql("postgres", laatste);
      lukt(tweede, laatste + ", een derde keer");
      assert.equal(tweede.uit, eerste.uit, laatste + ": de controles verschillen na herhalen");
      assert.doesNotMatch(tweede.uit, /FOUT/);

      // 4. Een ouder script opnieuw uitvoeren wordt geweigerd, met zijn eigen nummer in de melding.
      for (const script of scripts.slice(0, -1)) {
        const r = await psql("postgres", script);
        const nummer = script.match(/(\d{3})_/)[1];
        assert.notEqual(r.code, 0, script + " liet zich opnieuw uitvoeren na een later script");
        assert.match(r.fout, new RegExp("MT " + nummer + ":"), script + ": onverwachte melding:\n" + r.fout);
      }

      // 5. De proef, in beide tijdzones: dezelfde uitkomst (17.1).
      for (const tijdzone of ["UTC", "Europe/Brussels"]) {
        const r = await psql("supabase_admin", "tests/databank/proef.sql", tijdzone);
        assert.equal(r.code, 0, "de proef mislukte in " + tijdzone + ":\n" + r.uit + "\n" + r.fout);
        assert.match(r.uit, /\|\s+0\s*$/m, "de proef telt mislukte controles in " + tijdzone + ":\n" + r.uit);
      }

      // 6. De wedloop: twee verbindingen tegelijk (review 1).
      // Met uitvoerig staat de code van een fout (SQLSTATE) in de melding, zoals de Data API ze doorgeeft.
      const voer = async (gebruiker, sql, uitvoerig = false) => {
        const args = ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", ...(uitvoerig ? ["-v", "VERBOSITY=verbose"] : []), "-h", map, "-p", POORT, "-U", gebruiker, "-d", "postgres"];
        if (sql.length < 60000) return doe(bin + "/psql", [...args, "-c", sql], { env: { PGTZ: "UTC" } });
        // Een lange vraag past niet op de opdrachtregel: die gaat langs een bestand.
        const bestand = await Deno.makeTempFile({ dir: map, suffix: ".sql" });
        await Deno.writeTextFile(bestand, sql);
        return doe(bin + "/psql", [...args, "-f", bestand], { env: { PGTZ: "UTC" } });
      };
      assert.equal(await wedloop(voer), null, "de wedloop");

      // 7. De adapter en de databank samen (stap 3, B212).
      assert.equal(await adapterEnDatabank(voer), null, "de adapter en de databank");

      // 8. De serverfunctie en de databank samen (review 2: R11).
      assert.equal(await functieEnDatabank(voer), null, "de serverfunctie en de databank");
    } finally {
      await doe(bin + "/pg_ctl", ["-D", gegevens, "-m", "immediate", "stop"], { stil: true });
      await Deno.remove(map, { recursive: true });
    }
  },
});

Deno.test({
  name: "fouten: elke bewust ingebouwde fout wordt gevonden, door de controle van het script of door de proef",
  ignore: !AAN,
  async fn() {
    const bin = zoekPostgres();
    assert.ok(bin, "geen Postgres gevonden: zet MT_PG_BIN op de map met initdb, pg_ctl en psql");
    const scripts = sqlScripts();
    const map = await Deno.makeTempDir({ prefix: "mt-pgf-" });
    const gegevens = map + "/gegevens";
    const psql = (gebruiker, databank, args) =>
      doe(bin + "/psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", map, "-p", POORT_FOUTEN, "-U", gebruiker, "-d", databank, ...args], {
        env: { PGTZ: "UTC", PGOPTIONS: "-c client_min_messages=warning" },
      });
    const lukt = (r, wat) => assert.equal(r.code, 0, wat + " mislukte:\n" + r.fout + "\n" + r.uit);
    const nietGevonden = [];
    const gevondenDoor = { "het script": 0, "een later script": 0, "de proef": 0, "de wedloop": 0 };
    let gedaan = 0;

    try {
      lukt(await doe(bin + "/initdb", ["-D", gegevens, "-U", "supabase_admin", "-A", "trust", "-E", "UTF8", "--locale=C.UTF-8"]), "initdb");
      const start = await doe(
        bin + "/pg_ctl",
        ["-D", gegevens, "-w", "-l", map + "/log", "-o", `-p ${POORT_FOUTEN} -c listen_addresses='' -c unix_socket_directories='${map}' ${SNEL}`, "start"],
        { stil: true },
      );
      assert.equal(start.code, 0, "Postgres start niet: zie " + map + "/log");
      lukt(await psql("supabase_admin", "postgres", ["-f", pad("tests/databank/supabase.sql")]), "tests/databank/supabase.sql");

      // Per script: eerst een sjabloon met alles wat ervoor komt, dan elke fout op een eigen kopie,
      // en pas daarna het script zelf, zonder fout, voor wat volgt.
      for (const [i, script] of scripts.entries()) {
        const fouten = FOUTEN.filter((f) => "sql/" + f.script === script && (!ENKEL || ENKEL.split(",").some((begin) => f.script.startsWith(begin.trim()))));
        if (fouten.length) {
          const sjabloon = "sjabloon" + i;
          lukt(await psql("supabase_admin", "template1", ["-c", `create database ${sjabloon} template postgres`]), "het sjabloon");
          const bron = lees(script);
          // Elke fout op een eigen kopie. Een paar tegelijk: de kopieën staan los van elkaar.
          const eenFout = async (n, f) => {
            const databank = "fout" + i + "_" + n;
            lukt(await psql("supabase_admin", "template1", ["-c", `create database ${databank} template ${sjabloon}`]), "de kopie voor een fout");
            // Zoals de nabootsing het voor de eerste databank doet: een kopie neemt die rechten niet mee.
            lukt(await psql("supabase_admin", "template1", ["-c", `grant all on database ${databank} to postgres`]), "de rechten op de kopie");
            const bestand = map + "/" + databank + ".sql";
            await Deno.writeTextFile(bestand, bron.replace(f.oud, () => f.nieuw));

            let door = null;
            const r = await psql("postgres", databank, ["-f", bestand]);
            if (r.code !== 0) {
              // Het script moet afbreken op zijn eigen controle, niet op een tikfout in de ingebouwde fout.
              assert.match(r.fout, /MT \d{3}:/, f.naam + ": het script brak af, maar niet op zijn eigen controle:\n" + r.fout);
              door = "het script";
            } else {
              for (const later of scripts.slice(i + 1)) {
                if ((await psql("postgres", databank, ["-f", pad(later)])).code !== 0) door = "een later script";
              }
              if (!door && f.wedloop) {
                const voer = (gebruiker, sql) => psql(gebruiker, databank, ["-t", "-A", "-c", sql]);
                if ((await wedloop(voer)) !== null) door = "de wedloop";
              } else if (!door) {
                const p = await psql("supabase_admin", databank, ["-f", pad("tests/databank/proef.sql")]);
                if (p.code !== 0 || !/\|\s+0\s*$/m.test(p.uit)) door = "de proef";
              }
            }
            if (door) gevondenDoor[door]++;
            else nietGevonden.push(f.naam);
            lukt(await psql("supabase_admin", "template1", ["-c", `drop database ${databank}`]), "opruimen");
          };
          const wachtrij = [...fouten.entries()];
          const werker = async () => {
            for (let volgende = wachtrij.shift(); volgende; volgende = wachtrij.shift()) await eenFout(volgende[0], volgende[1]);
          };
          await Promise.all(Array.from({ length: GELIJK }, werker));
          gedaan += fouten.length;
        }
        lukt(await psql("postgres", "postgres", ["-f", pad(script)]), script);
      }

      console.log(
        gedaan + (ENKEL ? " van de " + FOUTEN.length : "") + " fouten ingebouwd; gevonden door het script: " + gevondenDoor["het script"] +
          ", door een later script: " + gevondenDoor["een later script"] + ", door de proef: " + gevondenDoor["de proef"] +
          ", door de wedloop: " + gevondenDoor["de wedloop"],
      );
      assert.deepEqual(nietGevonden, [], "niet gevonden: " + nietGevonden.join("; "));
    } finally {
      await doe(bin + "/pg_ctl", ["-D", gegevens, "-m", "immediate", "stop"], { stil: true });
      await Deno.remove(map, { recursive: true });
    }
  },
});
