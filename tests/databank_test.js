// MT · tests/databank_test.js
// De databanktest (17.12): de SQL-scripts op een nagebootste Supabase, en de proef die per rol nagaat
// wat mag en wat niet. Ze start een eigen, tijdelijke Postgres en ruimt die daarna weer op.
//
//   1. tests/databank/supabase.sql: de rollen, het auth-schema en de oude standaardrechten van Supabase;
//   2. elk script van sql/, op volgorde, als de rol postgres, zoals de SQL Editor van Supabase;
//   3. het laatste script nog eens: herhaalbaar, met dezelfde uitkomst;
//   4. elk ouder script nog eens: dat moet geweigerd worden, want het zou rechten terugzetten;
//   5. tests/databank/proef.sql, in UTC en in de tijd van Brussel.
//
// Draait enkel met MT_DATABANK=1 en de nodige rechten:
//   MT_DATABANK=1 deno test --allow-read --allow-write --allow-env --allow-run --no-prompt tests/databank_test.js
// Zonder die instelling staat de test op "ignored", zodat de gewone tests niets extra vragen.
// MT_PG_BIN wijst naar de map met initdb, pg_ctl en psql; anders zoekt de test in /usr/lib/postgresql.

import assert from "node:assert/strict";
import { MAP, sqlScripts } from "./hulp.js";

function instelling(naam) {
  try {
    return Deno.env.get(naam) ?? null;
  } catch {
    return null;
  }
}

const AAN = instelling("MT_DATABANK") === "1";
const POORT = "54329";

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
    } finally {
      await doe(bin + "/pg_ctl", ["-D", gegevens, "-m", "immediate", "stop"], { stil: true });
      await Deno.remove(map, { recursive: true });
    }
  },
});
