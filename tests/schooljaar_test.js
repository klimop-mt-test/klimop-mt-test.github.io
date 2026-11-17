// MT · tests/schooljaar_test.js
// De regels rond schooljaren (code/schooljaar.js): welk schooljaar de MT aanmaakt, vanaf wanneer het kan
// starten, welke schooljaren open staan en in welk de schermen werken (B132, B144, B164, B169).

import assert from "node:assert/strict";
import {
  beginjaar, dagInBrussel, dagVoluit, isSchooljaar, kiesJaar, magStarten, openJaren, STANDKLEUR, STANDNAAM, startVanaf, teMaken, vanJaar, volgende, vorigVan,
} from "../code/schooljaar.js";
import { lees, sqlScripts, sqlZonderCommentaar } from "./hulp.js";

const jaar = (schooljaar, stand) => ({ schooljaar, stand });

Deno.test("schooljaar: de vorm, het beginjaar en het volgende", () => {
  assert.equal(isSchooljaar("2026-2027"), true);
  for (const fout of ["2026-2028", "2026-2026", "26-27", "2026/2027", "2026-2027 ", "", null, undefined, 20262027]) assert.equal(isSchooljaar(fout), false, String(fout));
  assert.equal(beginjaar("2026-2027"), 2026);
  assert.equal(vanJaar(2026), "2026-2027");
  assert.equal(volgende("2026-2027"), "2027-2028");
  assert.equal(volgende("2099-2100"), "2100-2101");
});

Deno.test("de dag in Brussel: om middernacht in Brussel begint de dag, wat de klok van de computer ook zegt", () => {
  // Zomertijd: 23.59 uur in Brussel is 21.59 UTC.
  assert.equal(dagInBrussel(Date.UTC(2027, 5, 30, 21, 59)), "2027-06-30");
  assert.equal(dagInBrussel(Date.UTC(2027, 5, 30, 22, 0)), "2027-07-01");
  // Wintertijd: 23.59 uur in Brussel is 22.59 UTC.
  assert.equal(dagInBrussel(Date.UTC(2026, 11, 31, 22, 59)), "2026-12-31");
  assert.equal(dagInBrussel(Date.UTC(2026, 11, 31, 23, 0)), "2027-01-01");
  assert.equal(dagInBrussel(Date.UTC(2026, 10, 17, 9, 0)), "2026-11-17");
});

Deno.test("starten kan vanaf 1 juli van het jaar waarin het schooljaar begint, zoals in de databank (B169)", () => {
  assert.equal(startVanaf("2027-2028"), "2027-07-01");
  assert.equal(magStarten("2027-2028", "2027-06-30"), false);
  assert.equal(magStarten("2027-2028", "2027-07-01"), true);
  assert.equal(magStarten("2027-2028", "2027-09-15"), true);
  assert.equal(magStarten("2027-2028", "2026-11-17"), false);
  assert.equal(magStarten("2026-2027", "2026-11-17"), true);
  // De databank beslist, met dezelfde regel: 1 juli van het beginjaar.
  const sql = sqlScripts().map((pad) => sqlZonderCommentaar(lees(pad))).join("\n");
  assert.ok(sql.includes("if mt_intern.vandaag() < make_date(left(p_schooljaar, 4)::integer, 7, 1) then"), "de databank rekent de eerste dag anders dan de pagina");
  assert.equal(dagVoluit("2027-07-01"), "1 juli 2027");
  assert.equal(dagVoluit("2026-12-31"), "31 december 2026");
});

Deno.test("welk schooljaar de MT aanmaakt: zonder lopend schooljaar dat van vandaag, en vanaf 1 juli al het volgende", () => {
  assert.equal(teMaken([], "2026-11-17"), "2026-2027");
  assert.equal(teMaken([], "2026-09-01"), "2026-2027");
  assert.equal(teMaken([], "2027-01-01"), "2026-2027");
  assert.equal(teMaken([], "2027-06-30"), "2026-2027");
  assert.equal(teMaken([], "2027-07-01"), "2027-2028");
  assert.equal(teMaken([], "2027-08-31"), "2027-2028");
  // Wat de MT voorstelt, kan altijd meteen starten.
  for (const dag of ["2026-11-17", "2027-06-30", "2027-07-01", "2027-08-31", "2027-12-31", "2028-02-29"]) {
    assert.equal(magStarten(teMaken([], dag), dag), true, dag);
  }
});

Deno.test("welk schooljaar de MT aanmaakt: met een lopend schooljaar het volgende, nooit twee tegelijk, en nooit een ouder", () => {
  const lopend = [jaar("2025-2026", "voorbij"), jaar("2026-2027", "lopend")];
  assert.equal(teMaken(lopend, "2026-11-17"), "2027-2028");
  assert.equal(teMaken(lopend, "2027-08-20"), "2027-2028");
  assert.equal(teMaken(lopend, "2028-03-01"), "2027-2028");
  // Er staat al een schooljaar in te vullen: geen tweede.
  assert.equal(teMaken([...lopend, jaar("2027-2028", "in_te_vullen")], "2027-08-20"), null);
  assert.equal(teMaken([jaar("2026-2027", "in_te_vullen")], "2026-11-17"), null);
  // Zonder lopend schooljaar, maar met een schooljaar dat al bestaat: het schooljaar erna. De databank start geen ouder.
  assert.equal(teMaken([jaar("2026-2027", "voorbij")], "2026-11-17"), "2027-2028");
  assert.equal(teMaken([jaar("2030-2031", "afgesloten")], "2026-11-17"), "2031-2032");
  assert.equal(teMaken([jaar("2024-2025", "afgesloten")], "2026-11-17"), "2026-2027");
});

Deno.test("de open schooljaren voor de kop: het lopende eerst, dan wat nog open staat, het recentste eerst (B132, B164)", () => {
  const alle = [jaar("2023-2024", "afgesloten"), jaar("2024-2025", "voorbij"), jaar("2025-2026", "voorbij"), jaar("2026-2027", "lopend"), jaar("2027-2028", "in_te_vullen")];
  assert.deepEqual(openJaren(alle).map((j) => j.schooljaar), ["2026-2027", "2025-2026", "2024-2025"]);
  assert.deepEqual(openJaren([...alle].reverse()).map((j) => j.schooljaar), ["2026-2027", "2025-2026", "2024-2025"]);
  assert.deepEqual(openJaren([jaar("2027-2028", "in_te_vullen")]), []);
  assert.deepEqual(openJaren([]), []);
});

Deno.test("het schooljaar waarin de schermen werken: de keuze zolang ze open staat, anders het lopende", () => {
  const open = openJaren([jaar("2025-2026", "voorbij"), jaar("2026-2027", "lopend")]);
  assert.equal(kiesJaar(open, null), "2026-2027");
  assert.equal(kiesJaar(open, "2025-2026"), "2025-2026");
  assert.equal(kiesJaar(open, "2026-2027"), "2026-2027");
  // Wat gekozen was, staat niet meer open, bv. afgesloten: terug naar het lopende.
  assert.equal(kiesJaar(open, "2024-2025"), "2026-2027");
  assert.equal(kiesJaar(openJaren([jaar("2025-2026", "voorbij")]), null), "2025-2026");
  assert.equal(kiesJaar([], "2026-2027"), null);
});

Deno.test("het vorige schooljaar van een nieuw schooljaar: het lopende, anders het recentste dat ooit startte", () => {
  const alle = [jaar("2024-2025", "afgesloten"), jaar("2025-2026", "voorbij"), jaar("2026-2027", "lopend"), jaar("2027-2028", "in_te_vullen")];
  assert.equal(vorigVan(alle, "2027-2028").schooljaar, "2026-2027");
  assert.equal(vorigVan(alle.filter((j) => j.stand !== "lopend"), "2027-2028").schooljaar, "2025-2026");
  assert.equal(vorigVan([jaar("2027-2028", "in_te_vullen")], "2027-2028"), null);
  assert.equal(vorigVan([], "2026-2027"), null);
  // Nooit het schooljaar zelf, en nooit een later.
  assert.equal(vorigVan([jaar("2026-2027", "lopend"), jaar("2028-2029", "voorbij")], "2026-2027"), null);
});

Deno.test("elke stand van de databank heeft een naam en een kleur", () => {
  const sql = sqlScripts().map((pad) => sqlZonderCommentaar(lees(pad))).join("\n");
  const m = /check \(stand in \('in_te_vullen', ([^)]*)\)\)/.exec(sql);
  assert.ok(m, "de standen van een schooljaar staan niet meer zo in de SQL-scripts");
  const standen = ["in_te_vullen", ...m[1].split(",").map((s) => s.trim().replace(/'/g, ""))];
  assert.deepEqual(Object.keys(STANDNAAM).sort(), [...standen].sort());
  assert.deepEqual(Object.keys(STANDKLEUR).sort(), [...standen].sort());
  assert.equal(STANDNAAM.voorbij, "Voorbij, nog open");
  for (const kleur of Object.values(STANDKLEUR)) assert.ok(["open", "info", "muted", "done", "warn"].includes(kleur));
});
