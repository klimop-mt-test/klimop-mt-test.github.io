// MT · tests/rekenen_test.js
// Het rekencontract (mt-rekencontract.md, versie 19) als automatische test (17.1, 17.12, T10):
//   - de testgevallen van fase 1, uit dezelfde lijst als de testpagina (code/rekentest.js);
//   - de afronding van B97, ook bij een credit en bij grote bedragen;
//   - G21, de controle over alle gevallen, met willekeurige bedragen en aantallen: elk bedrag wijkt
//     hoogstens een halve cent af van het exacte deel. Het exacte deel rekent deze test zelf uit, leerling
//     per leerling en los van rekenen.js, volgens 1.16 van het contract;
//   - wat niet mag: een onbekende prijs die € 0 wordt, een deling door nul, een oproep die niet klopt.
// Alles draait twee keer, in UTC en in de tijd van Brussel, met dezelfde uitkomst.

import assert from "node:assert/strict";
import {
  AANWEZIG, aantallen, afronden, bedrag, dagNa, ENKEL_GEDEELD, isDatum, isSchoolverlater, jaarStand, NIET_AANGEREKEND, periodeOp, plafondStand, profiel, profielVan,
  REKENVERSIE, schooljaarVan, standBedrag, totalen, verdeel, verdeelCorrectie,
} from "../code/rekenen.js";
import { alsTekst, telling, voerUit } from "../code/rekentest.js";
import { reeks } from "./hulp.js";

// ---------- De testgevallen van het rekencontract ----------

Deno.test("rekencontract: elk testgeval van fase 1 geeft het verwachte bedrag", () => {
  const gevallen = voerUit();
  const mis = [];
  for (const geval of gevallen) {
    for (const rij of geval.rijen) {
      if (!rij.ok) mis.push(geval.nr + " · " + rij.wat + ": verwacht " + alsTekst(rij.verwacht, rij.soort) + ", berekend " + alsTekst(rij.berekend, rij.soort));
    }
  }
  assert.deepEqual(mis, [], "het rekencontract en rekenen.js verschillen:\n" + mis.join("\n"));
});

Deno.test("rekencontract: de lijst bevat alle gevallen van fase 1", () => {
  const gevallen = voerUit();
  const nummers = gevallen.map((geval) => geval.nr);
  assert.deepEqual(nummers, ["A1", "A2", "A6", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G11", "G12", "G18", "G19", "G20"]);
  const t = telling(gevallen);
  assert.ok(t.controles >= 110, "te weinig controles: " + t.controles);
  assert.equal(t.afwijkend, 0);
  for (const geval of gevallen) assert.ok(geval.rijen.length >= 2, geval.nr + " heeft te weinig controles");
});

Deno.test("de testpagina toont een bedrag in euro, en een onbekend bedrag nooit als € 0", () => {
  assert.equal(alsTekst(277200, "geld"), "€ 2.772,00");
  assert.equal(alsTekst(-33, "geld"), "− € 0,33");
  assert.equal(alsTekst(null, "geld"), "onbekend");
  assert.equal(alsTekst({ activiteit: 288, vervoer: null, totaal: null }, "geld"), "activiteit € 2,88 · vervoer onbekend · totaal onbekend");
  assert.equal(alsTekst(true, "feit"), "ja");
  assert.equal(alsTekst({ aangerekend: 43, betalers: 41 }, "feit"), "aangerekend 43 · betalers 41");
});

// ---------- Afronden (B97) ----------

Deno.test("afronden: tot en met de halve cent naar beneden, daarboven naar boven", () => {
  assert.equal(afronden(335, 10), 33);     // 0,335
  assert.equal(afronden(3349, 100), 33);   // 0,3349
  assert.equal(afronden(3351, 100), 34);   // 0,3351
  assert.equal(afronden(336, 10), 34);     // 0,336
  assert.equal(afronden(19650, 20), 982);  // 9,825 (G1d)
  assert.equal(afronden(43250, 21), 2060); // 20,5952… (G1b)
  assert.equal(afronden(1, 2), 0);
  assert.equal(afronden(3, 2), 1);
  assert.equal(afronden(0, 7), 0);
  assert.equal(afronden(1234), 1234);
});

Deno.test("afronden: bij een credit dezelfde regel op het bedrag", () => {
  assert.equal(afronden(-335, 10), -33);
  assert.equal(afronden(-3351, 100), -34);
  assert.equal(afronden(-1, 2), 0);
  assert.equal(afronden(-3, 2), -1);
  assert.equal(afronden(335, -10), -33);
  assert.equal(Object.is(afronden(-1, 3), -0), false, "min nul hoort gewoon nul te zijn");
});

Deno.test("afronden: exact, ook waar kommagetallen het niet zijn", () => {
  // 1,005 is als kommagetal net geen 1,005: wie met kommagetallen rekent, rondt hier fout af.
  assert.equal(afronden(1005, 10), 100);
  assert.equal(afronden(10051, 100), 101);
  // Ver boven wat een kommagetal exact kan bewaren.
  assert.equal(afronden(10n ** 30n + 1n, 2n * 10n ** 18n), 500000000000);
  assert.equal(afronden(9007199254740993n, 2n), 4503599627370496);
});

Deno.test("afronden: een oproep die niet klopt, is een fout en nooit een bedrag", () => {
  assert.throws(() => afronden(1, 0), RangeError);
  assert.throws(() => afronden(1.5, 2), RangeError);
  assert.throws(() => afronden("12", 2), RangeError);
  assert.throws(() => afronden(NaN), RangeError);
  assert.throws(() => afronden(2n ** 80n, 1n), RangeError);
});

// ---------- Verdelen: wat nooit mag ----------

Deno.test("een onbekende prijs wordt nooit € 0, en nooit een totaal (B80)", () => {
  const v = verdeel({ activiteit: { onbekend: true }, vervoer: { onbekend: true } });
  assert.deepEqual(bedrag(v, AANWEZIG), { activiteit: null, vervoer: null, totaal: null });
  assert.equal(v.volledig, false);
  assert.deepEqual(totalen(v, [{ profiel: AANWEZIG, aantal: 5 }]), { ouders: null, kost: null, tussenkomst: null, school: null });
  const half = verdeel({ activiteit: { onbekend: true, gedeeld: 5000, aangerekend: 10 }, vervoer: { gedeeld: 1000, aangerekend: 10 } });
  assert.deepEqual(bedrag(half, AANWEZIG), { activiteit: null, vervoer: 100, totaal: null });
  assert.equal(half.activiteit.kost, null);
  assert.equal(half.overschot.rest, null);
});

Deno.test("een onbekende prijs raakt enkel wie er iets van betaalt: een attest blijft € 0, en wat de school draagt ook", () => {
  const v = verdeel({ activiteit: { onbekend: true }, vervoer: { gedeeld: 16000, aangerekend: 22 } });
  // Wie een attest heeft, betaalt niets, wat de activiteit ook kost.
  assert.deepEqual(bedrag(v, NIET_AANGEREKEND), { activiteit: 0, vervoer: 0, totaal: 0 });
  // De school draagt de activiteit (bv. de toegang in het gratis zwemjaar): de ouders betalen enkel het vervoer.
  const schoolDraagtActiviteit = { activiteit: { aangerekend: true, perKind: true, school: true }, vervoer: { aangerekend: true } };
  assert.deepEqual(bedrag(v, schoolDraagtActiviteit), { activiteit: 0, vervoer: 727, totaal: 727 });
  // Wie de activiteit wel betaalt, heeft geen totaal.
  assert.deepEqual(bedrag(v, AANWEZIG), { activiteit: null, vervoer: 727, totaal: null });
  // De sommen: de kost is onbekend, en telt nooit als € 0, ook niet als niemand iets betaalt.
  assert.deepEqual(totalen(v, [{ profiel: AANWEZIG, aantal: 20 }, { profiel: ENKEL_GEDEELD, aantal: 2 }, { profiel: NIET_AANGEREKEND, aantal: 1 }]), { ouders: null, kost: null, tussenkomst: null, school: null });
  const niemand = verdeel({ activiteit: { onbekend: true }, vervoer: { gedeeld: 16000, aangerekend: 0 } });
  assert.deepEqual(totalen(niemand, [{ profiel: NIET_AANGEREKEND, aantal: 22 }]), { ouders: 0, kost: null, tussenkomst: null, school: null });
});

Deno.test("een tussenkomst die naar een onbekend onderdeel zou gaan, verdwijnt niet en telt niet als rest", () => {
  const v = verdeel({ activiteit: { onbekend: true }, vervoer: { gedeeld: 10000, aangerekend: 10, tussenkomstTotaal: 15000 } });
  assert.deepEqual(bedrag(v, AANWEZIG), { activiteit: null, vervoer: 0, totaal: null });
  assert.equal(v.overschot.vanVervoer, 5000);
  assert.equal(v.overschot.rest, null);
});

Deno.test("een overschot zonder ander onderdeel is de rest: dat lost de beheerder op (B102)", () => {
  const v = verdeel({ activiteit: { gedeeld: 10000, aangerekend: 10, tussenkomstTotaal: 12500 } });
  assert.deepEqual(bedrag(v, AANWEZIG), { activiteit: 0, vervoer: 0, totaal: 0 });
  assert.deepEqual(v.overschot, { vanActiviteit: 2500, vanVervoer: 0, terugActiviteit: 0, terugVervoer: 0, rest: 2500 });
  // Beide onderdelen volledig gedekt: wat samen overblijft, is de rest.
  const beide = verdeel({ activiteit: { gedeeld: 10000, aangerekend: 10, tussenkomstTotaal: 12500 }, vervoer: { gedeeld: 4000, aangerekend: 10, tussenkomstTotaal: 4100 } });
  assert.deepEqual(beide.overschot, { vanActiviteit: 2500, vanVervoer: 100, terugActiviteit: 0, terugVervoer: 0, rest: 2600 });
  // Het overschot dekt het andere onderdeel maar deels: de rest is wat daarna overblijft.
  const deels = verdeel({ activiteit: { gedeeld: 10000, aangerekend: 10, tussenkomstTotaal: 16000 }, vervoer: { gedeeld: 4000, aangerekend: 10 } });
  assert.deepEqual(bedrag(deels, AANWEZIG), { activiteit: 0, vervoer: 0, totaal: 0 });
  assert.deepEqual(deels.overschot, { vanActiviteit: 6000, vanVervoer: 0, terugActiviteit: 0, terugVervoer: 0, rest: 2000 });
  assert.equal(deels.vervoer.tussenkomst, 4000);
});

Deno.test("een tussenkomst per kind verlaagt enkel wie de prijs per kind betaalt; zonder prijs per kind elke aangerekende leerling (B104)", () => {
  const met = verdeel({ activiteit: { perKind: 500, gedeeld: 2000, aangerekend: 10, betalers: 8, tussenkomstPerKind: 100 } });
  assert.equal(bedrag(met, AANWEZIG).totaal, 600);       // 5,00 + 2,00 − 1,00
  assert.equal(bedrag(met, ENKEL_GEDEELD).totaal, 200);  // geen prijs per kind, dus geen korting
  assert.equal(met.activiteit.tussenkomst, 800);
  const zonder = verdeel({ activiteit: { gedeeld: 2000, aangerekend: 10, tussenkomstPerKind: 50 } });
  assert.equal(bedrag(zonder, AANWEZIG).totaal, 150);
  assert.equal(bedrag(zonder, ENKEL_GEDEELD).totaal, 150);
  assert.equal(zonder.activiteit.tussenkomst, 500);
  // Per kind meer dan het hele deel van een betaler: zijn bedrag wordt nooit negatief (B141). Wat overblijft,
  // 4 × (5,00 − 4,00), kan nergens anders heen en keert terug: de zes anderen betalen samen 6,00 − 4,00 (B221).
  const veel = verdeel({ activiteit: { perKind: 300, gedeeld: 1000, aangerekend: 10, betalers: 4, tussenkomstPerKind: 500 } });
  assert.equal(bedrag(veel, AANWEZIG).totaal, 0);
  assert.equal(bedrag(veel, ENKEL_GEDEELD).totaal, 33);  // 2,00 / 6 = 0,333…
  assert.deepEqual(veel.overschot, { vanActiviteit: 400, vanVervoer: 0, terugActiviteit: 400, terugVervoer: 0, rest: 0 });
  assert.equal(veel.activiteit.tussenkomst, 2000);  // 4 × 4,00 per kind en 4,00 terug: 20,00 van de 22,00 die de activiteit kost
});

Deno.test("een tussenkomst blijft nooit ongebruikt zolang er nog iets te betalen is (B219, B221)", () => {
  // Toegang 6,00 en een gids van 50,00; 20 aangerekend, van wie 10 mee; 10,00 per kind dat mee was (G5g).
  const act = { gedeeld: 5000, perKind: 600, tussenkomstPerKind: 1000, aangerekend: 20, betalers: 10 };
  const zonder = verdeel({ activiteit: act });
  assert.deepEqual(bedrag(zonder, AANWEZIG), { activiteit: 0, vervoer: 0, totaal: 0 });
  assert.deepEqual(bedrag(zonder, ENKEL_GEDEELD), { activiteit: 100, vervoer: 0, totaal: 100 });
  assert.deepEqual(zonder.overschot, { vanActiviteit: 1500, vanVervoer: 0, terugActiviteit: 1500, terugVervoer: 0, rest: 0 });
  // Eerst het andere onderdeel (B102), dan pas terug: een bus van 10,00 neemt 10,00 op, 5,00 keert terug.
  const kleineBus = verdeel({ activiteit: act, vervoer: { gedeeld: 1000, aangerekend: 20 } });
  assert.deepEqual(bedrag(kleineBus, AANWEZIG), { activiteit: 0, vervoer: 0, totaal: 0 });
  assert.deepEqual(bedrag(kleineBus, ENKEL_GEDEELD), { activiteit: 200, vervoer: 0, totaal: 200 });
  assert.deepEqual(kleineBus.overschot, { vanActiviteit: 1500, vanVervoer: 0, terugActiviteit: 500, terugVervoer: 0, rest: 0 });
  assert.equal(kleineBus.vervoer.tussenkomst, 1000);
  assert.equal(kleineBus.activiteit.tussenkomst, 9000);  // 10 × 8,50 per kind en 5,00 terug
  // Kan het andere onderdeel alles opnemen, dan keert er niets terug.
  const groteBus = verdeel({ activiteit: act, vervoer: { gedeeld: 30000, aangerekend: 20 } });
  assert.deepEqual(bedrag(groteBus, AANWEZIG), { activiteit: 0, vervoer: 1425, totaal: 1425 });
  assert.deepEqual(bedrag(groteBus, ENKEL_GEDEELD), { activiteit: 250, vervoer: 1425, totaal: 1675 });
  assert.deepEqual(groteBus.overschot, { vanActiviteit: 1500, vanVervoer: 0, terugActiviteit: 0, terugVervoer: 0, rest: 0 });
  // Een rest is er enkel nog als de tussenkomsten samen groter zijn dan de totale kost.
  const iedereenMee = verdeel({ activiteit: { ...act, betalers: 20 } });
  assert.deepEqual(iedereenMee.overschot, { vanActiviteit: 3000, vanVervoer: 0, terugActiviteit: 0, terugVervoer: 0, rest: 3000 });
  // Andersom: het vervoer heeft de prijs per kind. De activiteit neemt 10,00 op, 5,00 keert terug naar het vervoer.
  const andersom = verdeel({ activiteit: { gedeeld: 1000, aangerekend: 20 }, vervoer: act });
  assert.deepEqual(andersom.overschot, { vanActiviteit: 0, vanVervoer: 1500, terugActiviteit: 0, terugVervoer: 500, rest: 0 });
  assert.deepEqual(bedrag(andersom, ENKEL_GEDEELD), { activiteit: 0, vervoer: 200, totaal: 200 });
  // Ook naast een tussenkomst als totaal: 10,00 als totaal, dan nog 15,00 terug; de tien anderen betalen samen niets meer.
  const metTotaal = verdeel({ activiteit: { ...act, tussenkomstTotaal: 1000 } });
  assert.deepEqual(bedrag(metTotaal, ENKEL_GEDEELD), { activiteit: 0, vervoer: 0, totaal: 0 });
  assert.deepEqual(metTotaal.overschot, { vanActiviteit: 1500, vanVervoer: 0, terugActiviteit: 1500, terugVervoer: 0, rest: 0 });
  // Is de prijs van het andere onderdeel onbekend, dan wacht het overschot: geen rest, en er keert niets terug.
  const wacht = verdeel({ activiteit: act, vervoer: { onbekend: true } });
  assert.deepEqual(wacht.overschot, { vanActiviteit: 1500, vanVervoer: 0, terugActiviteit: 0, terugVervoer: 0, rest: null });
  assert.deepEqual(bedrag(wacht, ENKEL_GEDEELD), { activiteit: 250, vervoer: null, totaal: null });
});

Deno.test("de school draagt: eerst gewoon berekend, dan voor de ouders op € 0, met één afronding op wat de ouders betalen", () => {
  // Exact 2,104 voor de activiteit en 2,264 voor het vervoer. Draagt de school de activiteit, dan betalen
  // de ouders 2,264: € 2,26, en niet het verschil van twee afrondingen (4,37 − 2,10 = 2,27).
  const v = verdeel({ activiteit: { gedeeld: 2104, aangerekend: 10 }, vervoer: { gedeeld: 2264, aangerekend: 10 } });
  assert.deepEqual(bedrag(v, AANWEZIG), { activiteit: 210, vervoer: 227, totaal: 437 });
  const schoolDraagtActiviteit = { activiteit: { aangerekend: true, perKind: true, school: true }, vervoer: { aangerekend: true } };
  assert.deepEqual(bedrag(v, schoolDraagtActiviteit), { activiteit: 0, vervoer: 226, totaal: 226 });
  assert.deepEqual(bedrag(v, profiel(true, true, true)), { activiteit: 0, vervoer: 0, totaal: 0 });
});

Deno.test("een oproep die niet klopt, is een fout: nooit een stil bedrag", () => {
  assert.throws(() => verdeel({ activiteit: { gedeeld: -1, aangerekend: 3 } }), RangeError);
  assert.throws(() => verdeel({ activiteit: { gedeeld: 10.5, aangerekend: 3 } }), RangeError);
  assert.throws(() => verdeel({ activiteit: { gedeeld: 100, aangerekend: 2.5 } }), RangeError);
  assert.throws(() => verdeel({ activiteit: { perKind: 100, aangerekend: 3, betalers: 4 } }), RangeError);
  assert.throws(() => verdeel({ activiteit: { gedeeld: "100", aangerekend: 3 } }), RangeError);
  assert.throws(() => bedrag({ activiteit: {}, vervoer: {} }, AANWEZIG), RangeError);
  const v = verdeel({ activiteit: { gedeeld: 1000, aangerekend: 4 } });
  // De groepen moeten samen precies de aangerekende leerlingen zijn: anders klopt geen enkele som.
  assert.throws(() => totalen(v, [{ profiel: AANWEZIG, aantal: 3 }]), RangeError);
  assert.throws(() => totalen(v, null), RangeError);
  assert.throws(() => verdeelCorrectie(-100, 0), RangeError);
  assert.throws(() => plafondStand(100, -1), RangeError);
  assert.throws(() => jaarStand([{ cent: 100, soort: "iets" }], 11000), RangeError);
  assert.throws(() => standBedrag({ alleKlassenBevestigd: true, factuurActiviteit: "misschien" }), RangeError);
});

Deno.test("een verdeling is gewone, vaste gegevens: te bewaren als JSON, niet te wijzigen", () => {
  const v = verdeel({ activiteit: { gedeeld: 1000, aangerekend: 3, tussenkomstTotaal: 100 }, vervoer: { gedeeld: 500, aangerekend: 3 } });
  assert.ok(Object.isFrozen(v) && Object.isFrozen(v.activiteit) && Object.isFrozen(v.overschot));
  assert.deepEqual(JSON.parse(JSON.stringify(v)), {
    activiteit: { bestaat: true, bekend: true, kost: 1000, tussenkomst: 100, aangerekend: 3, betalers: 0 },
    vervoer: { bestaat: true, bekend: true, kost: 500, tussenkomst: 0, aangerekend: 3, betalers: 0 },
    volledig: true,
    overschot: { vanActiviteit: 0, vanVervoer: 0, terugActiviteit: 0, terugVervoer: 0, rest: 0 },
  });
});

// ---------- G21: de controle over alle gevallen ----------

// Een eigen, eenvoudige breuk voor de test: bewust niet die van rekenen.js.
class Breuk {
  constructor(t, n = 1n) {
    this.t = BigInt(t);
    this.n = BigInt(n);
  }
  plus(b) { return new Breuk(this.t * b.n + b.t * this.n, this.n * b.n); }
  min(b) { return new Breuk(this.t * b.n - b.t * this.n, this.n * b.n); }
  maal(b) { return new Breuk(this.t * b.t, this.n * b.n); }
  door(b) { return new Breuk(this.t * b.n, this.n * b.t); }
  kleinerDan(b) { return this.t * b.n < b.t * this.n; }
  get nul() { return this.t === 0n; }
}
const B = (x) => new Breuk(x);
const kleinsteVan = (a, b) => (b.kleinerDan(a) ? b : a);
const nooitNegatief = (a) => (a.kleinerDan(B(0)) ? B(0) : a);

/**
 * Eén onderdeel op zich, volgens 1.16, leerling per leerling. leerlingen: [{ a, p }]: aangerekend, en
 * betaalt de prijs per kind. Geeft wat elke leerling exact betaalt na de tussenkomst per kind (e), de som
 * daarvan (K), wat er na de eigen tussenkomst als totaal nog te betalen is (R), en het overschot (O).
 */
function onderdeelAlleen(o, leerlingen) {
  const A = leerlingen.filter((l) => l.a).length;
  const kost = B(o.G).plus(B(o.p * leerlingen.filter((l) => l.p).length));
  let e = leerlingen.map((l) => (l.a ? B(l.p ? o.p : 0).plus(B(o.G).door(B(A))) : B(0)));
  let O = B(0);
  if (o.t > 0 && A > 0) {
    e = e.map((deel, i) => {
      const krijgt = o.p > 0 ? leerlingen[i].p : leerlingen[i].a;
      if (!krijgt) return deel;
      O = O.plus(nooitNegatief(B(o.t).min(deel)));
      return nooitNegatief(deel.min(B(o.t)));
    });
  }
  const K = A > 0 ? e.reduce((som, deel) => som.plus(deel), B(0)) : kost;
  const eigen = kleinsteVan(B(o.T), K);
  return { e, K, R: K.min(eigen), O: O.plus(B(o.T).min(eigen)) };
}

/**
 * Beide onderdelen samen: het overschot gaat eerst naar het andere onderdeel (B102); wat dat niet kan
 * opnemen, keert terug naar het eigen onderdeel (B221); wat dan nog overblijft, is de rest.
 */
function exactSamen(x, y) {
  const binnenX = kleinsteVan(y.O, x.R);
  const binnenY = kleinsteVan(x.O, y.R);
  const terugX = kleinsteVan(x.O.min(binnenY), x.R.min(binnenX));
  const terugY = kleinsteVan(y.O.min(binnenX), y.R.min(binnenY));
  const maak = (z, binnen, terug) => {
    const blijft = z.R.min(binnen).min(terug);
    return { delen: z.e.map((deel) => (z.K.nul ? B(0) : deel.maal(blijft.door(z.K)))), blijft };
  };
  return { x: maak(x, binnenX, terugX), y: maak(y, binnenY, terugY), rest: x.O.min(binnenY).min(terugX).plus(y.O.min(binnenX).min(terugY)) };
}

Deno.test("G21: elk bedrag wijkt hoogstens een halve cent af van het exacte deel, en het vervoer is nooit negatief", () => {
  const kies = reeks(20261116);
  const bedragOfNul = (max) => (kies(4) === 0 ? 0 : kies(max) + 1);
  let metTerug = 0;
  let metRest = 0;
  for (let ronde = 0; ronde < 4000; ronde++) {
    const n = kies(60) + 1;
    // Per leerling en per onderdeel: aangerekend, en betaalt hij de prijs per kind?
    const leerlingen = Array.from({ length: n }, () => {
      const soort = kies(10);
      const a = soort > 0;                   // 1 op 10 heeft een attest
      const p = a && soort > 2;              // 2 op 10 zijn aangerekend, maar afwezig
      const andersVoorVervoer = kies(12) === 0;
      return { activiteit: { a, p }, vervoer: andersVoorVervoer ? { a: !a, p: false } : { a, p: a && kies(3) > 0 } };
    });
    // Eén ronde op vijf met kleine bedragen en vaak een tussenkomst per kind: dan is die geregeld groter dan
    // wat een kind betaalt, en kan het andere onderdeel het overschot niet altijd opnemen (B221).
    const klein = kies(5) === 0;
    const onderdeel = (naam) => {
      const metPrijsPerKind = kies(2) === 0;
      const o = klein
        ? { G: bedragOfNul(3000), p: metPrijsPerKind ? kies(800) + 1 : 0, T: kies(4) === 0 ? kies(3000) : 0, t: kies(2) === 0 ? kies(2000) + 1 : 0 }
        : { G: bedragOfNul(250000), p: metPrijsPerKind ? kies(4000) + 1 : 0, T: kies(3) === 0 ? kies(300000) : 0, t: kies(5) === 0 ? kies(1500) + 1 : 0 };
      const lln = leerlingen.map((l) => ({ a: l[naam].a, p: l[naam].a && metPrijsPerKind && l[naam].p }));
      return { o, lln };
    };
    const act = onderdeel("activiteit");
    const verv = onderdeel("vervoer");
    const invoer = (x) => ({
      gedeeld: x.o.G, perKind: x.o.p, tussenkomstTotaal: x.o.T, tussenkomstPerKind: x.o.t,
      aangerekend: x.lln.filter((l) => l.a).length, betalers: x.lln.filter((l) => l.p).length,
    });
    const v = verdeel({ activiteit: invoer(act), vervoer: invoer(verv) });

    // Het exacte deel, los van rekenen.js: eerst elk onderdeel op zich, dan beide samen.
    const exact = exactSamen(onderdeelAlleen(act.o, act.lln), onderdeelAlleen(verv.o, verv.lln));
    const exactAct = exact.x;
    const exactVerv = exact.y;

    const waar = "ronde " + ronde + ": " + JSON.stringify({ activiteit: invoer(act), vervoer: invoer(verv) });
    let somExact = B(0);
    let somOuders = 0n;
    for (let i = 0; i < n; i++) {
      const wie = { activiteit: { aangerekend: act.lln[i].a, perKind: act.lln[i].p }, vervoer: { aangerekend: verv.lln[i].a, perKind: verv.lln[i].p } };
      const b = bedrag(v, wie);
      const exact = exactAct.delen[i].plus(exactVerv.delen[i]);
      // |totaal − exact| ≤ 1/2  ⇔  |2·(totaal·n − t)| ≤ n
      let verschil = 2n * (BigInt(b.totaal) * exact.n - exact.t);
      if (verschil < 0n) verschil = -verschil;
      const noemer = exact.n < 0n ? -exact.n : exact.n;
      assert.ok(verschil <= noemer, waar + ": leerling " + i + " betaalt " + b.totaal + ", exact " + exact.t + "/" + exact.n);
      assert.ok(b.activiteit >= 0 && b.vervoer >= 0, waar + ": een negatief bedrag op de fiche");
      assert.equal(b.activiteit + b.vervoer, b.totaal, waar + ": de lijnen tellen niet op");
      somExact = somExact.plus(exact);
      somOuders += BigInt(b.totaal);
    }
    // Samen wijken de ouders hoogstens een halve cent per leerling af van wat exact te betalen is.
    let samen = 2n * (somOuders * somExact.n - somExact.t);
    if (samen < 0n) samen = -samen;
    assert.ok(samen <= BigInt(n) * (somExact.n < 0n ? -somExact.n : somExact.n), waar + ": de som wijkt te veel af");
    // Wat exact te betalen is, is de kost na de tussenkomsten: er verdwijnt niets en er komt niets bij.
    const kostNa = (x, deel) => (x.lln.some((l) => l.a) ? deel.blijft : B(0));
    const verwacht = kostNa(act, exactAct).plus(kostNa(verv, exactVerv));
    assert.ok(somExact.min(verwacht).nul, waar + ": de exacte delen tellen niet op tot de kost na de tussenkomsten");
    // Een tussenkomst blijft nooit ongebruikt zolang er nog iets te betalen is (B219, B221): blijft er
    // een rest, dan kost geen enkel onderdeel nog iets, en betaalt geen enkele leerling nog iets.
    if (!exact.rest.nul) {
      assert.ok(exactAct.blijft.nul && exactVerv.blijft.nul && somExact.nul && somOuders === 0n, waar + ": er blijft een rest terwijl er nog iets te betalen is");
    }
    // De rest die rekenen.js meldt, is die rest, afgerond op de cent.
    let restVerschil = 2n * (BigInt(v.overschot.rest) * exact.rest.n - exact.rest.t);
    if (restVerschil < 0n) restVerschil = -restVerschil;
    assert.ok(restVerschil <= (exact.rest.n < 0n ? -exact.rest.n : exact.rest.n), waar + ": de rest is " + v.overschot.rest + ", exact " + exact.rest.t + "/" + exact.rest.n);
    if (v.overschot.terugActiviteit + v.overschot.terugVervoer > 0) metTerug++;
    if (v.overschot.rest > 0) metRest++;
  }
  // De willekeurige gevallen raken ook echt wat ze moeten nakijken: een overschot dat terugkeert, en een rest.
  assert.ok(metTerug >= 40 && metRest >= 40, "te weinig gevallen met een overschot dat terugkeert (" + metTerug + ") of met een rest (" + metRest + ")");
});

Deno.test("G21: de sommen van een activiteit kloppen met de kost, de tussenkomsten en de bedragen per leerling", () => {
  const kies = reeks(424242);
  for (let ronde = 0; ronde < 1500; ronde++) {
    const aanwezig = kies(40);
    const afwezig = kies(5);
    const attest = kies(4);
    const A = aanwezig + afwezig;
    const invoer = {
      activiteit: { gedeeld: kies(3) ? kies(100000) : 0, perKind: kies(2) ? kies(2000) : 0, aangerekend: A, betalers: aanwezig, tussenkomstTotaal: kies(4) ? 0 : kies(50000) },
      vervoer: { gedeeld: kies(60000), aangerekend: A, tussenkomstTotaal: kies(5) ? 0 : kies(30000) },
    };
    const v = verdeel(invoer);
    const groepen = [{ profiel: AANWEZIG, aantal: aanwezig }, { profiel: ENKEL_GEDEELD, aantal: afwezig }, { profiel: NIET_AANGEREKEND, aantal: attest }];
    const t = totalen(v, groepen);
    const waar = "ronde " + ronde + ": " + JSON.stringify(invoer);
    assert.equal(t.kost, invoer.activiteit.gedeeld + invoer.activiteit.perKind * aanwezig + invoer.vervoer.gedeeld, waar);
    assert.equal(t.ouders, aanwezig * bedrag(v, AANWEZIG).totaal + afwezig * bedrag(v, ENKEL_GEDEELD).totaal, waar);
    assert.equal(t.school, t.kost - t.tussenkomst - t.ouders, waar);
    assert.ok(t.tussenkomst <= t.kost, waar + ": de tussenkomsten dragen meer dan de kost");
    // Zonder attesten voor iedereen is wat de school draagt enkel het afrondingsverschil: hoogstens een halve
    // cent per aangerekende leerling, plus één cent voor de afronding van de som van de tussenkomsten.
    if (A > 0) assert.ok(Math.abs(t.school) <= A / 2 + 1, waar + ": de school draagt " + t.school);
    else assert.equal(t.school, t.kost - t.tussenkomst, waar);
  }
});

Deno.test("G21: het aanrekenbare bedrag is nooit hoger dan het plafond, en nooit hoger dan de werkelijke kost", () => {
  const kies = reeks(7);
  for (let ronde = 0; ronde < 5000; ronde++) {
    const plafond = [5500, 11000, 56000][kies(3)];
    const werkelijk = kies(2 * plafond + 2);
    const s = plafondStand(werkelijk, plafond);
    assert.ok(s.aanrekenbaar <= plafond && s.aanrekenbaar <= werkelijk);
    assert.equal(s.aanrekenbaar + s.school, werkelijk);
    assert.equal(s.label, werkelijk > plafond ? "boven" : werkelijk === plafond ? "op" : "onder");
    assert.equal(s.ruimte, Math.max(0, plafond - werkelijk));
  }
  // Eén cent boven het plafond is "boven"; de marge speelt hier niet mee (B100).
  assert.equal(plafondStand(11001, 11000).label, "boven");
  assert.equal(plafondStand(10999, 11000).label, "onder");
  // Een jaartotaal onder nul, door een credit: aanrekenbaar is dan dat bedrag, en de school draagt niets.
  assert.deepEqual(plafondStand(-250, 11000), { werkelijk: -250, aanrekenbaar: -250, school: 0, ruimte: 11250, label: "onder" });
});

// ---------- De aantallen en de profielen ----------

Deno.test("de aantallen uit de lijsten: daguitstap, \"ook de prijs per kind\" en meerdaags (1.2, 1.2b)", () => {
  const lijsten = [{ deelnemers: 23, aangerekend: 22, aanwezig: 21 }, { deelnemers: 22, aangerekend: 21, aanwezig: 20 }];
  assert.deepEqual(aantallen(lijsten), { aangerekend: 43, betalers: 41 });
  assert.deepEqual(aantallen(lijsten, { iedereenBetaalt: true }), { aangerekend: 43, betalers: 43 });
  // Bij een meerdaagse betaalt elke deelnemer zijn deel, ongeacht attesten (B112).
  assert.deepEqual(aantallen(lijsten, { meerdaags: true }), { aangerekend: 45, betalers: 45 });
  assert.deepEqual(aantallen([]), { aangerekend: 0, betalers: 0 });
  assert.throws(() => aantallen([{ aangerekend: -1, aanwezig: 0 }]), RangeError);
  // Een aantal dat ontbreekt, is nooit stil nul.
  assert.throws(() => aantallen([{ aangerekend: 5 }]), RangeError);
  assert.throws(() => aantallen([{ deelnemers: 5, aangerekend: 5, aanwezig: 5 }], { annulering: true }), RangeError);
  // Annuleringskosten doorrekenen: gedeeld over wie de beheerder bevestigde, zonder prijs per kind (1.7, G6b).
  const geannuleerd = [{ deelnemers: 26, aangerekend: 26, aanwezig: 26, annulering_betalers: 26 }, { deelnemers: 20, aangerekend: 20, aanwezig: 20, annulering_betalers: 0 }];
  assert.deepEqual(aantallen(geannuleerd, { annulering: true }), { aangerekend: 26, betalers: 0 });
  const g6b = verdeel({ activiteit: { gedeeld: 7500, aangerekend: 26 }, vervoer: { gedeeld: 6000, aangerekend: aantallen(geannuleerd, { annulering: true }).aangerekend } });
  assert.deepEqual(bedrag(g6b, AANWEZIG), { activiteit: 288, vervoer: 231, totaal: 519 });
});

Deno.test("het profiel van een leerling volgt uit zijn status (B19, B22, B109, B112)", () => {
  const deel = (aangerekend, perKind, school = false) => ({ aangerekend, perKind, school });
  assert.deepEqual(profielVan({}).activiteit, deel(true, true));
  assert.deepEqual(profielVan({ aanwezig: false }).activiteit, deel(true, false));                           // briefje ouders, enkel gedeelde kosten
  assert.deepEqual(profielVan({ aanwezig: false }, { iedereenBetaalt: true }).activiteit, deel(true, true)); // "ook de prijs per kind"
  assert.deepEqual(profielVan({ aangerekend: false, aanwezig: false }).activiteit, deel(false, false));      // attest
  assert.deepEqual(profielVan({ aangerekend: false, aanwezig: false }, { iedereenBetaalt: true }).activiteit, deel(false, false)); // nooit wie een attest heeft (B166)
  assert.deepEqual(profielVan({ neemtDeel: false }).activiteit, deel(false, false));                         // op de lijst, maar niet mee
  assert.deepEqual(profielVan({ neemtDeel: false }, { meerdaags: true }).activiteit, deel(false, false));    // uitgevinkt (B109)
  assert.deepEqual(profielVan({ aangerekend: false, aanwezig: false }, { meerdaags: true }).activiteit, deel(true, true)); // attest bij een meerdaagse: toch zijn deel (B112)
  assert.deepEqual(profielVan({ school: true }, { meerdaags: true }).vervoer, deel(true, true, true));
  assert.equal(profielVan({ neemtDeel: false }), NIET_AANGEREKEND);
});

Deno.test("het jaartotaal van een leerling: wat telt, wat een raming is en wat enkel apart staat (1.11)", () => {
  const stand = jaarStand([
    { cent: 1980, soort: "definitief" }, { cent: 1840, soort: "voorlopig" }, { cent: -1460, soort: "definitief" }, { cent: 3250, soort: "raming" },
    { cent: 9000, soort: "aangevraagd" }, { cent: null, soort: "voorlopig" },
  ], 5500);
  assert.equal(stand.definitief, 520);
  assert.equal(stand.voorlopig, 1840);
  assert.equal(stand.raming, 3250);
  assert.equal(stand.aangevraagd, 9000);
  assert.equal(stand.onbekend, 1);
  assert.equal(stand.nu.werkelijk, 2360);
  assert.equal(stand.nu.label, "onder");
  assert.deepEqual(stand.prognose, { werkelijk: 5610, aanrekenbaar: 5500, school: 110, ruimte: 0, label: "boven" });
});

Deno.test("de stand van een bedrag: vanzelf, met de redenen (1.8)", () => {
  assert.deepEqual(standBedrag({ alleKlassenBevestigd: true, factuurActiviteit: "ontvangen", factuurVervoer: "nvt" }), { stand: "definitief", redenen: [] });
  assert.deepEqual(standBedrag({ alleKlassenBevestigd: true }), { stand: "definitief", redenen: [] });  // een beurt van een lopende activiteit (F10)
  assert.deepEqual(standBedrag({ alleKlassenBevestigd: true, gefactureerd: true }), { stand: "gefactureerd", redenen: [] });
  assert.deepEqual(standBedrag({ alleKlassenBevestigd: false, openAanvraag: true, prijzenGekend: false, factuurActiviteit: "teontvangen", factuurVervoer: "teontvangen", gefactureerd: true }),
    { stand: "voorlopig", redenen: ["aanwezigheden", "aanvraag", "prijs", "factuur_activiteit", "factuur_vervoer"] });
});

// ---------- Kalenderdatums, zonder klok en zonder tijdzone ----------

Deno.test("datums: een bestaande kalenderdatum, de dag erna en het schooljaar", () => {
  for (const goed of ["2026-09-01", "2027-02-28", "2028-02-29", "2000-02-29", "2026-12-31"]) assert.ok(isDatum(goed), goed);
  for (const fout of ["2027-02-29", "2100-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-9-1", "01/09/2026", "", null, 20260901, "2026-09-01T00:00:00Z"]) assert.ok(!isDatum(fout), String(fout));
  assert.equal(dagNa("2027-01-17"), "2027-01-18");
  assert.equal(dagNa("2026-12-31"), "2027-01-01");
  assert.equal(dagNa("2027-02-28"), "2027-03-01");
  assert.equal(dagNa("2028-02-28"), "2028-02-29");
  assert.equal(dagNa("2028-02-29"), "2028-03-01");
  assert.equal(dagNa("2027-03-27"), "2027-03-28");  // de nacht van het zomeruur: geen dag over of te weinig
  assert.equal(dagNa("2026-10-24"), "2026-10-25");  // de nacht van het winteruur
  assert.equal(dagNa("2026-10-25"), "2026-10-26");
  assert.equal(schooljaarVan("2026-09-01"), "2026-2027");
  assert.equal(schooljaarVan("2027-08-31"), "2026-2027");
  assert.equal(schooljaarVan("2026-08-31"), "2025-2026");
  assert.throws(() => dagNa("2027-02-30"), RangeError);
  assert.throws(() => schooljaarVan("morgen"), RangeError);
});

Deno.test("klasperioden: van een dag tot vóór een dag; een ongeldige datum is een fout", () => {
  const perioden = [{ klas: "3A", van: "2026-09-01", einde: "2027-01-19" }, { klas: "3B", van: "2027-01-19", einde: "2027-09-01" }];
  assert.equal(periodeOp(perioden, "2026-08-31"), null);
  assert.equal(periodeOp(perioden, "2026-09-01").klas, "3A");
  assert.equal(periodeOp(perioden, "2027-01-18").klas, "3A");
  assert.equal(periodeOp(perioden, "2027-01-19").klas, "3B");
  assert.equal(periodeOp(perioden, "2027-08-31").klas, "3B");
  assert.equal(periodeOp(perioden, "2027-09-01"), null);
  assert.equal(periodeOp([], "2027-01-19"), null);
  assert.throws(() => periodeOp(perioden, "19/01/2027"), RangeError);
  assert.throws(() => periodeOp([{ van: "2026-09-01", einde: null }], "2027-01-19"), RangeError);
});

Deno.test("schoolverlater: de laatste periode beslist, en de beheerder kan afwijken (B99, B101, B157)", () => {
  const zesde = [{ van: "2026-09-01", tot: null, leerjaar: 6 }];
  const vertrokken = [{ van: "2026-09-01", tot: "2027-04-01", leerjaar: 2 }];
  const terug = [{ van: "2027-01-11", tot: null, leerjaar: 3 }, { van: "2026-09-01", tot: "2026-11-14", leerjaar: 3 }];
  assert.equal(isSchoolverlater(zesde), true);
  assert.equal(isSchoolverlater(vertrokken), true);
  assert.equal(isSchoolverlater(terug), false, "de volgorde van de perioden speelt geen rol");
  assert.equal(isSchoolverlater([{ van: "2026-09-01", tot: null, leerjaar: null }]), false);  // een kleuter die blijft
  assert.equal(isSchoolverlater(zesde, false), false);  // doet het 6de leerjaar over
  assert.equal(isSchoolverlater(terug, true), true);
  assert.equal(isSchoolverlater([]), false);
});

Deno.test("de rekenversie is een geheel getal vanaf 1", () => {
  assert.ok(Number.isInteger(REKENVERSIE) && REKENVERSIE >= 1);
});
