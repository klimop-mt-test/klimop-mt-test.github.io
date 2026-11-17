// MT · tests/uitstapfunctie_test.js
// De serverfunctie voor de uitstappen (functies/mt-uitstappen), tegen een nagebootste Supabase en een
// nagebootste uitstappentool. Er gaat niets over het netwerk. Wat de test bewaakt (17.4, B212):
//   - de functie gebruikt dezelfde tekst als code/adapter.js, woord voor woord;
//   - de secret key gaat enkel naar het eigen project, enkel om een lezing te starten, door te geven en
//     te stoppen, en staat nooit in een antwoord of in het logboek; naar de uitstappentool gaat enkel
//     haar eigen publishable key, nooit de secret key en nooit het toegangsbewijs van de vrager;
//   - wie mag vragen, beslist de databank, met het toegangsbewijs van de vrager zelf;
//   - de klassen gaan vóór de uitstappen, en enkel bij een beheerder, met zijn eigen toegangsbewijs;
//   - elke lezing krijgt een volgnummer vóór ze leest; één lezing tegelijk, en hoogstens één per dertig
//     seconden (review 2);
//   - de uitstappen gaan in delen, met de volledige lijst van id's bij het laatste deel;
//   - lukt het lezen niet, of niet volledig, dan wijzigt er niets.
// De databankfuncties zelf worden nagekeken in tests/databank/proef.sql, en de echte serverfunctie
// tegen de echte databankfuncties in tests/databank_test.js. De nabootsing van hier staat in
// tests/nabootsing.js; ze volgt sql/006_review2.sql.

import assert from "node:assert/strict";
import { REKENVERSIE } from "../code/rekenen.js";
import { alleOmgevingen, omgeving, UITSTAPFUNCTIE, UITSTAPFUNCTIE_VERSIE, UITSTAPPENTOOL as BRON_IN_CONFIG } from "../code/config.js";
import { bestaat, CODE, lees } from "./hulp.js";
import { b64, GEHEIM, ID, nep, OORSPRONG, PUBLIEK, URL_MT } from "./nabootsing.js";
import { maakBehandelaar, magNaarBron, PAGINA, UITSTAPPENTOOL, VERSIE } from "../functies/mt-uitstappen/index.ts";

const FUNCTIE = "functies/" + UITSTAPFUNCTIE + "/index.ts";

// ---------- De functie en de pagina gebruiken dezelfde tekst ----------

Deno.test("de serverfunctie bevat de tekst van adapter.js, woord voor woord", () => {
  const adapter = lees(CODE + "adapter.js");
  const streep = "// ==== adapter: gedeeld met de serverfunctie ====\n";
  assert.equal(adapter.split(streep).length, 2, "adapter.js heeft zijn streep niet precies één keer");
  const gedeeld = adapter.split(streep)[1].replace(/^export /gm, "").replace(/^\n+|\n+$/g, "");
  const functie = lees(FUNCTIE);
  const begin = "// ==== adapter: begin ====\n";
  const einde = "\n// ==== adapter: einde ====";
  assert.ok(functie.split(begin).length === 2 && functie.split(einde).length === 2, "de serverfunctie heeft haar twee merktekens niet precies één keer");
  const erin = functie.slice(functie.indexOf(begin) + begin.length, functie.indexOf(einde));
  assert.equal(erin, gedeeld,
    "code/adapter.js en de serverfunctie verschillen. Zet alles wat in adapter.js onder de streep staat opnieuw tussen de merktekens van " + FUNCTIE
    + ", zonder het woord \"export\" vooraan, geef de functie het nummer van deze levering, en zeg bij de levering dat Pablo ze opnieuw plakt.");
  // Buiten het blok importeert de functie niets: één bestand, zonder bibliotheken (17.4).
  assert.doesNotMatch(functie, /^\s*import\b/m);
  assert.doesNotMatch(functie, /\bimport\s*\(/);
});

Deno.test("de serverfunctie: dezelfde projecten, dezelfde uitstappentool en dezelfde versie als de pagina verwacht", () => {
  assert.ok(bestaat(FUNCTIE), "de map van de serverfunctie heet niet zoals in config.js");
  assert.equal(VERSIE, UITSTAPFUNCTIE_VERSIE, "config.js verwacht een andere versie van de serverfunctie");
  assert.match(lees(FUNCTIE).split("\n")[0], new RegExp("^// MT · " + FUNCTIE.replace(/[.]/g, "\\.") + " · versie " + VERSIE.replace(/[.]/g, "\\.") + "$"));
  assert.deepEqual({ ...UITSTAPPENTOOL }, { ...BRON_IN_CONFIG }, "de serverfunctie leest een andere uitstappentool dan de pagina");
  assert.deepEqual(Object.keys(PAGINA).sort(), alleOmgevingen().map((o) => o.mt.url).sort(), "PAGINA in de serverfunctie en config.js noemen niet dezelfde projecten");
  for (const [project, pagina] of Object.entries(PAGINA)) {
    const o = omgeving(pagina.replace(/^https:\/\//, ""));
    assert.ok(o && o.mt.url === project, pagina + " hoort in config.js niet bij " + project);
  }
});

// ---------- De school van de tests (de nabootsing zelf staat in tests/nabootsing.js) ----------

/** Een school met een lopend schooljaar, drie klassen en vier uitstappen in de uitstappentool. */
function school() {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A", "4B"]);
  s.klassenlijst("4A", "4B", "1KA");
  s.uitstap("u1", { v: 2, datumStart: "2026-11-20", klassen: ["4A", "4B"], planStatus: "bevestigd", activiteit: "Zoo", leerkracht: "een naam", kostprijs: 187.5 });
  s.uitstap("u2", { v: 2, datumStart: "2026-12-03", klassen: ["1KA"], planStatus: "aangevraagd" });
  s.uitstap("u3", { v: 2, datumStart: "2026-12-10", categorie: "nascholing", planStatus: "bevestigd" });
  s.uitstap("u4", { v: 2, datumStart: "2025-10-10", klassen: ["4A"], planStatus: "bevestigd" });
  return s;
}

// ---------- Wat de functie doet ----------

Deno.test("een leerkracht opent de MT: de functie leest de uitstappen en werkt de MT bij, zonder de klassen", async () => {
  const s = school();
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 200, r.tekst);
  assert.equal(r.g.ok, true);
  assert.equal(r.g.versie, VERSIE);
  assert.equal(r.g.rekenversie, REKENVERSIE, "de functie meldt de rekenversie van haar adapter");
  assert.deepEqual(r.g.gelezen, { uitstappen: 4, klassen: null });
  assert.equal(r.g.klassen, null);
  // u1 en u2 zijn nieuw; de nascholing kent de MT niet; u4 valt buiten een open schooljaar.
  assert.deepEqual(r.g.uitstappen, { nieuw: 2, gewijzigd: 0, weg: 0, ongewijzigd: 0, ongeldig: 0, buiten: 1, geen: 1, gesloten: 0, niet_gevonden: 0, tegengehouden: 0 });
  // De lezing is afgesloten, met haar nummer en het uur; de pagina toont wat de functie las (review 2: R12).
  assert.equal(r.g.stand, "klaar");
  assert.equal(r.g.lezing, 1);
  assert.equal(r.g.klaar_op, new Date(s.nu).toISOString());
  assert.deepEqual(r.g.overzicht, {
    jaren: [{ schooljaar: "2025-2026", bevestigd: 1, aangevraagd: 0, geannuleerd: 0 }, { schooljaar: "2026-2027", bevestigd: 1, aangevraagd: 1, geannuleerd: 0 }],
    nascholingen: 1, verwijderd: 0, zonderDatum: 0, onbekendeVersie: 0, onbruikbaar: 0,
  });
  assert.deepEqual(r.g.onbruikbaar, []);
  assert.equal(r.g.verdwenen_taak, null);
  assert.deepEqual(r.g.wacht, []);
  // 1KA kent de MT nog niet: enkel een beheerder werkt de klassen bij.
  // Met het schooljaar van de uitstap erbij: zo zegt de melding waar de klas onbekend is (review 2: R07).
  assert.deepEqual(r.g.onbekende_klassen, [{ uitstap: "u2", schooljaar: "2026-2027", klassen: ["1KA"] }]);
  assert.deepEqual(r.g.onbekende_versie, []);
  assert.ok(Number.isInteger(r.g.duur_ms) && r.g.duur_ms > 0);
  // De volgorde: eerst het nummer van de lezing, dan pas lezen.
  assert.deepEqual(s.oproepen.map((o) => o.pad), ["/auth/v1/user", "/rest/v1/rpc/mt_mijn_account", "/rest/v1/rpc/mt_lezing_start", "/rest/v1/uitstappen", "/rest/v1/rpc/mt_uitstappen_bijwerken"]);
  assert.deepEqual(s.oproepen[2].lichaam, { p_door: ID(2) }, "de databank noteert wie de lezing startte: enkel de id");
  assert.equal(r.koppen.get("Access-Control-Allow-Origin"), OORSPRONG);
  assert.equal(r.koppen.get("Cache-Control"), "no-store");
});

Deno.test("een beheerder opent de MT: eerst de klassen, met zijn eigen toegangsbewijs, dan de uitstappen", async () => {
  const s = school();
  const token = s.gebruiker(1, "beheerder");
  const r = await s.vraag(token);
  assert.equal(r.status, 200, r.tekst);
  assert.deepEqual(r.g.gelezen, { uitstappen: 4, klassen: 3 });
  assert.deepEqual(r.g.klassen, { ok: true, schooljaar: "2026-2027", nieuw: 1, gewijzigd: 0, uitgezet: 0 });
  // 1KA is nu gekend vóór haar lijst ontstaat: niets onbekend.
  assert.deepEqual(r.g.onbekende_klassen, []);
  const paden = s.oproepen.map((o) => o.pad);
  assert.ok(paden.indexOf("/rest/v1/rpc/mt_klassen_bijwerken") > paden.indexOf("/rest/v1/instellingen"));
  assert.ok(paden.indexOf("/rest/v1/rpc/mt_klassen_bijwerken") < paden.indexOf("/rest/v1/rpc/mt_uitstappen_bijwerken"), "de klassen gaan vóór de uitstappen");
  const klassen = s.oproepen.find((o) => o.pad === "/rest/v1/rpc/mt_klassen_bijwerken");
  assert.equal(klassen.sleutel, PUBLIEK);
  assert.equal(klassen.drager, "Bearer " + token, "de klassen gaan met het toegangsbewijs van de beheerder, niet met de secret key");
  assert.deepEqual(klassen.lichaam, { p_klassen: [
    { id: "k0", naam: "4A", groep: "Lager", actief: true }, { id: "k1", naam: "4B", groep: "Lager", actief: true }, { id: "k2", naam: "1KA", groep: "Kleuter", actief: true },
  ] });
});

Deno.test("wat naar de databank gaat: per uitstap enkel de velden van 64.3, met de volledige lijst van id's", async () => {
  const s = school();
  await s.vraag(s.gebruiker(2, "leerkracht"));
  const [oproep] = s.naarDatabank();
  assert.deepEqual(Object.keys(oproep.lichaam).sort(), ["p_alle_ids", "p_lezing", "p_uitkomst", "p_uitstappen"]);
  assert.equal(oproep.lichaam.p_lezing, 1);
  // Wat de functie zelf weet, gaat mee met het laatste deel: de databank bewaart het bij de lezing.
  assert.deepEqual(Object.keys(oproep.lichaam.p_uitkomst).sort(), ["gelezen", "klassen", "onbekende_versie", "onbruikbaar", "overzicht", "rekenversie", "versie"]);
  assert.deepEqual({ p_uitstappen: oproep.lichaam.p_uitstappen, p_alle_ids: oproep.lichaam.p_alle_ids }, {
    p_uitstappen: [
      { id: "u1", gewijzigd: "2026-11-10T08:00:00+00:00", categorie: "uitstap", verwijderd: false, planStatus: "bevestigd", type: "dag", datumStart: "2026-11-20", datumEind: null, klassen: ["4A", "4B"] },
      { id: "u2", gewijzigd: "2026-11-10T08:00:00+00:00", categorie: "uitstap", verwijderd: false, planStatus: "aangevraagd", type: "dag", datumStart: "2026-12-03", datumEind: null, klassen: ["1KA"] },
      { id: "u3", gewijzigd: "2026-11-10T08:00:00+00:00", categorie: "nascholing", verwijderd: false, planStatus: "bevestigd", type: "dag", datumStart: "2026-12-10", datumEind: null, klassen: [] },
      { id: "u4", gewijzigd: "2026-11-10T08:00:00+00:00", categorie: "uitstap", verwijderd: false, planStatus: "bevestigd", type: "dag", datumStart: "2025-10-10", datumEind: null, klassen: ["4A"] },
    ],
    p_alle_ids: ["u1", "u2", "u3", "u4"],
  });
  // De titel, de naam van de leerkracht en de prijs verlaten de uitstappentool niet eens: de functie vraagt ze niet.
  assert.doesNotMatch(JSON.stringify(s.oproepen.map((o) => [o.adres, o.lichaam])), /Zoo|een naam|187/);
});

Deno.test("een tweede keer lezen wijzigt niets; een nieuwere versie wel, en wat verdween is \"niet gevonden\"", async () => {
  const s = school();
  const token = s.gebruiker(1, "beheerder");
  await s.vraag(token);
  s.later();
  const tweede = await s.vraag(token);
  assert.deepEqual(tweede.g.uitstappen, { nieuw: 0, gewijzigd: 0, weg: 0, ongewijzigd: 2, ongeldig: 0, buiten: 1, geen: 1, gesloten: 0, niet_gevonden: 0, tegengehouden: 0 });
  assert.equal(tweede.g.lezing, 2);
  // u1 wijzigt in de uitstappentool, en u2 verdwijnt er.
  s.bron.uitstappen[0].updated_at = "2026-11-15T09:00:00+00:00";
  s.bron.uitstappen[0].trip.planStatus = "geannuleerd";
  s.bron.uitstappen.splice(1, 1);
  s.later();
  const derde = await s.vraag(token);
  assert.deepEqual(derde.g.uitstappen, { nieuw: 0, gewijzigd: 1, weg: 0, ongewijzigd: 0, ongeldig: 0, buiten: 1, geen: 1, gesloten: 0, niet_gevonden: 1, tegengehouden: 0 });
  assert.equal(s.activiteiten.get("u2").stand, "niet_gevonden");
});

Deno.test("nog geen lopend schooljaar: de functie zegt het, en de uitstappen wachten", async () => {
  const s = school();
  s.jaren.clear();
  const r = await s.vraag(s.gebruiker(1, "beheerder"));
  assert.equal(r.status, 200, r.tekst);
  assert.deepEqual(r.g.klassen, { ok: false, melding: "er is nog geen lopend schooljaar" });
  assert.deepEqual(r.g.uitstappen, { nieuw: 0, gewijzigd: 0, weg: 0, ongewijzigd: 0, ongeldig: 0, buiten: 3, geen: 1, gesloten: 0, niet_gevonden: 0, tegengehouden: 0 });
  assert.equal(s.activiteiten.size, 0);
});

Deno.test("een klassenlijst die de databank weigert, houdt de uitstappen niet tegen; een uitstappentool zonder klassenlijst ook niet", async () => {
  const s = school();
  s.bron.instellingen[0].data.klassen.push({ naam: "zonder id", groep: "Lager" });
  const r = await s.vraag(s.gebruiker(1, "beheerder"));
  assert.equal(r.status, 200, r.tekst);
  assert.deepEqual(r.g.klassen, { ok: false, melding: "klas 4 in de klassenlijst klopt niet. Er is niets gewijzigd." });
  assert.equal(r.g.uitstappen.nieuw, 2);
  const leeg = school();
  leeg.bron.instellingen = [];
  const r2 = await leeg.vraag(leeg.gebruiker(1, "beheerder"));
  assert.equal(r2.status, 200, r2.tekst);
  assert.deepEqual(r2.g.klassen, { ok: false, melding: "De uitstappentool heeft geen klassenlijst." });
  assert.deepEqual(r2.g.gelezen, { uitstappen: 4, klassen: null });
  assert.equal(leeg.oproepen.some((o) => o.pad === "/rest/v1/rpc/mt_klassen_bijwerken"), false);
});

Deno.test("lukt het bijwerken van de klassen niet om een andere reden dan \"het kan niet\", dan stopt de functie vóór de uitstappen", async () => {
  for (const [antwoord, status, code, onzeker] of [
    [() => new Response('{"code":"55P03","message":"lock timeout"}', { status: 500 }), 503, "databank", false],
    [() => new Response('{"code":"42501","message":"MT: geen rechten voor deze handeling"}', { status: 403 }), 403, "rechten", false],
    [() => "gooi", 503, "databank", true],
    [() => new Response("<html>", { status: 502 }), 500, "databank", true],
    [() => new Response("", { status: 401 }), 401, "sessie", false],
    [() => new Response("{}", { status: 404 }), 500, "databank", false],
  ]) {
    const s = school();
    s.storing = (o) => (o.pad === "/rest/v1/rpc/mt_klassen_bijwerken" ? antwoord() : null);
    const r = await s.vraag(s.gebruiker(1, "beheerder"));
    assert.equal(r.status, status, r.tekst);
    assert.equal(r.g.code, code);
    assert.equal(s.naarDatabank().length, 0, "na een mislukte bijwerking van de klassen gaat er niets naar de uitstappen");
    // De lezing strandde: de functie meldt het, zodat de volgende niet een minuut wacht.
    assert.equal(s.oproepen.at(-1).pad, "/rest/v1/rpc/mt_lezing_stop");
    assert.equal(s.lezingen[0].stand, "afgebroken");
    // Gaf de databank zelf een fout, dan is er niets bewaard; geen antwoord, of een antwoord van onderweg,
    // laat het in het midden (review 2: R07).
    assert.equal(r.g.deels, onzeker, r.tekst);
  }
});

Deno.test("is de tijd om tijdens het bijwerken, dan vertrekt er geen deel meer naar de databank", async () => {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 1500; i++) s.uitstap("u" + String(i).padStart(4, "0"), { datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  // Elke oproep duurt vijf seconden: na het lezen van de twee bladzijden is de tijd van het verzoek om.
  s.duur = 5000;
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 503, r.tekst);
  assert.equal(r.g.code, "databank");
  assert.equal(r.g.deels, false, "er vertrok niets naar de databank");
  // Enkel het stoppen van de lezing vertrekt nog, met een eigen, korte tijd.
  assert.deepEqual(s.oproepen.map((o) => o.pad), ["/auth/v1/user", "/rest/v1/rpc/mt_mijn_account", "/rest/v1/rpc/mt_lezing_start", "/rest/v1/uitstappen", "/rest/v1/uitstappen", "/rest/v1/rpc/mt_lezing_stop"]);
});

Deno.test("een onbekende schemaversie gaat niet naar de databank, maar blijft in de lijst van id's", async () => {
  const s = school();
  s.uitstap("u5", { v: 3, datumStart: "2026-11-25", klassen: ["4A"], planStatus: "bevestigd" });
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 200, r.tekst);
  assert.deepEqual(r.g.onbekende_versie, ["u5"]);
  const [oproep] = s.naarDatabank();
  assert.deepEqual(oproep.lichaam.p_uitstappen.map((u) => u.id), ["u1", "u2", "u3", "u4"]);
  assert.deepEqual(oproep.lichaam.p_alle_ids, ["u1", "u2", "u3", "u4", "u5"]);
  assert.equal(s.activiteiten.has("u5"), false);
});

// ---------- De sleutels ----------

Deno.test("de secret key gaat enkel naar het eigen project, enkel voor mt_uitstappen_bijwerken; de uitstappentool krijgt enkel haar eigen sleutel", async () => {
  const s = school();
  const token = s.gebruiker(1, "beheerder");
  const r = await s.vraag(token);
  assert.equal(r.status, 200, r.tekst);
  assert.ok(s.oproepen.length >= 7);
  for (const o of s.oproepen) {
    assert.equal(o.opties.redirect, "error", o.pad + ": een oproep volgt een omleiding");
    assert.ok(o.opties.signal instanceof AbortSignal, o.pad + ": een oproep zonder grens in de tijd");
    const alles = JSON.stringify([o.adres, [...new Headers(o.opties.headers)], o.lichaam]);
    if (o.host === UITSTAPPENTOOL.url) {
      assert.equal(o.methode, "GET", "de functie schrijft in de uitstappentool");
      assert.equal(o.sleutel, UITSTAPPENTOOL.sleutel);
      assert.equal(o.drager, null, "de uitstappentool krijgt een Authorization-kop");
      assert.ok(!alles.includes(GEHEIM) && !alles.includes(token) && !alles.includes(PUBLIEK), "een sleutel of het toegangsbewijs van de MT gaat naar de uitstappentool");
      assert.match(o.pad, /^\/rest\/v1\/(uitstappen|instellingen)$/);
    } else {
      assert.equal(o.host, URL_MT);
      if (alles.includes(GEHEIM)) {
        assert.match(o.pad, /^\/rest\/v1\/rpc\/mt_(lezing_start|lezing_stop|uitstappen_bijwerken)$/, "de secret key dient voor iets anders dan een lezing starten, doorgeven of stoppen");
        assert.equal(o.sleutel, GEHEIM);
        assert.equal(o.drager, "Bearer " + GEHEIM);
      } else {
        assert.equal(o.sleutel, PUBLIEK);
        assert.equal(o.drager, "Bearer " + token);
      }
    }
  }
  assert.equal(s.naarDatabank().every((o) => o.sleutel === GEHEIM), true, "mt_uitstappen_bijwerken gaat met de secret key");
  // Nooit in een antwoord of in het logboek.
  const buiten = r.tekst + JSON.stringify(s.logboek) + JSON.stringify([...r.koppen]);
  assert.ok(!buiten.includes(GEHEIM) && !buiten.includes(token) && !buiten.includes(PUBLIEK) && !buiten.includes(UITSTAPPENTOOL.sleutel));
  // In het logboek: de uitkomst en de id van de vrager, zonder naam of e-mailadres (review 2: R2-10).
  assert.deepEqual(s.logboek, [{ resultaat: "gelukt", stand: "klaar", wie: ID(1), lezing: 1, gelezen: 4, duur_ms: r.g.duur_ms }]);
  assert.doesNotMatch(JSON.stringify(s.logboek), /@|proef@/);
});

Deno.test("een omleiding of een ander adres van de uitstappentool krijgt nooit een sleutel van de MT", async () => {
  const s = school();
  // De uitstappentool antwoordt met een omleiding: fetch volgt ze niet (redirect: "error") en gooit.
  s.storing = (o) => (o.host === UITSTAPPENTOOL.url ? "gooi" : null);
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 503);
  assert.equal(r.g.code, "bron");
  assert.equal(s.naarDatabank().length, 0, "zonder lezing gaat er niets naar de databank");
});

Deno.test("de bewaker van het netwerk: naar de uitstappentool gaat enkel een leesvraag met haar eigen sleutel, en enkel daarheen", () => {
  const goed = { method: "GET", headers: { apikey: UITSTAPPENTOOL.sleutel, Accept: "application/json", Prefer: "count=exact" }, redirect: "error" };
  const adres = UITSTAPPENTOOL.url + "/rest/v1/uitstappen?select=id&order=id.asc&limit=1000&id=gt.u0999";
  assert.equal(magNaarBron(adres, goed), true);
  // Een ander adres, ook een dat erop lijkt, of het eigen project.
  for (const elders of [UITSTAPPENTOOL.url + ".voorbeeld.be/rest/v1/uitstappen", UITSTAPPENTOOL.url.replace("https:", "http:") + "/rest/v1/uitstappen", URL_MT + "/rest/v1/uitstappen",
    UITSTAPPENTOOL.url + "/auth/v1/user", UITSTAPPENTOOL.url + "/functions/v1/iets", "https://elders.voorbeeld/?" + UITSTAPPENTOOL.url + "/rest/v1/", null]) {
    assert.equal(magNaarBron(elders, goed), false, String(elders));
  }
  // Schrijven, of iets meesturen.
  for (const methode of ["POST", "PATCH", "PUT", "DELETE", "get", undefined]) assert.equal(magNaarBron(adres, { ...goed, method: methode }), false, String(methode));
  assert.equal(magNaarBron(adres, { ...goed, body: "{}" }), false);
  // Een andere sleutel, een toegangsbewijs erbij, of een kop te veel of te weinig.
  assert.equal(magNaarBron(adres, { ...goed, headers: { ...goed.headers, apikey: GEHEIM } }), false);
  assert.equal(magNaarBron(adres, { ...goed, headers: { ...goed.headers, apikey: PUBLIEK } }), false);
  assert.equal(magNaarBron(adres, { ...goed, headers: { ...goed.headers, Authorization: "Bearer " + GEHEIM } }), false);
  assert.equal(magNaarBron(adres, { ...goed, headers: { ...goed.headers, authorization: "Bearer x" } }), false);
  assert.equal(magNaarBron(adres, { ...goed, headers: { apikey: UITSTAPPENTOOL.sleutel } }), false);
  // De functie spreekt het netwerk op precies twee plaatsen aan: het eigen project, en de uitstappentool na de bewaker.
  const functie = lees(FUNCTIE);
  assert.deepEqual([...functie.matchAll(/o\.haal\(([^,]+),/g)].map((m) => m[1]), ["o.url + pad", "adres"]);
  assert.match(functie, /return \(adres, opties\) => \{\n\s+if \(!magNaarBron\(adres, opties\)\) return Promise\.reject\(/, "de bewaker staat niet meer vóór het netwerk naar de uitstappentool");
  // fetch zelf staat er twee keer: de naam van de ingang van de functie, en het netwerk dat ze van buiten meekrijgt.
  assert.deepEqual(functie.match(/.{0,28}\bfetch\(.{0,16}/g).map((stuk) => stuk.trim()), ["fetch(verzoek) {", "haal: (adres, opties) => fetch(adres, opties),"]);
});

// ---------- In delen ----------

Deno.test("veel uitstappen gaan in delen van 500, met de volledige lijst van id's enkel bij het laatste deel", async () => {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 1234; i++) s.uitstap("u" + String(i).padStart(4, "0"), { v: 2, datumStart: "2026-11-20", klassen: i % 100 ? ["4A"] : ["Zonneklas"], planStatus: "bevestigd" });
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 200, r.tekst);
  // 1234 uitstappen: twee bladzijden lezen, drie delen schrijven.
  assert.equal(s.naarBron().length, 2);
  const delen = s.naarDatabank();
  assert.deepEqual(delen.map((o) => o.lichaam.p_uitstappen.length), [500, 500, 234]);
  assert.deepEqual(delen.map((o) => (o.lichaam.p_alle_ids === null ? null : o.lichaam.p_alle_ids.length)), [null, null, 1234]);
  assert.equal(new Set(delen.flatMap((o) => o.lichaam.p_uitstappen.map((u) => u.id))).size, 1234, "elke uitstap gaat precies één keer mee");
  // De tellers en de onbekende klassen van alle delen samen.
  assert.equal(r.g.uitstappen.nieuw, 1234);
  assert.equal(r.g.onbekende_klassen.length, 13);
  assert.equal(r.g.gelezen.uitstappen, 1234);
  // Precies 1000: twee delen, geen leeg derde.
  const rond = nep();
  rond.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 1000; i++) rond.uitstap("u" + String(i).padStart(4, "0"), { datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  await rond.vraag(rond.gebruiker(2, "leerkracht"));
  assert.deepEqual(rond.naarDatabank().map((o) => [o.lichaam.p_uitstappen.length, o.lichaam.p_alle_ids === null]), [[500, true], [500, false]]);
});

Deno.test("een lege uitstappentool: de databank beslist of dat een fout is", async () => {
  const leeg = nep();
  leeg.schooljaar("2026-2027", "lopend");
  const r = await leeg.vraag(leeg.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 200, r.tekst);
  assert.deepEqual(leeg.naarDatabank().map((o) => [o.lichaam.p_uitstappen, o.lichaam.p_alle_ids]), [[[], []]]);
  // Kent de MT al uitstappen, dan is een lege uitstappentool een fout, geen resultaat (17.3).
  const s = school();
  const token = s.gebruiker(2, "leerkracht");
  await s.vraag(token);
  s.bron.uitstappen = [];
  s.later();
  const fout = await s.vraag(token);
  assert.equal(fout.status, 422);
  assert.equal(fout.g.code, "kan_niet");
  assert.match(fout.g.melding, /geen enkele uitstap/);
  assert.equal(fout.g.deels, false, "de databank weigerde: er is niets bewaard");
  assert.equal(s.activiteiten.get("u1").stand, "actief", "er is niets gewijzigd");
  assert.equal(s.lezingen.at(-1).stand, "afgebroken", "de lezing is gestopt");
});

// ---------- Wat misloopt ----------

Deno.test("de uitstappentool antwoordt niet, of niet volledig: er wijzigt niets", async () => {
  const stil = school();
  stil.storing = (o) => (o.pad === "/rest/v1/uitstappen" ? "gooi" : null);
  const r = await stil.vraag(stil.gebruiker(1, "beheerder"));
  assert.equal(r.status, 503);
  assert.equal(r.g.ok, false);
  assert.equal(r.g.code, "bron");
  assert.match(r.g.melding, /antwoordt niet/);
  assert.equal(stil.oproepen.some((o) => o.pad.startsWith("/rest/v1/rpc/mt_klassen") || o.pad.startsWith("/rest/v1/rpc/mt_uitstappen")), false, "zonder volledige lezing wijzigt er niets, ook de klassen niet");

  const half = school();
  half.storing = (o) => (o.pad === "/rest/v1/uitstappen" ? new Response("[]", { status: 200, headers: { "content-range": "*/9" } }) : null);
  const r2 = await half.vraag(half.gebruiker(2, "leerkracht"));
  assert.equal(r2.status, 502);
  assert.equal(r2.g.code, "bron");
  assert.match(r2.g.melding, /niet volledig/);
  assert.equal(half.naarDatabank().length, 0);

  const klassenStil = school();
  klassenStil.storing = (o) => (o.pad === "/rest/v1/instellingen" ? new Response("kapot", { status: 500 }) : null);
  const r3 = await klassenStil.vraag(klassenStil.gebruiker(1, "beheerder"));
  assert.equal(r3.status, 502);
  assert.equal(klassenStil.naarDatabank().length, 0);
  assert.equal(klassenStil.activiteiten.size, 0);
});

Deno.test("wie niet aangemeld is, of geen gebruiker van de MT is, zet niets in gang", async () => {
  const s = school();
  const zonder = await s.vraag(null);
  assert.equal(zonder.status, 401);
  assert.equal(zonder.g.code, "sessie");
  assert.equal(s.oproepen.length, 0, "zonder toegangsbewijs vertrekt er geen enkele oproep");

  const vals = await s.vraag(b64("a") + "." + b64("b") + "." + b64("c"));
  assert.equal(vals.status, 401);
  assert.deepEqual(s.oproepen.map((o) => o.pad), ["/auth/v1/user"]);

  // Een geldig account bij Supabase dat geen gebruiker van de MT is: de databank weigert.
  s.oproepen.length = 0;
  const vreemd = b64('{"alg":"ES256"}') + "." + b64('{"sub":"x"}') + "." + b64("handtekening");
  s.sessies.set(vreemd, ID(99));
  const geen = await s.vraag(vreemd);
  assert.equal(geen.status, 403);
  assert.equal(geen.g.code, "rechten");
  assert.deepEqual(s.oproepen.map((o) => o.pad), ["/auth/v1/user", "/rest/v1/rpc/mt_mijn_account"], "de uitstappentool wordt niet gelezen, en de secret key niet gebruikt");
  assert.equal(s.oproepen.some((o) => JSON.stringify([...new Headers(o.opties.headers)]).includes(GEHEIM)), false);
});

Deno.test("Supabase of de databank antwoordt niet: later opnieuw, zonder halve uitkomst te verzwijgen", async () => {
  const s = school();
  s.storing = (o) => (o.pad === "/auth/v1/user" ? "gooi" : null);
  const auth = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(auth.status, 503);
  assert.equal(auth.g.code, "supabase");

  // De databank wacht te lang op een slot (55P03) of op een antwoord (57014).
  for (const code of ["55P03", "57014"]) {
    const bezet = school();
    bezet.storing = (o) => (o.pad === "/rest/v1/rpc/mt_uitstappen_bijwerken" ? new Response(JSON.stringify({ code, message: "canceling statement" }), { status: 500 }) : null);
    const r = await bezet.vraag(bezet.gebruiker(2, "leerkracht"));
    assert.equal(r.status, 503);
    assert.equal(r.g.code, "databank");
    assert.match(r.g.melding, /opnieuw/);
  }

  // De databankfunctie ontbreekt: een script is niet uitgevoerd.
  const oud = school();
  oud.storing = (o) => (o.pad === "/rest/v1/rpc/mt_uitstappen_bijwerken" ? new Response('{"code":"PGRST202","message":"bestaat niet"}', { status: 404 }) : null);
  const r4 = await oud.vraag(oud.gebruiker(2, "leerkracht"));
  assert.equal(r4.status, 500);
  assert.match(r4.g.melding, /006_review2/);

  // Het tweede deel mislukt: de functie zegt het, en stuurt de lijst van id's niet.
  const veel = nep();
  veel.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 1200; i++) veel.uitstap("u" + String(i).padStart(4, "0"), { datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  let nr = 0;
  veel.storing = (o) => (o.pad === "/rest/v1/rpc/mt_uitstappen_bijwerken" && ++nr === 2 ? "gooi" : null);
  const r5 = await veel.vraag(veel.gebruiker(2, "leerkracht"));
  assert.equal(r5.status, 503);
  assert.equal(veel.naarDatabank().length, 2, "na een mislukt deel volgt geen volgend deel");
  assert.equal(veel.naarDatabank().every((o) => o.lichaam.p_alle_ids === null), true, "zonder alle delen gaat de lijst van id's niet mee: niets wordt \"niet gevonden\"");
  assert.equal(veel.activiteiten.size, 500, "wat al doorgegeven was, blijft: de volgende lezing vult aan");
  assert.equal(r5.g.deels, true, "de melding zegt dat een deel al bewaard kan zijn (review 2: R07)");
  // De gestrande lezing is gestopt: de volgende leest meteen opnieuw, en vult aan.
  veel.storing = null;
  const r6 = await veel.vraag(veel.gebruiker(2, "leerkracht"));
  assert.equal(r6.status, 200, r6.tekst);
  assert.equal(r6.g.lezing, 2);
  assert.equal(veel.activiteiten.size, 1200);
});

Deno.test("een verzoek blijft onder de dertig seconden van de pagina: is de tijd om, dan begint de functie niets nieuws", async () => {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 2600; i++) s.uitstap("u" + String(i).padStart(4, "0"), { datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  // Elke oproep duurt zeven seconden: na vier oproepen is de tijd om. Enkel het stoppen van de lezing volgt nog.
  s.duur = 7000;
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.ok(r.status === 503 || r.status === 502, "status " + r.status);
  assert.deepEqual(s.oproepen.map((o) => o.pad), ["/auth/v1/user", "/rest/v1/rpc/mt_mijn_account", "/rest/v1/rpc/mt_lezing_start", "/rest/v1/uitstappen", "/rest/v1/rpc/mt_lezing_stop"]);
  assert.equal(s.naarDatabank().length, 0);
});

// ---------- De oproep zelf ----------

Deno.test("enkel de pagina van de MT mag vragen, enkel met POST, en enkel om bij te werken", async () => {
  const s = school();
  const token = s.gebruiker(2, "leerkracht");
  const ander = await s.vraag(token, { oorsprong: "https://elders.voorbeeld" });
  assert.equal(ander.status, 403);
  assert.equal(ander.g.code, "oorsprong");
  assert.equal(ander.koppen.get("Access-Control-Allow-Origin"), null);
  const vooraf = await s.behandel(new Request(URL_MT + "/functions/v1/" + UITSTAPFUNCTIE, { method: "OPTIONS", headers: { Origin: OORSPRONG } }));
  assert.equal(vooraf.status, 204);
  assert.equal(vooraf.headers.get("Access-Control-Allow-Origin"), OORSPRONG);
  assert.equal(vooraf.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal((await s.vraag(token, { methode: "GET" })).status, 405);
  for (const lichaam of ["", "geen json", "[]", "null", '{"actie":"wissen"}', "{}", '{"actie":["bijwerken"]}']) {
    const r = await s.vraag(token, { lichaam });
    assert.equal(r.status, 400, "lichaam " + lichaam);
    assert.equal(r.g.code, "oproep");
  }
  assert.equal((await s.vraag(token, { lichaam: JSON.stringify({ actie: "bijwerken", vulling: "x".repeat(1200) }) })).status, 413);
  assert.equal(s.oproepen.length, 0, "een oproep die niet klopt, zet niets in gang");
});

Deno.test("zonder sleutels, of in een project dat de functie niet kent, doet ze niets", async () => {
  for (const o of [{ url: URL_MT, publiek: PUBLIEK, geheim: "" }, { url: URL_MT, publiek: "", geheim: GEHEIM }, { url: "https://ander.supabase.co", publiek: PUBLIEK, geheim: GEHEIM }]) {
    const oproepen = [];
    const behandel = maakBehandelaar({ ...o, haal: (adres) => (oproepen.push(adres), Promise.reject(new Error("mag niet"))), meld: () => undefined, nu: () => 0 });
    const antwoord = await behandel(new Request(o.url + "/functions/v1/" + UITSTAPFUNCTIE, { method: "POST", headers: { Origin: OORSPRONG }, body: '{"actie":"bijwerken"}' }));
    assert.equal(antwoord.status, 500);
    assert.equal((await antwoord.json()).code, "instelling");
    assert.equal(oproepen.length, 0);
  }
});

Deno.test("een onverwachte fout verklapt niets", async () => {
  const s = school();
  s.storing = (o) => {
    if (o.pad === "/rest/v1/rpc/mt_mijn_account") return new Response(JSON.stringify({ id: ID(2), rol: "leerkracht" }), { status: 200 });
    if (o.pad === "/rest/v1/uitstappen") return new Response(JSON.stringify([{ id: "u1", updated_at: "x", klassen: { geen: "lijst" }, datumStart: "2026-11-20" }]), { status: 200, headers: { "content-range": "0-0/1" } });
    return null;
  };
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  // Klassen die geen lijst zijn, leest norm() als geen klassen: geen fout, en niets onverwachts.
  assert.equal(r.status, 200, r.tekst);
  assert.deepEqual(s.naarDatabank()[0].lichaam.p_uitstappen[0].klassen, []);
  const kapot = school();
  kapot.storing = (o) => (o.pad === "/rest/v1/rpc/mt_uitstappen_bijwerken" ? new Response("<html>storing</html>", { status: 502 }) : null);
  const r2 = await kapot.vraag(kapot.gebruiker(2, "leerkracht"));
  assert.equal(r2.status, 500);
  assert.equal(r2.g.code, "databank");
  assert.doesNotMatch(r2.tekst, /html|storing/);
});

// ---------- De lezingen (review 2) ----------

Deno.test("binnen de dertig seconden leest de functie niet opnieuw: ze geeft de uitkomst van de laatste lezing terug (R09, R2-10)", async () => {
  const s = school();
  const eerste = await s.vraag(s.gebruiker(1, "beheerder"));
  s.oproepen.length = 0;
  s.later(5000);
  const tweede = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(tweede.status, 200, tweede.tekst);
  assert.equal(tweede.g.stand, "recent");
  assert.deepEqual(s.oproepen.map((o) => o.pad), ["/auth/v1/user", "/rest/v1/rpc/mt_mijn_account", "/rest/v1/rpc/mt_lezing_start"], "geen lezing van de uitstappentool en geen schrijven");
  // Dezelfde uitkomst, met het uur van de lezing: de pagina toont dat.
  const zonderStand = (g) => ({ ...g, stand: null });
  assert.deepEqual(zonderStand(tweede.g), zonderStand(eerste.g));
  assert.equal(tweede.g.klaar_op, eerste.g.klaar_op);
  assert.equal(s.lezingen.length, 1);
  // Na de dertig seconden volgt een nieuwe lezing.
  s.later();
  const derde = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(derde.g.stand, "klaar");
  assert.equal(derde.g.lezing, 2);
});

Deno.test("loopt er al een lezing, dan start er geen tweede: de vrager krijgt de laatste uitkomst, of nog niets", async () => {
  const s = school();
  const token = s.gebruiker(2, "leerkracht");
  // Een lezing van iemand anders is bezig, en er is nog geen vorige uitkomst.
  s.lezingen.push({ nummer: 1, stand: "bezig", begonnen: s.nu, klaar: null, door: null, tellingen: null, uitkomst: null, verouderd: false });
  const r = await s.vraag(token);
  assert.equal(r.status, 200, r.tekst);
  assert.equal(r.g.stand, "bezig");
  assert.equal(r.g.versie, VERSIE);
  assert.equal(r.g.uitstappen, undefined, "er is nog geen uitkomst om te tonen");
  assert.equal(s.naarBron().length, 0);
  assert.equal(s.naarDatabank().length, 0);
  // Bleef die lezing langer dan een minuut bezig, dan is ze afgebroken, en leest de volgende vraag zelf.
  s.later(61000);
  const later = await s.vraag(token);
  assert.equal(later.g.stand, "klaar");
  assert.equal(s.lezingen[0].stand, "afgebroken");
  assert.equal(later.g.lezing, 2);
});

Deno.test("een lezing die ingehaald is, wijzigt niets: de functie zegt het (R03, R2-08)", async () => {
  const s = school();
  // Terwijl deze lezing de uitstappentool leest, start een nieuwere: de databank breekt de oude af.
  s.storing = (o) => {
    if (o.pad === "/rest/v1/uitstappen") {
      s.lezingen[0].stand = "afgebroken";
      s.lezingen.push({ nummer: 2, stand: "bezig", begonnen: s.nu, klaar: null, door: null, tellingen: null, uitkomst: null, verouderd: false });
    }
    return null;
  };
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 409, r.tekst);
  assert.equal(r.g.code, "ingehaald");
  assert.equal(r.g.deels, false);
  assert.equal(s.activiteiten.size, 0, "een ingehaalde lezing schrijft niets");
  assert.equal(s.lezingen[1].stand, "bezig", "de nieuwere lezing loopt gewoon door");
});

Deno.test("de uitstappentool antwoordt niet: de lezing stopt, en de volgende vraag leest meteen opnieuw", async () => {
  const s = school();
  const token = s.gebruiker(2, "leerkracht");
  s.storing = (o) => (o.pad === "/rest/v1/uitstappen" ? "gooi" : null);
  const r = await s.vraag(token);
  assert.equal(r.g.code, "bron");
  assert.equal(r.g.deels, false);
  assert.deepEqual(s.oproepen.at(-1).lichaam, { p_lezing: 1, p_reden: "bron" });
  assert.equal(s.lezingen[0].stand, "afgebroken");
  s.storing = null;
  const opnieuw = await s.vraag(token);
  assert.equal(opnieuw.status, 200, opnieuw.tekst);
  assert.equal(opnieuw.g.stand, "klaar");
  // Lukt ook het stoppen niet, dan blijft de fout dezelfde: de databank breekt de lezing na een minuut zelf af.
  const stil = school();
  stil.storing = (o) => (o.pad === "/rest/v1/uitstappen" || o.pad === "/rest/v1/rpc/mt_lezing_stop" ? "gooi" : null);
  const r2 = await stil.vraag(stil.gebruiker(2, "leerkracht"));
  assert.equal(r2.status, 503);
  assert.equal(r2.g.code, "bron");
});

Deno.test("de rem: verdwijnen er meer dan vijf uitstappen tegelijk, dan neemt de MT dat niet over, en zegt de uitkomst het (B225)", async () => {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 8; i++) s.uitstap("u" + i, { v: 2, datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  const token = s.gebruiker(1, "beheerder");
  s.klassenlijst("4A");
  await s.vraag(token);
  // De uitstappentool toont er nog maar twee: zes ontbreken.
  s.bron.uitstappen.splice(2);
  s.later();
  const r = await s.vraag(token);
  assert.equal(r.status, 200, r.tekst);
  assert.equal(r.g.uitstappen.tegengehouden, 6);
  assert.equal(r.g.uitstappen.niet_gevonden, 0);
  assert.equal(r.g.verdwenen_taak, s.taken[0].id, "de pagina krijgt de taak mee, voor de knop van de beheerder");
  assert.equal([...s.activiteiten.values()].every((a) => a.stand === "actief"), true);
  // Vijf mag wel.
  const vijf = nep();
  vijf.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 8; i++) vijf.uitstap("u" + i, { v: 2, datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  const t = vijf.gebruiker(2, "leerkracht");
  await vijf.vraag(t);
  vijf.bron.uitstappen.splice(3);
  vijf.later();
  const r2 = await vijf.vraag(t);
  assert.equal(r2.g.uitstappen.niet_gevonden, 5);
  assert.equal(r2.g.uitstappen.tegengehouden, 0);
  assert.equal(r2.g.verdwenen_taak, null);
});

Deno.test("een rij in een vorm die de overgenomen code niet verwacht, legt het bijwerken niet stil (R13)", async () => {
  const s = school();
  // Iedereen kan in de uitstappentool een aanvraag toevoegen, ook buiten het scherm om.
  s.uitstap("u5", { v: 2, datumStart: ["2026-11-25"], klassen: ["4A"], planStatus: "bevestigd" });
  s.uitstap("u6", { v: 2, datumStart: "2026-11-26", klassen: Array.from({ length: 51 }, (_, i) => "K" + i), planStatus: "bevestigd" });
  s.uitstap("u7", null);
  s.uitstap("u8", "geen uitstap");
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 200, r.tekst);
  assert.deepEqual(r.g.onbruikbaar, ["u5", "u6"]);
  assert.equal(r.g.overzicht.onbruikbaar, 2);
  // Een rij zonder gegevens is een uitstap zonder datum: de databank slaat ze over als ongeldig (R2-06).
  assert.equal(r.g.overzicht.zonderDatum, 2);
  assert.equal(r.g.uitstappen.ongeldig, 2);
  const [oproep] = s.naarDatabank();
  assert.deepEqual(oproep.lichaam.p_uitstappen.map((u) => u.id), ["u1", "u2", "u3", "u4", "u7", "u8"]);
  // Hun id blijft in de lijst: niets wordt daardoor "niet gevonden".
  assert.deepEqual(oproep.lichaam.p_alle_ids, ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"]);
  assert.equal(r.g.uitstappen.nieuw, 2, "de andere uitstappen komen gewoon in de MT");
});

Deno.test("struikelt de functie toch over wat ze las, dan is er nog niets gewijzigd: ook de klassen niet (R13)", async () => {
  const s = school();
  // Een antwoord van de uitstappentool waarin een rij een id heeft die geen tekst is: de lijst is niet te vertrouwen.
  s.storing = (o) => (o.pad === "/rest/v1/uitstappen" ? new Response(JSON.stringify([{ id: 5, updated_at: "2026-11-10T08:00:00+00:00", datumStart: "2026-11-20" }]), { status: 200, headers: { "content-range": "0-0/1" } }) : null);
  const r = await s.vraag(s.gebruiker(1, "beheerder"));
  assert.equal(r.status, 502, r.tekst);
  assert.equal(r.g.code, "bron");
  assert.equal(r.g.deels, false);
  assert.equal(s.oproepen.some((o) => o.pad === "/rest/v1/rpc/mt_klassen_bijwerken"), false, "de klassen gaan pas mee als ook de uitstappen klaarstaan");
});

Deno.test("lezen op id: een rij die tussen twee bladzijden verdwijnt en een die erbij komt, laten geen bestaande uitstap wegvallen (R05, R2-04)", async () => {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 1500; i++) s.uitstap("u" + String(i).padStart(4, "0"), { v: 2, datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  let bladzijde = 0;
  s.storing = (o) => {
    // Tussen de eerste en de tweede bladzijde: de eerste rij wordt gewist, en achteraan komt er een bij.
    if (o.pad === "/rest/v1/uitstappen" && ++bladzijde === 2) {
      s.bron.uitstappen.shift();
      s.uitstap("u2000", { v: 2, datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
    }
    return null;
  };
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 200, r.tekst);
  const ids = s.naarDatabank().at(-1).lichaam.p_alle_ids;
  assert.ok(ids.includes("u1000"), "u1000 stond er heel de tijd, en is toch weggevallen");
  // Alles wat er heel de tijd stond, is gelezen; de tweede vraag ging verder vanaf de laatste id.
  for (let i = 1; i < 1500; i++) assert.ok(ids.includes("u" + String(i).padStart(4, "0")), "u" + i + " ontbreekt");
  assert.match(s.naarBron()[1].adres, /[?&]id=gt\.u0999(&|$)/);
  assert.doesNotMatch(s.naarBron().map((o) => o.adres).join(" "), /offset=/);
});

Deno.test("lezen op id: geeft de uitstappentool kleinere bladzijden dan gevraagd, dan leest de MT toch alles", async () => {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 250; i++) s.uitstap("u" + String(i).padStart(4, "0"), { v: 2, datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  s.maxRijen = 100;
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 200, r.tekst);
  assert.equal(r.g.gelezen.uitstappen, 250);
  assert.equal(s.naarBron().length, 3);
  assert.equal(s.activiteiten.size, 250);
});

Deno.test("een datum die wacht, staat in de uitkomst van de lezing (R2-12)", async () => {
  const s = school();
  const token = s.gebruiker(2, "leerkracht");
  await s.vraag(token);
  // In de MT ligt de datum van u1 vast, bv. door een bevestigde klas; in de uitstappentool verschuift ze.
  s.vast.add("u1");
  s.bron.uitstappen[0].trip.datumStart = "2026-11-27";
  s.bron.uitstappen[0].updated_at = "2026-11-15T09:00:00+00:00";
  s.later();
  const r = await s.vraag(token);
  assert.deepEqual(r.g.wacht, ["u1"]);
  assert.equal(s.activiteiten.get("u1").start, "2026-11-20", "de MT houdt de datum van toen");
  assert.equal(s.activiteiten.get("u1").gewijzigd, "2026-11-10T08:00:00+00:00", "en de versie van toen");
});

Deno.test("de nabootsing: dezelfde verwijderde stand in een nieuwere versie, klassen die geen lijst zijn, en een einddatum vóór de start", async () => {
  const s = school();
  const token = s.gebruiker(2, "leerkracht");
  await s.vraag(token);
  s.bron.uitstappen[0].trip.verwijderdOp = "2026-11-12T10:00:00.000Z";
  s.bron.uitstappen[0].updated_at = "2026-11-12T10:00:00+00:00";
  s.later();
  assert.equal((await s.vraag(token)).g.uitstappen.weg, 1);
  s.bron.uitstappen[0].updated_at = "2026-11-14T10:00:00+00:00";
  s.later();
  const r = await s.vraag(token);
  assert.equal(r.g.uitstappen.ongewijzigd, 2);
  assert.equal(s.activiteiten.get("u1").gewijzigd, "2026-11-14T10:00:00+00:00", "de MT onthoudt de versie die ze las (R04)");
  // Een meerdaagse met een einddatum vóór de start is ongeldig, zoals in de databank.
  s.uitstap("u9", { v: 2, type: "meerdaags", datumStart: "2026-12-10", datumEind: "2026-12-08", klassen: ["4A"], planStatus: "bevestigd" });
  s.later();
  const r2 = await s.vraag(token);
  assert.equal(r2.g.uitstappen.ongeldig + r2.g.overzicht.zonderDatum >= 1, true);
  assert.equal(s.activiteiten.has("u9"), false);
});

// ---------- Deels bewaard (review 2: R07) ----------

Deno.test("mislukt het bijwerken, dan zegt het antwoord of er al iets bewaard is of bewaard kan zijn (R07)", async () => {
  const leerkracht = (s) => s.gebruiker(2, "leerkracht");
  const veel = () => {
    const s = nep();
    s.schooljaar("2026-2027", "lopend", ["4A"]);
    for (let i = 0; i < 1200; i++) s.uitstap("u" + String(i).padStart(4, "0"), { v: 2, datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
    return s;
  };
  const opDeel = (s, nummer, antwoord) => {
    let nr = 0;
    s.storing = (o) => (o.pad === "/rest/v1/rpc/mt_uitstappen_bijwerken" && ++nr === nummer ? antwoord() : null);
  };

  // De databank gaf zelf een fout: ze draaide alles van die oproep terug. Er is niets bewaard.
  const geweigerd = school();
  opDeel(geweigerd, 1, () => new Response('{"code":"57014","message":"canceling statement due to statement timeout"}', { status: 500 }));
  const r1 = await geweigerd.vraag(leerkracht(geweigerd));
  assert.equal(r1.status, 503, r1.tekst);
  assert.equal(r1.g.deels, false);

  // Geen antwoord, of een antwoord van onderweg: de databank kan de oproep uitgevoerd hebben.
  for (const antwoord of [() => "gooi", () => new Response("<html>", { status: 502 }), () => new Response("", { status: 500 })]) {
    const stil = school();
    opDeel(stil, 1, antwoord);
    const r = await stil.vraag(leerkracht(stil));
    assert.equal(r.g.code, "databank", r.tekst);
    assert.equal(r.g.deels, true, r.tekst);
  }

  // Een goed antwoord dat de functie niet kan lezen: de databank voerde de oproep uit.
  const onleesbaar = school();
  opDeel(onleesbaar, 1, () => new Response("null", { status: 200 }));
  const r2 = await onleesbaar.vraag(leerkracht(onleesbaar));
  assert.equal(r2.status, 500, r2.tekst);
  assert.equal(r2.g.deels, true);

  // De oproep raakte er niet door: niets bewaard.
  for (const [status, lichaam] of [[401, ""], [404, "{}"]]) {
    const dicht = school();
    opDeel(dicht, 1, () => new Response(lichaam, { status }));
    const r = await dicht.vraag(leerkracht(dicht));
    assert.equal(r.g.deels, false, r.tekst);
  }

  // Het eerste deel is bewaard; het tweede weigert de databank. Een deel is dus bewaard.
  const half = veel();
  opDeel(half, 2, () => new Response('{"code":"57014","message":"canceling statement"}', { status: 500 }));
  const r3 = await half.vraag(leerkracht(half));
  assert.equal(r3.status, 503, r3.tekst);
  assert.equal(r3.g.deels, true);
  assert.equal(half.activiteiten.size, 500);

  // De klassen zijn bijgewerkt, en de uitstappen weigert de databank: de klassen zijn bewaard.
  const metKlassen = school();
  opDeel(metKlassen, 1, () => new Response('{"code":"MT422","message":"MT: dat kan niet"}', { status: 400 }));
  const r4 = await metKlassen.vraag(metKlassen.gebruiker(1, "beheerder"));
  assert.equal(r4.status, 422, r4.tekst);
  assert.equal(metKlassen.klassen.get("2026-2027").has("1KA"), true);
  assert.equal(r4.g.deels, true);
  // Een tweede keer wijzigt er aan de klassen niets meer: dan is er ook niets bewaard.
  const beheerder = metKlassen.gebruiker(1, "beheerder");
  opDeel(metKlassen, 1, () => new Response('{"code":"MT422","message":"MT: dat kan niet"}', { status: 400 }));
  const r5 = await metKlassen.vraag(beheerder);
  assert.equal(r5.status, 422, r5.tekst);
  assert.equal(r5.g.deels, false);
});

Deno.test("een onverwachte fout na een bewaard deel: het antwoord verklapt niets, maar zegt wel dat een deel bewaard is (R07)", async () => {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 1200; i++) s.uitstap("u" + String(i).padStart(4, "0"), { v: 2, datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  // De klok van de functie valt uit zodra het eerste deel onderweg is: het tweede deel begint niet.
  let kapot = false;
  let nr = 0;
  s.storing = (o) => {
    if (o.pad === "/rest/v1/rpc/mt_uitstappen_bijwerken" && ++nr === 1) kapot = true;
    return null;
  };
  const logboek = [];
  const behandel = maakBehandelaar({
    url: URL_MT, publiek: PUBLIEK, geheim: GEHEIM, haal: s.haal, meld: (regel) => logboek.push(regel),
    nu: () => {
      if (kapot) throw new RangeError("de klok met een geheim erin");
      return s.nu;
    },
  });
  const antwoord = await behandel(new Request(URL_MT + "/functions/v1/" + UITSTAPFUNCTIE, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: OORSPRONG, Authorization: "Bearer " + s.gebruiker(2, "leerkracht") }, body: '{"actie":"bijwerken"}',
  }));
  const tekst = await antwoord.text();
  assert.equal(antwoord.status, 500, tekst);
  assert.deepEqual(JSON.parse(tekst), { ok: false, code: "onverwacht", melding: "De serverfunctie gaf een onverwachte fout.", deels: true });
  assert.equal(s.activiteiten.size, 500, "het eerste deel is bewaard");
  assert.deepEqual(logboek, [{ resultaat: "onverwacht", soort: "RangeError", wie: ID(2) }]);
  assert.doesNotMatch(tekst + JSON.stringify(logboek), /geheim/);
});

Deno.test("het toegangsbewijs telt enkel als Supabase het aanvaardt: een ander antwoord dan 200 is geen aanmelding, ook met een id erin (review 2: R2-20)", async () => {
  for (const status of [201, 206, 301, 400, 401, 403, 404]) {
    const s = school();
    s.storing = (o) => (o.pad === "/auth/v1/user" ? new Response(JSON.stringify({ id: ID(2), email: "proef@school.voorbeeld" }), { status }) : null);
    const r = await s.vraag(s.gebruiker(2, "leerkracht"));
    assert.deepEqual([r.status, r.g.code], [401, "sessie"], "status " + status + ": " + r.tekst);
    assert.deepEqual(s.oproepen.map((o) => o.pad), ["/auth/v1/user"], "na een geweigerd toegangsbewijs ging de functie toch verder");
  }
  // Een antwoord 200 zonder bruikbare id is ook geen aanmelding.
  for (const lichaam of [{}, { id: "geen-uuid" }, { id: 5 }, null, []]) {
    const s = school();
    s.storing = (o) => (o.pad === "/auth/v1/user" ? new Response(JSON.stringify(lichaam), { status: 200 }) : null);
    const r = await s.vraag(s.gebruiker(2, "leerkracht"));
    assert.deepEqual([r.status, r.g.code], [401, "sessie"], JSON.stringify(lichaam));
  }
});
