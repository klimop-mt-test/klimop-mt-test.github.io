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
//      uitstappentool maakt, verwerkt de echte databankfunctie, in delen zoals de serverfunctie (B212).
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
 *   2. hetzelfde adres wordt twee keer tegelijk aangemaakt: precies één start lukt.
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
    values ('2025-2026', 'voorbij', 5500, 11000, 200, 400), ('2026-2027', 'lopend', 5500, 11000, 200, 400);
    select mt_intern.klassen_toepassen(j, ${tekst(JSON.stringify(["1KA", "2A", "3A", "4A", "4B", "6A"].map((naam, i) => ({ id: "k" + i, naam, groep: naam === "1KA" ? "Kleuter" : "Lager" }))))}::jsonb)
      from (values ('2025-2026'), ('2026-2027')) as x(j);`);
  if (opzet.code !== 0) return "de opzet voor de adapter mislukte: " + opzet.fout;

  /** Eén oproep, zoals de serverfunctie: als de rol service_role, via de rol van de Data API. */
  const stuur = async (uitstappen, ids, rol = "service_role") => {
    const r = await voer("authenticator", `
      begin;
      select set_config('request.jwt.claims', '${JSON.stringify({ role: rol })}', true);
      set local role ${rol};
      select public.mt_uitstappen_bijwerken(${tekst(JSON.stringify(uitstappen))}::jsonb, ${ids === null ? "null" : "array[" + ids.map(tekst).join(", ") + "]::text[]"});
      commit;`);
    if (r.code !== 0) return { fout: r.fout };
    // De eerste regel is wat set_config teruggeeft; het antwoord van de functie is de laatste.
    const regel = r.uit.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
    return regel ? JSON.parse(regel) : { fout: "geen antwoord: " + r.uit };
  };
  const tellers = (r) => ["nieuw", "gewijzigd", "weg", "ongewijzigd", "ongeldig", "buiten", "geen", "gesloten", "ouder", "niet_gevonden"].map((naam) => naam + " " + r[naam]).join(", ");

  // De eerste lezing: zeven uitstappen komen in de MT.
  const eerste = await stuur(b.uitstappen, b.alleIds);
  if (eerste.fout) return "de databank weigert het bericht van de adapter: " + eerste.fout;
  if (tellers(eerste) !== "nieuw 7, gewijzigd 0, weg 0, ongewijzigd 0, ongeldig 1, buiten 1, geen 2, gesloten 0, ouder 0, niet_gevonden 0") return "de eerste lezing gaf: " + tellers(eerste);
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
  if (tweede.fout || tellers(tweede) !== "nieuw 0, gewijzigd 0, weg 0, ongewijzigd 7, ongeldig 1, buiten 1, geen 2, gesloten 0, ouder 0, niet_gevonden 0") return "de tweede lezing gaf: " + (tweede.fout || tellers(tweede));

  // In delen, zoals de serverfunctie: enkel het laatste deel draagt de lijst van id's. u-dag staat er niet meer in.
  const deel1 = await stuur(b.uitstappen.slice(0, 6), null);
  if (deel1.fout || deel1.niet_gevonden !== 0) return "het eerste deel, zonder lijst van id's: " + (deel1.fout || tellers(deel1));
  const deel2 = await stuur(b.uitstappen.slice(6), b.alleIds.filter((id) => id !== "u-dag"));
  if (deel2.fout || deel2.niet_gevonden !== 1) return "het laatste deel, met de lijst van id's: " + (deel2.fout || tellers(deel2));
  const weg = await voer("supabase_admin", "select string_agg(uitstap_id, ',' order by uitstap_id) from public.activiteiten where bron_stand = 'niet_gevonden';");
  if (weg.uit.trim() !== "u-dag") return "niet meer gevonden: " + weg.uit.trim() + " (verwacht: u-dag)";

  // Enkel de serverfunctie mag dit: een gewone gebruiker wordt geweigerd.
  const gewoon = await stuur(b.uitstappen, b.alleIds, "authenticated");
  if (!gewoon.fout || !/permission denied|42501/.test(gewoon.fout)) return "een gewone gebruiker werd niet geweigerd: " + JSON.stringify(gewoon);
  return null;
}

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
        ["-D", gegevens, "-w", "-l", map + "/log", "-o", `-p ${POORT} -c listen_addresses='' -c unix_socket_directories='${map}'`, "start"],
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
      const voer = (gebruiker, sql) =>
        doe(bin + "/psql", ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-h", map, "-p", POORT, "-U", gebruiker, "-d", "postgres", "-c", sql], { env: { PGTZ: "UTC" } });
      assert.equal(await wedloop(voer), null, "de wedloop");

      // 7. De adapter en de databank samen (stap 3, B212).
      assert.equal(await adapterEnDatabank(voer), null, "de adapter en de databank");
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
        ["-D", gegevens, "-w", "-l", map + "/log", "-o", `-p ${POORT_FOUTEN} -c listen_addresses='' -c unix_socket_directories='${map}'`, "start"],
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
