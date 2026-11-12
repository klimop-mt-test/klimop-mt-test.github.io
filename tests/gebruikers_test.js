// MT · tests/gebruikers_test.js
// Het scherm Gebruikers (code/gebruikers.js): wat zonder browser te testen valt. De stand van een
// account, de klassen per schooljaar, "overnemen" (B170), de filters en het nakijken van de invoer.
// Het scherm beslist niets over rechten: dat doen de databank en de serverfunctie.

import assert from "node:assert/strict";
import { keur, kiesRijen, klasGroepen, klassenVan, maakRijen, norm, overnemen, resterend, toestandVan, vorigeKlassen } from "../code/gebruikers.js";

const NU = Date.parse("2026-11-11T10:00:00Z");
const uur = 3600000;
const account = (anders = {}) => ({ id: "g1", naam: "Proef", email: "proef@klimopvilvoorde.be", rol: "leerkracht", actief: true, wachtwoord_tijdelijk: false, tijdelijk_tot: null, eerste_aanmelding_afgerond: true, app_koppelen: false, open_operatie: null, ...anders });

Deno.test("de stand van een account: één label, in deze voorrang", () => {
  assert.deepEqual(toestandVan(account(), NU), { soort: "actief", tekst: "Actief", kleur: "done", aandacht: false });
  const tijdelijk = account({ wachtwoord_tijdelijk: true, tijdelijk_tot: new Date(NU + 31 * uur + 1000).toISOString(), eerste_aanmelding_afgerond: false, app_koppelen: true });
  assert.deepEqual(toestandVan(tijdelijk, NU), { soort: "tijdelijk", tekst: "Tijdelijk wachtwoord, nog 31 uur", kleur: "open", aandacht: true });
  assert.equal(toestandVan({ ...tijdelijk, tijdelijk_tot: new Date(NU).toISOString() }, NU).soort, "verlopen", "op het uur zelf is het verlopen, zoals in de databank");
  assert.equal(toestandVan({ ...tijdelijk, tijdelijk_tot: null }, NU).tekst, "Tijdelijk wachtwoord verlopen");
  assert.equal(toestandVan(account({ app_koppelen: true }), NU).tekst, "App opnieuw te koppelen");
  assert.equal(toestandVan(account({ app_koppelen: true, eerste_aanmelding_afgerond: false }), NU).tekst, "App nog te koppelen");
  assert.deepEqual(toestandVan(account({ actief: false, wachtwoord_tijdelijk: true }), NU), { soort: "uit", tekst: "Uitgeschakeld", kleur: "muted", aandacht: false });
  assert.equal(toestandVan(account({ actief: false, open_operatie: "x" }), NU).tekst, "Wijziging niet afgerond", "een handeling die niet rond is, gaat voor alles");
});

Deno.test("de resterende tijd van een tijdelijk wachtwoord", () => {
  assert.equal(resterend(NU + 48 * uur, NU), "nog 48 uur");
  assert.equal(resterend(NU + 48 * uur - 1, NU), "nog 47 uur");
  assert.equal(resterend(NU + uur, NU), "nog 1 uur");
  assert.equal(resterend(NU + uur - 1, NU), "nog 59 minuten");
  assert.equal(resterend(NU + 60000, NU), "nog 1 minuut");
  assert.equal(resterend(NU + 59999, NU), "nog minder dan een minuut");
});

const KLASSEN = [
  { id: "a25", schooljaar: "2025-2026", bron_id: "k4a", naam: "4A", groep: "Lager", leerjaar: 4, actief: true, volgorde: 40 },
  { id: "b25", schooljaar: "2025-2026", bron_id: "k4b", naam: "4B", groep: "Lager", leerjaar: 4, actief: true, volgorde: 41 },
  { id: "c25", schooljaar: "2025-2026", bron_id: "k4c", naam: "4C", groep: "Lager", leerjaar: 4, actief: true, volgorde: 42 },
  { id: "k26", schooljaar: "2026-2027", bron_id: "k1ka", naam: "1KA", groep: "Kleuter", leerjaar: null, actief: true, volgorde: 5 },
  { id: "a26", schooljaar: "2026-2027", bron_id: "k4a", naam: "4A", groep: "Lager", leerjaar: 4, actief: true, volgorde: 40 },
  { id: "b26", schooljaar: "2026-2027", bron_id: "k4b", naam: "4B", groep: "Lager", leerjaar: 4, actief: true, volgorde: 41 },
  { id: "z26", schooljaar: "2026-2027", bron_id: "k6a", naam: "6A", groep: "Lager", leerjaar: 6, actief: false, volgorde: 60 },
  { id: "l26", schooljaar: "2026-2027", bron_id: "klo", naam: "LO", groep: "Andere", leerjaar: null, actief: true, volgorde: 90 },
  { id: "x26", schooljaar: "2026-2027", bron_id: "kok", naam: "OKAN", groep: "Lager", leerjaar: null, actief: true, volgorde: 70 },
];
const PER_ID = new Map(KLASSEN.map((k) => [k.id, k]));
const TOEW = [
  { gebruiker_id: "ellen", klas_id: "c25", schooljaar: "2025-2026" },
  { gebruiker_id: "ellen", klas_id: "a25", schooljaar: "2025-2026" },
  { gebruiker_id: "ellen", klas_id: "b25", schooljaar: "2025-2026" },
  { gebruiker_id: "jonas", klas_id: "b25", schooljaar: "2025-2026" },
  { gebruiker_id: "jonas", klas_id: "a26", schooljaar: "2026-2027" },
];

Deno.test("klassen per schooljaar, in de volgorde van de klassenlijst", () => {
  assert.deepEqual(klassenVan("ellen", "2025-2026", TOEW, PER_ID).map((k) => k.naam), ["4A", "4B", "4C"]);
  assert.deepEqual(klassenVan("ellen", "2026-2027", TOEW, PER_ID), []);
  assert.deepEqual(klassenVan("jonas", "2026-2027", TOEW, PER_ID).map((k) => k.naam), ["4A"]);
  assert.deepEqual(vorigeKlassen("ellen", "2026-2027", TOEW, PER_ID).klassen.map((k) => k.naam), ["4A", "4B", "4C"]);
  assert.equal(vorigeKlassen("ellen", "2026-2027", TOEW, PER_ID).schooljaar, "2025-2026");
  assert.equal(vorigeKlassen("ellen", "2025-2026", TOEW, PER_ID), null, "er is geen eerder schooljaar");
  assert.equal(vorigeKlassen("nieuw", "2026-2027", TOEW, PER_ID), null);
});

Deno.test("overnemen (B170): dezelfde klassen via het klas-id van de uitstappentool; wat niet meer bestaat, wordt gemeld", () => {
  const nu = KLASSEN.filter((k) => k.schooljaar === "2026-2027");
  const over = overnemen(vorigeKlassen("ellen", "2026-2027", TOEW, PER_ID).klassen, nu);
  assert.deepEqual(over, { ids: ["a26", "b26"], namen: ["4A", "4B"], ontbreekt: ["4C"] });
  const nietActief = overnemen([{ bron_id: "k6a", naam: "6A" }], nu);
  assert.deepEqual(nietActief, { ids: [], namen: [], ontbreekt: ["6A"] }, "een klas die niet meer actief is, wordt niet overgenomen");
});

const GEBRUIKERS = [
  account({ id: "pablo", naam: "Pablo Pérez León", email: "pablo.perezleon@klimopvilvoorde.be", rol: "beheerder" }),
  account({ id: "ellen", naam: "Ellen Verhulst", email: "ellen.verhulst@klimopvilvoorde.be" }),
  account({ id: "jonas", naam: "Jonas Dewaele", email: "jonas.dewaele@klimopvilvoorde.be" }),
  account({ id: "lien", naam: "Lien Dierickx", email: "lien.dierickx@klimopvilvoorde.be", wachtwoord_tijdelijk: true, tijdelijk_tot: new Date(NU + 31 * uur + 5).toISOString() }),
  account({ id: "marc", naam: "Marc Hendrikx, directie", email: "marc.hendrikx@klimopvilvoorde.be", rol: "lezer", app_koppelen: true }),
  account({ id: "weg", naam: "Zoë Weg", email: "zoe.weg@klimopvilvoorde.be", actief: false }),
];

Deno.test("de rijen: wie nog te koppelen is, en het eigen account", () => {
  const rijen = maakRijen({ gebruikers: GEBRUIKERS, toewijzingen: TOEW, klassen: KLASSEN, jaar: "2026-2027", ik: "pablo", nu: NU });
  const per = Object.fromEntries(rijen.map((r) => [r.g.id, r]));
  assert.equal(per.pablo.eigen, true);
  assert.equal(per.ellen.eigen, false);
  assert.deepEqual([per.ellen.teKoppelen, per.jonas.teKoppelen, per.lien.teKoppelen, per.marc.teKoppelen, per.pablo.teKoppelen, per.weg.teKoppelen], [true, false, true, false, false, false],
    "enkel een actieve leerkracht zonder klassen is nog te koppelen");
  assert.deepEqual(per.ellen.vorig.klassen.map((k) => k.naam), ["4A", "4B", "4C"]);
  assert.equal(per.lien.vorig, null);
  assert.deepEqual(per.jonas.klassen.map((k) => k.naam), ["4A"]);
  const zonderJaar = maakRijen({ gebruikers: GEBRUIKERS, toewijzingen: TOEW, klassen: KLASSEN, jaar: null, ik: "pablo", nu: NU });
  assert.ok(zonderJaar.every((r) => !r.teKoppelen && r.klassen.length === 0), "zonder schooljaar is niemand te koppelen");
});

Deno.test("zoeken en filteren: op naam of e-mailadres, zonder accenten of hoofdletters; de filters samen", () => {
  const rijen = maakRijen({ gebruikers: GEBRUIKERS, toewijzingen: TOEW, klassen: KLASSEN, jaar: "2026-2027", ik: "pablo", nu: NU });
  const namen = (f) => kiesRijen(rijen, f).map((r) => r.g.id);
  assert.equal(norm("  Pérez LEÓN "), "perez leon");
  assert.deepEqual(namen({}), ["pablo", "ellen", "jonas", "lien", "marc", "weg"]);
  assert.deepEqual(namen({ zoek: "perez" }), ["pablo"]);
  assert.deepEqual(namen({ zoek: "ZOE" }), ["weg"]);
  assert.deepEqual(namen({ zoek: "dewaele@klim" }), ["jonas"]);
  assert.deepEqual(namen({ rol: "leerkracht" }), ["ellen", "jonas", "lien", "weg"]);
  assert.deepEqual(namen({ toestand: "koppelen" }), ["ellen", "lien"]);
  assert.deepEqual(namen({ toestand: "aandacht" }), ["lien", "marc"]);
  assert.deepEqual(namen({ rol: "lezer", toestand: "aandacht", zoek: "directie" }), ["marc"]);
  assert.deepEqual(namen({ zoek: "niemand" }), []);
});

Deno.test("de invoer nakijken zoals de databank, met een fout per veld; een vreemd adres mag, na een vraag", () => {
  const goed = keur({ naam: "  Lien   Dierickx ", email: " Lien.Dierickx@KlimopVilvoorde.be ", rol: "leerkracht" });
  assert.deepEqual([goed.ok, goed.naam, goed.email, goed.vreemd], [true, "Lien Dierickx", "lien.dierickx@klimopvilvoorde.be", false]);
  assert.equal(keur({ naam: "", email: "a@b.be", rol: "lezer" }).fouten.naam, "Vul een naam in.");
  assert.match(keur({ naam: "x".repeat(81), email: "a@b.be", rol: "lezer" }).fouten.naam, /hoogstens 80/);
  assert.equal(keur({ naam: "A", email: "", rol: "lezer" }).fouten.email, "Vul een e-mailadres in.");
  for (const fout of ["geen adres", "a@b", "a b@c.be", "a@b@c.be"]) assert.equal(keur({ naam: "A", email: fout, rol: "lezer" }).fouten.email, "Dit is geen geldig e-mailadres.", fout);
  assert.equal(keur({ naam: "A", email: "a@b.be", rol: "directeur" }).fouten.rol, "Kies een rol.");
  assert.equal(keur({ naam: "A", email: "nadia@scholengroep.be", rol: "lezer" }).vreemd, true);
  assert.equal(keur({ naam: "A", email: "x@nepklimopvilvoorde.be", rol: "lezer" }).vreemd, true, "een domein dat er enkel op eindigt, is niet het domein van de school");
  assert.equal(keur({ naam: "A", email: "fout", rol: "lezer" }).vreemd, false, "een ongeldig adres krijgt de fout, niet de vraag");
});

Deno.test("klassen kiezen: per groep en per leerjaar; een klas die niet meer actief is enkel als ze gekozen was", () => {
  const groepen = klasGroepen(KLASSEN, "2026-2027", new Set());
  assert.deepEqual(groepen.map(([titel, klassen]) => [titel, klassen.map((k) => k.naam)]), [["Kleuters", ["1KA"]], ["4e leerjaar", ["4A", "4B"]], ["Lager", ["OKAN"]], ["Andere", ["LO"]]]);
  const metOude = klasGroepen(KLASSEN, "2026-2027", new Set(["z26"]));
  assert.deepEqual(metOude.map(([titel]) => titel), ["Kleuters", "4e leerjaar", "6e leerjaar", "Lager", "Andere"]);
  assert.deepEqual(klasGroepen(KLASSEN, "2027-2028", new Set()), []);
});
