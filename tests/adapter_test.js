// MT · tests/adapter_test.js
// De adapter (code/adapter.js): de uitstappentool lezen in de vaste volgorde van T1.
//   - de vergelijking met de uitstappentool: wat overgenomen is, staat er woord voor woord (V20, V22);
//   - de ruwe schemaversie, vóór norm(), en een eigen kopie;
//   - wat de databank van de MT krijgt (64.3), en dat een korte lezing dezelfde melding geeft als een
//     volledige rij;
//   - wat een uitstap kost voor het rekencontract (1.3), getoetst aan kosten() van de uitstappentool;
//   - volledig en gecontroleerd ophalen, tegen een nagebootste uitstappentool.
//
// De vergelijking met een echt uitstappen.html draait als de test weet waar het staat:
//   MT_UITSTAPPEN_HTML=/pad/naar/uitstappen.html deno test --allow-read --allow-env=MT_UITSTAPPEN_HTML --no-prompt tests/adapter_test.js
// Zonder die instelling staat ze op "ignored". Claude draait ze bij elke oplevering, met het
// uitstappen.html uit de projectkennis (V20).

import assert from "node:assert/strict";
import {
  annuleringVoorMT, BEKENDE_VERSIES, bericht, klassenUit, kostenVoorMT, leesKlassen, leesUitstappen, leesUitstappenKort, melding, normaliseer, overgenomen, overzicht,
  soortVan,
} from "../code/adapter.js";
import { afdruk, CODE, instelling, lees, reeks } from "./hulp.js";

const { kosten, norm, persAantal, schooljaarVan } = overgenomen;

// ---------- T1: wat overgenomen is, staat er woord voor woord ----------

/** Wat de MT uit uitstappen.html overneemt, in de volgorde waarin het daar staat. */
const NAMEN = ["SCHEMA", "GROEPEN", "r2", "parseISO", "schooljaarVan", "toNum", "NASCH_FIELDS", "DN_VERV_KEYS", "normNascholing", "norm", "isNasch", "persAantal", "bonNodig", "kosten"];

/**
 * De afdruk van het overgenomen blok. Het komt uit het uitstappen.html van de projectkennis op
 * 16 november 2026. Wijzigt de uitstappentool een van deze functies, dan wijzigt het blok mee, komt
 * hier de nieuwe afdruk, en gaat de rekenversie omhoog (tests/rekenversie_test.js).
 */
const AFDRUK_BLOK = "6c0ed4f6cf8f2e357b05b952d40b1742ee2c2bb4c341a97d4bf1c12ace4d95b9";

/**
 * Eén definitie op het hoogste niveau van een script, van haar eerste tot haar laatste regel: een
 * functie tot haar accolades in evenwicht zijn, een const tot de regel die op een puntkomma eindigt.
 * Geeft null als de naam niet precies één keer voorkomt.
 */
function definitie(bron, naam) {
  const regels = bron.split("\n");
  const begin = [];
  const kop = new RegExp("^(const|function)\\s+" + naam + "\\b");
  regels.forEach((regel, i) => {
    if (kop.test(regel)) begin.push(i);
  });
  if (begin.length !== 1) return null;
  const uit = [];
  let diepte = 0;
  for (let i = begin[0]; i < regels.length; i++) {
    const regel = regels[i];
    uit.push(regel);
    if (regels[begin[0]].startsWith("function")) {
      diepte += regel.split("{").length - regel.split("}").length;
      if (diepte === 0 && uit.join("").includes("{")) return uit.join("\n");
    } else if (regel.trimEnd().endsWith(";")) return uit.join("\n");
  }
  return null;
}

/** Het overgenomen blok in adapter.js, zonder de uitleg erboven. */
function blok() {
  const tekst = lees(CODE + "adapter.js");
  const begin = tekst.indexOf("// ---- uitstappentool: begin ----\n");
  const einde = tekst.indexOf("\n// ---- uitstappentool: einde ----");
  assert.ok(begin >= 0 && einde > begin, "adapter.js mist de merktekens van het overgenomen blok");
  const regels = tekst.slice(begin, einde).split("\n").slice(1);
  while (regels.length && regels[0].startsWith("// ")) regels.shift();
  return regels.join("\n");
}

Deno.test("T1: het overgenomen blok bestaat uit de veertien definities, in de volgorde van de uitstappentool, en niets anders", () => {
  const b = blok();
  const delen = NAMEN.map((naam) => definitie(b, naam));
  delen.forEach((deel, i) => assert.ok(deel !== null, "het blok mist " + NAMEN[i] + ", of heeft het twee keer"));
  assert.equal(b, delen.join("\n"), "in het overgenomen blok staat iets anders dan de veertien definities");
});

Deno.test("T1: het overgenomen blok wijzigt niet ongemerkt", async () => {
  assert.equal(await afdruk(blok()), AFDRUK_BLOK,
    "het overgenomen blok in adapter.js wijzigde. Vergelijk het met uitstappen.html (MT_UITSTAPPEN_HTML), zet de nieuwe afdruk in deze test, en verhoog de rekenversie.");
});

const UITSTAPPEN_HTML = instelling("MT_UITSTAPPEN_HTML");

Deno.test({
  name: "T1: de vergelijking met de uitstappentool: norm(), kosten() en hun hulp staan er woord voor woord",
  ignore: !UITSTAPPEN_HTML,
  fn() {
    const bron = Deno.readTextFileSync(UITSTAPPEN_HTML);
    const b = blok();
    for (const naam of NAMEN) {
      const daar = definitie(bron, naam);
      assert.ok(daar !== null, "uitstappen.html heeft " + naam + " niet (meer) precies één keer: bekijk de uitstappentool");
      assert.equal(definitie(b, naam), daar, naam + " verschilt van de uitstappentool: neem de nieuwe versie over, met een nieuwe rekenversie");
    }
  },
});

Deno.test("T1: de overgenomen functies kennen het venster en de klok niet", () => {
  const b = blok();
  assert.doesNotMatch(b, /\bwindow\b|todayISO|Date\.now|new\s+Date\s*\(\s*\)|Math\.random/);
  // Wat overgenomen is, steunt enkel op wat zelf overgenomen is.
  for (const naam of ["isPast", "uid", "clone", "nasKlassen", "klassenVan", "S\\(\\)", "D\\."]) assert.doesNotMatch(b, new RegExp("\\b" + naam), "het blok gebruikt " + naam);
});

// ---------- T1, stap 2 en 3: de ruwe versie, en een eigen kopie ----------

const rij = (trip, id = "u1", gewijzigd = "2026-11-10T08:00:00+00:00") => ({ id, updated_at: gewijzigd, trip });

Deno.test("de ruwe schemaversie telt, vóór norm(): norm() zelf maakt van elke versie 2", () => {
  assert.equal(norm({ v: 999 }).v, 2, "norm() zet de versie zelf: daarom kijkt de MT de ruwe versie na");
  assert.deepEqual([...BEKENDE_VERSIES], [1, 2]);
  for (const v of [undefined, null, 1, 2]) {
    const n = normaliseer(rij({ v, datumStart: "2026-11-20", planStatus: "bevestigd" }));
    assert.equal(n.bekend, true, "versie " + v);
    assert.equal(n.uitstap.planStatus, "bevestigd");
    assert.equal(n.versie, v === undefined ? null : v);
  }
  for (const v of [3, 999, 0, -1, 2.5, "2", "1", true, {}, [2]]) {
    const n = normaliseer(rij({ v, datumStart: "2026-11-20", planStatus: "bevestigd" }));
    assert.equal(n.bekend, false, "versie " + JSON.stringify(v));
    assert.equal(n.uitstap, null, "een onbekende versie wordt nooit als versie 2 gelezen");
  }
  // Een rij zonder uitstap erin leest de MT niet.
  for (const trip of [null, undefined, "tekst", 5, [1, 2]]) assert.equal(normaliseer(rij(trip)).bekend, false);
  assert.equal(normaliseer(null).bekend, false);
});

Deno.test("norm() krijgt een eigen kopie: de rij zelf wijzigt nooit, ook niet wat erin genest zit", () => {
  const trip = {
    v: 2, datumStart: "2026-11-20", planStatus: "geannuleerd", busNodig: true, klassen: ["4A", "", "4B"], kostprijs: "120",
    annulering: { reden: "ziekte", kosten: "20", busKosten: "", busMetKosten: "wel" }, log: [{ op: "x" }],
  };
  const voor = JSON.stringify(trip);
  const n = normaliseer(rij(trip));
  assert.equal(JSON.stringify(trip), voor, "normaliseer() wijzigde de rij");
  // norm() wijzigt de annulering van wat het krijgt: de kopie, niet de rij.
  assert.equal(n.uitstap.annulering.kosten, 20);
  assert.equal(n.uitstap.annulering.metKosten, "wel");
  assert.equal(trip.annulering.kosten, "20");
  assert.deepEqual(n.uitstap.klassen, ["4A", "4B"]);
  assert.equal(n.id, "u1");
  assert.equal(n.gewijzigd, "2026-11-10T08:00:00+00:00");
});

Deno.test("de proeven van de review (C4-1): wat norm() en kosten() doen, en wat de MT ermee doet", () => {
  // De categorie ontbreekt: een uitstap. Oude, geldige rijen blijven meetellen.
  assert.equal(norm({}).categorie, "uitstap");
  // Geen bus: geen factuur van een bus.
  assert.equal(norm({ busNodig: false }).factuurStatusBus, null);
  // De prijs is nog te bevestigen, met een oud bedrag erbij: onbekend, nooit het oude bedrag.
  const teBevestigen = norm({ prijsStatus: "tebevestigen", kostprijs: 120, aantalLln: 20 });
  assert.equal(kosten(teBevestigen).tot, null);
  assert.deepEqual(kostenVoorMT(teBevestigen), { activiteit: { onbekend: true }, vervoer: null, volledig: false });
  // Een bus zonder prijs: onbekend, nooit € 0.
  const busZonderPrijs = norm({ prijsStatus: "gratis", busNodig: true, aantalLln: 20 });
  assert.equal(kosten(busZonderPrijs).tot, null);
  assert.deepEqual(kostenVoorMT(busZonderPrijs), { activiteit: { onbekend: false, gedeeld: 0, perKind: 0 }, vervoer: { onbekend: true }, volledig: false });
  // € 2 voor drie leerlingen: perAll van de uitstappentool (€ 0,67) is niet het bedrag van de MT. De MT
  // neemt de gedeelde kost, en verdeelt ze zelf, over de leerlingen die aangerekend worden.
  const twee = norm({ prijsStatus: "bekend", kostprijs: 2, aantalLln: 3 });
  assert.equal(kosten(twee).perAll, 0.67);
  assert.deepEqual(kostenVoorMT(twee).activiteit, { onbekend: false, gedeeld: 200, perKind: 0 });
  // Drie tickets van € 8 en een exclusief voorschot van € 30: bij de uitstappentool € 54 samen. De MT
  // telt het voorschot één keer, als gedeelde kost, naast de prijs per kind (B83).
  const tickets = norm({ prijsStatus: "bekend", kostprijsBasis: "perLln", kostprijsPerLln: 8, aantalLln: 3, voorschot: true, voorschotBedrag: 30, voorschotInclusief: "excl" });
  assert.equal(kosten(tickets).actTot, 54);
  assert.deepEqual(kostenVoorMT(tickets).activiteit, { onbekend: false, gedeeld: 3000, perKind: 800 });
  // Een annulering met € 20 kosten: kosten() rekent die niet; de MT heeft er een eigen tak voor (V23).
  const geannuleerd = norm({ planStatus: "geannuleerd", prijsStatus: "bekend", kostprijs: 100, aantalLln: 20, annulering: { metKosten: "wel", kosten: 20 } });
  assert.equal(kosten(geannuleerd).tot, 100);
  assert.deepEqual(annuleringVoorMT(geannuleerd), { activiteit: { onbekend: false, gedeeld: 2000, perKind: 0 }, vervoer: null });
});

// ---------- T1, stap 4: wat de databank van de MT krijgt ----------

Deno.test("de melding aan de databank: precies de velden van 64.3", () => {
  const n = normaliseer(rij({ v: 2, type: "meerdaags", datumStart: "2026-09-23", datumEind: "2026-09-25", klassen: ["6A", "6B"], planStatus: "bevestigd", activiteit: "GWP", leerkracht: "een naam" }, "u-gwp"));
  assert.deepEqual(melding(n), {
    id: "u-gwp", gewijzigd: "2026-11-10T08:00:00+00:00", categorie: "uitstap", verwijderd: false, planStatus: "bevestigd", type: "meerdaags",
    datumStart: "2026-09-23", datumEind: "2026-09-25", klassen: ["6A", "6B"],
  });
  // Geen naam, geen titel, geen prijs: de databank van de MT krijgt enkel wat ze nodig heeft.
  assert.deepEqual(Object.keys(melding(n)).sort(), ["categorie", "datumEind", "datumStart", "gewijzigd", "id", "klassen", "planStatus", "type", "verwijderd"]);
});

Deno.test("de melding: een daguitstap heeft geen einddatum, de prullenbak is \"verwijderd\", en een nascholing heeft geen klassen", () => {
  const dag = melding(normaliseer(rij({ datumStart: "2026-11-20", datumEind: "2026-11-27", klassen: ["4A"], planStatus: "onzin" })));
  assert.equal(dag.type, "dag");
  assert.equal(dag.datumEind, null);
  assert.equal(dag.planStatus, "aangevraagd");
  assert.equal(melding(normaliseer(rij({ datumStart: "2026-11-20", verwijderdOp: "2026-11-01T10:00:00.000Z" }))).verwijderd, true);
  assert.equal(melding(normaliseer(rij({ datumStart: "2026-11-20", verwijderdOp: null }))).verwijderd, false);
  const nascholing = melding(normaliseer(rij({ categorie: "nascholing", type: "meerdaags", datumStart: "2026-11-20", datumEind: "2026-11-21", klassen: ["4A"], planStatus: "bevestigd" })));
  assert.deepEqual([nascholing.categorie, nascholing.type, nascholing.datumEind, nascholing.klassen], ["nascholing", "dag", null, []]);
});

Deno.test("de melding: een datum die de uitstappentool ongeldig noemt, gaat niet mee", () => {
  for (const trip of [
    { datumStart: "2026-02-30" }, { datumStart: "20261120" }, { datumStart: 20261120 }, { datumStart: "2026-11-9" }, { datumStart: "" }, {},
    { type: "meerdaags", datumStart: "2026-09-23", datumEind: "2026-09-22" }, { type: "meerdaags", datumStart: "2026-09-23" }, { type: "meerdaags", datumStart: "2026-09-23", datumEind: "later" },
  ]) {
    const m = melding(normaliseer(rij(trip)));
    assert.equal(m.datumStart, null, JSON.stringify(trip));
    assert.equal(m.datumEind, null, JSON.stringify(trip));
  }
  // Een naam van een klas blijft tekst, ook als er iets anders stond: de databank meldt ze dan als onbekend.
  assert.deepEqual(melding(normaliseer(rij({ datumStart: "2026-11-20", klassen: ["4A", 7, null, "", { a: 1 }] }))).klassen, ["4A", "7", "[object Object]"]);
  assert.deepEqual(melding(normaliseer(rij({ datumStart: "2026-11-20", klassen: "4A" }))).klassen, []);
});

Deno.test("het bericht: een onbekende schemaversie gaat niet mee, maar haar id blijft in de volledige lijst", () => {
  const b = bericht([
    rij({ v: 2, datumStart: "2026-11-20", planStatus: "bevestigd" }, "u1"),
    rij({ v: 3, datumStart: "2026-11-21", planStatus: "bevestigd" }, "u2"),
    rij({ datumStart: "2026-11-22", categorie: "nascholing" }, "u3"),
    rij({ v: 1, datumStart: "2026-11-23", verwijderdOp: "2026-11-01T10:00:00.000Z" }, "u4"),
  ]);
  assert.deepEqual(b.uitstappen.map((u) => u.id), ["u1", "u3", "u4"]);
  assert.deepEqual(b.alleIds, ["u1", "u2", "u3", "u4"]);
  assert.deepEqual(b.onbekendeVersie, ["u2"]);
  assert.deepEqual(bericht([]), { uitstappen: [], alleIds: [], onbekendeVersie: [] });
});

// ---------- Willekeurige uitstappen, voor de controles over alle gevallen ----------

const VELDEN_KORT = ["v", "categorie", "type", "datumStart", "datumEind", "klassen", "planStatus", "verwijderdOp"];

function willekeurigeUitstap(kies) {
  const een = (...keuzes) => keuzes[kies(keuzes.length)];
  const bedrag = () => een(null, undefined, "", 0, 12.5, 187.5, 245, 7.5, 0.07, 1234.56, "66", "7,5", 2.1, -5);
  const datum = () => een("2026-09-01", "2026-11-20", "2027-01-18", "2027-08-31", "2026-08-31", "2026-02-30", "", null, undefined, "20261120", "2026-11-9");
  const t = {};
  const zet = (veld, waarde) => {
    if (waarde !== undefined) t[veld] = waarde;
  };
  zet("v", een(undefined, undefined, 1, 2, 2, 2));
  zet("categorie", een(undefined, "uitstap", "uitstap", "nascholing", "iets"));
  zet("type", een(undefined, "dag", "dag", "meerdaags", "week"));
  zet("datumStart", datum());
  zet("datumEind", datum());
  zet("klassen", een(undefined, [], ["4A"], ["4A", "4B"], ["4A", "", null, "Zonneklas"], "4A", null));
  zet("planStatus", een(undefined, "aangevraagd", "bevestigd", "bevestigd", "geannuleerd", "x"));
  zet("verwijderdOp", een(undefined, undefined, null, "", "2026-11-01T10:00:00.000Z"));
  zet("aantalLln", een(undefined, 0, 1, 3, 23, 46, "22", ""));
  zet("aantalDeelnemers", een(undefined, 0, 4));
  zet("prijsStatus", een(undefined, "gratis", "bekend", "bekend", "bekend", "tebevestigen"));
  zet("kostprijsBasis", een(undefined, "totaal", "perLln", "perLln"));
  zet("kostprijs", bedrag());
  zet("kostprijsPerLln", bedrag());
  zet("voorschot", een(undefined, false, true, true));
  zet("voorschotBedrag", bedrag());
  zet("voorschotInclusief", een(undefined, null, "excl", "excl", "incl"));
  zet("busNodig", een(undefined, false, true, true));
  zet("prijsVervoer", bedrag());
  zet("vervoerwijze", een(undefined, null, "openbaar", "openbaar", "tevoet", "fiets"));
  zet("kostOpenbaarBasis", een(undefined, "totaal", "perLln"));
  zet("kostOpenbaar", bedrag());
  zet("kostOpenbaarPerLln", bedrag());
  zet("annulering", een(undefined, undefined, null, { reden: "x" }, { metKosten: "wel", kosten: bedrag(), busMetKosten: een(undefined, "wel", "geen"), busKosten: bedrag() }, { metKosten: "geen", kosten: 5 }, { kosten: 20 }));
  zet("factuurStatus", een(undefined, "teontvangen", "ontvangen", "nvt"));
  zet("activiteit", een(undefined, "Zoo", "Bos"));
  return t;
}

function kort(trip) {
  const uit = {};
  for (const veld of VELDEN_KORT) uit[veld] = trip[veld] === undefined ? null : trip[veld];
  return uit;
}

Deno.test("een korte lezing geeft dezelfde melding als de volledige rij, voor elke uitstap", () => {
  const kies = reeks(4141);
  for (let i = 0; i < 6000; i++) {
    const trip = willekeurigeUitstap(kies);
    const vol = normaliseer(rij(trip, "u" + i));
    const klein = normaliseer(rij(kort(trip), "u" + i));
    const waar = "uitstap " + i + ": " + JSON.stringify(trip);
    assert.equal(klein.bekend, vol.bekend, waar);
    assert.equal(klein.versie, vol.versie, waar);
    assert.deepEqual(melding(klein), melding(vol), waar);
    assert.equal(soortVan(klein.uitstap), soortVan(vol.uitstap), waar);
    assert.equal(klein.uitstap._datumFout, vol.uitstap._datumFout, waar);
  }
});

Deno.test("een korte lezing telt de uitstappen zoals een volledige lezing", () => {
  const kies = reeks(99);
  const rijen = Array.from({ length: 800 }, (_, i) => rij(willekeurigeUitstap(kies), "u" + i));
  rijen.push(rij({ v: 7, datumStart: "2026-11-20" }, "nieuw-schema"));
  const vol = overzicht(rijen);
  assert.deepEqual(overzicht(rijen.map((r) => rij(kort(r.trip), r.id))), vol);
  const geteld = vol.jaren.reduce((som, j) => som + j.bevestigd + j.aangevraagd + j.geannuleerd, 0) + vol.nascholingen + vol.verwijderd + vol.zonderDatum + vol.onbekendeVersie;
  assert.equal(geteld, rijen.length, "elke uitstap telt precies één keer");
  assert.equal(vol.onbekendeVersie, 1);
  assert.deepEqual(vol.jaren.map((j) => j.schooljaar), ["2025-2026", "2026-2027"]);
});

// ---------- T1, stap 5: kiezen ----------

Deno.test("kiezen: eerst de categorie, dan de prullenbak, dan de planning (V19, B14, B15)", () => {
  const soort = (trip) => soortVan(normaliseer(rij(trip)).uitstap);
  assert.equal(soort({ planStatus: "bevestigd" }), "bevestigd");
  assert.equal(soort({ planStatus: "aangevraagd" }), "aangevraagd");
  assert.equal(soort({}), "aangevraagd");
  assert.equal(soort({ planStatus: "geannuleerd" }), "geannuleerd");
  assert.equal(soort({ planStatus: "bevestigd", verwijderdOp: "2026-11-01T10:00:00.000Z" }), "verwijderd");
  assert.equal(soort({ planStatus: "bevestigd", categorie: "nascholing" }), "nascholing");
  // Een nascholing in de prullenbak blijft een nascholing: ze komt nooit in de MT (B64).
  assert.equal(soort({ planStatus: "bevestigd", categorie: "nascholing", verwijderdOp: "2026-11-01T10:00:00.000Z" }), "nascholing");
});

Deno.test("het overzicht: per schooljaar, met het schooljaar van de startdatum zoals in de uitstappentool", () => {
  assert.equal(schooljaarVan("2026-09-01"), "2026-2027");
  assert.equal(schooljaarVan("2026-08-31"), "2025-2026");
  const o = overzicht([
    rij({ datumStart: "2026-09-01", planStatus: "bevestigd" }, "a"), rij({ datumStart: "2027-08-31", planStatus: "bevestigd" }, "b"),
    rij({ datumStart: "2026-11-20", planStatus: "aangevraagd" }, "c"), rij({ datumStart: "2026-11-21", planStatus: "geannuleerd" }, "d"),
    rij({ datumStart: "2026-08-31", planStatus: "bevestigd" }, "e"), rij({ datumStart: "2026-11-22", categorie: "nascholing" }, "f"),
    rij({ datumStart: "2026-11-23", verwijderdOp: "x" }, "g"), rij({ datumStart: "geen datum", planStatus: "bevestigd" }, "h"), rij({ v: 5 }, "i"),
  ]);
  assert.deepEqual(o, {
    jaren: [{ schooljaar: "2025-2026", bevestigd: 1, aangevraagd: 0, geannuleerd: 0 }, { schooljaar: "2026-2027", bevestigd: 2, aangevraagd: 1, geannuleerd: 1 }],
    nascholingen: 1, verwijderd: 1, zonderDatum: 1, onbekendeVersie: 1,
  });
});

// ---------- Wat een uitstap kost (rekencontract 1.3) ----------

const kost = (trip) => kostenVoorMT(norm(trip));
const deel = (gedeeld, perKind = 0) => ({ onbekend: false, gedeeld, perKind });
const ONBEKEND = { onbekend: true };

Deno.test("kosten: de tabel van het rekencontract (1.3)", () => {
  // gratis
  assert.deepEqual(kost({ prijsStatus: "gratis", kostprijs: 50 }), { activiteit: deel(0), vervoer: null, volledig: true });
  // prijs gekend, totaal voor de groep
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: 187.5, aantalLln: 23 }).activiteit, deel(18750));
  // prijs gekend, per leerling: de prijs zelf, niet het totaal met het geraamde aantal
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijsBasis: "perLln", kostprijsPerLln: 7.5, aantalLln: 46 }).activiteit, deel(0, 750));
  // prijs nog te bevestigen
  assert.deepEqual(kost({ prijsStatus: "tebevestigen" }).activiteit, ONBEKEND);
  // "gekend", maar zonder bedrag: onbekend, nooit € 0
  assert.deepEqual(kost({ prijsStatus: "bekend" }).activiteit, ONBEKEND);
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijsBasis: "perLln", aantalLln: 20 }).activiteit, ONBEKEND);
  // voorschot, exclusief: komt erbij, één keer, als gedeelde kost
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: 420, voorschot: true, voorschotBedrag: 80, voorschotInclusief: "excl" }).activiteit, deel(50000));
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijsBasis: "perLln", kostprijsPerLln: 9, aantalLln: 24, voorschot: true, voorschotBedrag: 50, voorschotInclusief: "excl" }).activiteit, deel(5000, 900));
  // voorschot, inclusief: zit al in de prijs
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: 420, voorschot: true, voorschotBedrag: 80, voorschotInclusief: "incl" }).activiteit, deel(42000));
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijsBasis: "perLln", kostprijsPerLln: 9, aantalLln: 24, voorschot: true, voorschotBedrag: 50, voorschotInclusief: "incl" }).activiteit, deel(0, 900));
  // bus: een gedeelde kost; zonder prijs onbekend
  assert.deepEqual(kost({ prijsStatus: "gratis", busNodig: true, prijsVervoer: 245 }).vervoer, deel(24500));
  assert.deepEqual(kost({ prijsStatus: "gratis", busNodig: true }).vervoer, ONBEKEND);
  // openbaar vervoer, totaal en per leerling (B90)
  assert.deepEqual(kost({ prijsStatus: "gratis", vervoerwijze: "openbaar", kostOpenbaar: 66 }).vervoer, deel(6600));
  assert.deepEqual(kost({ prijsStatus: "gratis", vervoerwijze: "openbaar", kostOpenbaarBasis: "perLln", kostOpenbaarPerLln: 2.1, aantalLln: 22 }).vervoer, deel(0, 210));
  assert.deepEqual(kost({ prijsStatus: "gratis", vervoerwijze: "openbaar" }).vervoer, ONBEKEND);
  // te voet, met de fiets, op school: geen vervoer
  for (const wijze of ["tevoet", "fiets", "school", null, undefined]) assert.equal(kost({ prijsStatus: "gratis", vervoerwijze: wijze }).vervoer, null);
  // met een bus telt het openbaar vervoer niet meer
  assert.deepEqual(kost({ prijsStatus: "gratis", busNodig: true, prijsVervoer: 100, vervoerwijze: "openbaar", kostOpenbaar: 66 }).vervoer, deel(10000));
});

Deno.test("kosten: een bedrag dat geen bedrag is, wordt nooit € 0", () => {
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: -5 }).activiteit, ONBEKEND);
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: "veel" }).activiteit, ONBEKEND);
  assert.deepEqual(kost({ prijsStatus: "gratis", busNodig: true, prijsVervoer: -1 }).vervoer, ONBEKEND);
  assert.equal(kost({ prijsStatus: "bekend", kostprijs: -5 }).volledig, false);
  // De uitstappentool kent enkel hele centen (parseEuro): een bedrag met een stukje van een cent rondt de MT niet stil af.
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijsBasis: "perLln", kostprijsPerLln: 3.335, aantalLln: 23 }).activiteit, ONBEKEND);
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: 10.001 }).activiteit, ONBEKEND);
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: 100, voorschot: true, voorschotBedrag: 10.004, voorschotInclusief: "excl" }).activiteit, ONBEKEND);
  assert.deepEqual(kost({ prijsStatus: "gratis", vervoerwijze: "openbaar", kostOpenbaar: 0.005 }).vervoer, ONBEKEND);
  // Een bedrag als tekst leest norm() als getal, zoals in de uitstappentool.
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: "187.50" }).activiteit, deel(18750));
  // Centen zijn hele getallen, ook waar een kommagetal net naast ligt.
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: 0.07 }).activiteit, deel(7));
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijs: 1234.56 }).activiteit, deel(123456));
  assert.deepEqual(kost({ prijsStatus: "bekend", kostprijsBasis: "perLln", kostprijsPerLln: 2.3, aantalLln: 3 }).activiteit, deel(0, 230));
});

Deno.test("kosten: voor elke uitstap dezelfde uitkomst als kosten() van de uitstappentool, met haar eigen aantal", () => {
  const kies = reeks(2026);
  let gekend = 0;
  for (let i = 0; i < 8000; i++) {
    const t = norm(willekeurigeUitstap(kies));
    const k = kosten(t);
    const mt = kostenVoorMT(t);
    const aantal = persAantal(t);
    const waar = "uitstap " + i + ": " + JSON.stringify(t);
    const negatief = [t.kostprijs, t.kostprijsPerLln, t.prijsVervoer, t.kostOpenbaar, t.kostOpenbaarPerLln, t.voorschotBedrag].some((b) => typeof b === "number" && b < 0);
    if (negatief) {
      // Een negatief bedrag kent de uitstappentool niet: de MT rekent er nooit mee.
      for (const o of [mt.activiteit, mt.vervoer]) if (o && !o.onbekend) assert.ok(o.gedeeld >= 0 && o.perKind >= 0, waar);
      continue;
    }
    assert.equal(mt.volledig, k.volledig, waar);
    assert.equal(mt.activiteit.onbekend, k.act == null, waar);
    if (k.act != null) {
      // De gedeelde kost plus de prijs per kind maal het aantal van de uitstappentool is haar eigen totaal.
      assert.ok(Math.abs(mt.activiteit.gedeeld + mt.activiteit.perKind * aantal - k.actTot * 100) < 1.5, waar + " → " + JSON.stringify([mt.activiteit, k]));
      gekend++;
    }
    const vervoerNodig = t.busNodig || t.vervoerwijze === "openbaar";
    assert.equal(mt.vervoer !== null, vervoerNodig, waar);
    if (vervoerNodig) {
      assert.equal(mt.vervoer.onbekend, k.verv == null, waar);
      if (k.verv != null) assert.ok(Math.abs(mt.vervoer.gedeeld + mt.vervoer.perKind * aantal - k.verv * 100) < 1.5, waar + " → " + JSON.stringify([mt.vervoer, k]));
    }
  }
  assert.ok(gekend > 2000, "te weinig uitstappen met een gekende prijs: " + gekend);
});

Deno.test("annuleringskosten: geen, een bedrag, of een bedrag dat nog moet volgen (1.7, V23)", () => {
  const ann = (trip) => annuleringVoorMT(norm({ planStatus: "geannuleerd", ...trip }));
  assert.deepEqual(ann({}), { activiteit: null, vervoer: null });
  assert.deepEqual(ann({ annulering: { reden: "x" } }), { activiteit: null, vervoer: null });
  assert.deepEqual(ann({ annulering: { metKosten: "geen", kosten: 20 } }), { activiteit: null, vervoer: null });
  assert.deepEqual(ann({ annulering: { metKosten: "wel", kosten: 75 } }), { activiteit: deel(7500), vervoer: null });
  // het bedrag moet nog volgen: onbekend, nooit € 0
  assert.deepEqual(ann({ annulering: { metKosten: "wel" } }), { activiteit: ONBEKEND, vervoer: null });
  // de bus apart, enkel bij een uitstap met een bus
  assert.deepEqual(ann({ busNodig: true, annulering: { metKosten: "wel", kosten: 75, busMetKosten: "wel", busKosten: 60 } }), { activiteit: deel(7500), vervoer: deel(6000) });
  assert.deepEqual(ann({ busNodig: true, annulering: { metKosten: "geen", busMetKosten: "wel" } }), { activiteit: null, vervoer: ONBEKEND });
  assert.deepEqual(ann({ busNodig: false, annulering: { metKosten: "wel", kosten: 75, busMetKosten: "wel", busKosten: 60 } }), { activiteit: deel(7500), vervoer: null });
  // een oudere annulering zonder keuze, met een bedrag: met kosten
  assert.deepEqual(ann({ annulering: { kosten: 20 } }), { activiteit: deel(2000), vervoer: null });
  // enkel bij een geannuleerde uitstap
  assert.deepEqual(annuleringVoorMT(norm({ planStatus: "bevestigd", annulering: { metKosten: "wel", kosten: 75 } })), { activiteit: null, vervoer: null });
});

// ---------- De klassenlijst ----------

Deno.test("de klassen: in de volgorde van de lijst, met de groep en \"actief\" zoals de uitstappentool ze leest", () => {
  assert.deepEqual(klassenUit({ klassen: [
    { id: "k1", naam: "1KA", groep: "Kleuter", actief: true }, { id: "k2", naam: " 4A ", groep: "Lager" }, { id: "k3", naam: "LO", groep: "Sport", actief: false },
    { naam: "zonder id", groep: "Lager" }, null,
  ] }), [
    { id: "k1", naam: "1KA", groep: "Kleuter", actief: true }, { id: "k2", naam: "4A", groep: "Lager", actief: true }, { id: "k3", naam: "LO", groep: "Andere", actief: false },
    // Geen verzonnen id: de databank weigert zo'n lijst, en er wijzigt niets.
    { id: null, naam: "zonder id", groep: "Lager", actief: true }, { id: null, naam: "", groep: "Andere", actief: true },
  ]);
  for (const leeg of [null, undefined, {}, { klassen: null }, { klassen: "4A" }, { klassen: [] }]) assert.deepEqual(klassenUit(leeg), []);
});

// ---------- T1, stap 1: volledig en gecontroleerd ophalen ----------

const BRON = { url: "https://uitstappentool.voorbeeld", sleutel: "sb_publishable_voorbeeld" };

/**
 * Een nagebootste uitstappentool: de Data API met haar bladzijden, haar totaal en haar korte kolommen.
 * tabellen: { uitstappen: [rijen], instellingen: [rijen] }; opties.antwoord kan één oproep vervangen.
 */
function nep(tabellen, opties = {}) {
  const oproepen = [];
  const haal = (adres, init) => {
    oproepen.push({ adres, init });
    const nr = oproepen.length;
    if (opties.antwoord) {
      const eigen = opties.antwoord(nr, adres);
      if (eigen === "gooi") return Promise.reject(new TypeError("geen netwerk"));
      if (eigen) return Promise.resolve(eigen);
    }
    const url = new URL(adres);
    const tabel = url.pathname.replace("/rest/v1/", "");
    if (!Object.prototype.hasOwnProperty.call(tabellen, tabel)) return Promise.resolve(new Response('{"message":"bestaat niet"}', { status: 404 }));
    let rijen = tabellen[tabel];
    for (const veld of ["schooljaar", "id"]) {
      const filter = url.searchParams.get(veld);
      if (filter) rijen = rijen.filter((r) => "eq." + r[veld] === filter);
    }
    const volgorde = url.searchParams.get("order").split(",").map((deel) => deel.replace(/\.asc$/, ""));
    rijen = [...rijen].sort((a, b) => {
      for (const veld of volgorde) if (a[veld] !== b[veld]) return a[veld] < b[veld] ? -1 : 1;
      return 0;
    });
    const limiet = Number(url.searchParams.get("limit"));
    const vanaf = Number(url.searchParams.get("offset"));
    const stuk = rijen.slice(vanaf, vanaf + limiet).map((r) => {
      const uit = {};
      for (const kolom of url.searchParams.get("select").split(",")) {
        const m = /^(\w+):trip->(\w+)$/.exec(kolom);
        if (m) uit[m[1]] = r.trip && r.trip[m[2]] !== undefined ? r.trip[m[2]] : null;
        else uit[kolom] = r[kolom] === undefined ? null : r[kolom];
      }
      return uit;
    });
    const totaal = opties.totaal ? opties.totaal(nr, rijen.length) : rijen.length;
    const bereik = (stuk.length ? vanaf + "-" + (vanaf + stuk.length - 1) : "*") + "/" + totaal;
    return Promise.resolve(new Response(JSON.stringify(stuk), { status: stuk.length < rijen.length ? 206 : 200, headers: { "content-range": bereik } }));
  };
  return { haal, oproepen };
}

const uitstappen = (aantal) => Array.from({ length: aantal }, (_, i) => ({
  id: "u" + String(i).padStart(5, "0"), nr: i + 1, schooljaar: i % 2 ? "2026-2027" : "2025-2026", updated_at: "2026-11-10T08:00:00+00:00",
  trip: { v: 2, datumStart: i % 2 ? "2026-11-20" : "2026-03-20", klassen: ["4A"], planStatus: "bevestigd", activiteit: "Uitstap " + i, leerkracht: "een naam", kostprijs: 100 },
}));

Deno.test("ophalen: de korte lezing vraagt enkel wat de databank nodig heeft, met de sleutel enkel als apikey", async () => {
  const bron = nep({ uitstappen: uitstappen(3) });
  const uit = await leesUitstappenKort(bron.haal, BRON);
  assert.equal(uit.ok, true);
  assert.equal(bron.oproepen.length, 1);
  const { adres, init } = bron.oproepen[0];
  assert.equal(adres, "https://uitstappentool.voorbeeld/rest/v1/uitstappen?select=id,updated_at,v:trip->v,categorie:trip->categorie,type:trip->type,datumStart:trip->datumStart,"
    + "datumEind:trip->datumEind,klassen:trip->klassen,planStatus:trip->planStatus,verwijderdOp:trip->verwijderdOp&order=id.asc&limit=1000&offset=0");
  assert.deepEqual(init, { method: "GET", headers: { apikey: "sb_publishable_voorbeeld", Accept: "application/json", Prefer: "count=exact" }, redirect: "error" });
  // Geen titel, geen naam van een leerkracht, geen prijs: enkel de acht velden.
  assert.deepEqual(uit.rijen[0], {
    id: "u00000", updated_at: "2026-11-10T08:00:00+00:00",
    trip: { v: 2, categorie: null, type: null, datumStart: "2026-03-20", datumEind: null, klassen: ["4A"], planStatus: "bevestigd", verwijderdOp: null },
  });
  assert.deepEqual(bericht(uit.rijen).alleIds, ["u00000", "u00001", "u00002"]);
});

Deno.test("ophalen: alle bladzijden, met het totaal bij elke bladzijde", async () => {
  const bron = nep({ uitstappen: uitstappen(2500) });
  const uit = await leesUitstappenKort(bron.haal, BRON);
  assert.equal(uit.ok, true);
  assert.equal(uit.rijen.length, 2500);
  assert.deepEqual(bron.oproepen.map((o) => new URL(o.adres).searchParams.get("offset")), ["0", "1000", "2000"]);
  assert.ok(bron.oproepen.every((o) => o.init.headers.Prefer === "count=exact" && o.init.method === "GET" && !("Authorization" in o.init.headers)));
  assert.equal(new Set(uit.rijen.map((r) => r.id)).size, 2500);
  // Precies een veelvoud van een bladzijde: geen vraag te veel, en niets te weinig.
  const rond = nep({ uitstappen: uitstappen(2000) });
  assert.equal((await leesUitstappenKort(rond.haal, BRON)).rijen.length, 2000);
  assert.equal(rond.oproepen.length, 2);
});

Deno.test("ophalen: een lege uitstappentool is een lege lijst; of dat een fout is, beslist de databank", async () => {
  const bron = nep({ uitstappen: [] });
  assert.deepEqual(await leesUitstappenKort(bron.haal, BRON), { ok: true, rijen: [] });
  assert.equal(bron.oproepen.length, 1);
});

Deno.test("ophalen: geen antwoord, een weigering of een ander antwoord is nooit een lege lijst", async () => {
  const geval = async (antwoord) => await leesUitstappenKort(nep({ uitstappen: uitstappen(5) }, { antwoord }).haal, BRON);
  assert.deepEqual(await geval(() => "gooi"), { ok: false, reden: "verbinding", status: 0 });
  assert.deepEqual(await geval(() => new Response('{"message":"nee"}', { status: 401 })), { ok: false, reden: "geweigerd", status: 401 });
  assert.deepEqual(await geval(() => new Response('{"message":"nee"}', { status: 403 })), { ok: false, reden: "geweigerd", status: 403 });
  assert.deepEqual(await geval(() => new Response("kapot", { status: 500 })), { ok: false, reden: "fout", status: 500 });
  assert.deepEqual(await geval(() => new Response('{"geen":"lijst"}', { status: 200, headers: { "content-range": "0-0/1" } })), { ok: false, reden: "fout", status: 200 });
  assert.deepEqual(await geval(() => new Response("[1, 2]", { status: 200, headers: { "content-range": "0-1/2" } })), { ok: false, reden: "fout", status: 200 });
  // Een antwoord dat geen JSON is, ook met status 200: geen lijst.
  assert.deepEqual(await geval(() => new Response("<html>", { status: 200, headers: { "content-range": "0-0/1" } })), { ok: false, reden: "verbinding", status: 0 });
  // De tweede bladzijde valt weg: geen halve lijst.
  const half = nep({ uitstappen: uitstappen(1500) }, { antwoord: (nr) => (nr === 2 ? "gooi" : null) });
  assert.deepEqual(await leesUitstappenKort(half.haal, BRON), { ok: false, reden: "verbinding", status: 0 });
});

Deno.test("ophalen: klopt het aantal niet met het totaal, dan leest de MT één keer opnieuw; blijft het zo, dan is er geen lijst", async () => {
  // Zonder totaal valt een bladzijde die ontbreekt niet op.
  const zonder = nep({ uitstappen: uitstappen(5) }, { antwoord: () => new Response("[]", { status: 200 }) });
  assert.deepEqual(await leesUitstappenKort(zonder.haal, BRON), { ok: false, reden: "onvolledig", status: 0 });
  assert.equal(zonder.oproepen.length, 2, "één keer opnieuw, niet vaker");
  // Het totaal wijzigt tussen twee bladzijden: er kwam iets bij of er ging iets weg.
  const schuift = nep({ uitstappen: uitstappen(1500) }, { totaal: (nr, echt) => (nr === 2 ? echt + 1 : echt) });
  const uit = await leesUitstappenKort(schuift.haal, BRON);
  assert.equal(uit.ok, true, "de tweede lezing klopt");
  assert.equal(uit.rijen.length, 1500);
  assert.equal(schuift.oproepen.length, 4);
  const blijft = nep({ uitstappen: uitstappen(1500) }, { totaal: (nr, echt) => (nr % 2 === 0 ? echt + 1 : echt) });
  assert.deepEqual(await leesUitstappenKort(blijft.haal, BRON), { ok: false, reden: "onvolledig", status: 0 });
  // De lijst wordt korter terwijl de MT leest: de tweede bladzijde begint dan voorbij het einde, en de
  // Data API antwoordt met 416. Geen fout, maar een lijst die wijzigde: één keer opnieuw lezen.
  let korter = 0;
  const gekrompen = nep({ uitstappen: uitstappen(1500) }, {
    antwoord: (nr) => (nr === 2 && ++korter === 1 ? new Response('{"code":"PGRST103","message":"Requested range not satisfiable"}', { status: 416, headers: { "content-range": "*/900" } }) : null),
  });
  const opnieuw = await leesUitstappenKort(gekrompen.haal, BRON);
  assert.equal(opnieuw.ok, true);
  assert.equal(opnieuw.rijen.length, 1500);
  assert.equal(gekrompen.oproepen.length, 4, "na een 416 leest de MT één keer opnieuw, vanaf het begin");
  const blijftKort = nep({ uitstappen: uitstappen(1500) }, { antwoord: (nr) => (nr % 2 === 0 ? new Response("{}", { status: 416 }) : null) });
  assert.deepEqual(await leesUitstappenKort(blijftKort.haal, BRON), { ok: false, reden: "onvolledig", status: 0 });
  // De databank meldt meer rijen dan ze geeft.
  const teWeinig = nep({ uitstappen: uitstappen(5) }, { totaal: (_nr, echt) => echt + 3 });
  assert.deepEqual(await leesUitstappenKort(teWeinig.haal, BRON), { ok: false, reden: "onvolledig", status: 0 });
});

Deno.test("ophalen: twee keer hetzelfde id, of een rij zonder id, is geen lijst", async () => {
  const dubbel = uitstappen(3);
  dubbel[2].id = dubbel[0].id;
  assert.deepEqual(await leesUitstappenKort(nep({ uitstappen: dubbel }).haal, BRON), { ok: false, reden: "onvolledig", status: 0 });
  const zonder = uitstappen(3);
  zonder[1].id = 7;
  assert.deepEqual(await leesUitstappenKort(nep({ uitstappen: zonder }).haal, BRON), { ok: false, reden: "onvolledig", status: 0 });
});

Deno.test("ophalen: de uitstappen van één schooljaar, volledig, zoals de uitstappentool ze zelf leest", async () => {
  const bron = nep({ uitstappen: uitstappen(10) });
  const uit = await leesUitstappen(bron.haal, BRON, "2026-2027");
  assert.equal(uit.ok, true);
  assert.equal(uit.rijen.length, 5);
  assert.equal(bron.oproepen[0].adres, "https://uitstappentool.voorbeeld/rest/v1/uitstappen?select=id,nr,schooljaar,trip,updated_at&schooljaar=eq.2026-2027&order=nr.asc,id.asc&limit=1000&offset=0");
  assert.equal(uit.rijen[0].trip.activiteit, "Uitstap 1");
  assert.equal(normaliseer(uit.rijen[0]).uitstap.kostprijs, 100);
  // Wat geen schooljaar is, komt nooit in een vraag terecht.
  for (const fout of ["2026", "2026-2027&select=*", "", null, undefined, "2026-2027 "]) {
    const stil = nep({ uitstappen: uitstappen(2) });
    assert.deepEqual(await leesUitstappen(stil.haal, BRON, fout), { ok: false, reden: "fout", status: 0 });
    assert.equal(stil.oproepen.length, 0);
  }
});

Deno.test("ophalen: de klassenlijst; een lege lijst is een fout, geen resultaat", async () => {
  const instellingen = [{ id: "klimop", data: { klassen: [{ id: "k1", naam: "1KA", groep: "Kleuter" }, { id: "k2", naam: "4A", groep: "Lager", actief: false }], vakanties: [] } }, { id: "ander", data: { klassen: [{ id: "x", naam: "X", groep: "Lager" }] } }];
  const bron = nep({ instellingen });
  assert.deepEqual(await leesKlassen(bron.haal, BRON), { ok: true, klassen: [{ id: "k1", naam: "1KA", groep: "Kleuter", actief: true }, { id: "k2", naam: "4A", groep: "Lager", actief: false }] });
  assert.equal(bron.oproepen[0].adres, "https://uitstappentool.voorbeeld/rest/v1/instellingen?select=data&id=eq.klimop&order=id.asc&limit=1000&offset=0");
  assert.deepEqual(await leesKlassen(nep({ instellingen: [] }).haal, BRON), { ok: false, reden: "leeg", status: 0 });
  assert.deepEqual(await leesKlassen(nep({ instellingen: [{ id: "klimop", data: { klassen: [] } }] }).haal, BRON), { ok: false, reden: "leeg", status: 0 });
  assert.deepEqual(await leesKlassen(nep({ instellingen: [{ id: "klimop", data: null }] }).haal, BRON), { ok: false, reden: "leeg", status: 0 });
  assert.deepEqual(await leesKlassen(nep({ instellingen }, { antwoord: () => "gooi" }).haal, BRON), { ok: false, reden: "verbinding", status: 0 });
});

Deno.test("ophalen: de MT leest enkel, en enkel de twee tabellen", async () => {
  const bron = nep({ uitstappen: uitstappen(1200), instellingen: [{ id: "klimop", data: { klassen: [{ id: "k1", naam: "1KA", groep: "Kleuter" }] } }] });
  await leesUitstappenKort(bron.haal, BRON);
  await leesUitstappen(bron.haal, BRON, "2026-2027");
  await leesKlassen(bron.haal, BRON);
  assert.ok(bron.oproepen.length >= 4);
  for (const { adres, init } of bron.oproepen) {
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, "error");
    assert.deepEqual(Object.keys(init.headers).sort(), ["Accept", "Prefer", "apikey"]);
    assert.match(new URL(adres).pathname, /^\/rest\/v1\/(uitstappen|instellingen)$/);
    assert.ok(adres.startsWith(BRON.url + "/"));
  }
});
