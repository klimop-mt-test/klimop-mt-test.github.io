// MT · tests/instellingen_test.js
// Het scherm Instellingen (code/instellingen.js): wat zonder browser te testen valt. Wat het scherm leest
// en schrijft, moet in de databank bestaan en mogen; wat het zegt, volgt uit de stand van de schooljaren.

import assert from "node:assert/strict";
import {
  BEDRAGEN, beheerOverzicht, bewaardTekst, gestartRegels, hintBedrag, KOLOMMEN, MAX_BEDRAG_CENT, nieuweRij, notaStarten, ontbreekt, ontbreektTekst, vakSchooljaren, VERPLICHT,
  vraagStarten, zinLezing, zwemAntwoord, ZWEMVRAGEN,
} from "../code/instellingen.js";
import { maakRijen } from "../code/gebruikers.js";
import { lees, sqlScripts, sqlZonderCommentaar } from "./hulp.js";

const SQL = sqlScripts().map((pad) => sqlZonderCommentaar(lees(pad))).join("\n");

/** De kolommen waarvoor een aangemelde gebruiker een recht per kolom kreeg op de tabel van de schooljaren. */
function rechten(soort) {
  const m = new RegExp("grant " + soort + " \\(([^)]*)\\)\\s+on table public\\.schooljaren to authenticated;").exec(SQL);
  assert.ok(m, "de rechten per kolom (" + soort + ") op de schooljaren staan niet meer zo in de SQL-scripts");
  return m[1].split(",").map((kolom) => kolom.trim());
}

const leeg = (schooljaar, extra = {}) => ({
  schooljaar, stand: "in_te_vullen", plafond_kleuter_cent: null, plafond_lager_cent: null, marge_kleuter_cent: null, marge_lager_cent: null,
  gratis_zwemjaar_leerjaar: null, gratis_zwemjaar_toegang_aangerekend: false, gratis_zwemjaar_bus: "school", prijs_per_kind_afwezigen: false, ...extra,
});
const vol = (schooljaar, stand, extra = {}) => leeg(schooljaar, {
  stand, plafond_kleuter_cent: 5500, plafond_lager_cent: 11000, marge_kleuter_cent: 0, marge_lager_cent: 400, gratis_zwemjaar_leerjaar: 1, ...extra,
});

Deno.test("Instellingen leest en schrijft enkel kolommen die bestaan, en schrijft enkel waar de databank het toelaat", () => {
  const tabel = /create table if not exists public\.schooljaren \(([\s\S]*?)\n\);/.exec(SQL);
  assert.ok(tabel);
  const bestaat = (kolom) => new RegExp("^\\s*" + kolom + "\\s", "m").test(tabel[1]);
  for (const kolom of KOLOMMEN) assert.ok(bestaat(kolom), "de kolom " + kolom + " bestaat niet in de tabel van de schooljaren");
  // Wat het formulier bewaart: enkel kolommen met het recht om te wijzigen. De stand hoort daar nooit bij.
  const wijzigen = rechten("update");
  const formulier = [...BEDRAGEN.map((b) => b.kolom), ...ZWEMVRAGEN.map((z) => z.kolom)];
  for (const kolom of formulier) assert.ok(wijzigen.includes(kolom), "het formulier bewaart " + kolom + ", maar de databank geeft daar geen recht op");
  assert.equal(wijzigen.includes("stand"), false);
  assert.equal(formulier.includes("stand"), false);
  for (const kolom of formulier) assert.ok(KOLOMMEN.includes(kolom), kolom + " wordt bewaard maar niet teruggelezen");
  // Wat bij het aanmaken meegaat: enkel kolommen met het recht om toe te voegen.
  const toevoegen = rechten("insert");
  for (const kolom of Object.keys(nieuweRij("2027-2028", vol("2026-2027", "lopend")))) assert.ok(toevoegen.includes(kolom), kolom + " gaat mee bij het aanmaken, zonder recht");
  // Wat verplicht is, eist de databank ook, of het is een keuze van het formulier.
  for (const kolom of VERPLICHT) assert.ok(formulier.includes(kolom));
  for (const kolom of ["plafond_kleuter_cent", "plafond_lager_cent", "marge_kleuter_cent", "marge_lager_cent"]) assert.ok(VERPLICHT.includes(kolom), "de databank eist " + kolom);
});

Deno.test("de keuzes van het gratis zwemjaar zijn die van de databank (B103, B163)", () => {
  const perKolom = Object.fromEntries(ZWEMVRAGEN.map((z) => [z.kolom, z.keuzes.map((k) => k.waarde)]));
  assert.ok(SQL.includes("gratis_zwemjaar_leerjaar smallint check (gratis_zwemjaar_leerjaar between 1 and 6)"));
  assert.deepEqual(perKolom.gratis_zwemjaar_leerjaar, [1, 2, 3, 4, 5, 6]);
  assert.ok(SQL.includes("check (gratis_zwemjaar_bus in ('school', 'ouders', 'geen'))"));
  assert.deepEqual(perKolom.gratis_zwemjaar_bus, ["school", "ouders", "geen"]);
  assert.deepEqual(perKolom.gratis_zwemjaar_toegang_aangerekend, [false, true]);
  // De laatste keuze van de bus staat rechts: geen bus (B163).
  assert.equal(ZWEMVRAGEN[2].keuzes.at(-1).tekst, "Geen bus");
});

Deno.test("een schooljaar aanmaken: enkel het schooljaar, met de standaard voor een prijs per kind van het vorige", () => {
  assert.deepEqual(nieuweRij("2026-2027", null), { schooljaar: "2026-2027" });
  assert.deepEqual(nieuweRij("2027-2028", vol("2026-2027", "lopend", { prijs_per_kind_afwezigen: true })), { schooljaar: "2027-2028", prijs_per_kind_afwezigen: true });
  assert.deepEqual(nieuweRij("2027-2028", vol("2026-2027", "lopend")), { schooljaar: "2027-2028", prijs_per_kind_afwezigen: false });
  // Nooit de stand, en nooit de bedragen: die vult de beheerder bewust in (B144).
  const rij = nieuweRij("2027-2028", vol("2026-2027", "lopend"));
  for (const kolom of ["stand", "plafond_kleuter_cent", "plafond_lager_cent", "marge_kleuter_cent", "marge_lager_cent", "gratis_zwemjaar_leerjaar"]) assert.equal(kolom in rij, false, kolom);
});

Deno.test("wat nog ontbreekt: de vier bedragen en het leerjaar van het gratis zwemjaar; nul is een bedrag", () => {
  assert.deepEqual(ontbreekt(leeg("2026-2027")), ["plafond_kleuter_cent", "plafond_lager_cent", "marge_kleuter_cent", "marge_lager_cent", "gratis_zwemjaar_leerjaar"]);
  assert.deepEqual(ontbreekt(leeg("2026-2027", { plafond_kleuter_cent: 5500, marge_kleuter_cent: 0, marge_lager_cent: 0 })), ["plafond_lager_cent", "gratis_zwemjaar_leerjaar"]);
  assert.deepEqual(ontbreekt(vol("2026-2027", "in_te_vullen")), []);
  assert.equal(ontbreektTekst(0), "Alles is ingevuld.");
  assert.equal(ontbreektTekst(1), "Nog in te vullen: 1 veld.");
  assert.equal(ontbreektTekst(5), "Nog in te vullen: 5 velden.");
  assert.equal(MAX_BEDRAG_CENT, 1000000);
});

Deno.test("onder een bedrag: wat het vorige schooljaar gold, om over te nemen of bewust af te wijken (B144)", () => {
  const vorig = vol("2025-2026", "lopend", { marge_kleuter_cent: null });
  assert.equal(hintBedrag(null, "plafond_kleuter_cent", null), null);
  assert.deepEqual(hintBedrag(vorig, "plafond_kleuter_cent", null), { tekst: "2025-2026: € 55,00", overnemen: true, anders: false });
  assert.deepEqual(hintBedrag(vorig, "plafond_kleuter_cent", 5500), { tekst: "2025-2026: € 55,00", overnemen: false, anders: false });
  assert.deepEqual(hintBedrag(vorig, "plafond_kleuter_cent", 6000), { tekst: "2025-2026: € 55,00", overnemen: true, anders: true });
  // Het vorige schooljaar had geen bedrag: niets over te nemen; een ingevuld bedrag wijkt af.
  assert.deepEqual(hintBedrag(vorig, "marge_kleuter_cent", null), { tekst: "2025-2026: geen", overnemen: false, anders: false });
  assert.deepEqual(hintBedrag(vorig, "marge_kleuter_cent", 0), { tekst: "2025-2026: geen", overnemen: false, anders: true });
  // Nul is een bedrag, geen leeg veld.
  assert.deepEqual(hintBedrag(vol("2025-2026", "lopend"), "marge_kleuter_cent", null), { tekst: "2025-2026: € 0,00", overnemen: true, anders: false });
});

Deno.test("het gratis zwemjaar in woorden, en wat de MT zegt na het bewaren", () => {
  assert.equal(zwemAntwoord("gratis_zwemjaar_leerjaar", 1), "1ste leerjaar");
  assert.equal(zwemAntwoord("gratis_zwemjaar_leerjaar", 6), "6de leerjaar");
  assert.equal(zwemAntwoord("gratis_zwemjaar_leerjaar", null), "nog niet gekozen");
  assert.equal(zwemAntwoord("gratis_zwemjaar_leerjaar", 7), "nog niet gekozen");
  assert.equal(zwemAntwoord("gratis_zwemjaar_toegang_aangerekend", false), "nee: de toegang kost niets");
  assert.equal(zwemAntwoord("gratis_zwemjaar_toegang_aangerekend", true), "ja: de toegang is voor de school");
  assert.equal(zwemAntwoord("gratis_zwemjaar_bus", "school"), "voor de school, zoals de regelgeving vraagt");
  assert.equal(zwemAntwoord("gratis_zwemjaar_bus", "ouders"), "aangerekend aan de ouders");
  assert.equal(zwemAntwoord("gratis_zwemjaar_bus", "geen"), "geen bus");
  assert.equal(bewaardTekst("plafond_kleuter_cent", 5500), "Bewaard: het plafond van de kleuterschool, € 55,00.");
  assert.equal(bewaardTekst("marge_lager_cent", null), "Bewaard: de terugbetaling aan schoolverlaters van de lagere school is leeg.");
  assert.equal(bewaardTekst("marge_lager_cent", 0), "Bewaard: de terugbetaling aan schoolverlaters van de lagere school, € 0,00.");
  assert.equal(bewaardTekst("gratis_zwemjaar_leerjaar", 3), "Bewaard: het gratis zwemjaar is het 3de leerjaar.");
  assert.equal(bewaardTekst("gratis_zwemjaar_toegang_aangerekend", true), "Bewaard: de toegang, ja: de toegang is voor de school.");
  assert.equal(bewaardTekst("gratis_zwemjaar_bus", "geen"), "Bewaard: de bus, geen bus.");
});

Deno.test("de kaart Schooljaren zegt wat er te doen is: aanmaken, verder invullen of bevestigen", () => {
  // Nog geen enkel schooljaar: de MT stelt het schooljaar van vandaag voor, en dat vraagt aandacht.
  assert.deepEqual(vakSchooljaren([], "2026-11-17"), {
    soort: "aanmaken", schooljaar: "2026-2027", knop: "Nieuw schooljaar aanmaken", dringend: true,
    tekst: "Er is nog geen lopend schooljaar. Maak schooljaar 2026-2027 aan: zodra het gestart is, neemt de MT de uitstappen van dat schooljaar over.",
  });
  // Er loopt een schooljaar. Vóór 1 juli: het volgende kan al, zonder aandrang. Vanaf 1 juli: het is nog niet aangemaakt.
  const lopend = [vol("2026-2027", "lopend")];
  const vroeg = vakSchooljaren(lopend, "2026-11-17");
  assert.deepEqual([vroeg.soort, vroeg.schooljaar, vroeg.dringend], ["aanmaken", "2027-2028", false]);
  assert.equal(vroeg.tekst, "Het volgende schooljaar, 2027-2028, kan je al aanmaken en invullen. Starten kan vanaf 1 juli 2027.");
  const laat = vakSchooljaren(lopend, "2027-07-01");
  assert.deepEqual([laat.soort, laat.schooljaar, laat.dringend, laat.tekst], ["aanmaken", "2027-2028", true, "Schooljaar 2027-2028 is nog niet aangemaakt."]);
  // Aangemaakt, nog niet bevestigd: wat ontbreekt, of dat bevestigen kan.
  const bezig = vakSchooljaren([...lopend, leeg("2027-2028", { plafond_kleuter_cent: 5500 })], "2027-08-20");
  assert.deepEqual([bezig.soort, bezig.schooljaar, bezig.knop, bezig.dringend], ["invullen", "2027-2028", "Verder invullen", true]);
  assert.equal(bezig.tekst, "2027-2028 is aangemaakt, maar nog niet bevestigd. Nog in te vullen: 4 velden.");
  assert.equal(vakSchooljaren([...lopend, vol("2027-2028", "in_te_vullen")], "2027-08-20").tekst, "2027-2028 is aangemaakt, maar nog niet bevestigd. Alles is ingevuld: je kan het bevestigen.");
  assert.equal(vakSchooljaren([...lopend, vol("2027-2028", "in_te_vullen")], "2027-03-01").tekst, "2027-2028 is aangemaakt, maar nog niet bevestigd. Alles is ingevuld. Bevestigen kan vanaf 1 juli 2027.");
});

Deno.test("de vraag vóór het starten, en de nota onder de knop: met en zonder een schooljaar dat al loopt", () => {
  assert.deepEqual(vraagStarten("2026-2027", null), {
    titel: "Schooljaar 2026-2027 starten?",
    tekst: "2026-2027 wordt het lopende schooljaar. De MT neemt dan de uitstappen van 2026-2027 over uit de uitstappentool.",
    slot: "Dit kan je niet ongedaan maken.", ja: "Ja, 2026-2027 starten", nee: "Nee, nog niet",
  });
  assert.equal(vraagStarten("2027-2028", "2026-2027").tekst,
    "2027-2028 wordt het lopende schooljaar. Imports en aanwezigheden gaan voortaan daarheen. 2026-2027 blijft open tot alles gefactureerd, gecrediteerd of afgeboekt is.");
  assert.equal(notaStarten("2026-2027", null, "2026-11-17"), "Na het bevestigen is 2026-2027 het lopende schooljaar: de MT neemt dan de uitstappen van 2026-2027 over uit de uitstappentool.");
  assert.equal(notaStarten("2027-2028", "2026-2027", "2027-08-20"),
    "Bevestigen kan ten vroegste vanaf 1 juli, als 2026-2027 voorbij is; later kan ook. Daarna gaan imports en aanwezigheden naar 2027-2028; 2026-2027 blijft open tot alles rond is.");
  // Vóór 1 juli zegt de nota eerst vanaf wanneer het kan.
  assert.match(notaStarten("2027-2028", "2026-2027", "2027-03-01"), /^Bevestigen kan vanaf 1 juli 2027\. /);
});

Deno.test("na de start: wat de MT in de uitstappentool las, de volgende stap, en wat nog open staat in het vorige schooljaar", () => {
  const lezing = (gegevens) => ({ ok: true, gegevens: { stand: "klaar", ...gegevens } });
  assert.equal(zinLezing(lezing({ klassen: { ok: true, nieuw: 14 }, uitstappen: { nieuw: 23 } })), "De MT las de uitstappentool opnieuw: 14 klassen en 23 uitstappen kwamen erbij. Het resultaat staat op Overzicht.");
  assert.equal(zinLezing(lezing({ klassen: { ok: true, nieuw: 1 }, uitstappen: { nieuw: 0 } })), "De MT las de uitstappentool opnieuw: 1 klas kwam erbij. Het resultaat staat op Overzicht.");
  assert.equal(zinLezing(lezing({ klassen: { ok: false, melding: "x" }, uitstappen: { nieuw: 1 } })), "De MT las de uitstappentool opnieuw: 1 uitstap kwam erbij. Het resultaat staat op Overzicht.");
  assert.equal(zinLezing(lezing({ klassen: null, uitstappen: { nieuw: 0 } })), "De MT las de uitstappentool opnieuw: er kwam niets bij. Het resultaat staat op Overzicht.");
  // Iemand anders las net, of leest nog: dan is dit niet de lezing van na de start.
  assert.match(zinLezing({ ok: true, gegevens: { stand: "recent", uitstappen: { nieuw: 5 } } }), /leest de uitstappentool op dit moment/);
  assert.match(zinLezing({ ok: true, gegevens: { stand: "bezig" } }), /leest de uitstappentool op dit moment/);
  for (const mis of [null, undefined, false, { ok: false, soort: "bron", tekst: "x" }]) assert.match(zinLezing(mis), /lukte nu niet/);

  const eerste = gestartRegels({ schooljaar: "2026-2027", vorig: null, open: null, lezing: lezing({ klassen: { ok: true, nieuw: 14 }, uitstappen: { nieuw: 23 } }) });
  assert.equal(eerste.length, 2);
  assert.match(eerste[1], /^Volgende stap: de klassen van 2026-2027 aan de leerkrachten koppelen in Gebruikers\./);
  const volgend = gestartRegels({ schooljaar: "2027-2028", vorig: "2026-2027", open: 2, lezing: null });
  assert.equal(volgend[2], "2026-2027 blijft open tot alles rond is: kies het bovenaan. Nog open in 2026-2027: 2 aanwezigheidslijsten.");
  assert.equal(gestartRegels({ schooljaar: "2027-2028", vorig: "2026-2027", open: 1, lezing: null })[2], "2026-2027 blijft open tot alles rond is: kies het bovenaan. Nog open in 2026-2027: 1 aanwezigheidslijst.");
  assert.equal(gestartRegels({ schooljaar: "2027-2028", vorig: "2026-2027", open: 0, lezing: null })[2], "2026-2027 blijft open tot alles rond is: kies het bovenaan.");
  assert.equal(gestartRegels({ schooljaar: "2027-2028", vorig: "2026-2027", open: null, lezing: null })[2], "2026-2027 blijft open tot alles rond is: kies het bovenaan.");
});

Deno.test("de kaart Beheerders: de beheerders, wie er verder is, en wat aandacht vraagt", () => {
  const nu = Date.parse("2026-11-17T09:00:00Z");
  const g = (id, rol, extra = {}) => ({
    id, naam: "Naam " + id, email: id + "@voorbeeld.test", rol, actief: true, wachtwoord_tijdelijk: false, tijdelijk_tot: null, eerste_aanmelding_afgerond: true,
    app_koppelen: false, open_operatie: null, herstel_wachtwoord: false, herstel_app: false, ...extra,
  });
  const gebruikers = [
    g("b1", "beheerder"), g("b2", "beheerder", { wachtwoord_tijdelijk: true, tijdelijk_tot: "2026-11-18T09:00:00Z" }),
    g("l1", "leerkracht"), g("l2", "leerkracht"), g("l3", "leerkracht", { app_koppelen: true }), g("l4", "leerkracht", { actief: false }),
    g("z1", "lezer"), g("z2", "lezer", { open_operatie: "op-1" }),
  ];
  const klassen = [{ id: "k1", schooljaar: "2026-2027", naam: "4A", volgorde: 1 }];
  const toewijzingen = [{ gebruiker_id: "l1", klas_id: "k1", schooljaar: "2026-2027" }];
  const rijen = maakRijen({ gebruikers, toewijzingen, klassen, jaar: "2026-2027", ik: "b1", nu });
  const o = beheerOverzicht(rijen, "2026-2027");
  assert.deepEqual(o.beheerders.map((r) => r.g.id), ["b1", "b2"]);
  assert.equal(o.verder, "Verder: 4 leerkrachten en 2 lezers.");
  assert.deepEqual(o.aandacht, ["2 leerkrachten: klassen 2026-2027 nog te koppelen", "1 tijdelijk wachtwoord", "1 app te koppelen", "1 wijziging niet afgerond"]);
  // Zonder schooljaar valt er niets te koppelen; zonder anderen zegt de kaart dat ook.
  const zonder = beheerOverzicht(maakRijen({ gebruikers: [g("b1", "beheerder"), g("l1", "leerkracht")], toewijzingen: [], klassen: [], jaar: null, ik: "b1", nu }), null);
  assert.equal(zonder.verder, "Verder: 1 leerkracht.");
  assert.deepEqual(zonder.aandacht, []);
  assert.equal(beheerOverzicht(maakRijen({ gebruikers: [g("b1", "beheerder")], toewijzingen: [], klassen: [], jaar: null, ik: "b1", nu }), null).verder, "Verder zijn er nog geen leerkrachten of lezers.");
});
