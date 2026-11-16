// MT · rekentest.js · versie 0.7.1
// De testgevallen van het rekencontract (mt-rekencontract.md, versie 19, deel 2), met het verwachte en
// het berekende bedrag: de testpagina van 17.1. Wat hier staat, is fase 1: A1, A2, A6, G1 tot G9,
// G11a, G11c, G12 en G18 tot G20. De gevallen van de facturatie en de voorschotten volgen in fase 2,
// die van de meerdaagse uitstappen in fase 3. De controle over alle gevallen (G21) draait met
// willekeurige bedragen in de automatische tests (tests/rekenen_test.js).
//
// De automatische tests en de testpagina lopen door dezelfde lijst: wat de pagina toont, is wat de
// tests nagaan. Alle namen en bedragen zijn verzonnen, zoals in het rekencontract.
//
// Bovenaan staat wat zonder browser te testen valt; daaronder het scherm zelf.

import {
  AANWEZIG, aantallen, afronden, bedrag, dagNa, ENKEL_GEDEELD, inGratisZwemjaar, isSchoolverlater, leerjaarVan, NIET_AANGEREKEND, niveauVan, periodeOp,
  plafondStand, plafondVoor, profiel, profielVan, REKENVERSIE, standBedrag, totalen, verdeel, verdeelCorrectie,
} from "./rekenen.js";
import { euro, html, zet } from "./ui.js";

export const VERSIE = "0.7.1";

// ---------- Zonder browser te testen ----------

const gelijk = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Een controle op bedragen, in centen: een getal, of een object met getallen. null is "onbekend". */
const geld = (wat, berekend, verwacht) => ({ wat, soort: "geld", berekend, verwacht, ok: gelijk(berekend, verwacht) });
/** Een controle op iets anders dan een bedrag: een woord, ja of nee, een aantal. */
const feit = (wat, berekend, verwacht) => ({ wat, soort: "feit", berekend, verwacht, ok: gelijk(berekend, verwacht) });
const bedragen = (activiteit, vervoer, totaal) => ({ activiteit, vervoer, totaal });
const NIETS = bedragen(0, 0, 0);
const sommen = (ouders, kost, tussenkomst, school) => ({ ouders, kost, tussenkomst, school });

/** De lijst: per geval het nummer, de titel, de regels van het contract en de controles. */
const LIJST = [
  ["A1", "€ 10 activiteit en € 10 bus, drie aangerekende leerlingen", "1.1, 1.4", () => {
    const v = verdeel({ activiteit: { gedeeld: 1000, aangerekend: 3 }, vervoer: { gedeeld: 1000, aangerekend: 3 } });
    return [
      geld("Elke leerling: 20,00 / 3 = 6,666… wordt € 6,67; het vervoer is het verschil", bedrag(v, AANWEZIG), bedragen(333, 334, 667)),
      geld("Samen € 20,01: de ouders betalen € 0,01 meer dan de kost", totalen(v, [{ profiel: AANWEZIG, aantal: 3 }]), sommen(2001, 2000, 0, -1)),
    ];
  }],
  ["A2", "38 aanwezig, twee aangerekende afwezigen; ticket € 8, enkel gedeelde kosten; bus € 200", "1.4", () => {
    const v = verdeel({ activiteit: { perKind: 800, aangerekend: 40, betalers: 38 }, vervoer: { gedeeld: 20000, aangerekend: 40 } });
    return [
      geld("Aanwezig: € 8,00 + € 5,00", bedrag(v, AANWEZIG), bedragen(800, 500, 1300)),
      geld("Aangerekend afwezig: geen ticket, enkel de bus", bedrag(v, ENKEL_GEDEELD), bedragen(0, 500, 500)),
      geld("De tickets (€ 304,00) en de bus (€ 200,00) sluiten aan", totalen(v, [{ profiel: AANWEZIG, aantal: 38 }, { profiel: ENKEL_GEDEELD, aantal: 2 }]), sommen(50400, 50400, 0, 0)),
    ];
  }],
  ["A6", "Nul aangerekende leerlingen, bekende kost", "1.4", () => {
    const v = verdeel({ activiteit: { gedeeld: 6600, aangerekend: 0 }, vervoer: { gedeeld: 14000, aangerekend: 0 } });
    return [
      geld("Geen factuur en geen fout", bedrag(v, NIET_AANGEREKEND), NIETS),
      geld("De kost is zichtbaar voor de school", totalen(v, [{ profiel: NIET_AANGEREKEND, aantal: 22 }]), sommen(0, 20600, 0, 20600)),
    ];
  }],
  ["G1", "Gewone uitstap: activiteit en bus", "1.1 tot 1.4", () => {
    const kost = (aangerekend) => verdeel({ activiteit: { gedeeld: 18750, aangerekend }, vervoer: { gedeeld: 24500, aangerekend } });
    const raming = kost(23);
    const na = kost(21);
    const halve = verdeel({ activiteit: { gedeeld: 19650, aangerekend: 20 } });
    return [
      geld("a. Raming op 23 leerlingen: 432,50 / 23 = 18,804…", bedrag(raming, AANWEZIG), bedragen(815, 1065, 1880)),
      geld("a. Samen € 432,40: de school draagt € 0,10", totalen(raming, [{ profiel: AANWEZIG, aantal: 23 }]), sommen(43240, 43250, 0, 10)),
      geld("b. 21 aangerekend, aanwezig: 432,50 / 21 = 20,5952…, boven de halve cent", bedrag(na, AANWEZIG), bedragen(893, 1167, 2060)),
      geld("b. Briefje ouders of ongewettigd afwezig: hetzelfde bedrag", bedrag(na, ENKEL_GEDEELD), bedragen(893, 1167, 2060)),
      geld("b. Attest", bedrag(na, NIET_AANGEREKEND), NIETS),
      geld("b. Samen € 432,60: de ouders betalen € 0,10 meer dan de kost",
        totalen(na, [{ profiel: AANWEZIG, aantal: 19 }, { profiel: ENKEL_GEDEELD, aantal: 2 }, { profiel: NIET_AANGEREKEND, aantal: 2 }]), sommen(43260, 43250, 0, -10)),
      geld("c. \"Nog te bepalen\" telt voorlopig mee: dezelfde bedragen", bedrag(na, profielVan({ aangerekend: true, aanwezig: false })), bedragen(893, 1167, 2060)),
      feit("c. De stand blijft voorlopig: 4A kan niet bevestigd worden",
        standBedrag({ alleKlassenBevestigd: false, factuurActiviteit: "ontvangen", factuurVervoer: "ontvangen" }).stand, "voorlopig"),
      geld("d. Precies op de halve cent: 196,50 / 20 = 9,825 wordt € 9,82", bedrag(halve, AANWEZIG), bedragen(982, 0, 982)),
      geld("d. Samen € 196,40: de school draagt € 0,10", totalen(halve, [{ profiel: AANWEZIG, aantal: 20 }]), sommen(19640, 19650, 0, 10)),
    ];
  }],
  ["G2", "Prijs per kind, twee klassen samen", "1.4", () => {
    // De totalen per lijst, zoals de databank ze geeft: 4A (21 aanwezig, 1 briefje ouders, 1 attest) en 4B (20 aanwezig, 1 ongewettigd, 1 attest).
    const lijsten = [{ deelnemers: 23, aangerekend: 22, aanwezig: 21 }, { deelnemers: 22, aangerekend: 21, aanwezig: 20 }];
    const enkel = aantallen(lijsten, { iedereenBetaalt: false });
    const ook = aantallen(lijsten, { iedereenBetaalt: true });
    const kost = (n) => verdeel({ activiteit: { perKind: 750, aangerekend: n.aangerekend, betalers: n.betalers }, vervoer: { gedeeld: 31000, aangerekend: n.aangerekend } });
    const a = kost(enkel);
    const b = kost(ook);
    return [
      feit("De aantallen uit de lijsten: 43 aangerekend, 41 betalen de prijs per kind", enkel, { aangerekend: 43, betalers: 41 }),
      geld("a. Enkel gedeelde kosten, aanwezig: 7,50 + 310,00 / 43", bedrag(a, AANWEZIG), bedragen(750, 721, 1471)),
      geld("a. Briefje ouders (4A), ongewettigd afwezig (4B): enkel het vervoer", bedrag(a, profielVan({ aanwezig: false }, { iedereenBetaalt: false })), bedragen(0, 721, 721)),
      geld("a. Attest", bedrag(a, profielVan({ aangerekend: false, aanwezig: false })), NIETS),
      geld("a. Vervoer 43 × € 7,21 = € 310,03; activiteit 41 × € 7,50 = € 307,50",
        totalen(a, [{ profiel: AANWEZIG, aantal: 41 }, { profiel: ENKEL_GEDEELD, aantal: 2 }, { profiel: NIET_AANGEREKEND, aantal: 2 }]), sommen(61753, 61750, 0, -3)),
      feit("b. \"Ook de prijs per kind\": 43 betalen de prijs per kind", ook, { aangerekend: 43, betalers: 43 }),
      geld("b. Briefje ouders, ongewettigd afwezig: zoals aanwezig", bedrag(b, profielVan({ aanwezig: false }, { iedereenBetaalt: true })), bedragen(750, 721, 1471)),
      geld("b. Activiteit 43 × € 7,50 = € 322,50", totalen(b, [{ profiel: AANWEZIG, aantal: 43 }, { profiel: NIET_AANGEREKEND, aantal: 2 }]), sommen(63253, 63250, 0, -3)),
    ];
  }],
  ["G3", "Exclusief voorschot", "1.3, 1.4", () => {
    const groep = [{ profiel: AANWEZIG, aantal: 22 }, { profiel: ENKEL_GEDEELD, aantal: 1 }, { profiel: NIET_AANGEREKEND, aantal: 1 }];
    const excl = verdeel({ activiteit: { gedeeld: 42000 + 8000, aangerekend: 23 } });
    const incl = verdeel({ activiteit: { gedeeld: 42000, aangerekend: 23 } });
    const perKind = verdeel({ activiteit: { perKind: 900, gedeeld: 5000, aangerekend: 23, betalers: 21 } });
    return [
      geld("a. Exclusief: (420,00 + 80,00) / 23 = 21,739…", bedrag(excl, AANWEZIG), bedragen(2174, 0, 2174)),
      geld("a. Exclusief: de ouders betalen samen € 0,02 meer", totalen(excl, groep), sommen(50002, 50000, 0, -2)),
      geld("a. Inclusief: 420,00 / 23 = 18,260…", bedrag(incl, AANWEZIG), bedragen(1826, 0, 1826)),
      geld("a. Inclusief: de school draagt € 0,02", totalen(incl, groep), sommen(41998, 42000, 0, 2)),
      geld("a. Attest", bedrag(excl, NIET_AANGEREKEND), NIETS),
      geld("b. Prijs per kind, aanwezig: 9,00 + 50,00 / 23 = 11,173…", bedrag(perKind, AANWEZIG), bedragen(1117, 0, 1117)),
      geld("b. Briefje ouders, ongewettigd afwezig: enkel het voorschot", bedrag(perKind, ENKEL_GEDEELD), bedragen(217, 0, 217)),
      geld("b. De ouders betalen € 238,91 van € 239,00: de school draagt € 0,09",
        totalen(perKind, [{ profiel: AANWEZIG, aantal: 21 }, { profiel: ENKEL_GEDEELD, aantal: 2 }, { profiel: NIET_AANGEREKEND, aantal: 1 }]), sommen(23891, 23900, 0, 9)),
    ];
  }],
  ["G4", "Niemand aangerekend", "1.4", () => {
    const v = verdeel({ activiteit: { gedeeld: 6600, aangerekend: 0 }, vervoer: { gedeeld: 14000, aangerekend: 0 } });
    const perKind = verdeel({ activiteit: { perKind: 300, aangerekend: 0, betalers: 0 }, vervoer: { gedeeld: 14000, aangerekend: 0 } });
    return [
      geld("Alle 22 met een attest: geen deling door nul", bedrag(v, NIET_AANGEREKEND), NIETS),
      geld("De volle € 206,00 is voor de school", totalen(v, [{ profiel: NIET_AANGEREKEND, aantal: 22 }]), sommen(0, 20600, 0, 20600)),
      geld("Met een prijs per kind van € 3,00 en niemand aanwezig", bedrag(perKind, NIET_AANGEREKEND), NIETS),
    ];
  }],
  ["G5", "Tussenkomst", "1.5", () => {
    const basis = { activiteit: { perKind: 400, aangerekend: 47, betalers: 46 }, vervoer: { gedeeld: 33000, aangerekend: 47 } };
    const groep = [{ profiel: AANWEZIG, aantal: 46 }, { profiel: ENKEL_GEDEELD, aantal: 1 }, { profiel: NIET_AANGEREKEND, aantal: 2 }];
    const a = verdeel({ ...basis, vervoer: { ...basis.vervoer, tussenkomstTotaal: 20000 } });
    const b = verdeel({ ...basis, vervoer: { ...basis.vervoer, tussenkomstTotaal: 35000 } });
    const c = verdeel({ ...basis, activiteit: { ...basis.activiteit, tussenkomstPerKind: 100 } });
    const cTotaal = verdeel({ ...basis, activiteit: { ...basis.activiteit, tussenkomstTotaal: 4600 } });
    const d = { perKind: 900, gedeeld: 5000, aangerekend: 23, betalers: 21 };
    const dPerKind = verdeel({ activiteit: { ...d, tussenkomstPerKind: 100 } });
    const dTotaal = verdeel({ activiteit: { ...d, tussenkomstTotaal: 2100 } });
    const e = verdeel({ activiteit: { perKind: 300, aangerekend: 25, betalers: 24, tussenkomstPerKind: 400 }, vervoer: { gedeeld: 25000, aangerekend: 25 } });
    const f = verdeel({ activiteit: { gedeeld: 10000, aangerekend: 21, tussenkomstTotaal: 15000 }, vervoer: { gedeeld: 30000, aangerekend: 21, tussenkomstTotaal: 6000 } });
    // g: toegang € 6,00 per kind en een gids van € 50,00; 20 aangerekend, van wie 10 aanwezig; € 10,00 per kind (B219, B221).
    const g = { gedeeld: 5000, perKind: 600, tussenkomstPerKind: 1000, aangerekend: 20, betalers: 10 };
    const gGroep = [{ profiel: AANWEZIG, aantal: 10 }, { profiel: ENKEL_GEDEELD, aantal: 10 }];
    const gZonder = verdeel({ activiteit: g });
    const gKleineBus = verdeel({ activiteit: g, vervoer: { gedeeld: 1000, aangerekend: 20 } });
    const gGroteBus = verdeel({ activiteit: g, vervoer: { gedeeld: 30000, aangerekend: 20 } });
    const gIedereen = verdeel({ activiteit: { ...g, betalers: 20 } });
    return [
      geld("a. € 200,00 van de bus, aanwezig: 4,00 + (330,00 − 200,00) / 47 = 6,7659…", bedrag(a, AANWEZIG), bedragen(400, 277, 677)),
      geld("a. Briefje ouders: 2,7659…", bedrag(a, ENKEL_GEDEELD), bedragen(0, 277, 277)),
      geld("a. Het vervoer samen € 130,19: de ouders betalen € 0,19 meer", totalen(a, groep), sommen(31419, 51400, 20000, -19)),
      geld("b. € 350,00 voor een bus van € 330,00, aanwezig: 4,00 − 20,00 / 46 = 3,5652…", bedrag(b, AANWEZIG), bedragen(357, 0, 357)),
      geld("b. Briefje ouders", bedrag(b, ENKEL_GEDEELD), NIETS),
      geld("b. Het overschot van € 20,00 gaat naar de activiteit; er blijft niets over", b.overschot, { vanActiviteit: 0, vanVervoer: 2000, terugActiviteit: 0, terugVervoer: 0, rest: 0 }),
      geld("b. Samen € 164,22: de ouders betalen € 0,22 meer", totalen(b, groep), sommen(16422, 51400, 35000, -22)),
      geld("c. € 1,00 per kind voor de activiteit, aanwezig: 3,00 + 330,00 / 47", bedrag(c, AANWEZIG), bedragen(300, 702, 1002)),
      geld("c. Briefje ouders: 7,021…", bedrag(c, ENKEL_GEDEELD), bedragen(0, 702, 702)),
      geld("c. Het vervoer samen € 329,94: de school draagt € 0,06", totalen(c, groep), sommen(46794, 51400, 4600, 6)),
      geld("c. Als totaal van € 46,00 is het resultaat hier hetzelfde", bedrag(cTotaal, AANWEZIG), bedragen(300, 702, 1002)),
      geld("d. € 1,00 per kind, aanwezig: 9,00 − 1,00 + 50,00 / 23 = 10,1739…", bedrag(dPerKind, AANWEZIG), bedragen(1017, 0, 1017)),
      geld("d. € 1,00 per kind, afwezig: geen ticket, dus geen korting", bedrag(dPerKind, ENKEL_GEDEELD), bedragen(217, 0, 217)),
      geld("d. € 21,00 in totaal, aanwezig: 11,1739… × 218,00 / 239,00 = 10,1921…", bedrag(dTotaal, AANWEZIG), bedragen(1019, 0, 1019)),
      geld("d. € 21,00 in totaal, afwezig: ook de afwezigen delen in de korting", bedrag(dTotaal, ENKEL_GEDEELD), bedragen(198, 0, 198)),
      geld("e. € 4,00 per kind voor een toegang van € 3,00, aanwezig: (250,00 − 24,00) / 25", bedrag(e, AANWEZIG), bedragen(0, 904, 904)),
      geld("e. Briefje ouders", bedrag(e, ENKEL_GEDEELD), bedragen(0, 904, 904)),
      geld("e. Het overschot van 24 × € 1,00 gaat als totaal naar de bus", e.overschot, { vanActiviteit: 2400, vanVervoer: 0, terugActiviteit: 0, terugVervoer: 0, rest: 0 }),
      geld("f. Tussenkomsten op beide onderdelen: (300,00 − 60,00 − 50,00) / 21 = 9,0476…", bedrag(f, AANWEZIG), bedragen(0, 905, 905)),
      geld("f. Het overschot van € 50,00 gaat van de activiteit naar de bus", f.overschot, { vanActiviteit: 5000, vanVervoer: 0, terugActiviteit: 0, terugVervoer: 0, rest: 0 }),
      geld("f. Samen € 190,05: de ouders betalen € 0,05 meer", totalen(f, [{ profiel: AANWEZIG, aantal: 21 }]), sommen(19005, 40000, 21000, -5)),
      geld("g. € 10,00 per kind, zonder vervoer, aanwezig: 8,50 − 10,00 wordt € 0,00", bedrag(gZonder, AANWEZIG), NIETS),
      geld("g. Briefje ouders: de € 15,00 die overblijft, keert terug: (25,00 − 15,00) / 10", bedrag(gZonder, ENKEL_GEDEELD), bedragen(100, 0, 100)),
      geld("g. Niets blijft ongebruikt: de € 15,00 keert terug naar de activiteit", gZonder.overschot, { vanActiviteit: 1500, vanVervoer: 0, terugActiviteit: 1500, terugVervoer: 0, rest: 0 }),
      geld("g. Samen betalen de ouders € 10,00: de kost van € 110,00 min de tussenkomst van € 100,00", totalen(gZonder, gGroep), sommen(1000, 11000, 10000, 0)),
      geld("g. Met een bus van € 10,00: de bus neemt € 10,00 op, € 5,00 keert terug; briefje ouders: (25,00 − 5,00) / 10", bedrag(gKleineBus, ENKEL_GEDEELD), bedragen(200, 0, 200)),
      geld("g. Met een bus van € 10,00: niets blijft ongebruikt", gKleineBus.overschot, { vanActiviteit: 1500, vanVervoer: 0, terugActiviteit: 500, terugVervoer: 0, rest: 0 }),
      geld("g. Met een bus van € 300,00 gaat alles naar de bus, aanwezig: (300,00 − 15,00) / 20", bedrag(gGroteBus, AANWEZIG), bedragen(0, 1425, 1425)),
      geld("g. Met een bus van € 300,00, briefje ouders: 2,50 + 14,25", bedrag(gGroteBus, ENKEL_GEDEELD), bedragen(250, 1425, 1675)),
      geld("g. Iedereen aanwezig, zonder vervoer: de tussenkomst (€ 200,00) is groter dan de kost (€ 170,00), dus € 30,00 blijft over", gIedereen.overschot, { vanActiviteit: 3000, vanVervoer: 0, terugActiviteit: 0, terugVervoer: 0, rest: 3000 }),
    ];
  }],
  ["G6", "Annulering met kosten", "1.7", () => {
    const allen = [{ profiel: AANWEZIG, aantal: 26 }];
    const niet = verdeel({ activiteit: { gedeeld: 7500, aangerekend: 0 }, vervoer: { gedeeld: 6000, aangerekend: 0 } });
    const door = verdeel({ activiteit: { gedeeld: 7500, aangerekend: 26 }, vervoer: { gedeeld: 6000, aangerekend: 26 } });
    const volgt = verdeel({ activiteit: { gedeeld: 7500, aangerekend: 26 }, vervoer: { onbekend: true } });
    const met = verdeel({ activiteit: { gedeeld: 7500, aangerekend: 26 }, vervoer: { gedeeld: 6000, aangerekend: 26, tussenkomstTotaal: 2600 } });
    return [
      geld("a. Standaard niet doorgerekend: alle 26", bedrag(niet, NIET_AANGEREKEND), NIETS),
      geld("a. De € 135,00 is voor de school", totalen(niet, [{ profiel: NIET_AANGEREKEND, aantal: 26 }]), sommen(0, 13500, 0, 13500)),
      geld("b. Doorgerekend aan alle 26: 135,00 / 26 = 5,192…", bedrag(door, AANWEZIG), bedragen(288, 231, 519)),
      geld("b. Samen € 134,94: de school draagt € 0,06", totalen(door, allen), sommen(13494, 13500, 0, 6)),
      geld("c. Het bedrag voor de bus moet nog volgen: geen totaal, en de bus is nooit € 0", bedrag(volgt, AANWEZIG), bedragen(288, null, null)),
      feit("c. Er is geen volledig bedrag", volgt.volledig, false),
      geld("d. De ouderraad betaalt € 26,00 van de bus: (75,00 + 60,00 − 26,00) / 26 = 4,1923…", bedrag(met, AANWEZIG), bedragen(288, 131, 419)),
      geld("d. Samen € 108,94: de school draagt € 0,06", totalen(met, allen), sommen(10894, 13500, 2600, 6)),
    ];
  }],
  ["G7", "Zwemmen en het gratis zwemjaar", "1.6, 1.7", () => {
    // 1A (gratis zwemjaar): 19 aanwezig, 1 briefje ouders, 1 attest. 2A: 21 aanwezig, 1 ongewettigd afwezig.
    // De bus is voor de 42 aangerekende leerlingen; de toegang enkel voor wie aanwezig is.
    const bus = { gedeeld: 9500, aangerekend: 42 };
    // Het zwembad rekent de toegang van 1A niet aan (B103): enkel 2A telt voor de toegang.
    const zonder = verdeel({ activiteit: { perKind: 210, aangerekend: 22, betalers: 21 }, vervoer: bus });
    // Rekent het zwembad de toegang van 1A wel aan, dan draagt de school ze.
    const metToegang = verdeel({ activiteit: { perKind: 210, aangerekend: 42, betalers: 40 }, vervoer: bus });
    const deel = (aangerekend, perKind = false, school = false) => ({ aangerekend, perKind, school });
    const eersteBusOuders = { activiteit: deel(false), vervoer: deel(true) };
    const eersteBusSchool = { activiteit: deel(false), vervoer: deel(true, false, true) };
    const eersteMetToegang = (busSchool) => ({ activiteit: deel(true, true, true), vervoer: deel(true, false, busSchool) });
    const eersteAfwezigMetToegang = (busSchool) => ({ activiteit: deel(true, false, true), vervoer: deel(true, false, busSchool) });
    const tweede = [{ profiel: AANWEZIG, aantal: 21 }, { profiel: ENKEL_GEDEELD, aantal: 1 }];
    const attest = { profiel: NIET_AANGEREKEND, aantal: 1 };
    const nietDoor = verdeel({ activiteit: { gedeeld: 4000, aangerekend: 21 } });
    return [
      geld("a. Bus aangerekend aan de ouders. 1A, aanwezig of briefje ouders: 95,00 / 42 = 2,261…", bedrag(zonder, eersteBusOuders), bedragen(0, 226, 226)),
      geld("a. 1A, attest", bedrag(zonder, NIET_AANGEREKEND), NIETS),
      geld("a. 2A, aanwezig: 2,10 + 2,261…", bedrag(zonder, AANWEZIG), bedragen(210, 226, 436)),
      geld("a. 2A, ongewettigd afwezig", bedrag(zonder, ENKEL_GEDEELD), bedragen(0, 226, 226)),
      geld("a. Voor de school: enkel € 0,08 afrondingsverschil op de bus", totalen(zonder, [{ profiel: eersteBusOuders, aantal: 20 }, attest, ...tweede]), sommen(13902, 13910, 0, 8)),
      geld("a. Rekent het zwembad de toegang van 1A aan, dan draagt de school ook 19 × € 2,10",
        totalen(metToegang, [{ profiel: eersteMetToegang(false), aantal: 19 }, { profiel: eersteAfwezigMetToegang(false), aantal: 1 }, attest, ...tweede]), sommen(13902, 17900, 0, 3998)),
      geld("b. Bus voor de school in 1A: iedereen van 1A", bedrag(zonder, eersteBusSchool), NIETS),
      geld("b. 2A betaalt haar gewone deel, niet meer", bedrag(zonder, AANWEZIG), bedragen(210, 226, 436)),
      geld("b. Voor de school: € 95,00 − 22 × € 2,26 = € 45,28", totalen(zonder, [{ profiel: eersteBusSchool, aantal: 20 }, attest, ...tweede]), sommen(9382, 13910, 0, 4528)),
      geld("b. Rekent het zwembad de toegang aan: € 85,18",
        totalen(metToegang, [{ profiel: eersteMetToegang(true), aantal: 19 }, { profiel: eersteAfwezigMetToegang(true), aantal: 1 }, attest, ...tweede]), sommen(9382, 17900, 0, 8518)),
      geld("c. Het zwembad is dicht: de beurt ging niet door, zonder kosten", bedrag(verdeel({}), AANWEZIG), NIETS),
      geld("c. De school gaat niet; het zwembad rekent € 40,00 aan: 40,00 / 21 = 1,9047…", bedrag(nietDoor, AANWEZIG), bedragen(190, 0, 190)),
      geld("c. De leerling met een attest", bedrag(nietDoor, NIET_AANGEREKEND), NIETS),
      geld("c. Samen € 39,90: de school draagt € 0,10", totalen(nietDoor, [{ profiel: AANWEZIG, aantal: 21 }, attest]), sommen(3990, 4000, 0, 10)),
    ];
  }],
  ["G8", "Prijs nog te bevestigen", "1.3, 1.8", () => {
    const open = verdeel({ activiteit: { onbekend: true }, vervoer: { gedeeld: 16000, aangerekend: 22 } });
    const gekend = verdeel({ activiteit: { gedeeld: 15400, aangerekend: 22 }, vervoer: { gedeeld: 16000, aangerekend: 22 } });
    return [
      geld("De activiteit is nooit € 0,00, en € 7,27 is nooit het totaal", bedrag(open, AANWEZIG), bedragen(null, 727, null)),
      feit("De stand: voorlopig, door de prijs", standBedrag({ alleKlassenBevestigd: true, prijzenGekend: false, factuurActiviteit: "teontvangen", factuurVervoer: "ontvangen" }),
        { stand: "voorlopig", redenen: ["prijs", "factuur_activiteit"] }),
      geld("De prijs wordt € 154,00: één afronding op (154,00 + 160,00) / 22 = 14,2727…", bedrag(gekend, AANWEZIG), bedragen(700, 727, 1427)),
      feit("Nog voorlopig zolang de factuur van de activiteit ontbreekt",
        standBedrag({ alleKlassenBevestigd: true, factuurActiviteit: "teontvangen", factuurVervoer: "ontvangen" }), { stand: "voorlopig", redenen: ["factuur_activiteit"] }),
      feit("Definitief zodra de factuur van de activiteit ontvangen is",
        standBedrag({ alleKlassenBevestigd: true, factuurActiviteit: "ontvangen", factuurVervoer: "ontvangen" }).stand, "definitief"),
    ];
  }],
  ["G9", "Wie meetelt: instap, klaswissel en vertrek", "1.2", () => {
    const klasOp = (perioden, dag) => (periodeOp(perioden, dag) || { klas: "geen" }).klas;
    const noor = [{ klas: "1B", van: "2026-11-09", einde: "2027-09-01" }];
    const sami = [{ klas: "3A", van: "2026-09-01", einde: "2027-01-19" }, { klas: "3B", van: "2027-01-19", einde: "2027-09-01" }];
    // De einddatum van Jonas in Informat is zondag 17/01/2027: die dag telt nog mee (B89).
    const jonas = [{ klas: "5A", van: "2026-09-01", einde: dagNa("2027-01-17") }];
    return [
      feit("Noor, 1B, bibliotheek op vr 06/11/2026: nog niet ingeschreven", klasOp(noor, "2026-11-06"), "geen"),
      feit("Noor, 1B, boerderij op ma 09/11/2026: de begindatum telt mee", klasOp(noor, "2026-11-09"), "1B"),
      feit("Sami, toneel van 3B op vr 15/01/2027: zat toen in 3A", klasOp(sami, "2027-01-15"), "3A"),
      feit("Sami, planetarium van 3A op ma 18/01/2027", klasOp(sami, "2027-01-18"), "3A"),
      feit("Sami, museum van 3B op di 19/01/2027", klasOp(sami, "2027-01-19"), "3B"),
      feit("Sami, bos van 3A op di 26/01/2027: zat toen in 3B", klasOp(sami, "2027-01-26"), "3B"),
      feit("De einddatum zondag 17/01/2027 wordt \"tot vóór\" maandag 18/01/2027", dagNa("2027-01-17"), "2027-01-18"),
      feit("Jonas, sportdag van 5A op vr 15/01/2027", klasOp(jonas, "2027-01-15"), "5A"),
      feit("Jonas, theater van 5A op ma 18/01/2027: maandag telt niet meer", klasOp(jonas, "2027-01-18"), "geen"),
    ];
  }],
  ["G11", "Een correctie verdelen (a en c)", "1.10", () => [
    geld("a. € 1,00 terug over 3 leerlingen: 0,333… wordt € 0,33; de school betaalt € 0,01 minder terug", verdeelCorrectie(-100, 3), { perLeerling: -33, samen: -99, verschil: -1 }),
    geld("c. € 6,70 terug over 20 leerlingen: 0,335, tot en met de halve cent naar beneden", verdeelCorrectie(-670, 20), { perLeerling: -33, samen: -660, verschil: -10 }),
    geld("Afronden: € 0,335 wordt € 0,33; € 0,3351 en € 0,336 worden € 0,34", [afronden(335, 10), afronden(3351, 100), afronden(336, 10), afronden(3349, 100)], [33, 34, 34, 33]),
  ]],
  ["G12", "Plafond: drie getallen per leerling", "1.11", () => {
    const stand = (werkelijk, aanrekenbaar, school, ruimte, label) => ({ werkelijk, aanrekenbaar, school, ruimte, label });
    return [
      geld("Lien, lager: € 96,35", plafondStand(9635, 11000), stand(9635, 9635, 0, 1365, "onder")),
      geld("Elif, lager: € 106,00", plafondStand(10600, 11000), stand(10600, 10600, 0, 400, "onder")),
      geld("Sven, lager: precies € 110,00", plafondStand(11000, 11000), stand(11000, 11000, 0, 0, "op")),
      geld("Bilal, lager: € 112,69", plafondStand(11269, 11000), stand(11269, 11000, 269, 0, "boven")),
      geld("Tom, kleuter: € 58,10", plafondStand(5810, 5500), stand(5810, 5500, 310, 0, "boven")),
    ];
  }],
  ["G18", "Meerdaagse uitstap in de kleuterschool", "1.15", () => {
    const v = verdeel({ activiteit: { perKind: 5500, aangerekend: 22, betalers: 22 }, vervoer: { gedeeld: 33000, aangerekend: 22 } });
    const kleuter = profielVan({ school: true }, { meerdaags: true });
    return [
      geld("Alle 22 kleuters: nooit aangerekend", bedrag(v, kleuter), NIETS),
      geld("De volledige € 1.540,00 is voor de school", totalen(v, [{ profiel: kleuter, aantal: 22 }]), sommen(0, 154000, 0, 154000)),
    ];
  }],
  ["G19", "Uit en weer in, in hetzelfde schooljaar", "1.2", () => {
    // Lotte: einddatum in Informat vrijdag 13/11/2026, opnieuw ingeschreven vanaf maandag 11/01/2027, weer in 3B.
    const lotte = [
      { klas: "3B", leerjaar: 3, van: "2026-09-01", tot: dagNa("2026-11-13"), einde: dagNa("2026-11-13") },
      { klas: "3B", leerjaar: 3, van: "2027-01-11", tot: null, einde: "2027-09-01" },
    ];
    const ingeschreven = (dag) => periodeOp(lotte, dag) !== null;
    return [
      feit("Voorschot 1 op do 01/10/2026: ingeschreven", ingeschreven("2026-10-01"), true),
      feit("3B, toneel op di 01/12/2026: niet ingeschreven", ingeschreven("2026-12-01"), false),
      feit("3B, museum op do 21/01/2027", ingeschreven("2027-01-21"), true),
      feit("Voorschot 2 op ma 01/02/2027: ingeschreven", ingeschreven("2027-02-01"), true),
      feit("Schoolverlater? Nee: haar laatste periode heeft geen einddatum", isSchoolverlater(lotte), false),
      feit("Met enkel de eerste periode was ze wel schoolverlater", isSchoolverlater(lotte.slice(0, 1)), true),
    ];
  }],
  ["G20", "Niveau en leerjaar", "1.2", () => {
    const jaar = { plafond_kleuter_cent: 5500, plafond_lager_cent: 11000, gratis_zwemjaar_leerjaar: 1 };
    const klas = (naam, groep) => {
      const niveau = niveauVan(groep);
      const leerjaar = leerjaarVan(naam, groep);
      return { niveau, leerjaar, plafond: plafondVoor(jaar, niveau), gratisZwemjaar: inGratisZwemjaar({ naam, groep }, jaar), zesde: isSchoolverlater([{ van: "2026-09-01", tot: null, leerjaar }]) };
    };
    const rij = (niveau, leerjaar, plafond, gratisZwemjaar, zesde) => ({ niveau, leerjaar, plafond, gratisZwemjaar, zesde });
    return [
      feit("1instA, groep Kleuter: de instapklas, geen 1ste leerjaar", klas("1instA", "Kleuter"), rij("kleuter", null, 5500, false, false)),
      feit("1KA, groep Kleuter: de 1ste kleuterklas", klas("1KA", "Kleuter"), rij("kleuter", null, 5500, false, false)),
      feit("1A, groep Lager: het 1ste leerjaar, met het gratis zwemjaar", klas("1A", "Lager"), rij("lager", 1, 11000, true, false)),
      feit("6B, groep Lager: schoolverlater op het einde van het schooljaar", klas("6B", "Lager"), rij("lager", 6, 11000, false, true)),
      feit("Een lagere klas waarvan de naam niet met 1 tot 6 begint: het leerjaar is niet af te leiden", leerjaarVan("Zonneklas", "Lager"), null),
    ];
  }],
];

/**
 * Voert alle gevallen uit. Geeft per geval { nr, titel, regels, rijen, ok }; een rij is
 * { wat, soort, berekend, verwacht, ok }. Een geval dat een fout geeft, krijgt één rij met die fout.
 */
export function voerUit() {
  return LIJST.map(([nr, titel, regels, reken]) => {
    let rijen;
    try {
      rijen = reken();
    } catch (misgelopen) {
      rijen = [{ wat: "Dit geval gaf een fout", soort: "feit", berekend: String(misgelopen && misgelopen.message), verwacht: "geen fout", ok: false }];
    }
    return { nr, titel, regels, rijen, ok: rijen.every((rij) => rij.ok) };
  });
}

/** Het aantal controles, en hoeveel er afwijken. */
export function telling(gevallen) {
  const rijen = gevallen.flatMap((geval) => geval.rijen);
  return { gevallen: gevallen.length, controles: rijen.length, afwijkend: rijen.filter((rij) => !rij.ok).length };
}

// ---------- Het scherm ----------

const NAAM = {
  activiteit: "activiteit", vervoer: "vervoer", totaal: "totaal", ouders: "ouders samen", kost: "kost", tussenkomst: "tussenkomst", school: "voor de school",
  vanActiviteit: "van de activiteit", vanVervoer: "van het vervoer", terugActiviteit: "terug naar de activiteit", terugVervoer: "terug naar het vervoer", rest: "rest", perLeerling: "per leerling", samen: "samen", verschil: "verschil",
  werkelijk: "werkelijk", aanrekenbaar: "aanrekenbaar", ruimte: "ruimte", label: "plafond",
};

/** Een waarde als tekst: een bedrag in euro, "onbekend" als het ontbreekt, en een object veld per veld. */
export function alsTekst(waarde, soort) {
  if (waarde === null || waarde === undefined) return soort === "geld" ? "onbekend" : "geen";
  if (waarde === true) return "ja";
  if (waarde === false) return "nee";
  if (typeof waarde === "number") return soort === "geld" ? euro(waarde) : String(waarde);
  if (typeof waarde === "string") return waarde;
  if (Array.isArray(waarde)) return waarde.map((deel) => alsTekst(deel, soort)).join(" · ");
  return Object.entries(waarde).map(([naam, deel]) => (NAAM[naam] || naam) + " " + alsTekst(deel, soort)).join(" · ");
}

/**
 * Start de testpagina in een onderdeel van de pagina.
 *   deel   het element van het scherm
 *   terug  terug naar waar je vandaan kwam
 */
export function start({ deel, terug }) {
  const gevallen = voerUit();
  const t = telling(gevallen);
  zet(deel, html`
    <button class="btn-link" type="button" data-doe="terug">← Terug</button>
    <div class="page-head big">
      <div>
        <h2 tabindex="-1">Rekentest</h2>
        <p>De testgevallen van het rekencontract, uitgerekend door deze browser: telkens wat het contract verwacht, en wat de MT berekent. Alle namen en bedragen zijn verzonnen.</p>
      </div>
    </div>
    <p class="${t.afwijkend ? "form-alert mt-melding" : "finfo mt-melding"}" role="status">${t.afwijkend
      ? t.afwijkend + " van de " + t.controles + " controles wijken af. Meld dit: de MT rekent dan niet zoals het rekencontract."
      : "Alle " + t.controles + " controles in " + t.gevallen + " gevallen kloppen met het rekencontract (versie 19, rekenversie " + REKENVERSIE + ")."}</p>
    ${gevallen.map((geval) => html`
      <section class="card mt-geval" aria-label="${"Geval " + geval.nr}">
        <div class="mt-gevalkop">
          <h3><span class="nr-tag">${geval.nr}</span> ${geval.titel}</h3>
          <span class="${"pill sm " + (geval.ok ? "done" : "warn")}"><span class="pt"></span>${geval.ok ? "klopt" : "wijkt af"}</span>
        </div>
        <p class="mt-gevalregels">Rekencontract ${geval.regels}</p>
        <div class="mt-controles" role="table" aria-label="${"Controles van geval " + geval.nr}">
          <div class="mt-controle mt-controlekop" role="row"><span role="columnheader">Wat</span><span role="columnheader">Verwacht</span><span role="columnheader">Berekend</span></div>
          ${geval.rijen.map((rij) => html`
            <div class="${"mt-controle" + (rij.ok ? "" : " fout")}" role="row">
              <span role="cell">${rij.wat}</span>
              <span role="cell" data-label="Verwacht" class="num">${alsTekst(rij.verwacht, rij.soort)}</span>
              <span role="cell" data-label="Berekend" class="num">${alsTekst(rij.berekend, rij.soort)}${rij.ok ? null : html` <span class="pill sm warn"><span class="pt"></span>wijkt af</span>`}</span>
            </div>`)}
        </div>
      </section>`)}`);
  deel.querySelector('[data-doe="terug"]').addEventListener("click", terug);
  return { herlaad() {} };
}
