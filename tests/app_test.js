// MT · tests/app_test.js
// De start van de pagina (code/app.js): wat niet in een zuivere functie past, omdat het de browser
// aanspreekt. app.js laadt zijn modules zelf en start meteen: de test voert daarom de echte tekst van
// app.js uit in een eigen, nagebootste omgeving (een venster, een opslag, een klok), zonder start().
//   - het herstel bij een oude kopie: hoogstens één keer herladen, en nooit een herlaadlus (review 2: R10);
//   - het afmelden na een tijd zonder activiteit: app.js doet wat de beslissingen in auth.js zeggen, om
//     de vijf seconden, en een klik na een lange pauze meldt af (review 1: I4; review 2: R2-19).

import assert from "node:assert/strict";
import vm from "node:vm";
import * as echteAuth from "../code/auth.js";
import { CODE, lees } from "./hulp.js";

/**
 * De tekst van app.js als gewoon script: zonder export, zonder de start, en met een vast adres in plaats
 * van import.meta.url. Elk van die drie moet er precies zo staan: anders test dit niets meer.
 */
function scriptVanApp() {
  const bron = lees(CODE + "app.js");
  assert.equal([...bron.matchAll(/^export /gm)].length, 1, "app.js exporteert meer of minder dan zijn versie");
  assert.equal([...bron.matchAll(/^start\(\);$/gm)].length, 1, "app.js start niet op precies één plaats");
  assert.equal([...bron.matchAll(/import\.meta\.url/g)].length, 1);
  return bron.replace(/^export /m, "").replace(/^start\(\);$/m, "").replace("import.meta.url", JSON.stringify("https://mt.voorbeeld/code/app.js"));
}

/** Een nagebootste sessionStorage; schrijven of lezen kan men laten mislukken. */
function opslag({ schrijven = true, lezen = true } = {}) {
  const m = new Map();
  return {
    m,
    getItem(k) {
      if (!lezen) throw new Error("SecurityError");
      return m.has(k) ? m.get(k) : null;
    },
    setItem(k, v) {
      if (schrijven === false) throw new Error("QuotaExceededError");
      if (schrijven === "stil") return;
      m.set(k, String(v));
    },
    removeItem(k) {
      m.delete(k);
    },
  };
}

/** app.js in een nagebootste pagina. Geeft de context terug: de functies van app.js staan erin. */
function pagina({ sessionStorage = opslag(), nu = () => 0 } = {}) {
  const p = { herladen: 0, opgehaald: [], melding: { textContent: "", hidden: true, klassen: [] }, luisteraars: {}, klokken: [] };
  p.melding.classList = { add: (klasse) => p.melding.klassen.push(klasse) };
  const luister = (waar) => (soort, actie, opties) => p.luisteraars[waar + ":" + soort] = { actie, opties };
  p.context = vm.createContext({
    URL,
    Promise,
    Number,
    String,
    Date: { now: nu },
    sessionStorage,
    location: { pathname: "/", hostname: "mt.voorbeeld", reload: () => p.herladen++ },
    fetch: async (adres, opties) => (p.opgehaald.push([adres, opties]), {}),
    document: { hidden: false, getElementById: (id) => (id === "laden" ? p.melding : null), addEventListener: luister("document") },
    window: { addEventListener: luister("window") },
    setInterval: (actie, ms) => p.klokken.push({ actie, ms }),
  });
  vm.runInContext(scriptVanApp(), p.context);
  p.doe = (code) => vm.runInContext(code, p.context);
  return p;
}

// ---------- Het herstel bij een oude kopie ----------

Deno.test("herstel: één keer vers ophalen en herladen; de tweede keer zegt de MT wat je kan doen", async () => {
  const kast = opslag();
  const p = pagina({ sessionStorage: kast });
  await p.doe('herstel("Niet alle bestanden van de MT hebben dezelfde versie.")');
  assert.equal(p.herladen, 1);
  assert.equal(kast.m.get("mt_versie_herstel_v1"), "1");
  // Alle bestanden van de pagina, vers: de pagina zelf, app.js, elke module en de opmaak.
  assert.ok(p.opgehaald.length >= 12, "te weinig bestanden vers opgehaald: " + p.opgehaald.length);
  assert.ok(p.opgehaald.every(([, opties]) => opties.cache === "reload"));
  assert.deepEqual(p.opgehaald.slice(0, 2).map(([adres]) => adres), ["/", "https://mt.voorbeeld/code/app.js"]);
  assert.ok(p.opgehaald.some(([adres]) => adres === "https://mt.voorbeeld/opmaak/mt.css"));
  // Na de herlading is de fout er nog: de MT herlaadt niet opnieuw.
  const na = pagina({ sessionStorage: kast });
  await na.doe('herstel("Niet alle bestanden van de MT hebben dezelfde versie.")');
  assert.equal(na.herladen, 0);
  assert.equal(na.melding.textContent, "Niet alle bestanden van de MT hebben dezelfde versie. Vernieuw de pagina met Ctrl+F5. Blijft dit staan, laad dan alle bestanden van de MT opnieuw op in GitHub.");
  assert.deepEqual([na.melding.hidden, na.melding.klassen], [false, ["fout"]]);
  // De teller is weg: een latere fout, in dezelfde sessie, krijgt opnieuw één poging.
  assert.equal(kast.m.has("mt_versie_herstel_v1"), false);
});

Deno.test("herstel: kan de MT niet bewaren dat ze het al probeerde, dan herlaadt ze niet: nooit een herlaadlus (review 2: R10)", async () => {
  // Het tegenvoorbeeld van de review: een volle opslag laat lezen toe, maar weigert schrijven.
  for (const [wat, kast] of [["schrijven weigert", opslag({ schrijven: false })], ["schrijven doet niets", opslag({ schrijven: "stil" })], ["geen opslag", opslag({ schrijven: false, lezen: false })]]) {
    const p = pagina({ sessionStorage: kast });
    await p.doe('herstel("Een bestand van de MT ontbreekt of laadt niet.")');
    await p.doe('herstel("Een bestand van de MT ontbreekt of laadt niet.")');
    assert.equal(p.herladen, 0, wat + ": de MT herlaadde zonder te kunnen onthouden dat ze het al probeerde");
    assert.equal(p.opgehaald.length, 0, wat);
    assert.match(p.melding.textContent, /^Een bestand van de MT ontbreekt of laadt niet\. Vernieuw de pagina met Ctrl\+F5\./, wat);
  }
});

// ---------- Afmelden na een tijd zonder activiteit ----------

/** Een nagebootste aanmelding voor bewaakStilte: de beslissingen zijn de echte van auth.js. */
function aanmelding({ sessie = true, blijft = false, laatste }) {
  const a = { geraakt: [], tijdstip: laatste };
  return Object.assign(a, {
    heeftSessie: () => sessie,
    blijft: () => blijft,
    laatste: () => a.tijdstip,
    raak: (nu) => {
      a.geraakt.push(nu);
      a.tijdstip = nu;
    },
    stilteVoorbij: echteAuth.stilteVoorbij,
    bijActiviteit: echteAuth.bijActiviteit,
    STILTE_NAKIJKEN_MS: echteAuth.STILTE_NAKIJKEN_MS,
  });
}

function bewaakt(auth, begin) {
  const klok = { nu: begin };
  const p = pagina({ nu: () => klok.nu });
  p.context.proefAuth = auth;
  p.context.afgemeld = [];
  p.doe("bewaakStilte(proefAuth, (bericht) => afgemeld.push(bericht))");
  return { p, klok, afgemeld: p.context.afgemeld, klik: (soort = "pointerdown") => p.luisteraars["window:" + soort].actie(), kijk: () => p.klokken[0].actie() };
}

Deno.test("stilte: de MT kijkt om de vijf seconden, en meldt af zodra er dertig minuten niets gebeurde (B26, B218)", () => {
  const min = 60000;
  const begin = 9000 * min;
  const auth = aanmelding({ laatste: begin });
  const b = bewaakt(auth, begin);
  assert.deepEqual(b.p.klokken.map((k) => k.ms), [5000], "de MT hoort om de vijf seconden na te kijken, met één klok");
  assert.deepEqual(b.afgemeld, []);
  b.klok.nu = begin + 29 * min + 55000;
  b.kijk();
  assert.deepEqual(b.afgemeld, []);
  b.klok.nu = begin + 30 * min;
  b.kijk();
  assert.deepEqual(b.afgemeld, ["Je bent afgemeld: er gebeurde 30 minuten niets."]);
  // Ook bij het terugkeren naar het tabblad, en na de slaapstand (T5).
  for (const bron of ["document:visibilitychange", "window:focus", "window:pageshow"]) {
    const later = bewaakt(aanmelding({ laatste: begin }), begin + 31 * min);
    later.afgemeld.length = 0;
    later.p.luisteraars[bron].actie();
    assert.equal(later.afgemeld.length, 1, bron);
  }
  // Bij de start zelf: een tabblad dat te lang stil was, gaat meteen op slot.
  assert.equal(bewaakt(aanmelding({ laatste: begin }), begin + 31 * min).afgemeld.length, 1);
});

Deno.test("stilte: een klik verlengt, hoogstens om de vijftien seconden; een klik na een lange pauze meldt af en verlengt niet (review 1: I4)", () => {
  const min = 60000;
  const begin = 9000 * min;
  const auth = aanmelding({ laatste: begin });
  const b = bewaakt(auth, begin);
  for (const soort of ["pointerdown", "keydown", "scroll", "touchstart"]) assert.ok(b.p.luisteraars["window:" + soort], soort + " telt niet als activiteit");
  b.klok.nu = begin + 20 * min;
  b.klik();
  assert.deepEqual(auth.geraakt, [begin + 20 * min]);
  b.klok.nu += 5000;
  b.klik("keydown");
  assert.equal(auth.geraakt.length, 1, "binnen de vijftien seconden schrijft de MT niet opnieuw");
  b.klok.nu += 10000;
  b.klik("scroll");
  assert.equal(auth.geraakt.length, 2);
  assert.deepEqual(b.afgemeld, []);
  // Dan de slaapstand: 45 minuten later komt de eerste klik. Die meldt af, en verlengt de sessie niet.
  b.klok.nu += 45 * min;
  b.klik();
  assert.deepEqual(b.afgemeld, ["Je bent afgemeld: er gebeurde 30 minuten niets."]);
  assert.equal(auth.geraakt.length, 2, "de klik na de pauze verlengde de sessie toch");
});

Deno.test("stilte: met \"Aangemeld blijven\", of zonder sessie, meldt de MT nooit af na een tijd", () => {
  const min = 60000;
  const begin = 9000 * min;
  for (const anders of [{ blijft: true }, { sessie: false }]) {
    const auth = aanmelding({ laatste: begin, ...anders });
    const b = bewaakt(auth, begin + 500 * min);
    b.kijk();
    b.klik();
    assert.deepEqual(b.afgemeld, [], JSON.stringify(anders));
  }
});

Deno.test("app.js gebruikt voor het afmelden na stilte de beslissingen van auth.js, en geen eigen regels (review 2: R2-19)", () => {
  const bron = lees(CODE + "app.js");
  assert.match(bron, /auth\.bijActiviteit\(/);
  assert.match(bron, /auth\.stilteVoorbij\(/);
  assert.match(bron, /setInterval\(kijk, auth\.STILTE_NAKIJKEN_MS\)/);
  assert.doesNotMatch(bron, /teLangStil|15000|\b5000\b/, "app.js heeft weer een eigen regel of een eigen getal voor de stilte");
});
