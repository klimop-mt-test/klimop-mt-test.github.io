// MT · tests/pagina_test.js
// Eén versie in alle bestanden van de pagina, de lijst van modules in app.js, en de opbouw van
// index.html: geen scriptcode, een strenge CSP, noindex (17.1, 17.10).

import assert from "node:assert/strict";
import { alleOmgevingen, UITSTAPPENTOOL } from "../config.js";
import { bestaat, lees, paginaModules } from "./hulp.js";

const VERSIE = /export const VERSIE = "(\d+\.\d+\.\d+)";/;

function versieVan(naam) {
  const m = lees(naam).match(VERSIE);
  assert.ok(m, naam + " heeft geen export const VERSIE");
  return m[1];
}

const versie = versieVan("app.js");

Deno.test("alle modules van de pagina dragen dezelfde versie", () => {
  for (const naam of paginaModules()) assert.equal(versieVan(naam), versie, naam + " heeft een andere versie");
});

Deno.test("index.html en mt.css dragen dezelfde versie", () => {
  assert.match(lees("index.html"), new RegExp('<meta name="mt-versie" content="' + versie.replaceAll(".", "\\.") + '">'));
  assert.match(lees("mt.css"), new RegExp('--mt-versie:"' + versie.replaceAll(".", "\\.") + '"'));
});

Deno.test("de kop van elk bestand noemt dezelfde versie", () => {
  for (const naam of [...paginaModules(), "index.html", "mt.css"]) {
    const kop = lees(naam).split("\n").slice(0, 12).join("\n");
    assert.match(kop, new RegExp("versie " + versie.replaceAll(".", "\\.") + "\\b"), naam + ": de kop noemt een andere versie");
  }
});

Deno.test("app.js laadt elke module van de pagina, en elke module bestaat", () => {
  const m = lees("app.js").match(/const MODULES = \[([^\]]*)\]/);
  assert.ok(m, "app.js heeft geen lijst MODULES");
  const lijst = [...m[1].matchAll(/"\.\/([\w-]+\.js)"/g)].map((x) => x[1]).sort();
  const verwacht = paginaModules().filter((naam) => naam !== "app.js");
  assert.deepEqual(lijst, verwacht, "MODULES in app.js en de bestanden in de hoofdmap verschillen");
  for (const naam of lijst) assert.ok(bestaat(naam), naam + " ontbreekt");
});

Deno.test("elke import verwijst naar een bestaand bestand", () => {
  for (const naam of paginaModules()) {
    for (const m of lees(naam).matchAll(/(?:from\s+|import\s*\(\s*)["'](\.\/[^"']+)["']/g)) {
      assert.ok(bestaat(m[1].slice(2)), naam + " importeert " + m[1] + ", dat niet bestaat");
    }
  }
});

// ---------- index.html ----------

const htmlTekst = lees("index.html");

function csp() {
  const m = htmlTekst.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, "index.html heeft geen CSP");
  const regels = new Map();
  for (const deel of m[1].split(";")) {
    const [naam, ...waarden] = deel.trim().split(/\s+/);
    if (naam) regels.set(naam, waarden);
  }
  return regels;
}

Deno.test("index.html bevat geen scriptcode: enkel app.js, als module", () => {
  const scripts = [...htmlTekst.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, "index.html heeft " + scripts.length + " scripts");
  assert.match(scripts[0][0], /^<script type="module" src="app\.js"><\/script>$/);
  assert.equal(scripts[0][1].trim(), "", "het script in index.html bevat code");
});

Deno.test("de CSP laat scripts enkel toe van het eigen adres, zonder unsafe-inline", () => {
  const regels = csp();
  assert.deepEqual(regels.get("default-src"), ["'none'"]);
  assert.deepEqual(regels.get("script-src"), ["'self'"]);
  assert.deepEqual(regels.get("font-src"), ["'self'"]);
  assert.deepEqual(regels.get("base-uri"), ["'none'"]);
  assert.deepEqual(regels.get("object-src"), ["'none'"]);
  assert.deepEqual(regels.get("form-action"), ["'none'"]);
});

Deno.test("de CSP verbindt enkel met het eigen adres en de projecten van config.js", () => {
  const verwacht = new Set(["'self'", UITSTAPPENTOOL.url, ...alleOmgevingen().map((o) => o.mt.url)]);
  assert.deepEqual(new Set(csp().get("connect-src")), verwacht);
});

Deno.test("index.html: noindex, geen referrer, en een taal", () => {
  assert.match(htmlTekst, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(htmlTekst, /<meta name="referrer" content="no-referrer">/);
  assert.match(htmlTekst, /<html lang="nl-BE">/);
});

Deno.test("mt.css laadt niets van buitenaf", () => {
  const css = lees("mt.css");
  assert.doesNotMatch(css, /@import/);
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)/g)) {
    assert.ok(m[1].startsWith("data:") || !/^[a-z]+:/i.test(m[1]), "mt.css laadt " + m[1]);
  }
});
