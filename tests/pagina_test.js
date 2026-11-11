// MT · tests/pagina_test.js
// Eén versie in alle bestanden van de pagina, de lijst van modules in app.js, en de opbouw van
// index.html: geen scriptcode, een strenge CSP, noindex (17.1, 17.10).

import assert from "node:assert/strict";
import { alleOmgevingen, UITSTAPPENTOOL } from "../code/config.js";
import { bestaat, CODE, lees, naamVan, OPMAAK, paginaModules } from "./hulp.js";

const VERSIE = /export const VERSIE = "(\d+\.\d+\.\d+)";/;
const CSS = OPMAAK + "mt.css";

function versieVan(pad) {
  const m = lees(pad).match(VERSIE);
  assert.ok(m, pad + " heeft geen export const VERSIE");
  return m[1];
}

const versie = versieVan(CODE + "app.js");
const metPunten = (tekst) => tekst.replaceAll(".", "\\.");

Deno.test("alle modules van de pagina dragen dezelfde versie", () => {
  for (const pad of paginaModules()) assert.equal(versieVan(pad), versie, pad + " heeft een andere versie");
});

Deno.test("index.html en mt.css dragen dezelfde versie", () => {
  assert.match(lees("index.html"), new RegExp('<meta name="mt-versie" content="' + metPunten(versie) + '">'));
  assert.match(lees(CSS), new RegExp('--mt-versie:"' + metPunten(versie) + '"'));
});

Deno.test("de kop van elk bestand noemt dezelfde versie", () => {
  for (const pad of [...paginaModules(), "index.html", CSS]) {
    const kop = lees(pad).split("\n").slice(0, 12).join("\n");
    assert.match(kop, new RegExp("versie " + metPunten(versie) + "\\b"), pad + ": de kop noemt een andere versie");
  }
});

Deno.test("app.js laadt elke module van de pagina, en elke module bestaat", () => {
  const m = lees(CODE + "app.js").match(/const MODULES = \[([^\]]*)\]/);
  assert.ok(m, "app.js heeft geen lijst MODULES");
  const lijst = [...m[1].matchAll(/"\.\/([\w-]+\.js)"/g)].map((x) => x[1]).sort();
  const verwacht = paginaModules().map(naamVan).filter((naam) => naam !== "app.js");
  assert.deepEqual(lijst, verwacht, "MODULES in app.js en de bestanden in code/ verschillen");
  for (const naam of lijst) assert.ok(bestaat(CODE + naam), CODE + naam + " ontbreekt");
});

Deno.test("elke import verwijst naar een bestaand bestand", () => {
  for (const pad of paginaModules()) {
    for (const m of lees(pad).matchAll(/(?:from\s+|import\s*\(\s*)["'](\.\.?\/[^"']+)["']/g)) {
      const doel = new URL(m[1], new URL(pad, "file:///repo/")).pathname.slice("/repo/".length);
      assert.ok(bestaat(doel), pad + " importeert " + m[1] + ", dat niet bestaat");
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

/** supabase-js in de eigen repository (B158): het officiële bestand uit het npm-pakket, op één vaste versie. */
const BIBLIOTHEEK = "code/lib/supabase-2.116.0.js";
const BIBLIOTHEEK_SHA256 = "84ee9bf45695c1dd3ba1595b6bcfb0f09672434631351ffc8ebe9140545d5ff6";

async function som(pad, soort) {
  const bytes = Deno.readFileSync(new URL("../" + pad, import.meta.url));
  return new Uint8Array(await crypto.subtle.digest(soort, bytes));
}

Deno.test("index.html bevat geen scriptcode: enkel supabase-js uit de eigen repository en code/app.js", () => {
  const scripts = [...htmlTekst.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 2, "index.html heeft " + scripts.length + " scripts");
  assert.match(scripts[0][0], new RegExp('^<script src="' + metPunten(BIBLIOTHEEK) + '" integrity="sha384-[A-Za-z0-9+/=]+" defer><\\/script>$'));
  assert.match(scripts[1][0], /^<script type="module" src="code\/app\.js"><\/script>$/);
  for (const script of scripts) assert.equal(script[1].trim(), "", "een script in index.html bevat code");
});

Deno.test("supabase-js is het officiële bestand van versie 2.116.0, en de browser bewaakt dezelfde controlesom", async () => {
  const hex = [...await som(BIBLIOTHEEK, "SHA-256")].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(hex, BIBLIOTHEEK_SHA256, BIBLIOTHEEK + " is gewijzigd: het is niet meer het bestand dist/umd/supabase.js uit @supabase/supabase-js@2.116.0");
  const sha384 = btoa(String.fromCharCode(...await som(BIBLIOTHEEK, "SHA-384")));
  assert.ok(htmlTekst.includes('integrity="sha384-' + sha384 + '"'), "de controlesom in index.html klopt niet met " + BIBLIOTHEEK);
  assert.ok(bestaat("code/lib/LICENSE-supabase-js.txt"), "de licentie van supabase-js ontbreekt");
});

Deno.test("index.html verwijst enkel naar bestanden die bestaan", () => {
  const verwijzingen = [...htmlTekst.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(verwijzingen.length >= 3, "index.html verwijst naar te weinig bestanden");
  for (const adres of verwijzingen) {
    assert.doesNotMatch(adres, /^[a-z]+:|^\/\//i, "index.html laadt iets van een ander adres: " + adres);
    assert.ok(bestaat(adres), "index.html verwijst naar " + adres + ", dat niet bestaat");
  }
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

Deno.test("mt.css laadt niets van buitenaf, en het lettertype staat ernaast", () => {
  const css = lees(CSS);
  assert.doesNotMatch(css, /@import/);
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)/g)) {
    if (m[1].startsWith("data:")) continue;
    assert.ok(!/^[a-z]+:|^\/\//i.test(m[1]), "mt.css laadt " + m[1]);
    assert.ok(bestaat(OPMAAK + m[1]), "mt.css verwijst naar " + m[1] + ", dat niet in " + OPMAAK + " staat");
  }
  assert.ok(bestaat(OPMAAK + "OFL-outfit.txt"), "de licentie van het lettertype ontbreekt");
});
