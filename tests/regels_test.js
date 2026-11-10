// MT · tests/regels_test.js
// De vijf regels van 17.1, de regels voor SQL (17.3, 17.12) en geen geheimen in de repository.
// Regel 1 en 2 gelden zodra rekenen.js en adapter.js bestaan (stap 3); tot dan staan ze op "ignored".

import assert from "node:assert/strict";
import { alleTekstbestanden, bestaat, CODE, lees, naamVan, paginaModules, sqlScripts, sqlZonderCommentaar } from "./hulp.js";

// ---------- Regel 1: rekenen.js ----------

Deno.test({
  name: "regel 1: rekenen.js importeert niets, en kent geen scherm, netwerk, browseropslag of klok",
  ignore: !bestaat(CODE + "rekenen.js"),
  fn() {
    const code = lees(CODE + "rekenen.js");
    assert.doesNotMatch(code, /^\s*import\b/m, "rekenen.js importeert iets");
    assert.doesNotMatch(code, /\bimport\s*\(/, "rekenen.js laadt iets dynamisch");
    for (const verboden of ["window", "document", "fetch", "localStorage", "sessionStorage", "navigator", "XMLHttpRequest", "Deno"]) {
      assert.doesNotMatch(code, new RegExp("\\b" + verboden + "\\b"), "rekenen.js gebruikt " + verboden);
    }
    assert.doesNotMatch(code, /Date\.now\s*\(|new\s+Date\s*\(\s*\)|performance\.now/, "rekenen.js leest de klok");
  },
});

// ---------- Regel 2: adapter.js ----------

Deno.test({
  name: "regel 2: adapter.js gebruikt enkel fetch, en laadt nooit code van de uitstappentool",
  ignore: !bestaat(CODE + "adapter.js"),
  fn() {
    const code = lees(CODE + "adapter.js");
    assert.doesNotMatch(code, /\bimport\s*\(/, "adapter.js laadt code dynamisch");
    assert.doesNotMatch(code, /from\s+["']https?:/, "adapter.js importeert code van een ander adres");
    assert.doesNotMatch(code, /\beval\s*\(|new\s+Function\s*\(/, "adapter.js voert tekst uit als code");
    for (const verboden of ["document", "localStorage", "sessionStorage", "XMLHttpRequest"]) {
      assert.doesNotMatch(code, new RegExp("\\b" + verboden + "\\b"), "adapter.js gebruikt " + verboden);
    }
    assert.doesNotMatch(code, /Date\.now\s*\(|new\s+Date\s*\(\s*\)|performance\.now/, "adapter.js leest de klok");
  },
});

// ---------- Regel 3: enkel data.js praat met de databank ----------

Deno.test("regel 3: enkel config.js kent de adressen van Supabase", () => {
  for (const pad of paginaModules()) {
    if (naamVan(pad) === "config.js") continue;
    assert.doesNotMatch(lees(pad), /supabase\.co/, pad + " bevat een adres van Supabase");
  }
});

Deno.test("regel 3: enkel data.js, adapter.js en app.js gebruiken fetch", () => {
  const mag = new Set(["data.js", "adapter.js", "app.js"]);
  for (const pad of paginaModules()) {
    if (mag.has(naamVan(pad))) continue;
    assert.doesNotMatch(lees(pad), /\bfetch\s*\(/, pad + " gebruikt fetch");
  }
});

// ---------- Regel 4: enkel ui.js schrijft HTML ----------

const HTML_SCHRIJVEN = /\b(innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|srcdoc)\b|document\.write|\bDOMParser\b/;

Deno.test("regel 4: enkel ui.js schrijft HTML in de pagina", () => {
  for (const pad of paginaModules()) {
    if (naamVan(pad) === "ui.js") continue;
    assert.doesNotMatch(lees(pad), HTML_SCHRIJVEN, pad + " schrijft HTML");
  }
});

Deno.test("regel 4: ui.js schrijft HTML op één plaats, in zet()", () => {
  const code = lees(CODE + "ui.js");
  const plaatsen = code.match(/\binnerHTML\b/g) || [];
  assert.equal(plaatsen.length, 1, "ui.js gebruikt innerHTML op " + plaatsen.length + " plaatsen");
  assert.doesNotMatch(code, /\b(outerHTML|insertAdjacentHTML|createContextualFragment)\b|document\.write/);
});

Deno.test("regel 4: geen acties of javascript: in de opmaak", () => {
  for (const pad of ["index.html", ...paginaModules()]) {
    const tekst = lees(pad);
    assert.doesNotMatch(tekst, /<[a-z][^>]*\son[a-z]+\s*=/i, pad + " zet een actie in een HTML-attribuut");
    assert.doesNotMatch(tekst, /javascript:/i, pad + " bevat javascript:");
  }
});

// ---------- Regel 5 en de SQL-regels ----------

/** De functies in een script: schema, naam en de kop tot het begin van de code. */
function functies(sql) {
  const uit = [];
  const patroon = /create\s+(?:or\s+replace\s+)?function\s+(?:(\w+)\.)?(\w+)\s*\(([\s\S]*?)\bas\s+\$/gi;
  for (const m of sql.matchAll(patroon)) uit.push({ schema: m[1] || null, naam: m[2], kop: m[3] });
  return uit;
}

Deno.test("regel 5: elke functie staat in een vast schema, met haar rechten uitdrukkelijk in hetzelfde script", () => {
  for (const pad of sqlScripts()) {
    const sql = sqlZonderCommentaar(lees(pad));
    for (const f of functies(sql)) {
      const volledig = f.schema + "." + f.naam;
      assert.ok(f.schema === "public" || f.schema === "mt_intern", pad + ": " + f.naam + " staat niet in public of mt_intern");
      const intrekken = new RegExp("revoke\\s+all\\s+on\\s+function\\s+" + volledig.replace(".", "\\.") + "\\s*\\([^;]*\\)\\s*from\\s+public", "i");
      assert.match(sql, intrekken, pad + ": " + volledig + " wordt niet ingetrokken voor public");
    }
  }
});

Deno.test("regel 5: security definer enkel in mt_intern, met een vaste search_path", () => {
  for (const pad of sqlScripts()) {
    const sql = sqlZonderCommentaar(lees(pad));
    for (const f of functies(sql)) {
      if (!/security\s+definer/i.test(f.kop)) continue;
      assert.equal(f.schema, "mt_intern", pad + ": " + f.naam + " omzeilt RLS buiten mt_intern");
      assert.match(f.kop, /set\s+search_path/i, pad + ": " + f.naam + " heeft geen vaste search_path");
    }
  }
});

Deno.test("SQL: anon mag enkel de pingfunctie uitvoeren, en krijgt nooit rechten op tabellen", () => {
  for (const pad of sqlScripts()) {
    const sql = sqlZonderCommentaar(lees(pad));
    for (const m of sql.matchAll(/grant\s+([\s\S]*?)\s+on\s+([\s\S]*?)\s+to\s+([\s\S]*?);/gi)) {
      const aan = m[3].toLowerCase();
      if (!/\banon\b/.test(aan)) continue;
      const waarop = m[2].replace(/\s+/g, " ").trim().toLowerCase();
      assert.equal(waarop, "function public.mt_ping()", pad + ": anon krijgt rechten op " + waarop);
    }
  }
});

Deno.test("SQL: elke nieuwe tabel krijgt RLS in hetzelfde script", () => {
  for (const pad of sqlScripts()) {
    const sql = sqlZonderCommentaar(lees(pad));
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+\.\w+)/gi)) {
      const naam = m[1].replace(".", "\\.");
      assert.match(sql, new RegExp("alter\\s+table\\s+" + naam + "\\s+enable\\s+row\\s+level\\s+security", "i"), pad + ": " + m[1] + " krijgt geen RLS");
    }
  }
});

Deno.test("SQL: elk script is alles-of-niets, met een controle als laatste resultaat", () => {
  for (const pad of sqlScripts()) {
    const sql = lees(pad);
    assert.match(sql, /^\s*begin\s*;/im, pad + " begint geen transactie");
    assert.match(sql, /^\s*commit\s*;/im, pad + " sluit de transactie niet af");
    assert.match(sql, /\bselect\b[\s\S]*;\s*$/i, pad + " eindigt niet met een controle");
  }
});

// ---------- Geen geheimen ----------

Deno.test("geen secret key, oude sleutel of toegangsbewijs in de repository", () => {
  for (const pad of alleTekstbestanden()) {
    const tekst = lees(pad);
    assert.doesNotMatch(tekst, /sb_secret_[A-Za-z0-9_-]+/, pad + " bevat een secret key");
    assert.doesNotMatch(tekst, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, pad + " bevat een oude sleutel of een toegangsbewijs");
  }
});
