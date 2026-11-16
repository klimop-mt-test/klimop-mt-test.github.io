// MT · tests/uitstapfunctie_test.js
// De serverfunctie voor de uitstappen (functies/mt-uitstappen), tegen een nagebootste Supabase en een
// nagebootste uitstappentool. Er gaat niets over het netwerk. Wat de test bewaakt (17.4, B212):
//   - de functie gebruikt dezelfde tekst als code/adapter.js, woord voor woord;
//   - de secret key gaat enkel naar het eigen project, enkel voor mt_uitstappen_bijwerken, en staat
//     nooit in een antwoord of in het logboek; naar de uitstappentool gaat enkel haar eigen
//     publishable key, nooit de secret key en nooit het toegangsbewijs van de vrager;
//   - wie mag vragen, beslist de databank, met het toegangsbewijs van de vrager zelf;
//   - de klassen gaan vóór de uitstappen, en enkel bij een beheerder, met zijn eigen toegangsbewijs;
//   - de uitstappen gaan in delen, met de volledige lijst van id's bij het laatste deel;
//   - lukt het lezen niet, of niet volledig, dan wijzigt er niets.
// De databankfunctie zelf wordt nagekeken in tests/databank/proef.sql; hier staat een nabootsing die
// sql/005_review1.sql volgt.

import assert from "node:assert/strict";
import { REKENVERSIE } from "../code/rekenen.js";
import { alleOmgevingen, omgeving, UITSTAPFUNCTIE, UITSTAPFUNCTIE_VERSIE, UITSTAPPENTOOL as BRON_IN_CONFIG } from "../code/config.js";
import { bestaat, CODE, lees } from "./hulp.js";
import { maakBehandelaar, magNaarBron, PAGINA, UITSTAPPENTOOL, VERSIE } from "../functies/mt-uitstappen/index.ts";

const URL_MT = "https://ayszixqnuktogzjtreyy.supabase.co";
const OORSPRONG = PAGINA[URL_MT];
const PUBLIEK = "sb_publishable_voorbeeld";
const GEHEIM = ["sb", "secret", "enkelvoordetest"].join("_");
const ID = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
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

// ---------- De nagebootste Supabase en de nagebootste uitstappentool ----------

function b64(tekst) {
  return btoa(tekst).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const schooljaarVan = (datum) => {
  const jaar = Number(datum.slice(0, 4));
  return Number(datum.slice(5, 7)) >= 9 ? jaar + "-" + (jaar + 1) : jaar - 1 + "-" + jaar;
};

function nep() {
  const s = {
    nu: Date.parse("2026-11-16T08:00:00Z"),
    /** Elke oproep duurt zo lang: om een traag netwerk na te bootsen. */
    duur: 5,
    oproepen: [],
    logboek: [],
    sessies: new Map(), // token → id van de gebruiker
    gebruikers: new Map(), // id → { rol }
    jaren: new Map(), // schooljaar → stand
    klassen: new Map(), // schooljaar → Set van namen
    activiteiten: new Map(), // uitstap → { gewijzigd, stand, schooljaar }
    bron: { uitstappen: [], instellingen: [] },
    storing: null, // (oproep) → Response, "gooi" of niets
  };

  s.gebruiker = (n, rol) => {
    s.gebruikers.set(ID(n), { rol });
    const token = b64('{"alg":"ES256"}') + "." + b64(JSON.stringify({ sub: ID(n) })) + "." + b64("handtekening" + n);
    s.sessies.set(token, ID(n));
    return token;
  };
  s.uitstap = (id, trip, gewijzigd = "2026-11-10T08:00:00+00:00") => {
    s.bron.uitstappen.push({ id, nr: s.bron.uitstappen.length + 1, schooljaar: "", updated_at: gewijzigd, trip });
  };
  s.klassenlijst = (...namen) => {
    s.bron.instellingen = [{ id: "klimop", data: { klassen: namen.map((naam, i) => ({ id: "k" + i, naam, groep: /K/.test(naam) ? "Kleuter" : "Lager" })) } }];
  };
  s.schooljaar = (jaar, stand, namen = []) => {
    s.jaren.set(jaar, stand);
    s.klassen.set(jaar, new Set(namen));
  };

  const json = (status, lichaam, koppen = {}) => new Response(JSON.stringify(lichaam), { status, headers: { "Content-Type": "application/json", ...koppen } });
  const pg = (code, message, status = 400) => Object.assign(new Error(message), { antwoord: json(status, { code, message: "MT: " + message }) });

  /** Eén uitstap, zoals mt_intern.uitstap_bijwerken in 005. */
  function uitstapBijwerken(p) {
    const geldig = typeof p.id === "string" && p.id.length >= 1 && p.id.length <= 60 && typeof p.gewijzigd === "string" && !Number.isNaN(Date.parse(p.gewijzigd))
      && typeof p.datumStart === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.datumStart) && ["aangevraagd", "bevestigd", "geannuleerd"].includes(p.planStatus)
      && Date.parse(p.gewijzigd) <= s.nu + 5 * 60000 && Array.isArray(p.klassen);
    if (!geldig) return { wat: "ongeldig", uitstap: p.id };
    const weg = p.categorie === "nascholing" ? "nascholing" : p.verwijderd === true ? "verwijderd" : null;
    const jaar = schooljaarVan(p.datumStart);
    const onbekend = () => p.klassen.filter((naam) => !(s.klassen.get(jaar) ?? new Set()).has(naam));
    const act = s.activiteiten.get(p.id);
    if (!act) {
      if (weg) return { wat: "geen", uitstap: p.id };
      if (!["lopend", "voorbij"].includes(s.jaren.get(jaar))) return { wat: "buiten", uitstap: p.id };
      s.activiteiten.set(p.id, { gewijzigd: p.gewijzigd, stand: "actief", schooljaar: jaar, plan: p.planStatus, start: p.datumStart });
      return { wat: "nieuw", uitstap: p.id, onbekend: onbekend() };
    }
    if (Date.parse(p.gewijzigd) < Date.parse(act.gewijzigd)) return { wat: "ouder", uitstap: p.id };
    if (s.jaren.get(act.schooljaar) === "afgesloten") return { wat: "gesloten", uitstap: p.id };
    if (weg) {
      if (act.stand === weg) return { wat: "ongewijzigd", uitstap: p.id };
      Object.assign(act, { stand: weg, gewijzigd: p.gewijzigd });
      return { wat: "weg", uitstap: p.id };
    }
    const wijzigt = act.stand !== "actief" || act.plan !== p.planStatus || act.start !== p.datumStart || act.gewijzigd !== p.gewijzigd;
    Object.assign(act, { stand: "actief", plan: p.planStatus, start: p.datumStart, gewijzigd: p.gewijzigd });
    return { wat: wijzigt ? "gewijzigd" : "ongewijzigd", uitstap: p.id, onbekend: onbekend() };
  }

  const functies = {
    mt_mijn_account(_a, ctx) {
      const g = ctx.gebruiker ? s.gebruikers.get(ctx.gebruiker) : null;
      if (!g) throw pg("42501", "dit account heeft geen toegang tot de MT", 403);
      const lopend = [...s.jaren].find(([, stand]) => stand === "lopend");
      return { id: ctx.gebruiker, naam: "Proef", rol: g.rol, schooljaar: lopend ? lopend[0] : null, klassen: [], instellingen: {} };
    },
    mt_klassen_bijwerken(a, ctx) {
      const g = ctx.gebruiker ? s.gebruikers.get(ctx.gebruiker) : null;
      if (!g || g.rol !== "beheerder") throw pg("42501", "geen rechten voor deze handeling", 403);
      const lopend = [...s.jaren].find(([, stand]) => stand === "lopend");
      if (!lopend) throw pg("MT422", "er is nog geen lopend schooljaar");
      if (!Array.isArray(a.p_klassen) || a.p_klassen.length < 1) throw pg("MT422", "de klassenlijst is leeg of klopt niet. Er is niets gewijzigd.");
      a.p_klassen.forEach((k, i) => {
        if (typeof k.id !== "string" || !k.naam || !["Kleuter", "Lager", "Andere"].includes(k.groep)) throw pg("MT422", "klas " + (i + 1) + " in de klassenlijst klopt niet. Er is niets gewijzigd.");
      });
      const set = s.klassen.get(lopend[0]);
      let nieuw = 0;
      for (const k of a.p_klassen) {
        if (!set.has(k.naam)) nieuw++;
        set.add(k.naam);
      }
      return { schooljaar: lopend[0], nieuw, gewijzigd: 0, uitgezet: 0 };
    },
    mt_uitstappen_bijwerken(a, ctx) {
      if (ctx.rol !== "service_role") throw pg("42501", "enkel voor de serverfunctie", 403);
      if (!Array.isArray(a.p_uitstappen) || a.p_uitstappen.length > 5000) throw pg("22023", "de lijst van uitstappen klopt niet");
      const tel = { nieuw: 0, gewijzigd: 0, weg: 0, ongewijzigd: 0, ongeldig: 0, buiten: 0, geen: 0, gesloten: 0, ouder: 0 };
      const onbekend = [];
      for (const p of a.p_uitstappen) {
        const r = uitstapBijwerken(p);
        tel[r.wat]++;
        if (r.onbekend && r.onbekend.length) onbekend.push({ uitstap: r.uitstap, klassen: r.onbekend });
      }
      let weg = 0;
      if (a.p_alle_ids !== null && a.p_alle_ids !== undefined) {
        const open = [...s.activiteiten].filter(([, act]) => ["lopend", "voorbij"].includes(s.jaren.get(act.schooljaar)));
        if (a.p_alle_ids.length === 0 && open.some(([, act]) => act.stand === "actief")) {
          throw pg("MT422", "de uitstappentool gaf geen enkele uitstap terug. Dat is een fout, geen resultaat; er is niets gewijzigd.");
        }
        for (const [id, act] of open) {
          if (act.stand !== "niet_gevonden" && !a.p_alle_ids.includes(id)) {
            act.stand = "niet_gevonden";
            weg++;
          }
        }
      }
      return { ...tel, niet_gevonden: weg, onbekende_klassen: onbekend, wacht: [] };
    },
  };

  /** De Data API van de uitstappentool: bladzijden, een totaal en korte kolommen. */
  function bron(url) {
    const tabel = url.pathname.replace("/rest/v1/", "");
    if (!Object.prototype.hasOwnProperty.call(s.bron, tabel)) return json(404, { message: "bestaat niet" });
    let rijen = s.bron[tabel];
    const id = url.searchParams.get("id");
    if (id) rijen = rijen.filter((r) => "eq." + r.id === id);
    rijen = [...rijen].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const vanaf = Number(url.searchParams.get("offset"));
    const stuk = rijen.slice(vanaf, vanaf + Number(url.searchParams.get("limit"))).map((r) => {
      const uit = {};
      for (const kolom of url.searchParams.get("select").split(",")) {
        const m = /^(\w+):trip->(\w+)$/.exec(kolom);
        if (m) uit[m[1]] = r.trip && r.trip[m[2]] !== undefined ? r.trip[m[2]] : null;
        else uit[kolom] = r[kolom] === undefined ? null : r[kolom];
      }
      return uit;
    });
    return json(stuk.length < rijen.length ? 206 : 200, stuk, { "content-range": (stuk.length ? vanaf + "-" + (vanaf + stuk.length - 1) : "*") + "/" + rijen.length });
  }

  s.haal = (adres, opties) => {
    const url = new URL(adres);
    const koppen = new Headers(opties.headers);
    const lichaam = opties.body ? JSON.parse(opties.body) : null;
    const oproep = { adres, host: url.origin, pad: url.pathname, methode: opties.method, sleutel: koppen.get("apikey"), drager: koppen.get("Authorization"), lichaam, opties };
    s.oproepen.push(oproep);
    s.nu += s.duur;
    if (s.storing) {
      const eigen = s.storing(oproep);
      if (eigen === "gooi") return Promise.reject(new TypeError("geen netwerk"));
      if (eigen) return Promise.resolve(eigen);
    }
    if (url.origin === UITSTAPPENTOOL.url) {
      if (oproep.sleutel !== UITSTAPPENTOOL.sleutel) return Promise.resolve(json(401, { message: "Invalid API key" }));
      return Promise.resolve(bron(url));
    }
    if (url.origin !== URL_MT) return Promise.reject(new TypeError("onbekend adres: " + adres));
    if (oproep.sleutel !== PUBLIEK && oproep.sleutel !== GEHEIM) return Promise.resolve(json(401, { message: "Invalid API key" }));
    const drager = (oproep.drager ?? "").replace(/^Bearer /, "");
    if (url.pathname === "/auth/v1/user") {
      const id = s.sessies.get(drager);
      return Promise.resolve(id ? json(200, { id, email: "proef@school.voorbeeld" }) : json(403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" }));
    }
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);
    if (!m || !Object.prototype.hasOwnProperty.call(functies, m[1]) || opties.method !== "POST") return Promise.resolve(json(404, { code: "PGRST202", message: "bestaat niet" }));
    const ctx = drager === GEHEIM && oproep.sleutel === GEHEIM ? { rol: "service_role", gebruiker: null } : { rol: "authenticated", gebruiker: s.sessies.get(drager) ?? null };
    if (ctx.rol === "authenticated" && !ctx.gebruiker) return Promise.resolve(json(401, { code: "PGRST301", message: "JWT expired" }));
    try {
      return Promise.resolve(json(200, functies[m[1]](lichaam ?? {}, ctx)));
    } catch (fout) {
      if (fout.antwoord) return Promise.resolve(fout.antwoord);
      throw fout;
    }
  };

  s.behandel = maakBehandelaar({ url: URL_MT, publiek: PUBLIEK, geheim: GEHEIM, haal: s.haal, meld: (regel) => s.logboek.push(regel), nu: () => s.nu });
  s.vraag = async (token, { lichaam = { actie: "bijwerken" }, methode = "POST", oorsprong = OORSPRONG } = {}) => {
    const koppen = { "Content-Type": "application/json" };
    if (oorsprong) koppen.Origin = oorsprong;
    if (token) koppen.Authorization = "Bearer " + token;
    const antwoord = await s.behandel(new Request(URL_MT + "/functions/v1/" + UITSTAPFUNCTIE, { method: methode, headers: koppen, body: methode === "POST" ? (typeof lichaam === "string" ? lichaam : JSON.stringify(lichaam)) : undefined }));
    const tekst = await antwoord.text();
    return { status: antwoord.status, koppen: antwoord.headers, tekst, g: tekst ? JSON.parse(tekst) : null };
  };
  s.naarDatabank = () => s.oproepen.filter((o) => o.pad === "/rest/v1/rpc/mt_uitstappen_bijwerken");
  s.naarBron = () => s.oproepen.filter((o) => o.host === UITSTAPPENTOOL.url);
  return s;
}

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
  assert.deepEqual(r.g.uitstappen, { nieuw: 2, gewijzigd: 0, weg: 0, ongewijzigd: 0, ongeldig: 0, buiten: 1, geen: 1, gesloten: 0, ouder: 0, niet_gevonden: 0 });
  // 1KA kent de MT nog niet: enkel een beheerder werkt de klassen bij.
  assert.deepEqual(r.g.onbekende_klassen, [{ uitstap: "u2", klassen: ["1KA"] }]);
  assert.deepEqual(r.g.onbekende_versie, []);
  assert.ok(Number.isInteger(r.g.duur_ms) && r.g.duur_ms > 0);
  assert.deepEqual(s.oproepen.map((o) => o.pad), ["/auth/v1/user", "/rest/v1/rpc/mt_mijn_account", "/rest/v1/uitstappen", "/rest/v1/rpc/mt_uitstappen_bijwerken"]);
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
  assert.deepEqual(oproep.lichaam, {
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
  const tweede = await s.vraag(token);
  assert.deepEqual(tweede.g.uitstappen, { nieuw: 0, gewijzigd: 0, weg: 0, ongewijzigd: 2, ongeldig: 0, buiten: 1, geen: 1, gesloten: 0, ouder: 0, niet_gevonden: 0 });
  // u1 wijzigt in de uitstappentool, en u2 verdwijnt er.
  s.bron.uitstappen[0].updated_at = "2026-11-15T09:00:00+00:00";
  s.bron.uitstappen[0].trip.planStatus = "geannuleerd";
  s.bron.uitstappen.splice(1, 1);
  const derde = await s.vraag(token);
  assert.deepEqual(derde.g.uitstappen, { nieuw: 0, gewijzigd: 1, weg: 0, ongewijzigd: 0, ongeldig: 0, buiten: 1, geen: 1, gesloten: 0, ouder: 0, niet_gevonden: 1 });
  assert.equal(s.activiteiten.get("u2").stand, "niet_gevonden");
});

Deno.test("nog geen lopend schooljaar: de functie zegt het, en de uitstappen wachten", async () => {
  const s = school();
  s.jaren.clear();
  const r = await s.vraag(s.gebruiker(1, "beheerder"));
  assert.equal(r.status, 200, r.tekst);
  assert.deepEqual(r.g.klassen, { ok: false, melding: "er is nog geen lopend schooljaar" });
  assert.deepEqual(r.g.uitstappen, { nieuw: 0, gewijzigd: 0, weg: 0, ongewijzigd: 0, ongeldig: 0, buiten: 3, geen: 1, gesloten: 0, ouder: 0, niet_gevonden: 0 });
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
  for (const [antwoord, status, code] of [
    [() => new Response('{"code":"55P03","message":"lock timeout"}', { status: 500 }), 503, "databank"],
    [() => new Response('{"code":"42501","message":"MT: geen rechten voor deze handeling"}', { status: 403 }), 403, "rechten"],
    [() => "gooi", 503, "databank"],
    [() => new Response("<html>", { status: 502 }), 500, "databank"],
  ]) {
    const s = school();
    s.storing = (o) => (o.pad === "/rest/v1/rpc/mt_klassen_bijwerken" ? antwoord() : null);
    const r = await s.vraag(s.gebruiker(1, "beheerder"));
    assert.equal(r.status, status, r.tekst);
    assert.equal(r.g.code, code);
    assert.equal(s.naarDatabank().length, 0, "na een mislukte bijwerking van de klassen gaat er niets naar de uitstappen");
  }
});

Deno.test("is de tijd om tijdens het bijwerken, dan vertrekt er geen deel meer naar de databank", async () => {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 1500; i++) s.uitstap("u" + String(i).padStart(4, "0"), { datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  // Elke oproep duurt zeven seconden: na het lezen van de twee bladzijden is de tijd van het verzoek om.
  s.duur = 7000;
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.equal(r.status, 503, r.tekst);
  assert.equal(r.g.code, "databank");
  assert.deepEqual(s.oproepen.map((o) => o.pad), ["/auth/v1/user", "/rest/v1/rpc/mt_mijn_account", "/rest/v1/uitstappen", "/rest/v1/uitstappen"]);
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
  assert.ok(s.oproepen.length >= 6);
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
        assert.equal(o.pad, "/rest/v1/rpc/mt_uitstappen_bijwerken", "de secret key dient voor iets anders dan mt_uitstappen_bijwerken");
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
  assert.deepEqual(s.logboek, [{ resultaat: "gelukt", gelezen: 4, duur_ms: r.g.duur_ms }]);
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
  const adres = UITSTAPPENTOOL.url + "/rest/v1/uitstappen?select=id&order=id.asc&limit=1000&offset=0";
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
  assert.deepEqual(leeg.naarDatabank().map((o) => o.lichaam), [{ p_uitstappen: [], p_alle_ids: [] }]);
  // Kent de MT al uitstappen, dan is een lege uitstappentool een fout, geen resultaat (17.3).
  const s = school();
  const token = s.gebruiker(2, "leerkracht");
  await s.vraag(token);
  s.bron.uitstappen = [];
  const fout = await s.vraag(token);
  assert.equal(fout.status, 422);
  assert.equal(fout.g.code, "kan_niet");
  assert.match(fout.g.melding, /geen enkele uitstap/);
  assert.equal(s.activiteiten.get("u1").stand, "actief", "er is niets gewijzigd");
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
  assert.match(r4.g.melding, /005_review1/);

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
});

Deno.test("een verzoek blijft onder de dertig seconden van de pagina: is de tijd om, dan begint de functie niets nieuws", async () => {
  const s = nep();
  s.schooljaar("2026-2027", "lopend", ["4A"]);
  for (let i = 0; i < 2600; i++) s.uitstap("u" + String(i).padStart(4, "0"), { datumStart: "2026-11-20", klassen: ["4A"], planStatus: "bevestigd" });
  // Elke oproep duurt zeven seconden: na drie oproepen is er nog tijd, na vier niet meer.
  s.duur = 7000;
  const r = await s.vraag(s.gebruiker(2, "leerkracht"));
  assert.ok(r.status === 503 || r.status === 502, "status " + r.status);
  assert.ok(s.oproepen.length <= 4, "de functie begon nog " + s.oproepen.length + " oproepen");
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
