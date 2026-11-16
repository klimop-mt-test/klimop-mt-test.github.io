// MT · tests/uitstappentool_test.js
// Wat de startpagina meldt over de uitstappentool (code/uitstappentool.js): de zinnen onder de tabel.
// Ze zijn afgeleid uit het antwoord van de serverfunctie, en nergens bewaard (64.4).

import assert from "node:assert/strict";
import { UITSTAPFUNCTIE_VERSIE } from "../code/config.js";
import { REKENVERSIE } from "../code/rekenen.js";
import { onbekendeKlassen, regels, zinNietInDeMT } from "../code/uitstappentool.js";

const TELLERS = { nieuw: 0, gewijzigd: 0, weg: 0, ongewijzigd: 0, ongeldig: 0, buiten: 0, geen: 0, gesloten: 0, ouder: 0, niet_gevonden: 0 };
const gelukt = (extra = {}) => ({
  ok: true,
  gegevens: { ok: true, versie: UITSTAPFUNCTIE_VERSIE, rekenversie: REKENVERSIE, gelezen: { uitstappen: 0, klassen: null }, klassen: null, onbekende_klassen: [], wacht: [], onbekende_versie: [], ...extra, uitstappen: { ...TELLERS, ...(extra.uitstappen || {}) } },
});
const teksten = (lijnen, soort) => lijnen.filter((l) => !soort || l.soort === soort).map((l) => l.tekst);

Deno.test("de startpagina: wat de MT volgt, in één zin", () => {
  const lijnen = regels({ functie: gelukt({ uitstappen: { nieuw: 2, gewijzigd: 1, ongewijzigd: 84, buiten: 44, geen: 12 } }), rol: "leerkracht", schooljaar: "2026-2027" });
  assert.deepEqual(teksten(lijnen), [
    "De MT volgt 87 uitstappen: 2 nieuw, 1 gewijzigd en 84 ongewijzigd.",
    "44 uitstappen vallen buiten de schooljaren die in de MT open staan.",
  ]);
  assert.ok(lijnen.every((l) => l.soort === "info"));
  assert.deepEqual(teksten(regels({ functie: gelukt({ uitstappen: { ongewijzigd: 1 } }), rol: "lezer", schooljaar: "2026-2027" })), ["De MT volgt 1 uitstap: 1 ongewijzigd."]);
});

Deno.test("de startpagina: een beheerder ziet hoe lang de serverfunctie erover deed", () => {
  const functie = gelukt({ uitstappen: { ongewijzigd: 312 }, gelezen: { uitstappen: 331, klassen: 29 }, duur_ms: 1840 });
  assert.deepEqual(teksten(regels({ functie, rol: "beheerder", schooljaar: "2026-2027" })),
    ["De MT volgt 312 uitstappen: 312 ongewijzigd.", "De serverfunctie las 331 uitstappen en werkte de MT bij in 1,8 seconden."]);
  assert.deepEqual(teksten(regels({ functie, rol: "leerkracht", schooljaar: "2026-2027" })), ["De MT volgt 312 uitstappen: 312 ongewijzigd."]);
  assert.match(teksten(regels({ functie: gelukt({ uitstappen: { ongewijzigd: 1 }, gelezen: { uitstappen: 1, klassen: 3 }, duur_ms: 40 }), rol: "beheerder", schooljaar: "2026-2027" }))[1], /las 1 uitstap en werkte de MT bij in 0,0 seconden\.$/);
});

Deno.test("de startpagina: zonder schooljaar wachten de uitstappen, en dat is geen fout", () => {
  const lijnen = regels({ functie: gelukt({ uitstappen: { buiten: 131, geen: 12 }, klassen: { ok: false, melding: "er is nog geen lopend schooljaar" } }), rol: "beheerder", schooljaar: null });
  assert.deepEqual(lijnen, [{ soort: "info", tekst: "In de MT is er nog geen lopend schooljaar: de uitstappen wachten tot het aangemaakt is in Instellingen (stap 4)." }]);
  assert.deepEqual(teksten(regels({ functie: gelukt({ uitstappen: { geen: 3 } }), rol: "leerkracht", schooljaar: "2026-2027" })), ["De MT volgt nog geen uitstappen van 2026-2027."]);
});

Deno.test("de startpagina: wat aandacht vraagt, staat er als \"let op\"", () => {
  const lijnen = regels({
    functie: gelukt({
      uitstappen: { ongewijzigd: 40, weg: 1, niet_gevonden: 2, ongeldig: 1 },
      klassen: { ok: true, schooljaar: "2026-2027", nieuw: 1, gewijzigd: 0, uitgezet: 2 },
      onbekende_klassen: [{ uitstap: "u1", klassen: ["Zonneklas"] }, { uitstap: "u2", klassen: ["Zonneklas", "4Z"] }],
      wacht: ["u3"],
      onbekende_versie: ["u4", "u5"],
    }),
    rol: "beheerder",
    schooljaar: "2026-2027",
  });
  assert.deepEqual(teksten(lijnen, "info"), [
    "De MT volgt 40 uitstappen: 40 ongewijzigd.",
    "1 uitstap is in de uitstappentool verwijderd of een nascholing geworden: de MT telt ze niet meer mee.",
    "De klassen van 2026-2027 zijn bijgewerkt: 1 nieuw en 2 uitgezet.",
  ]);
  assert.deepEqual(teksten(lijnen, "let_op"), [
    "2 uitstappen staan niet meer in de uitstappentool: de MT telt ze niet meer mee.",
    "1 uitstap heeft geen geldige datum of gegevens: de MT neemt ze niet over. Kijk ze na in de uitstappentool.",
    "Klas onbekend: Zonneklas (2 uitstappen) en 4Z (1 uitstap). De MT kent deze klassen niet in het schooljaar van de uitstap, en maakt er geen lijst voor. Kijk de naam na in de uitstappentool.",
    "Bij 1 uitstap wijzigde de datum terwijl er al iets vastligt in de MT: de MT houdt de datum van toen, tot de beheerder beslist.",
    "2 uitstappen hebben een opbouw die deze versie van de MT niet kent. De MT leest ze niet, en houdt wat ze wist, tot ze bijgewerkt is.",
  ]);
  // Een leerkracht kan de klassen niet bijwerken: de MT zegt wat er dan gebeurt.
  const leerkracht = regels({ functie: gelukt({ uitstappen: { ongewijzigd: 1 }, onbekende_klassen: [{ uitstap: "u1", klassen: ["1KC"] }] }), rol: "leerkracht", schooljaar: "2026-2027" });
  assert.match(teksten(leerkracht, "let_op")[0], /^Klas onbekend: 1KC \(1 uitstap\)\. De MT kent deze klas niet .* Een nieuwe klas komt erbij zodra een beheerder de MT opent\.$/);
  // Een klassenlijst die de databank weigert.
  const geweigerd = regels({ functie: gelukt({ uitstappen: { ongewijzigd: 1 }, klassen: { ok: false, melding: "klas 4 in de klassenlijst klopt niet. Er is niets gewijzigd." } }), rol: "beheerder", schooljaar: "2026-2027" });
  assert.deepEqual(teksten(geweigerd, "let_op"), ["De klassen zijn niet bijgewerkt: klas 4 in de klassenlijst klopt niet. Er is niets gewijzigd."]);
});

Deno.test("de startpagina: een oudere serverfunctie in Supabase valt op, door haar versie of haar rekenversie", () => {
  for (const extra of [{ versie: "0.6.9" }, { rekenversie: REKENVERSIE + 1 }, { versie: undefined }]) {
    const beheerder = regels({ functie: gelukt({ ...extra, uitstappen: { ongewijzigd: 1 } }), rol: "beheerder", schooljaar: "2026-2027" });
    assert.equal(beheerder[0].soort, "let_op");
    assert.match(beheerder[0].tekst, /^In Supabase staat versie \S+ van de serverfunctie mt-uitstappen; deze versie van de MT verwacht \d+\.\d+\.\d+\. Plak functies\/mt-uitstappen\/index\.ts opnieuw in Supabase, bij Edge Functions\.$/);
    const leerkracht = regels({ functie: gelukt({ ...extra, uitstappen: { ongewijzigd: 1 } }), rol: "leerkracht", schooljaar: "2026-2027" });
    assert.match(leerkracht[0].tekst, /Meld het aan de beheerder\.$/);
  }
  assert.equal(regels({ functie: gelukt({ uitstappen: { ongewijzigd: 1 } }), rol: "beheerder", schooljaar: "2026-2027" }).some((l) => l.soort === "let_op"), false);
});

Deno.test("de startpagina: lukt het bijwerken niet, dan zegt de MT waarom, en wat een beheerder eraan doet", () => {
  const fout = (soort, tekst, rol = "beheerder") => regels({ functie: { ok: false, soort, tekst, status: 0 }, rol, schooljaar: "2026-2027" });
  assert.deepEqual(fout("ontbreekt", "De serverfunctie mt-uitstappen staat nog niet in Supabase."),
    [{ soort: "fout", tekst: "De serverfunctie mt-uitstappen staat nog niet in Supabase. Plak functies/mt-uitstappen/index.ts in Supabase, bij Edge Functions." }]);
  assert.match(fout("ontbreekt", "De serverfunctie mt-uitstappen staat nog niet in Supabase.", "leerkracht")[0].tekst, /Meld het aan de beheerder\.$/);
  assert.match(fout("verbinding", "Geen verbinding met de databank.")[0].tekst, /gaf geen antwoord: de MT is nu niet bijgewerkt .* Staat ze nog niet in Supabase, plak dan .* probeer het opnieuw\.$/);
  assert.doesNotMatch(fout("verbinding", "x", "leerkracht")[0].tekst, /Supabase/);
  assert.deepEqual(fout("bron", "De uitstappentool antwoordt niet."), [{ soort: "fout", tekst: "De uitstappentool antwoordt niet." }]);
  assert.equal(fout("kan_niet", "De uitstappentool gaf geen enkele uitstap terug.")[0].tekst, "De MT is niet bijgewerkt met de uitstappentool: de uitstappentool gaf geen enkele uitstap terug.");
  assert.equal(fout("fout", "De databank van de MT antwoordt niet.")[0].tekst, "De MT is nu niet bijgewerkt met de uitstappentool. De databank van de MT antwoordt niet.");
  // De serverfunctie weigert, maar de databank aanvaardt de aanmelding nog: de pagina zegt het, en herlaadt niet.
  for (const soort of ["sessie", "rechten"]) assert.match(fout(soort, "Je sessie is verlopen. Meld opnieuw aan.")[0].tekst, /aanvaardt je aanmelding niet: de MT is nu niet bijgewerkt .* Meld af en opnieuw aan\./);
});

Deno.test("klas onbekend: per naam, met het aantal uitstappen, de meeste eerst", () => {
  assert.deepEqual(onbekendeKlassen([{ uitstap: "a", klassen: ["X", "Y"] }, { uitstap: "b", klassen: ["Y", "Y"] }, { uitstap: "c", klassen: ["A"] }]),
    [{ naam: "Y", aantal: 2 }, { naam: "A", aantal: 1 }, { naam: "X", aantal: 1 }]);
  for (const leeg of [[], null, undefined, [{ uitstap: "a" }]]) assert.deepEqual(onbekendeKlassen(leeg), []);
});

Deno.test("wat nooit meetelt, in één zin", () => {
  assert.equal(zinNietInDeMT({ nascholingen: 12, verwijderd: 3, zonderDatum: 1 }), "Niet in de tabel, en nooit meegeteld: 12 nascholingen, 3 uitstappen in de prullenbak en 1 uitstap zonder geldige datum.");
  assert.equal(zinNietInDeMT({ nascholingen: 1, verwijderd: 0, zonderDatum: 0 }), "Niet in de tabel, en nooit meegeteld: 1 nascholing.");
  assert.equal(zinNietInDeMT({ nascholingen: 0, verwijderd: 0, zonderDatum: 0 }), null);
});
