// MT · tests/uitstappentool_test.js
// Wat de startpagina meldt over de uitstappentool (code/uitstappentool.js): de zinnen onder de tabel.
// Ze zijn afgeleid uit het antwoord van de serverfunctie, en nergens bewaard (64.4). Sinds 0.8.0 komt ook
// het overzicht per schooljaar uit dat antwoord: de pagina leest de uitstappentool niet zelf (review 2).

import assert from "node:assert/strict";
import { UITSTAPFUNCTIE_VERSIE } from "../code/config.js";
import { REKENVERSIE } from "../code/rekenen.js";
import { moetHerstarten, moetNavragen, onbekendeKlassen, opnieuwNodig, overzichtUit, regels, vraagVerdwenen, zinGelezen, zinNietInDeMT } from "../code/uitstappentool.js";
import { CODE, lees } from "./hulp.js";

const TELLERS = { nieuw: 0, gewijzigd: 0, weg: 0, ongewijzigd: 0, ongeldig: 0, buiten: 0, geen: 0, gesloten: 0, niet_gevonden: 0, tegengehouden: 0 };
const gelukt = (extra = {}) => ({
  ok: true,
  gegevens: {
    ok: true, stand: "klaar", lezing: 7, klaar_op: "2026-11-16T13:03:20.000Z", versie: UITSTAPFUNCTIE_VERSIE, rekenversie: REKENVERSIE, gelezen: { uitstappen: 0, klassen: null }, klassen: null,
    onbekende_klassen: [], wacht: [], onbekende_versie: [], onbruikbaar: [], verdwenen_taak: null, verdwenen: [], ...extra, uitstappen: { ...TELLERS, ...(extra.uitstappen || {}) },
  },
});
const mislukt = (soort, tekst, extra = {}) => ({ ok: false, soort, tekst, status: 0, extra: { geblokkeerd: false, onbekend: false, deels: false, ...extra } });
const teksten = (lijnen, soort) => lijnen.filter((l) => !soort || l.soort === soort).map((l) => l.tekst);
const voor = (rol, functie, schooljaar = "2026-2027") => regels({ functie, rol, schooljaar });

Deno.test("de startpagina: wat de MT volgt, in één zin", () => {
  const lijnen = voor("leerkracht", gelukt({ uitstappen: { nieuw: 2, gewijzigd: 1, ongewijzigd: 84, buiten: 44, geen: 12 } }));
  assert.deepEqual(teksten(lijnen), [
    "De MT volgt 87 uitstappen: 2 nieuw, 1 gewijzigd en 84 ongewijzigd.",
    "44 uitstappen vallen buiten de schooljaren die in de MT open staan.",
  ]);
  assert.ok(lijnen.every((l) => l.soort === "info"));
  assert.deepEqual(teksten(voor("lezer", gelukt({ uitstappen: { ongewijzigd: 1 } }))), ["De MT volgt 1 uitstap: 1 ongewijzigd."]);
});

Deno.test("de startpagina: een beheerder ziet hoe lang de lezing duurde", () => {
  const functie = gelukt({ uitstappen: { ongewijzigd: 312 }, gelezen: { uitstappen: 331, klassen: 29 }, duur_ms: 1840 });
  assert.deepEqual(teksten(voor("beheerder", functie)), ["De MT volgt 312 uitstappen: 312 ongewijzigd.", "De serverfunctie las 331 uitstappen en werkte de MT bij in 1,8 seconden."]);
  assert.deepEqual(teksten(voor("leerkracht", functie)), ["De MT volgt 312 uitstappen: 312 ongewijzigd."]);
  assert.match(teksten(voor("beheerder", gelukt({ uitstappen: { ongewijzigd: 1 }, gelezen: { uitstappen: 1, klassen: 3 }, duur_ms: 40 })))[1], /las 1 uitstap en werkte de MT bij in 0,0 seconden\.$/);
});

Deno.test("de startpagina: zonder schooljaar wachten de uitstappen, en dat is geen fout", () => {
  const functie = gelukt({ uitstappen: { buiten: 131, geen: 12 }, klassen: { ok: false, melding: "er is nog geen lopend schooljaar" } });
  assert.deepEqual(voor("beheerder", functie, null),
    [{ soort: "info", tekst: "In de MT is er nog geen lopend schooljaar: de uitstappen wachten tot het aangemaakt is. Dat kan in Instellingen, vanaf de volgende versie van de MT." }]);
  // Wie geen beheerder is, leest wat het voor hem betekent; geen bouwstap in de zin (review 2: R2-15).
  assert.deepEqual(voor("leerkracht", functie, null), [{ soort: "info", tekst: "De MT volgt de uitstappen zodra de beheerder het schooljaar aanmaakt." }]);
  assert.deepEqual(teksten(voor("leerkracht", gelukt({ uitstappen: { geen: 3 } }))), ["De MT volgt nog geen uitstappen van 2026-2027."]);
});

Deno.test("de startpagina: wat aandacht vraagt, staat er als \"let op\"", () => {
  const lijnen = voor("beheerder", gelukt({
    uitstappen: { ongewijzigd: 40, weg: 1, niet_gevonden: 2, ongeldig: 1 },
    klassen: { ok: true, schooljaar: "2026-2027", nieuw: 1, gewijzigd: 0, uitgezet: 2 },
    onbekende_klassen: [{ uitstap: "u1", schooljaar: "2026-2027", klassen: ["Zonneklas"] }, { uitstap: "u2", schooljaar: "2026-2027", klassen: ["Zonneklas", "4Z"] }],
    wacht: ["u3"],
    onbekende_versie: ["u4", "u5"],
    onbruikbaar: ["u6"],
  }));
  assert.deepEqual(teksten(lijnen, "info"), [
    "De MT volgt 40 uitstappen: 40 ongewijzigd.",
    "1 uitstap is in de uitstappentool verwijderd of een nascholing geworden: de MT telt ze niet meer mee.",
    "De klassen van 2026-2027 zijn bijgewerkt: 1 nieuw en 2 uitgezet.",
  ]);
  assert.deepEqual(teksten(lijnen, "let_op"), [
    "2 uitstappen staan niet meer in de uitstappentool: de MT telt ze niet meer mee.",
    "1 uitstap heeft geen geldige datum of gegevens: de MT neemt hem niet over. Kijk hem na in de uitstappentool.",
    "1 uitstap staat in de uitstappentool in een vorm die de MT niet kan lezen. De MT neemt hem niet over, en houdt wat ze wist. Kijk in de uitstappentool na of er een aanvraag bij staat die er niet hoort.",
    "Klas onbekend in 2026-2027: Zonneklas (2 uitstappen) en 4Z (1 uitstap). De MT kent deze klassen niet in het schooljaar van de uitstap, en maakt er geen lijst voor. Kijk de naam na in de uitstappentool.",
    "Bij 1 uitstap wijzigde de datum terwijl er al iets vastligt in de MT: de MT houdt de datum van toen, tot de beheerder beslist.",
    "2 uitstappen hebben een opbouw die deze versie van de MT niet kent. De MT leest ze niet, en houdt wat ze wist, tot ze bijgewerkt is.",
  ]);
  // Eerst wat er gebeurde, dan wat aandacht vraagt.
  assert.deepEqual(lijnen.map((l) => l.soort), ["info", "info", "info", "let_op", "let_op", "let_op", "let_op", "let_op", "let_op"]);
  // Een leerkracht kan de klassen niet bijwerken: de MT zegt wat er dan gebeurt.
  const leerkracht = voor("leerkracht", gelukt({ uitstappen: { ongewijzigd: 1 }, onbekende_klassen: [{ uitstap: "u1", schooljaar: "2026-2027", klassen: ["1KC"] }], onbruikbaar: ["u6", "u7"] }));
  assert.deepEqual(teksten(leerkracht, "let_op"), [
    "2 uitstappen staan in de uitstappentool in een vorm die de MT niet kan lezen. De MT neemt ze niet over, en houdt wat ze wist.",
    "Klas onbekend in 2026-2027: 1KC (1 uitstap). De MT kent deze klas niet in het schooljaar van de uitstap, en maakt er geen lijst voor. Een nieuwe klas komt erbij zodra een beheerder de MT opent.",
  ]);
  // Een klassenlijst die de databank weigert.
  const geweigerd = voor("beheerder", gelukt({ uitstappen: { ongewijzigd: 1 }, klassen: { ok: false, melding: "klas 4 in de klassenlijst klopt niet. Er is niets gewijzigd." } }));
  assert.deepEqual(teksten(geweigerd, "let_op"), ["De klassen zijn niet bijgewerkt: klas 4 in de klassenlijst klopt niet. Er is niets gewijzigd."]);
});

Deno.test("klas onbekend: met het schooljaar erbij, en voor een ander dan het lopende zegt de MT dat de klas er niet meer bij komt (review 2: R07)", () => {
  const functie = gelukt({
    uitstappen: { ongewijzigd: 3 },
    onbekende_klassen: [
      { uitstap: "u1", schooljaar: "2025-2026", klassen: ["3C"] }, { uitstap: "u2", schooljaar: "2026-2027", klassen: ["Zonneklas"] },
      { uitstap: "u3", schooljaar: "2025-2026", klassen: ["3C", "3D"] },
    ],
  });
  assert.deepEqual(teksten(voor("beheerder", functie), "let_op"), [
    "Klas onbekend in 2026-2027: Zonneklas (1 uitstap). De MT kent deze klas niet in het schooljaar van de uitstap, en maakt er geen lijst voor. Kijk de naam na in de uitstappentool.",
    "Klas onbekend in 2025-2026: 3C (2 uitstappen) en 3D (1 uitstap). Dat is niet het lopende schooljaar: de MT werkt de klassen ervan niet meer bij, en maakt voor deze klassen geen lijst. Klopt de naam niet, verbeter ze dan in de uitstappentool.",
  ]);
  // Wie geen beheerder is, krijgt voor een vorig schooljaar geen belofte die niet klopt.
  const leerkracht = teksten(voor("leerkracht", functie), "let_op");
  assert.match(leerkracht[0], /Een nieuwe klas komt erbij zodra een beheerder de MT opent\.$/);
  assert.equal(leerkracht[1], "Klas onbekend in 2025-2026: 3C (2 uitstappen) en 3D (1 uitstap). Dat is niet het lopende schooljaar: de MT werkt de klassen ervan niet meer bij, en maakt voor deze klassen geen lijst.");
  // Een antwoord zonder schooljaar, van een oudere serverfunctie: de melding blijft staan, zonder schooljaar.
  assert.match(teksten(voor("beheerder", gelukt({ uitstappen: { ongewijzigd: 1 }, onbekende_klassen: [{ uitstap: "u1", klassen: ["1KC"] }] })), "let_op")[0], /^Klas onbekend: 1KC \(1 uitstap\)\. De MT kent deze klas niet /);
});

Deno.test("klas onbekend: per schooljaar en per naam, met het aantal uitstappen, het jongste schooljaar en de meeste eerst", () => {
  assert.deepEqual(onbekendeKlassen([
    { uitstap: "a", schooljaar: "2026-2027", klassen: ["X", "Y"] }, { uitstap: "b", schooljaar: "2026-2027", klassen: ["Y", "Y"] }, { uitstap: "c", schooljaar: "2026-2027", klassen: ["A"] },
    { uitstap: "d", schooljaar: "2025-2026", klassen: ["Y"] }, { uitstap: "e", klassen: ["Y"] },
  ]), [
    { schooljaar: "2026-2027", naam: "Y", aantal: 2 }, { schooljaar: "2026-2027", naam: "A", aantal: 1 }, { schooljaar: "2026-2027", naam: "X", aantal: 1 },
    { schooljaar: "2025-2026", naam: "Y", aantal: 1 }, { schooljaar: "", naam: "Y", aantal: 1 },
  ]);
  for (const leeg of [[], null, undefined, [{ uitstap: "a" }], [null], "tekst"]) assert.deepEqual(onbekendeKlassen(leeg), []);
});

Deno.test("de rem: verdwijnen er veel uitstappen tegelijk, dan zegt de MT welke, en vraagt ze de beheerder om te bevestigen (B225)", () => {
  const verdwenen = [
    { uitstap: "u1", van: "2026-11-20", tot: "2026-11-20", klassen: ["4A", "4B"] }, { uitstap: "u2", van: "2026-12-03", tot: "2026-12-03", klassen: [] },
    { uitstap: "u3", van: "2027-05-10", tot: "2027-05-12", klassen: ["6A"] }, { uitstap: "u4", van: "2027-06-01", tot: "2027-06-01", klassen: ["1KA"] },
    { uitstap: "u5", van: "2027-06-02", tot: "2027-06-02", klassen: ["2A"] }, { uitstap: "u6", van: "2027-06-03", tot: "2027-06-03", klassen: ["2B"] },
  ];
  const functie = gelukt({ uitstappen: { ongewijzigd: 30, tegengehouden: 6 }, verdwenen_taak: "0000000a-0000-4000-8000-000000000001", verdwenen });
  const beheerder = voor("beheerder", functie);
  const regel = beheerder.find((l) => l.knop);
  assert.deepEqual(regel, {
    soort: "let_op",
    tekst: "6 uitstappen die de MT nog meetelden, staan niet meer in de uitstappentool: 20/11/2026 (4A, 4B), 03/12/2026, 10/05/2027 tot 12/05/2027 (6A), 01/06/2027 (1KA), 02/06/2027 (2A), 03/06/2027 (2B)."
      + " Dat zijn er te veel om zomaar over te nemen: de MT telt ze verder mee. Kijk in de uitstappentool na of ze echt weg zijn.",
    knop: "verdwenen",
  });
  assert.equal(beheerder.filter((l) => l.knop).length, 1);
  // Wie geen beheerder is, kan niets bevestigen: geen knop, en geen lijst.
  const leerkracht = voor("leerkracht", functie);
  assert.equal(leerkracht.some((l) => l.knop), false);
  assert.deepEqual(teksten(leerkracht, "let_op"), ["6 uitstappen staan niet meer in de uitstappentool. Dat zijn er veel tegelijk: de MT telt ze verder mee tot een beheerder dit nakijkt."]);
  // Zonder taak om te bevestigen is er geen knop: de melding blijft.
  const zonderTaak = voor("beheerder", gelukt({ uitstappen: { ongewijzigd: 30, tegengehouden: 6 }, verdwenen }));
  assert.equal(zonderTaak.some((l) => l.knop), false);
  assert.match(teksten(zonderTaak, "let_op")[0], /^6 uitstappen die de MT nog meetelden/);
  // Heel veel: de eerste tien bij hun datum, de rest geteld. De databank geeft er hoogstens vijftig mee.
  const veel = Array.from({ length: 50 }, (_, i) => ({ uitstap: "v" + i, van: "2027-01-" + String(i % 28 + 1).padStart(2, "0"), tot: "2027-01-" + String(i % 28 + 1).padStart(2, "0"), klassen: [] }));
  const lang = teksten(voor("beheerder", gelukt({ uitstappen: { tegengehouden: 73 }, verdwenen_taak: "0000000a-0000-4000-8000-000000000002", verdwenen: veel })), "let_op")[0];
  assert.match(lang, /^73 uitstappen die de MT nog meetelden, staan niet meer in de uitstappentool: 01\/01\/2027, 02\/01\/2027, .*, 10\/01\/2027, en 63 andere\. Dat zijn er te veel/);
  assert.equal(lang.split("/2027").length - 1, 10);
  // Een lijst die ontbreekt of niet klopt, doet de melding niet struikelen.
  for (const raar of [undefined, null, "tekst", [{}], [{ van: 5, klassen: "4A" }]]) {
    const tekst = teksten(voor("beheerder", gelukt({ uitstappen: { tegengehouden: 8 }, verdwenen_taak: "t", verdwenen: raar })), "let_op")[0];
    assert.match(tekst, /^8 uitstappen die de MT nog meetelden, staan niet meer in de uitstappentool/);
  }
  // De eerste regel zegt ook dan wat de MT volgt.
  assert.equal(teksten(voor("beheerder", gelukt({ uitstappen: { tegengehouden: 8 }, verdwenen_taak: "t" })), "info")[0], "De MT volgt 0 uitstappen.");
});

Deno.test("de rem: de vraag vóór het bevestigen zegt wat er gebeurt, en dat het terug kan", () => {
  assert.deepEqual(vraagVerdwenen(7), {
    titel: "Echt weg?",
    tekst: "7 uitstappen staan niet meer in de uitstappentool. Bevestig je, dan telt de MT ze niet meer mee. Wat er al bij ingegeven was, blijft bewaard. Staat een uitstap later weer in de uitstappentool, dan telt de MT hem opnieuw mee.",
    ja: "Ja, ze zijn echt weg",
    nee: "Nee, nog niet",
  });
  assert.match(vraagVerdwenen(1).tekst, /^1 uitstap staat niet meer in de uitstappentool\. Bevestig je, dan telt de MT hem niet meer mee\./);
});

Deno.test("de startpagina: een oudere serverfunctie in Supabase valt op, door haar versie of haar rekenversie", () => {
  for (const extra of [{ versie: "0.7.1" }, { rekenversie: REKENVERSIE + 1 }, { versie: undefined }]) {
    const beheerder = voor("beheerder", gelukt({ ...extra, uitstappen: { ongewijzigd: 1 } }));
    assert.equal(beheerder[0].soort, "let_op");
    assert.match(beheerder[0].tekst, /^In Supabase staat versie \S+ van de serverfunctie mt-uitstappen; deze versie van de MT verwacht \d+\.\d+\.\d+\. Plak functies\/mt-uitstappen\/index\.ts opnieuw in Supabase, bij Edge Functions\.$/);
    // Wie geen beheerder is, leest wat het voor hem betekent.
    const leerkracht = voor("leerkracht", gelukt({ ...extra, uitstappen: { ongewijzigd: 1 } }));
    assert.deepEqual(leerkracht[0], { soort: "let_op", tekst: "De MT is nog niet helemaal bijgewerkt naar haar nieuwste versie: wat hier staat, kan onvolledig zijn. Meld het aan de beheerder." });
  }
  assert.equal(voor("beheerder", gelukt({ uitstappen: { ongewijzigd: 1 } })).some((l) => l.soort === "let_op"), false);
  // Een antwoord van de serverfunctie van 0.7.1, zonder overzicht: de melding staat bovenaan, en er is geen tabel.
  const oud = { ok: true, gegevens: { ok: true, versie: "0.7.1", rekenversie: 2, gelezen: { uitstappen: 58, klassen: null }, klassen: null, uitstappen: { nieuw: 0, gewijzigd: 0, weg: 0, ongewijzigd: 41, ongeldig: 0, buiten: 17, geen: 0, gesloten: 0, ouder: 0, niet_gevonden: 0 }, onbekende_klassen: [], wacht: [], onbekende_versie: [], duur_ms: 500 } };
  assert.match(voor("beheerder", oud)[0].tekst, /^In Supabase staat versie 0\.7\.1 /);
  assert.equal(overzichtUit(oud.gegevens), null);
  assert.equal(zinGelezen(oud.gegevens), null);
});

Deno.test("de startpagina: lukt het bijwerken niet, dan zegt de MT waarom, en wat een beheerder eraan doet", () => {
  const fout = (soort, tekst, rol = "beheerder", extra = {}) => voor(rol, mislukt(soort, tekst, extra));
  assert.deepEqual(fout("ontbreekt", "De serverfunctie mt-uitstappen staat nog niet in Supabase."),
    [{ soort: "fout", tekst: "De serverfunctie mt-uitstappen staat nog niet in Supabase. Plak functies/mt-uitstappen/index.ts in Supabase, bij Edge Functions." }]);
  assert.equal(fout("ontbreekt", "De serverfunctie mt-uitstappen staat nog niet in Supabase.", "leerkracht")[0].tekst, "De MT kon de uitstappen nu niet bijwerken. Meld het aan de beheerder.");
  // Geen antwoord is niet "niet gebeurd": de uitkomst is niet bekend (review 2: R07).
  assert.equal(fout("verbinding", "Geen verbinding met de databank.")[0].tekst,
    "De MT kreeg geen antwoord op de vraag om de uitstappen bij te werken: de uitkomst is niet bekend. Staat de serverfunctie mt-uitstappen nog niet in Supabase, plak dan functies/mt-uitstappen/index.ts bij Edge Functions. Anders is het de verbinding: probeer het opnieuw.");
  assert.equal(fout("verbinding", "x", "leerkracht")[0].tekst,
    "De MT kreeg geen antwoord op de vraag om de uitstappen bij te werken: de uitkomst is niet bekend. Controleer je internetverbinding en probeer het opnieuw. Blijft dit zo, meld het dan aan de beheerder.");
  assert.deepEqual(fout("bron", "De uitstappentool antwoordt niet."), [{ soort: "fout", tekst: "De uitstappentool antwoordt niet." }]);
  assert.equal(fout("kan_niet", "De uitstappentool gaf geen enkele uitstap terug.")[0].tekst, "De MT is niet bijgewerkt met de uitstappentool: de uitstappentool gaf geen enkele uitstap terug.");
  assert.equal(fout("fout", "De databank van de MT antwoordt niet.")[0].tekst, "De MT is nu niet bijgewerkt met de uitstappentool. De databank van de MT antwoordt niet.");
  assert.equal(fout("fout", "De databank van de MT antwoordt niet.", "leerkracht")[0].tekst, "De MT kon de uitstappen nu niet bijwerken. Probeer het later opnieuw. Blijft dit zo, meld het dan aan de beheerder.");
  assert.equal(fout("ingehaald", "x")[0].tekst, "Terwijl de MT de uitstappentool las, begon ze aan een nieuwere lezing. Die geldt: deze lezing heeft niets gewijzigd. Probeer het zo meteen opnieuw.");
  // De serverfunctie weigert, maar de databank aanvaardt de aanmelding nog: de pagina zegt het, en herlaadt niet.
  for (const soort of ["sessie", "rechten"]) {
    assert.equal(fout(soort, "Je sessie is verlopen. Meld opnieuw aan.")[0].tekst,
      "De serverfunctie mt-uitstappen aanvaardt je aanmelding niet: de MT is nu niet bijgewerkt met de uitstappentool. Meld af en opnieuw aan. Blijft dit zo, meld het dan aan de beheerder.");
    assert.equal(fout(soort, "x", "lezer")[0].tekst, "De MT kon de uitstappen nu niet bijwerken: je aanmelding werd niet aanvaard. Meld af en opnieuw aan. Blijft dit zo, meld het dan aan de beheerder.");
  }
});

Deno.test("de startpagina: brak het bijwerken af terwijl een deel al bewaard kan zijn, dan zegt de MT dat, en nooit dat er niets gewijzigd is (review 2: R07)", () => {
  for (const soort of ["fout", "kan_niet", "rechten", "sessie", "bron", "ingehaald", "oproep"]) {
    for (const rol of ["beheerder", "leerkracht", "lezer"]) {
      const [lijn] = voor(rol, mislukt(soort, "De databank gaf een fout.", { deels: true }));
      assert.equal(lijn.soort, "fout");
      assert.match(lijn.tekst, /^Het bijwerken van de uitstappen is niet voltooid: een deel kan al bewaard zijn\. Probeer het opnieuw: de MT vult dan aan\./, soort + " voor " + rol);
      assert.doesNotMatch(lijn.tekst, /niet bijgewerkt|niets gewijzigd/, soort + " voor " + rol);
      if (rol === "beheerder") assert.match(lijn.tekst, / De reden: de databank gaf een fout\.$/);
      else assert.match(lijn.tekst, / Blijft dit zo, meld het dan aan de beheerder\.$/);
    }
  }
  // Zonder antwoord weet de MT het niet: dat zegt de zin van "geen antwoord" al.
  assert.match(voor("beheerder", mislukt("verbinding", "x", { deels: true }))[0].tekst, /de uitkomst is niet bekend/);
  // Een antwoord zonder die vlag, zoals van een oudere serverfunctie, of zonder extra.
  assert.equal(voor("beheerder", { ok: false, soort: "fout", tekst: "De databank gaf een fout.", status: 500 })[0].tekst, "De MT is nu niet bijgewerkt met de uitstappentool. De databank gaf een fout.");
});

Deno.test("wie geen beheerder is, leest nergens de namen van de techniek (review 2: R2-15)", () => {
  const techniek = /Supabase|serverfunctie|Edge Functions|index\.ts|mt-uitstappen|SQL|script/i;
  const antwoorden = [
    ...["ontbreekt", "verbinding", "sessie", "rechten", "fout", "ingehaald", "oproep"].map((soort) => mislukt(soort, "De serverfunctie mt-uitstappen staat nog niet in Supabase.")),
    mislukt("fout", "De databank kent deze functie niet: voer sql/006_review2.sql uit.", { deels: true }),
    gelukt({ versie: "0.7.1", uitstappen: { ongewijzigd: 1 } }),
    gelukt({ uitstappen: { ongewijzigd: 5, tegengehouden: 9 }, verdwenen_taak: "t", onbruikbaar: ["u"], gelezen: { uitstappen: 9, klassen: 3 }, duur_ms: 900 }),
    gelukt({ uitstappen: {} }),
    { ok: true, gegevens: { ok: true, stand: "bezig", versie: UITSTAPFUNCTIE_VERSIE, rekenversie: REKENVERSIE } },
  ];
  for (const functie of antwoorden) {
    for (const rol of ["leerkracht", "lezer"]) {
      for (const schooljaar of ["2026-2027", null]) {
        for (const lijn of regels({ functie, rol, schooljaar })) assert.doesNotMatch(lijn.tekst, techniek, rol + ": " + lijn.tekst);
      }
    }
  }
  // De beheerder leest wel wat hij moet doen.
  assert.match(voor("beheerder", mislukt("ontbreekt", "De serverfunctie mt-uitstappen staat nog niet in Supabase."))[0].tekst, techniek);
});

Deno.test("loopt er een lezing en is er nog geen vorige, dan zegt de MT dat, zonder tabel", () => {
  const bezig = { ok: true, gegevens: { ok: true, stand: "bezig", versie: UITSTAPFUNCTIE_VERSIE, rekenversie: REKENVERSIE } };
  assert.deepEqual(voor("leerkracht", bezig), [{ soort: "info", tekst: "De MT leest de uitstappentool op dit moment. Probeer het over enkele seconden opnieuw." }]);
  assert.equal(overzichtUit(bezig.gegevens), null);
  assert.equal(zinGelezen(bezig.gegevens), null);
});

Deno.test("wanneer de MT las: het uur van de lezing zelf, in de tijd van Brussel, ook als ze nu niet opnieuw las (review 2: R09)", () => {
  const telt = " Enkel bevestigde uitstappen tellen mee; aangevraagde komen apart in de prognose.";
  assert.equal(zinGelezen({ stand: "klaar", klaar_op: "2026-11-16T13:03:20.000Z" }), "Gelezen op maandag 16 november 2026 om 14:03." + telt);
  assert.equal(zinGelezen({ stand: "recent", klaar_op: "2026-11-16T13:03:20+00:00" }), "Gelezen op maandag 16 november 2026 om 14:03. Dat is minder dan een halve minuut geleden: de MT leest niet opnieuw." + telt);
  assert.equal(zinGelezen({ stand: "bezig", klaar_op: "2026-07-01T07:30:00.123456+00:00" }), "De MT leest de uitstappentool op dit moment opnieuw. Hieronder staat de vorige lezing, van woensdag 1 juli 2026 om 09:30." + telt);
  for (const zonder of [null, undefined, {}, { klaar_op: null }, { klaar_op: "geen datum" }, { klaar_op: 5 }]) assert.equal(zinGelezen(zonder), null);
});

Deno.test("het overzicht per schooljaar komt uit het antwoord van de serverfunctie; ontbreekt het of klopt het niet, dan is er geen tabel", () => {
  const overzicht = { jaren: [{ schooljaar: "2025-2026", bevestigd: 1, aangevraagd: 0, geannuleerd: 2 }, { schooljaar: "2026-2027", bevestigd: 40, aangevraagd: 3, geannuleerd: 1 }], nascholingen: 12, verwijderd: 3, zonderDatum: 1, onbekendeVersie: 0, onbruikbaar: 0 };
  assert.deepEqual(overzichtUit({ overzicht }), { jaren: overzicht.jaren, nascholingen: 12, verwijderd: 3, zonderDatum: 1 });
  for (const zonder of [null, undefined, {}, { overzicht: null }, { overzicht: "x" }, { overzicht: {} }, { overzicht: { jaren: "x" } }]) assert.equal(overzichtUit(zonder), null);
  // Wat geen aantal is, toont de pagina als nul, en een rij zonder schooljaar toont ze niet.
  assert.deepEqual(overzichtUit({ overzicht: { jaren: [{ schooljaar: "2026-2027", bevestigd: "veel", aangevraagd: -1 }, null, { bevestigd: 3 }], nascholingen: 1.5 } }),
    { jaren: [{ schooljaar: "2026-2027", bevestigd: 0, aangevraagd: 0, geannuleerd: 0 }], nascholingen: 0, verwijderd: 0, zonderDatum: 0 });
});

Deno.test("wat nooit meetelt, in één zin", () => {
  assert.equal(zinNietInDeMT({ nascholingen: 12, verwijderd: 3, zonderDatum: 1 }), "Niet in de tabel, en nooit meegeteld: 12 nascholingen, 3 uitstappen in de prullenbak en 1 uitstap zonder geldige datum.");
  assert.equal(zinNietInDeMT({ nascholingen: 1, verwijderd: 0, zonderDatum: 0 }), "Niet in de tabel, en nooit meegeteld: 1 nascholing.");
  assert.equal(zinNietInDeMT({ nascholingen: 0, verwijderd: 0, zonderDatum: 0 }), null);
});

Deno.test("de kaart leest de uitstappentool niet zelf: ze vraagt het enkel aan de serverfunctie (review 2: R12, R2-14)", () => {
  const bron = lees(CODE + "uitstappentool.js");
  assert.doesNotMatch(bron, /adapter\.js|leesUitstappen|UITSTAPPENTOOL\b|fetch\(/);
  assert.match(bron, /data\.uitstappenBijwerken\(\)/);
  // De handeling van de beheerder gaat via de databankfunctie, met de taak en het aantal dat het scherm toonde.
  assert.match(bron, /data\.rpc\("mt_verdwenen_bevestigen", \{ p_taak: g\.verdwenen_taak, p_aantal: aantal \}\)/);
});

Deno.test("geen herlaadlus: weigert de serverfunctie de aanmelding, dan herlaadt de pagina enkel als ook de databank ze weigert (review 2: R2-19)", () => {
  const goed = { ok: true, gegevens: {} };
  const weigering = (soort) => ({ ok: false, soort, tekst: "x", status: 401 });
  for (const soort of ["sessie", "rechten"]) {
    // De databank vragen: enkel als de serverfunctie de aanmelding weigert.
    assert.equal(moetNavragen(weigering(soort)), true);
    // Ook de databank weigert: herladen, het aanmeldscherm vraagt dan wat nodig is.
    for (const ook of ["sessie", "rechten"]) assert.equal(moetHerstarten(weigering(soort), weigering(ook)), true, soort + " en " + ook);
    // De databank aanvaardt de aanmelding: niet herladen. Dat was de herlaadlus.
    assert.equal(moetHerstarten(weigering(soort), goed), false, soort);
    // De databank antwoordt niet, of geeft een andere fout: niet herladen.
    for (const anders of ["verbinding", "fout", "ontbreekt", "kan_niet"]) assert.equal(moetHerstarten(weigering(soort), weigering(anders)), false, soort + " en " + anders);
    assert.equal(moetHerstarten(weigering(soort), null), false);
  }
  // Een ander antwoord van de serverfunctie: de databank hoeft niets te zeggen, en de pagina herlaadt nooit.
  for (const functie of [goed, weigering("verbinding"), weigering("fout"), weigering("bron"), weigering("ontbreekt"), weigering("ingehaald"), weigering("kan_niet")]) {
    assert.equal(moetNavragen(functie), false, JSON.stringify(functie));
    assert.equal(moetHerstarten(functie, weigering("sessie")), false, JSON.stringify(functie));
  }
});

Deno.test("terug op het tabblad leest de MT opnieuw na tien minuten, niet eerder en niet in een verborgen tabblad (review 2: R2-20)", () => {
  const toen = Date.parse("2026-11-16T13:00:00Z");
  const minuut = 60000;
  assert.equal(opnieuwNodig({ verborgen: false, gevraagdOp: toen, nu: toen + 10 * minuut + 1000 }), true);
  assert.equal(opnieuwNodig({ verborgen: false, gevraagdOp: toen, nu: toen + 10 * minuut }), false);
  assert.equal(opnieuwNodig({ verborgen: false, gevraagdOp: toen, nu: toen + 9 * minuut + 59000 }), false);
  assert.equal(opnieuwNodig({ verborgen: false, gevraagdOp: toen, nu: toen + 11000 }), false, "tien seconden is geen tien minuten");
  assert.equal(opnieuwNodig({ verborgen: true, gevraagdOp: toen, nu: toen + 60 * minuut }), false);
  assert.equal(opnieuwNodig({ verborgen: false, gevraagdOp: null, nu: toen }), false, "vóór de eerste vraag is er niets opnieuw te lezen");
});
