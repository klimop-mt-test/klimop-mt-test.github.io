// MT · tests/data_test.js
// De REST-laag: de publishable key enkel als apikey, en een begrijpelijke reden bij een fout.
// fetch wordt nagebootst; er gaat niets over het netwerk.

import assert from "node:assert/strict";
import { ping, redenVoor, stel } from "../code/data.js";

const PROJECT = { mt: { url: "https://voorbeeldvoorbeeldvoorb.supabase.co", sleutel: "sb_publishable_voorbeeld" } };

async function metFetch(nabootsing, werk) {
  const echt = globalThis.fetch;
  globalThis.fetch = nabootsing;
  try {
    return await werk();
  } finally {
    globalThis.fetch = echt;
  }
}

Deno.test("ping: true is verbonden, en de sleutel gaat enkel als apikey mee", async () => {
  stel(PROJECT);
  let gezien = null;
  const r = await metFetch(async (url, opties) => {
    gezien = { url, opties };
    return new Response("true", { status: 200 });
  }, ping);
  assert.deepEqual(r, { ok: true, reden: null });
  assert.equal(gezien.url, PROJECT.mt.url + "/rest/v1/rpc/mt_ping");
  assert.equal(gezien.opties.method, "GET");
  assert.equal(gezien.opties.headers.apikey, PROJECT.mt.sleutel);
  assert.equal("Authorization" in gezien.opties.headers, false, "de sleutel ging mee als Bearer");
  assert.equal(gezien.opties.cache, "no-store");
  assert.equal(gezien.opties.credentials, "omit");
});

Deno.test("ping: zonder pingfunctie zegt de MT welk script ontbreekt", async () => {
  stel(PROJECT);
  const r = await metFetch(async () => new Response('{"code":"PGRST202"}', { status: 404 }), ping);
  assert.equal(r.ok, false);
  assert.match(r.reden, /001_basis\.sql/);
});

Deno.test("ping: een ander antwoord dan true is geen verbinding", async () => {
  stel(PROJECT);
  const r = await metFetch(async () => new Response("false", { status: 200 }), ping);
  assert.equal(r.ok, false);
  assert.match(r.reden, /onverwacht/);
});

Deno.test("ping: zonder netwerk een duidelijke reden, en geen uitzondering", async () => {
  stel(PROJECT);
  const r = await metFetch(async () => {
    throw new TypeError("Failed to fetch");
  }, ping);
  assert.deepEqual(r, { ok: false, reden: "de databank is niet bereikbaar" });
});

Deno.test("redenVoor: de sleutel, een fout van de databank, en de rest", () => {
  assert.match(redenVoor(401), /sleutel/);
  assert.match(redenVoor(403), /rechten/);
  assert.match(redenVoor(503), /fout \(503\)/);
  assert.match(redenVoor(418), /onverwacht/);
});

// ---------- De databankfuncties en de serverfunctie (stap 2) ----------

import { rpc, serverfunctie, stelToken } from "../code/data.js";

const json = (status, lichaam, koppen = {}) => new Response(JSON.stringify(lichaam), { status, headers: { "Content-Type": "application/json", ...koppen } });

Deno.test("rpc: als wie aangemeld is, met het toegangsbewijs als Bearer en de sleutel enkel als apikey", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("kop.inhoud.handtekening"));
  let gezien = null;
  const r = await metFetch(async (url, opties) => {
    gezien = { url, opties };
    return json(200, { naam: "Proef" });
  }, () => rpc("mt_mijn_account"));
  assert.deepEqual(r, { ok: true, gegevens: { naam: "Proef" } });
  assert.equal(gezien.url, PROJECT.mt.url + "/rest/v1/rpc/mt_mijn_account");
  assert.equal(gezien.opties.method, "POST");
  assert.equal(gezien.opties.headers.apikey, PROJECT.mt.sleutel);
  assert.equal(gezien.opties.headers.Authorization, "Bearer kop.inhoud.handtekening");
  assert.equal(gezien.opties.body, "{}");
  assert.equal(gezien.opties.credentials, "omit");
});

Deno.test("rpc: zonder aanmelding gaat er niets naar de databank", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve(null));
  let opgeroepen = 0;
  const r = await metFetch(async () => (opgeroepen++, json(200, {})), () => rpc("mt_mijn_account"));
  assert.equal(r.ok, false);
  assert.equal(r.soort, "sessie");
  assert.equal(opgeroepen, 0);
});

Deno.test("rpc: de soort fout volgt uit de code van de databank, en de tekst is die van de databank (64.4)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const gevallen = [
    [403, { code: "42501", message: "MT: geen rechten voor deze handeling" }, "rechten", "Geen rechten voor deze handeling."],
    [400, { code: "MT409", message: "MT: de lijst wijzigde intussen." }, "gewijzigd", "De lijst wijzigde intussen."],
    [400, { code: "MT422", message: "MT: enkel een leerkracht heeft klassen" }, "kan_niet", "Enkel een leerkracht heeft klassen."],
    [400, { code: "MT429", message: "MT: te veel pogingen na elkaar." }, "te_veel", "Te veel pogingen na elkaar."],
    [400, { code: "22023", message: "MT: deze accounthandeling klopt niet" }, "oproep", "Deze accounthandeling klopt niet."],
    [401, { code: "PGRST301", message: "JWT expired" }, "sessie", "Je sessie is verlopen. Meld opnieuw aan."],
    [403, { code: "42501", message: "permission denied for function mt_account_stand" }, "rechten", "Je hebt geen rechten voor deze handeling."],
    [404, { code: "PGRST202", message: "Could not find the function" }, "ontbreekt", "De databank kent deze functie niet: een SQL-script is nog niet uitgevoerd."],
    [500, { code: "XX000", message: "relation \"geheim\" does not exist" }, "fout", "De databank gaf een fout. Probeer het opnieuw."],
  ];
  for (const [status, lichaam, soort, tekst] of gevallen) {
    const r = await metFetch(async () => json(status, lichaam), () => rpc("mt_iets", { p_x: 1 }));
    assert.deepEqual([r.ok, r.soort, r.tekst, r.status], [false, soort, tekst, status], JSON.stringify(lichaam));
  }
  const weg = await metFetch(async () => {
    throw new TypeError("Failed to fetch");
  }, () => rpc("mt_iets"));
  assert.equal(weg.soort, "verbinding");
});

Deno.test("serverfunctie: de handeling in het lichaam, het toegangsbewijs als Bearer", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  let gezien = null;
  const r = await metFetch(async (url, opties) => {
    gezien = { url, opties };
    return json(200, { ok: true, versie: "0.6.0", bekend: true });
  }, () => serverfunctie("stand"));
  assert.equal(r.ok, true);
  assert.equal(r.gegevens.bekend, true);
  assert.equal(gezien.url, PROJECT.mt.url + "/functions/v1/mt-accounts");
  assert.deepEqual(JSON.parse(gezien.opties.body), { actie: "stand" });
  assert.equal(gezien.opties.headers.Authorization, "Bearer a.b.c");
  assert.equal(gezien.opties.headers.apikey, PROJECT.mt.sleutel);
  const met = await metFetch(async (url, opties) => {
    gezien = { url, opties };
    return json(200, { ok: true });
  }, () => serverfunctie("uitschakelen", { operatie: "x", gebruiker: "y", actie: "aanmaken" }));
  assert.equal(met.ok, true);
  assert.equal(JSON.parse(gezien.opties.body).actie, "uitschakelen", "de invoer kon de handeling overschrijven");
});

Deno.test("serverfunctie: de soort en de tekst van de functie, en wat er scheelt als ze er niet is", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const gevallen = [
    [422, { ok: false, code: "kan_niet", melding: "Kies een ander wachtwoord dan je tijdelijke wachtwoord.", geblokkeerd: false }, "kan_niet", /ander wachtwoord/, false],
    [403, { ok: false, code: "rechten", melding: "geen rechten voor deze handeling" }, "rechten", /^Geen rechten voor deze handeling\.$/, false],
    [401, { ok: false, code: "sessie", melding: "Je sessie is verlopen. Meld opnieuw aan." }, "sessie", /verlopen/, false],
    [502, { ok: false, code: "supabase", melding: "Supabase stelde het wachtwoord niet in.", geblokkeerd: true }, "fout", /stelde het wachtwoord niet in/, true],
    [401, { code: 401, message: "Invalid JWT" }, "sessie", /verlopen/, false],
    [404, { code: "NOT_FOUND", message: "Requested function was not found" }, "ontbreekt", /mt-accounts staat nog niet in Supabase/, false],
    [500, null, "fout", /serverfunctie gaf een fout \(500\)/, false],
    [200, { ok: false }, "fout", /serverfunctie gaf een fout \(200\)/, false],
  ];
  for (const [status, lichaam, soort, tekst, geblokkeerd] of gevallen) {
    const r = await metFetch(async () => (lichaam === null ? new Response("", { status }) : json(status, lichaam)), () => serverfunctie("stand"));
    assert.equal(r.ok, false, JSON.stringify(lichaam));
    assert.equal(r.soort, soort, JSON.stringify(lichaam));
    assert.match(r.tekst, tekst);
    assert.equal(r.extra.geblokkeerd === true, geblokkeerd);
  }
  stelToken(() => Promise.resolve(null));
  assert.equal((await serverfunctie("stand")).soort, "sessie");
});

// ---------- Tabellen lezen (stap 2b) ----------

import { lees as leesTabel } from "../code/data.js";

Deno.test("lezen: kolommen en filters in de vraag, op de sleutel van de tabel, en een waarde wijzigt nooit de vraag zelf", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  let gezien = null;
  const r = await metFetch(async (url, opties) => {
    gezien = { url, opties };
    return json(200, [{ id: 1, naam: "4A", volgorde: 2 }], { "Content-Range": "0-0/1" });
  }, () => leesTabel("klassen", { kolommen: ["id", "naam", "volgorde"], waar: { schooljaar: "2026-2027", actief: true, id: ["a,b", 'c"d', "e)f"], leerjaar: null }, volgorde: ["volgorde", "id"] }));
  assert.deepEqual(r, { ok: true, gegevens: [{ id: 1, naam: "4A", volgorde: 2 }] });
  const u = new URL(gezien.url);
  assert.equal(u.origin + u.pathname, PROJECT.mt.url + "/rest/v1/klassen");
  assert.equal(u.searchParams.get("select"), "id,naam,volgorde");
  assert.equal(u.searchParams.get("schooljaar"), "eq.2026-2027");
  assert.equal(u.searchParams.get("actief"), "eq.true");
  assert.equal(u.searchParams.get("id"), 'in.("a,b","c\\"d","e)f")');
  assert.equal(u.searchParams.get("leerjaar"), "is.null");
  // De MT leest op de sleutel van de tabel, en sorteert zelf: de volgorde van het scherm staat niet in de vraag.
  assert.equal(u.searchParams.get("order"), "id.asc");
  assert.equal(u.searchParams.get("limit"), "1000");
  assert.equal(u.searchParams.has("offset"), false, "de MT leest niet meer op een aantal rijen (review 2: R06)");
  assert.equal(gezien.opties.headers.Prefer, "count=exact");
  assert.equal(gezien.opties.headers.Authorization, "Bearer a.b.c");
  assert.equal(gezien.opties.headers.apikey, PROJECT.mt.sleutel);
});

Deno.test("lezen: een naam die geen naam is, gaat nooit naar de databank", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  let opgeroepen = 0;
  const fout = [
    ["gebruikers?select=*", { kolommen: ["id"], volgorde: ["id"] }],
    ["gebruikers", { kolommen: ["id,wachtwoord"], volgorde: ["id"] }],
    ["gebruikers", { kolommen: ["id"], waar: { "naam=eq.x&or": 1 }, volgorde: ["id"] }],
    ["gebruikers", { kolommen: ["id"], volgorde: ["id.desc"] }],
    ["gebruikers", { kolommen: [], volgorde: ["id"] }],
    ["gebruikers", { kolommen: ["id"], volgorde: [] }],
    // De sleutel: een naam, bij de gevraagde kolommen, en niet leeg.
    ["gebruikers", { kolommen: ["id"], volgorde: ["id"], sleutel: ["id&limit=1"] }],
    ["gebruikers", { kolommen: ["naam"], volgorde: ["naam"] }],
    ["gebruikers", { kolommen: ["naam"], volgorde: ["naam"], sleutel: ["id"] }],
    ["gebruikers", { kolommen: ["id"], volgorde: ["id"], sleutel: [] }],
    // De MT sorteert zelf: dat kan enkel op een kolom die ze leest.
    ["gebruikers", { kolommen: ["id"], volgorde: ["naam", "id"] }],
  ];
  for (const [tabel, vraag] of fout) {
    const r = await metFetch(async () => (opgeroepen++, json(200, [], { "Content-Range": "*/0" })), () => leesTabel(tabel, vraag));
    assert.equal(r.soort, "oproep", tabel + " " + JSON.stringify(vraag));
  }
  assert.equal(opgeroepen, 0);
  const leeg = await metFetch(async () => (opgeroepen++, json(200, [], { "Content-Range": "*/0" })), () => leesTabel("klassen", { kolommen: ["id"], waar: { id: [] }, volgorde: ["id"] }));
  assert.deepEqual(leeg, { ok: true, gegevens: [] });
  assert.equal(opgeroepen, 0, "een lege lijst van id's vroeg toch iets aan de databank");
});

Deno.test("lezen: meer dan duizend rijen komen in bladzijden, allemaal, elke volgende vanaf de laatste sleutel", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const t = tabel(rijen(2300));
  const r = await metFetch(t.haal, () => leesProef());
  assert.equal(r.ok, true);
  assert.equal(r.gegevens.length, 2300);
  assert.deepEqual(t.lezingen().map((g) => g.vanaf), [null, "gt.r0999", "gt.r1999"]);
  assert.equal(r.gegevens[2299].id, "r2299");
  assert.ok(t.lezingen().every((g) => g.prefer === "count=exact"), "elke bladzijde vraagt hoeveel rijen er nog zijn");
  // Na een lijst van meer dan één bladzijde kijkt de MT de aanmelding na (review 1, I6).
  assert.equal(t.gezien.at(-1).pad, "/rest/v1/rpc/mt_mijn_account");
  // Precies een veelvoud van een bladzijde: geen vraag te veel.
  const rond = tabel(rijen(2000));
  assert.equal((await metFetch(rond.haal, () => leesProef())).gegevens.length, 2000);
  assert.equal(rond.lezingen().length, 2);
  // Geeft de databank kleinere bladzijden dan gevraagd, dan leest de MT verder tot alles er is.
  const klein = tabel(rijen(250), { maxRijen: 100 });
  assert.equal((await metFetch(klein.haal, () => leesProef())).gegevens.length, 250);
  assert.deepEqual(klein.lezingen().map((g) => g.vanaf), [null, "gt.r0099", "gt.r0199"]);
});

Deno.test("lezen: niets terug is pas een lege lijst als de aanmelding nog in orde is (17.3)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const leeg = tabel([], { account: () => json(200, { naam: "Proef" }) });
  assert.deepEqual(await metFetch(leeg.haal, () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] })), { ok: true, gegevens: [] });
  assert.deepEqual(leeg.gezien.map((g) => g.pad), ["/rest/v1/klassen", "/rest/v1/rpc/mt_mijn_account"]);
  const geweigerd = await metFetch(tabel([], { account: () => json(403, { code: "42501", message: "MT: geen rechten voor deze handeling" }) }).haal,
    () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
  assert.equal(geweigerd.ok, false);
  assert.equal(geweigerd.soort, "rechten", "zonder rechten leek de lijst gewoon leeg");
  // Met rijen, op één bladzijde, en zonder geëiste rol is de extra controle niet nodig: RLS toonde ze enkel aan wie binnen mag.
  const gevuld = tabel(rijen(1));
  assert.equal((await metFetch(gevuld.haal, () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }))).gegevens.length, 1);
  assert.deepEqual(gevuld.gezien.map((g) => g.pad), ["/rest/v1/klassen"]);
});

Deno.test("lezen: de soort fout, en zonder aanmelding gaat er niets naar de databank", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  for (const [status, soort] of [[401, "sessie"], [403, "rechten"], [404, "ontbreekt"], [500, "fout"]]) {
    const r = await metFetch(async () => json(status, { message: "x" }), () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
    assert.equal(r.soort, soort, String(status));
  }
  const geenLijst = await metFetch(async () => json(200, { geen: "lijst" }, { "Content-Range": "0-0/1" }), () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
  assert.equal(geenLijst.ok, false);
  const stil = await metFetch(async () => {
    throw new TypeError("Failed to fetch");
  }, () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
  assert.equal(stil.soort, "verbinding");
  stelToken(() => Promise.resolve(null));
  let opgeroepen = 0;
  const r = await metFetch(async () => (opgeroepen++, json(200, [], { "Content-Range": "*/0" })), () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
  assert.equal(r.soort, "sessie");
  assert.equal(opgeroepen, 0);
});

// ---------- Review 1 (versie 0.6.0) ----------

Deno.test("serverfunctie: geen antwoord van Supabase is 'uitkomst niet bekend', en dat komt mee tot bij het scherm (I2)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const r = await metFetch(
    async () => json(503, { ok: false, code: "supabase", melding: "Supabase gaf geen antwoord: de uitkomst is niet bekend.", onbekend: true, geblokkeerd: true }),
    () => serverfunctie("tijdelijk_wachtwoord", { operatie: "x", gebruiker: "y" }),
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, { geblokkeerd: true, onbekend: true, deels: false });
  const gewoon = await metFetch(
    async () => json(502, { ok: false, code: "supabase", melding: "Supabase stelde het wachtwoord niet in." }),
    () => serverfunctie("tijdelijk_wachtwoord", { operatie: "x", gebruiker: "y" }),
  );
  assert.deepEqual(gewoon.extra, { geblokkeerd: false, onbekend: false, deels: false });
});

Deno.test("rpc: een functie die de databank enkel in een oudere versie kent, en een databank die even bezet is", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const oud = await metFetch(async () => json(404, { code: "PGRST202", message: "Could not find the function public.mt_gebruiker_wijzigen" }), () => rpc("mt_gebruiker_wijzigen", {}));
  assert.equal(oud.soort, "ontbreekt");
  assert.match(oud.tekst, /SQL-script/);
  for (const code of ["55P03", "57014"]) {
    const bezet = await metFetch(async () => json(500, { code, message: "canceling statement" }), () => rpc("mt_iets"));
    assert.equal(bezet.soort, "fout");
    assert.match(bezet.tekst, /even bezet/);
  }
});

Deno.test("lees: een kolom die de databank nog niet kent, is een script dat nog niet uitgevoerd is", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const r = await metFetch(
    async () => json(400, { code: "42703", message: "column gebruikers.revisie does not exist" }),
    () => leesTabel("gebruikers", { kolommen: ["id", "revisie"], volgorde: ["id"] }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.soort, "ontbreekt");
  assert.match(r.tekst, /SQL-script/);
});

// ---------- Levering B: een lijst is pas een lijst als ze volledig is (I6), en het afmelden (I4) ----------

import { afmeldenBijSupabase, sorteer, totaalUit } from "../code/data.js";

/**
 * Een nagebootste tabel van de Data API. De MT leest op de sleutel: gesorteerd op de sleutel, en elke
 * volgende bladzijde vanaf de laatste waarde. Bij elke bladzijde staat in Content-Range hoeveel rijen
 * aan de vraag voldoen.
 *   alle        de rijen van de tabel; een functie geeft de rijen van dat moment
 *   account     wat mt_mijn_account antwoordt
 *   totaal      (nr, echt) → een ander totaal in de kop, of null om de kop weg te laten
 *   maxRijen    de grootste bladzijde die de databank geeft
 *   antwoord    (nr, url) → vervangt één leesvraag, of wijzigt de tabel en geeft niets terug
 */
function tabel(alle, { account = () => json(200, { id: "g1", rol: "beheerder" }), totaal = (_nr, echt) => echt, maxRijen = Infinity, antwoord = null } = {}) {
  const gezien = [];
  let nr = 0;
  const haal = async (url, opties) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/rpc/mt_mijn_account")) {
      gezien.push({ pad: u.pathname });
      return account();
    }
    const sleutel = u.searchParams.get("order").split(",").map((deel) => deel.replace(/\.asc$/, ""));
    const filters = u.searchParams.getAll(sleutel[0]).filter((f) => /^gte?\./.test(f));
    gezien.push({ pad: u.pathname, vanaf: filters[0] ?? null, order: u.searchParams.get("order"), prefer: opties.headers.Prefer ?? null, token: opties.headers.Authorization });
    nr++;
    if (antwoord) {
      const eigen = antwoord(nr, u);
      if (eigen) return eigen;
    }
    assert.equal(u.searchParams.has("offset"), false, "de MT leest op de sleutel, niet op een aantal rijen");
    const tekst = (rij) => JSON.stringify(sleutel.map((kolom) => rij[kolom]));
    let over = [...(typeof alle === "function" ? alle() : alle)].sort((a, b) => (tekst(a) < tekst(b) ? -1 : tekst(a) > tekst(b) ? 1 : 0));
    for (const filter of filters) {
      const waarde = filter.slice(filter.indexOf(".") + 1);
      over = over.filter((rij) => (filter.startsWith("gte.") ? String(rij[sleutel[0]]) >= waarde : String(rij[sleutel[0]]) > waarde));
    }
    const blad = over.slice(0, Math.min(Number(u.searchParams.get("limit")), maxRijen));
    const koppen = { "Content-Type": "application/json" };
    const getal = totaal(nr, over.length);
    if (getal !== null) koppen["Content-Range"] = (blad.length ? "0-" + (blad.length - 1) : "*") + "/" + getal;
    return new Response(JSON.stringify(blad), { status: blad.length < over.length ? 206 : 200, headers: koppen });
  };
  return { haal, gezien, lezingen: () => gezien.filter((g) => !g.pad.endsWith("/rpc/mt_mijn_account")) };
}
const rijen = (aantal, vanaf = 0) => Array.from({ length: aantal }, (_, i) => ({ id: "r" + String(vanaf + i).padStart(4, "0") }));
const leesProef = (rol) => leesTabel("leerlingen", { kolommen: ["id"], volgorde: ["id"], ...(rol ? { rol } : {}) });

Deno.test("totaalUit: het getal na de schuine streep, of niets", () => {
  assert.equal(totaalUit("0-999/1503"), 1503);
  assert.equal(totaalUit("*/0"), 0);
  assert.equal(totaalUit("0-24/*"), null);
  assert.equal(totaalUit(null), null);
});

Deno.test("lees: twee bladzijden, het totaal klopt, en de aanmelding wordt nagekeken", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const t = tabel(rijen(1503));
  const r = await metFetch(t.haal, () => leesProef());
  assert.equal(r.ok, true);
  assert.equal(r.gegevens.length, 1503);
  assert.deepEqual(t.gezien.map((g) => g.prefer ?? null), ["count=exact", "count=exact", null], "elke bladzijde vraagt het totaal");
  assert.equal(t.gezien.at(-1).pad, "/rest/v1/rpc/mt_mijn_account", "na een lijst van meer dan één bladzijde wordt de aanmelding nagekeken");
  // Het toegangsbewijs per bladzijde: een lange lijst leest nooit met een bewijs dat intussen verliep.
  let beurt = 0;
  stelToken(() => Promise.resolve("bewijs." + ++beurt + ".x"));
  const vers = tabel(rijen(1503));
  await metFetch(vers.haal, () => leesProef());
  assert.deepEqual(vers.lezingen().map((g) => g.token), ["Bearer bewijs.1.x", "Bearer bewijs.2.x"]);
});

Deno.test("lees: vallen de rechten weg na de eerste bladzijde, dan is er geen lijst (I6)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  // De eerste bladzijde telt 1000 van de 1503 rijen; daarna toont de databank niets meer.
  let zichtbaar = rijen(1503);
  const weg = tabel(() => zichtbaar, { antwoord: (nr) => (nr === 2 ? ((zichtbaar = []), null) : null), account: () => json(403, { code: "42501", message: "MT: geen toegang" }) });
  const r = await metFetch(weg.haal, () => leesProef());
  assert.equal(r.ok, false, "een afgekapte lijst van 1000 rijen telde als volledig");
  assert.equal(r.soort, "rechten");
  // Verloor wie aangemeld is enkel de rol die het scherm eist, dan ook: de databank toont hem minder.
  zichtbaar = rijen(1503);
  const rol = tabel(() => zichtbaar, { antwoord: (nr) => (nr === 2 ? ((zichtbaar = []), null) : null), account: () => json(200, { id: "g1", rol: "leerkracht" }) });
  assert.equal((await metFetch(rol.haal, () => leesProef("beheerder"))).soort, "rechten");
});

Deno.test("lees: klopt een bladzijde niet met het totaal, dan leest de MT één keer opnieuw; blijft het zo, dan is er geen lijst (review 2: R06)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  // De databank meldt minder rijen dan ze geeft: één keer opnieuw, en dan klopt het.
  const eerst = tabel(rijen(4), { totaal: (nr, echt) => (nr === 1 ? echt - 1 : echt) });
  const r = await metFetch(eerst.haal, () => leesProef());
  assert.equal(r.ok, true);
  assert.equal(r.gegevens.length, 4);
  assert.equal(eerst.lezingen().length, 2);
  // Blijft het zo, dan is er geen lijst, en zegt de MT dat.
  const blijft = tabel(rijen(4), { totaal: (_nr, echt) => echt - 1 });
  const s = await metFetch(blijft.haal, () => leesProef());
  assert.deepEqual([s.ok, s.soort, s.tekst], [false, "fout", "De MT kon deze lijst niet volledig lezen. Probeer het opnieuw."]);
  assert.equal(blijft.lezingen().length, 2, "één keer opnieuw, niet vaker");
  // De databank meldt meer rijen dan ze geeft: de MT vraagt verder, krijgt niets meer, en heeft geen lijst.
  const teWeinig = tabel(rijen(4), { totaal: (_nr, echt) => echt + 2 });
  assert.equal((await metFetch(teWeinig.haal, () => leesProef())).ok, false);
  assert.equal(teWeinig.lezingen().length, 4, "twee bladzijden, en één keer opnieuw");
});

Deno.test("lees: zonder het totaal is er geen lijst: volledigheid is dan niet bewezen (review 2: R06a, R2-17)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  // Het tegenvoorbeeld van de review: één rij van een langere lijst, zonder de kop met het totaal.
  const zonder = tabel(rijen(1), { totaal: () => null });
  const r = await metFetch(zonder.haal, () => leesProef("beheerder"));
  assert.equal(r.ok, false);
  assert.equal(r.soort, "fout");
  assert.match(r.tekst, /niet volledig lezen/);
  assert.equal(zonder.lezingen().length, 2, "één keer opnieuw");
  // Ook een lege lijst zonder totaal is geen lege lijst.
  assert.equal((await metFetch(tabel([], { totaal: () => null }).haal, () => leesProef())).ok, false);
  // Een totaal dat geen getal is.
  const raar = await metFetch(async (url) => (url.includes("/rpc/") ? json(200, { rol: "beheerder" }) : json(200, [{ id: "a" }], { "Content-Range": "0-0/*" })), () => leesProef());
  assert.equal(raar.ok, false);
});

Deno.test("lees: geen rij komt twee keer, en een dubbele rij vervangt nooit een rij die ontbreekt (review 2: R06b)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  // Het tegenvoorbeeld van de review: de tweede bladzijde herhaalt een rij van de eerste; het aantal klopt.
  const eerste = rijen(1000);
  const dubbel = await metFetch(async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/mt_mijn_account")) return json(200, { rol: "beheerder" });
    return u.searchParams.getAll("id").some((f) => f.startsWith("gt.")) ? json(200, [{ id: "r0999" }], { "Content-Range": "0-0/1" }) : json(206, eerste, { "Content-Range": "0-999/1001" });
  }, () => leesProef());
  assert.equal(dubbel.ok, false, "een lijst met twee keer dezelfde rij telde als volledig");
  // Een databank die "vanaf de laatste sleutel" negeert en telkens de eerste bladzijde geeft: de MT stopt.
  let vragen = 0;
  const staat = await metFetch(async (url) => (url.includes("/rpc/") ? json(200, { rol: "beheerder" }) : (vragen++, json(206, eerste, { "Content-Range": "0-999/1500" }))), () => leesProef());
  assert.equal(staat.ok, false);
  assert.equal(vragen, 4, "twee bladzijden, en één keer opnieuw");
  // Een rij zonder sleutel: de lijst is niet te vertrouwen.
  for (const rij of [{ naam: "zonder id" }, { id: null }, null, "tekst"]) {
    const zonder = await metFetch(async (url) => (url.includes("/rpc/") ? json(200, { rol: "beheerder" }) : json(200, [{ id: "a" }, rij], { "Content-Range": "0-1/2" })), () => leesProef());
    assert.equal(zonder.ok, false, JSON.stringify(rij));
  }
});

Deno.test("lees: komt er tussen twee bladzijden een rij bij en valt er een weg, dan valt geen rij weg die er heel de tijd stond (review 2: R06, zoals R05)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const alle = rijen(1500);
  const t = tabel(() => alle, {
    antwoord: (nr) => {
      if (nr === 2) {
        alle.shift();
        alle.push({ id: "r2000" });
      }
      return null;
    },
  });
  const r = await metFetch(t.haal, () => leesProef());
  assert.equal(r.ok, true);
  const ids = new Set(r.gegevens.map((rij) => rij.id));
  for (let i = 1; i < 1500; i++) assert.ok(ids.has("r" + String(i).padStart(4, "0")), "r" + String(i).padStart(4, "0") + " stond er heel de tijd, en ontbreekt");
  assert.ok(ids.has("r2000"));
  assert.equal(t.lezingen().length, 2);
});

Deno.test("lees: eist het scherm een rol, dan kijkt de MT die altijd na, ook bij een korte lijst met rijen (review 2: R06c)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  // Het tegenvoorbeeld van de review: wie geen beheerder meer is, ziet in de tabel van de gebruikers nog zijn eigen rij.
  const leerkracht = () => json(200, { id: "g1", rol: "leerkracht" });
  const eigenRij = tabel([{ id: "eigen-account" }], { account: leerkracht });
  const r = await metFetch(eigenRij.haal, () => leesProef("beheerder"));
  assert.equal(r.ok, false, "een rolverlaging gaf een korte lijst als volledige lijst van de beheerder");
  assert.equal(r.soort, "rechten");
  assert.deepEqual(eigenRij.gezien.map((g) => g.pad), ["/rest/v1/leerlingen", "/rest/v1/rpc/mt_mijn_account"]);
  // De rol wordt nagekeken ná het lezen: wat de MT toont, las ze toen de rol nog gold.
  assert.equal(eigenRij.gezien.at(-1).pad, "/rest/v1/rpc/mt_mijn_account");
  // Met de juiste rol, of een van de rollen die mogen.
  assert.equal((await metFetch(tabel(rijen(3)).haal, () => leesProef("beheerder"))).gegevens.length, 3);
  assert.equal((await metFetch(tabel(rijen(3), { account: leerkracht }).haal, () => leesProef(["beheerder", "leerkracht"]))).gegevens.length, 3);
  // Kan de MT de rol niet nakijken, dan is er geen lijst.
  const stil = tabel(rijen(3), { account: () => json(500, { message: "x" }) });
  assert.equal((await metFetch(stil.haal, () => leesProef("beheerder"))).ok, false);
});

Deno.test("lees: een lege lijst telt enkel voor wie de rol nog heeft die het scherm eist (I6)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const lezer = { account: () => json(200, { id: "g1", rol: "leerkracht" }) };
  assert.equal((await metFetch(tabel([], lezer).haal, () => leesProef("beheerder"))).soort, "rechten", "wie geen beheerder meer is, kreeg een lege lijst als antwoord");
  assert.deepEqual(await metFetch(tabel([], lezer).haal, () => leesProef(["beheerder", "leerkracht"])), { ok: true, gegevens: [] });
  assert.deepEqual(await metFetch(tabel([], lezer).haal, () => leesProef()), { ok: true, gegevens: [] }, "zonder geëiste rol volstaat een aanmelding die in orde is");
});

Deno.test("lees: een sleutel van meer dan één kolom: verder vanaf de eerste kolom, en wat al gelezen is, valt weg", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  // Zoals de klastoewijzingen: de sleutel is de gebruiker en de klas samen.
  const alle = [];
  for (let g = 0; g < 30; g++) for (let k = 0; k < 7; k++) alle.push({ gebruiker_id: "g" + String(g).padStart(2, "0"), klas_id: "k" + k, schooljaar: "2026-2027" });
  const lees2 = () => leesTabel("klastoewijzingen", { kolommen: ["gebruiker_id", "klas_id", "schooljaar"], volgorde: ["gebruiker_id", "klas_id"], sleutel: ["gebruiker_id", "klas_id"] });
  const t = tabel(alle, { maxRijen: 50 });
  const r = await metFetch(t.haal, lees2);
  assert.equal(r.ok, true);
  assert.equal(r.gegevens.length, 210);
  assert.equal(new Set(r.gegevens.map((rij) => rij.gebruiker_id + "/" + rij.klas_id)).size, 210, "een rij kwam twee keer in de lijst");
  assert.equal(t.lezingen()[0].order, "gebruiker_id.asc,klas_id.asc");
  // De tweede bladzijde begint bij de gebruiker waar de eerste eindigde, die gebruiker inbegrepen.
  assert.deepEqual(t.lezingen().slice(0, 2).map((g) => g.vanaf), [null, "gte.g07"]);
  assert.deepEqual(r.gegevens.slice(0, 2), [alle[0], alle[1]]);
  // Past wat dezelfde eerste kolom heeft niet op één bladzijde, dan komt de MT niet vooruit: geen lijst.
  const teGroot = tabel(alle, { maxRijen: 5 });
  assert.equal((await metFetch(teGroot.haal, lees2)).ok, false);
  // Eén kolom als tekst mag ook: de sleutel van de schooljaren.
  const jaren = tabel([{ schooljaar: "2026-2027", stand: "lopend" }, { schooljaar: "2025-2026", stand: "voorbij" }]);
  const j = await metFetch(jaren.haal, () => leesTabel("schooljaren", { kolommen: ["schooljaar", "stand"], volgorde: ["schooljaar"], sleutel: "schooljaar" }));
  assert.deepEqual(j.gegevens.map((rij) => rij.schooljaar), ["2025-2026", "2026-2027"]);
  assert.equal(jaren.lezingen()[0].order, "schooljaar.asc");
});

Deno.test("lees: de MT sorteert zelf, zoals het scherm het vraagt: namen zoals in een Nederlandse lijst, getallen als getallen, leeg achteraan", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const alle = [
    { id: "e", naam: "Zoë", volgorde: 2 }, { id: "a", naam: "anna", volgorde: 10 }, { id: "d", naam: "Émile", volgorde: null }, { id: "c", naam: "Bert", volgorde: 2 }, { id: "b", naam: "Anna", volgorde: 1 },
  ];
  const lees3 = (volgorde) => metFetch(tabel(alle).haal, () => leesTabel("gebruikers", { kolommen: ["id", "naam", "volgorde"], volgorde }));
  // Hoofdletters en accenten staan bij hun letter, niet achteraan.
  assert.deepEqual((await lees3(["naam", "id"])).gegevens.map((rij) => rij.naam), ["anna", "Anna", "Bert", "Émile", "Zoë"]);
  // Getallen als getallen (2 vóór 10), leeg achteraan, en wat gelijk is op de volgende kolom.
  assert.deepEqual((await lees3(["volgorde", "naam"])).gegevens.map((rij) => rij.id), ["b", "c", "e", "a", "d"]);
  assert.deepEqual((await lees3(["id"])).gegevens.map((rij) => rij.id), ["a", "b", "c", "d", "e"]);
  // sorteer() wijzigt de lijst zelf niet, en zet 4A vóór 10A, nee vóór ja.
  const klassen = [{ naam: "10A", actief: true }, { naam: "4A", actief: true }, { naam: "4B", actief: false }];
  const kopie = JSON.stringify(klassen);
  assert.deepEqual(sorteer(klassen, ["naam"]).map((k) => k.naam), ["4A", "4B", "10A"]);
  assert.deepEqual(sorteer(klassen, ["actief", "naam"]).map((k) => k.naam), ["4B", "4A", "10A"]);
  assert.equal(JSON.stringify(klassen), kopie);
  // Wat voor de volgorde gelijk is, houdt de plaats van de sleutel.
  assert.deepEqual(sorteer([{ id: 1, n: "x" }, { id: 2, n: "x" }, { id: 3, n: "a" }], ["n"]).map((rij) => rij.id), [3, 1, 2]);
});

Deno.test("lees: een lijst die te lang is om te lezen, is een fout en geen halve lijst", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  let teller = 0;
  const r = await metFetch(async (url) => (url.includes("/rpc/") ? json(200, { rol: "beheerder" }) : json(206, [{ id: "x" + String(++teller).padStart(5, "0") }], { "Content-Range": "0-0/9" })), () => leesProef());
  assert.deepEqual([r.ok, r.soort], [false, "fout"]);
  assert.match(r.tekst, /te lang/);
  assert.equal(teller, 60);
});

Deno.test("afmelden bij Supabase: enkel deze sessie, met het toegangsbewijs, en nooit langer dan anderhalve seconde (I4)", async () => {
  stel(PROJECT);
  let gezien = null;
  await metFetch(async (url, opties) => {
    gezien = { url, opties };
    return new Response(null, { status: 204 });
  }, () => afmeldenBijSupabase("a.b.c"));
  assert.equal(gezien.url, PROJECT.mt.url + "/auth/v1/logout?scope=local");
  assert.equal(gezien.opties.method, "POST");
  assert.equal(gezien.opties.headers.Authorization, "Bearer a.b.c");
  assert.equal(gezien.opties.keepalive, true, "het verzoek moet doorlopen als de pagina herlaadt");
  // Zonder netwerk, of met een netwerk dat nooit antwoordt: het afmelden gaat door.
  const begin = Date.now();
  let hangt;
  await metFetch(() => new Promise((_, weiger) => (hangt = weiger)), () => afmeldenBijSupabase("a.b.c"));
  assert.ok(Date.now() - begin < 2500, "het afmelden bleef wachten op Supabase");
  hangt(new TypeError("afgebroken"));
  await metFetch(async () => {
    throw new TypeError("geen netwerk");
  }, () => afmeldenBijSupabase("a.b.c"));
  let geroepen = false;
  await metFetch(async () => {
    geroepen = true;
    return new Response(null, { status: 204 });
  }, () => afmeldenBijSupabase(null));
  assert.equal(geroepen, false, "zonder toegangsbewijs valt er niets af te melden");
});

// ---------- De serverfunctie voor de uitstappen (stap 3) ----------

import { UITSTAPFUNCTIE } from "../code/config.js";
import { uitstappenBijwerken } from "../code/data.js";
import { CODE, lees, paginaModules, sqlScripts, sqlZonderCommentaar } from "./hulp.js";

Deno.test("uitstappen bijwerken: de pagina vraagt het, en geeft zelf niets door", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("kop.inhoud.handtekening"));
  let gezien = null;
  const r = await metFetch(async (url, opties) => {
    gezien = { url, opties };
    return json(200, { ok: true, stand: "klaar", versie: "0.8.0", uitstappen: { nieuw: 2 }, overzicht: { jaren: [] } });
  }, uitstappenBijwerken);
  assert.equal(r.ok, true);
  assert.equal(r.gegevens.uitstappen.nieuw, 2);
  assert.equal(gezien.url, PROJECT.mt.url + "/functions/v1/" + UITSTAPFUNCTIE);
  assert.equal(gezien.opties.method, "POST");
  // Geen uitstap, geen klas, geen id: wat in de MT komt, leest de serverfunctie zelf (B212).
  assert.equal(gezien.opties.body, '{"actie":"bijwerken"}');
  assert.equal(gezien.opties.headers.apikey, PROJECT.mt.sleutel);
  assert.equal(gezien.opties.headers.Authorization, "Bearer kop.inhoud.handtekening");
});

Deno.test("uitstappen bijwerken: wat er scheelt, in de soort en de tekst van de functie", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("kop.inhoud.handtekening"));
  const geval = (antwoord) => metFetch(antwoord, uitstappenBijwerken);
  const bron = await geval(async () => json(503, { ok: false, code: "bron", melding: "De uitstappentool antwoordt niet." }));
  assert.deepEqual([bron.ok, bron.soort, bron.tekst, bron.status], [false, "bron", "De uitstappentool antwoordt niet.", 503]);
  const leeg = await geval(async () => json(422, { ok: false, code: "kan_niet", melding: "de uitstappentool gaf geen enkele uitstap terug" }));
  assert.deepEqual([leeg.soort, leeg.tekst], ["kan_niet", "De uitstappentool gaf geen enkele uitstap terug."]);
  const bezet = await geval(async () => json(503, { ok: false, code: "databank", melding: "De databank van de MT antwoordt niet.", deels: false }));
  assert.equal(bezet.soort, "fout");
  assert.equal(bezet.extra.deels, false);
  // Brak het bijwerken af terwijl een deel al bewaard kan zijn, dan komt dat mee tot bij het scherm (review 2: R07).
  const half = await geval(async () => json(503, { ok: false, code: "databank", melding: "De databank van de MT antwoordt niet.", deels: true }));
  assert.deepEqual([half.soort, half.extra.deels], ["fout", true]);
  // Een nieuwere lezing nam het over: een eigen soort, want er is niets mis.
  const ingehaald = await geval(async () => json(409, { ok: false, code: "ingehaald", melding: "een nieuwere lezing nam het over", deels: false }));
  assert.deepEqual([ingehaald.soort, ingehaald.status], ["ingehaald", 409]);
  const weg = await geval(async () => json(404, { code: "NOT_FOUND", message: "Requested function was not found" }));
  assert.deepEqual([weg.soort, weg.tekst], ["ontbreekt", "De serverfunctie " + UITSTAPFUNCTIE + " staat nog niet in Supabase."]);
  const stil = await geval(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(stil.soort, "verbinding");
  assert.equal((await geval(async () => json(401, { msg: "Invalid JWT" }))).soort, "sessie");
  stelToken(() => Promise.resolve(null));
  let opgeroepen = false;
  const zonder = await metFetch(async () => {
    opgeroepen = true;
    return json(200, { ok: true });
  }, uitstappenBijwerken);
  assert.deepEqual([zonder.soort, opgeroepen], ["sessie", false]);
});

Deno.test("de pagina leest de uitstappentool niet zelf: data.js verbindt enkel met het eigen project (review 2: R12, R2-14)", () => {
  const bron = lees(CODE + "data.js");
  assert.doesNotMatch(bron, /\bUITSTAPPENTOOL\b|import[^;]*adapter\.js|leesUitstappen/);
  // Elke oproep van data.js gaat naar het project van de omgeving.
  const oproepen = [...bron.matchAll(/\bfetch\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(oproepen.length >= 2);
  for (const adres of oproepen) assert.match(adres, /^mt\.url \+ /, "data.js roept iets anders op dan het eigen project: " + adres);
});

// ---------- Elke tabel op haar echte sleutel ----------

/** De sleutel van een tabel, uit de SQL-scripts: de kolommen van haar primary key. */
function sleutelVan(tabel) {
  const sql = sqlScripts().map((pad) => sqlZonderCommentaar(lees(pad))).join("\n");
  const m = new RegExp("create table if not exists public\\." + tabel + " \\(([\\s\\S]*?)\\n\\);").exec(sql);
  if (!m) return null;
  const samen = /primary key \(([^)]+)\)/.exec(m[1]);
  if (samen) return samen[1].split(",").map((kolom) => kolom.trim());
  const kolom = /^\s*(\w+)\s[^\n]*\bprimary key\b/m.exec(m[1]);
  return kolom ? [kolom[1]] : null;
}

Deno.test("elke tabel die de pagina leest, leest ze op haar echte sleutel: de primary key in de SQL-scripts (review 2: R06)", () => {
  // Een sleutel die niet uniek is, zou rijen doen wegvallen: de MT houdt per sleutel één rij.
  assert.deepEqual(sleutelVan("gebruikers"), ["id"]);
  assert.deepEqual(sleutelVan("klastoewijzingen"), ["gebruiker_id", "klas_id"]);
  assert.deepEqual(sleutelVan("schooljaren"), ["schooljaar"]);
  let gevonden = 0;
  for (const pad of paginaModules()) {
    const bron = lees(pad);
    for (const m of bron.matchAll(/data\.lees\("(\w+)",/g)) {
      // De oproep tot haar sluitende haakje.
      let diepte = 0;
      let einde = m.index;
      for (let i = m.index + "data.lees".length; i < bron.length; i++) {
        if (bron[i] === "(") diepte++;
        else if (bron[i] === ")" && --diepte === 0) {
          einde = i;
          break;
        }
      }
      const oproep = bron.slice(m.index, einde + 1);
      const eigen = /\bsleutel:\s*(\[[^\]]*\]|"[^"]*")/.exec(oproep);
      const sleutel = eigen ? [].concat(JSON.parse(eigen[1])) : ["id"];
      assert.deepEqual(sleutel, sleutelVan(m[1]), pad + " leest " + m[1] + " op een andere sleutel dan haar primary key");
      gevonden++;
    }
  }
  assert.ok(gevonden >= 5, "de test vond te weinig leesvragen in de pagina: " + gevonden);
});

// ---------- Hoe lang de pagina wacht (review 2: R2-20, P05) ----------

/** De wachttijden die data.js instelt terwijl het werk loopt: elke oproep krijgt een grens in de tijd. */
async function wachttijden(werk) {
  const echt = globalThis.setTimeout;
  const gezien = [];
  globalThis.setTimeout = (actie, ms, ...rest) => (gezien.push(ms), echt(actie, ms, ...rest));
  try {
    await werk();
  } finally {
    globalThis.setTimeout = echt;
  }
  return gezien;
}

Deno.test("de pagina wacht dertig seconden op een serverfunctie, en twaalf op de databank: langer dan de serverfunctie zelf nodig kan hebben (review 2: R2-20)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const goed = async () => json(200, { ok: true });
  assert.deepEqual(await metFetch(goed, () => wachttijden(uitstappenBijwerken)), [30000]);
  assert.deepEqual(await metFetch(goed, () => wachttijden(() => serverfunctie("stand"))), [30000]);
  assert.deepEqual(await metFetch(goed, () => wachttijden(() => rpc("mt_mijn_account"))), [12000]);
  assert.deepEqual(await metFetch(async () => json(200, true), () => wachttijden(ping)), [12000]);
  // Geen antwoord binnen die tijd is geen antwoord: de pagina zegt "geen verbinding", nooit "gelukt".
  const echt = globalThis.setTimeout;
  globalThis.setTimeout = (actie) => echt(actie, 0);
  try {
    const stil = await metFetch((_url, opties) => new Promise((_ok, fout) => opties.signal.addEventListener("abort", () => fout(Object.assign(new Error("afgebroken"), { name: "AbortError" })))), uitstappenBijwerken);
    assert.deepEqual([stil.ok, stil.soort], [false, "verbinding"]);
  } finally {
    globalThis.setTimeout = echt;
  }
  // De serverfuncties antwoorden altijd binnen de dertig seconden van de pagina, met marge voor het netwerk.
  const getal = (bron, naam) => Number(new RegExp("const " + naam + " = ([0-9_]+);").exec(bron)[1].replaceAll("_", ""));
  const uitstappen = lees("functies/mt-uitstappen/index.ts");
  assert.ok(getal(uitstappen, "TIJD_PER_VERZOEK") + getal(uitstappen, "TIJD_VOOR_STOPPEN") <= 30000 - 2500, "mt-uitstappen kan langer duren dan de pagina wacht");
  const accounts = lees("functies/mt-accounts/index.ts");
  assert.ok(getal(accounts, "TIJD_PER_VERZOEK") + getal(accounts, "TIJD_VOOR_EINDE") <= 30000 - 2500, "mt-accounts kan langer duren dan de pagina wacht");
});
