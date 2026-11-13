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

const json = (status, lichaam) => new Response(JSON.stringify(lichaam), { status, headers: { "Content-Type": "application/json" } });

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

Deno.test("lezen: kolommen, filters en volgorde in de vraag, en een waarde wijzigt nooit de vraag zelf", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  let gezien = null;
  const r = await metFetch(async (url, opties) => {
    gezien = { url, opties };
    return json(200, [{ id: 1 }]);
  }, () => leesTabel("klassen", { kolommen: ["id", "naam"], waar: { schooljaar: "2026-2027", actief: true, id: ["a,b", 'c"d', "e)f"], leerjaar: null }, volgorde: ["volgorde", "id"] }));
  assert.deepEqual(r, { ok: true, gegevens: [{ id: 1 }] });
  const u = new URL(gezien.url);
  assert.equal(u.origin + u.pathname, PROJECT.mt.url + "/rest/v1/klassen");
  assert.equal(u.searchParams.get("select"), "id,naam");
  assert.equal(u.searchParams.get("schooljaar"), "eq.2026-2027");
  assert.equal(u.searchParams.get("actief"), "eq.true");
  assert.equal(u.searchParams.get("id"), 'in.("a,b","c\\"d","e)f")');
  assert.equal(u.searchParams.get("leerjaar"), "is.null");
  assert.equal(u.searchParams.get("order"), "volgorde.asc,id.asc");
  assert.equal(u.searchParams.get("limit"), "1000");
  assert.equal(u.searchParams.get("offset"), "0");
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
  ];
  for (const [tabel, vraag] of fout) {
    const r = await metFetch(async () => (opgeroepen++, json(200, [])), () => leesTabel(tabel, vraag));
    assert.equal(r.soort, "oproep", tabel + " " + JSON.stringify(vraag));
  }
  assert.equal(opgeroepen, 0);
  const leeg = await metFetch(async () => (opgeroepen++, json(200, [])), () => leesTabel("klassen", { kolommen: ["id"], waar: { id: [] }, volgorde: ["id"] }));
  assert.deepEqual(leeg, { ok: true, gegevens: [] });
  assert.equal(opgeroepen, 0, "een lege lijst van id's vroeg toch iets aan de databank");
});

Deno.test("lezen: meer dan duizend rijen komen in bladzijden, allemaal", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const alle = Array.from({ length: 2300 }, (_, i) => ({ id: i }));
  const gevraagd = [];
  const r = await metFetch(async (url) => {
    const u = new URL(url);
    // Na een lijst van meer dan één bladzijde kijkt de MT de aanmelding na (review 1, I6).
    if (u.pathname.endsWith("/rpc/mt_mijn_account")) return json(200, { id: "g1", rol: "beheerder" });
    const vanaf = Number(u.searchParams.get("offset"));
    gevraagd.push(vanaf);
    return json(200, alle.slice(vanaf, vanaf + Number(u.searchParams.get("limit"))));
  }, () => leesTabel("leerlingen", { kolommen: ["id"], volgorde: ["id"] }));
  assert.equal(r.ok, true);
  assert.equal(r.gegevens.length, 2300);
  assert.deepEqual(gevraagd, [0, 1000, 2000]);
  assert.equal(r.gegevens[2299].id, 2299);
});

Deno.test("lezen: niets terug is pas een lege lijst als de aanmelding nog in orde is (17.3)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const paden = [];
  const leeg = await metFetch(async (url) => {
    paden.push(new URL(url).pathname);
    return url.includes("/rpc/mt_mijn_account") ? json(200, { naam: "Proef" }) : json(200, []);
  }, () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
  assert.deepEqual(leeg, { ok: true, gegevens: [] });
  assert.deepEqual(paden, ["/rest/v1/klassen", "/rest/v1/rpc/mt_mijn_account"]);
  const geweigerd = await metFetch(async (url) => url.includes("/rpc/mt_mijn_account") ? json(403, { code: "42501", message: "MT: geen rechten voor deze handeling" }) : json(200, []),
    () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
  assert.equal(geweigerd.ok, false);
  assert.equal(geweigerd.soort, "rechten", "zonder rechten leek de lijst gewoon leeg");
  let nagekeken = 0;
  const gevuld = await metFetch(async (url) => (url.includes("/rpc/") ? (nagekeken++, json(200, {})) : json(200, [{ id: 1 }])), () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
  assert.equal(gevuld.gegevens.length, 1);
  assert.equal(nagekeken, 0, "met rijen is de extra controle niet nodig: RLS toonde ze enkel aan wie binnen mag");
});

Deno.test("lezen: de soort fout, en zonder aanmelding gaat er niets naar de databank", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  for (const [status, soort] of [[401, "sessie"], [403, "rechten"], [404, "ontbreekt"], [500, "fout"]]) {
    const r = await metFetch(async () => json(status, { message: "x" }), () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
    assert.equal(r.soort, soort, String(status));
  }
  const geenLijst = await metFetch(async () => json(200, { geen: "lijst" }), () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
  assert.equal(geenLijst.ok, false);
  stelToken(() => Promise.resolve(null));
  let opgeroepen = 0;
  const r = await metFetch(async () => (opgeroepen++, json(200, [])), () => leesTabel("klassen", { kolommen: ["id"], volgorde: ["id"] }));
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
  assert.deepEqual(r.extra, { geblokkeerd: true, onbekend: true });
  const gewoon = await metFetch(
    async () => json(502, { ok: false, code: "supabase", melding: "Supabase stelde het wachtwoord niet in." }),
    () => serverfunctie("tijdelijk_wachtwoord", { operatie: "x", gebruiker: "y" }),
  );
  assert.deepEqual(gewoon.extra, { geblokkeerd: false, onbekend: false });
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

import { afmeldenBijSupabase, totaalUit } from "../code/data.js";

/** Een nagebootste tabel: geeft bladzijden van 1000 rijen, met het totaal in Content-Range bij de eerste. */
function tabel(bladzijden, { totaal = null, account = () => json(200, { id: "g1", rol: "beheerder" }) } = {}) {
  const gezien = [];
  let beurt = 0;
  const haal = async (url, opties) => {
    const u = new URL(url);
    gezien.push({ pad: u.pathname, offset: u.searchParams.get("offset"), prefer: opties.headers.Prefer ?? null });
    if (u.pathname.endsWith("/rpc/mt_mijn_account")) return account();
    const blad = bladzijden[Math.min(beurt++, bladzijden.length - 1)];
    const koppen = { "Content-Type": "application/json" };
    if (totaal !== null && u.searchParams.get("offset") === "0") koppen["Content-Range"] = "0-" + (blad.length - 1) + "/" + totaal;
    return new Response(JSON.stringify(blad), { status: 200, headers: koppen });
  };
  return { haal, gezien };
}
const rijen = (aantal, vanaf = 0) => Array.from({ length: aantal }, (_, i) => ({ id: vanaf + i }));
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
  const t = tabel([rijen(1000), rijen(503, 1000)], { totaal: 1503 });
  const r = await metFetch(t.haal, () => leesProef());
  assert.equal(r.ok, true);
  assert.equal(r.gegevens.length, 1503);
  assert.deepEqual(t.gezien.map((g) => g.prefer), ["count=exact", null, null], "enkel de eerste bladzijde vraagt het totaal");
  assert.equal(t.gezien.at(-1).pad, "/rest/v1/rpc/mt_mijn_account", "na een lijst van meer dan één bladzijde wordt de aanmelding nagekeken");
});

Deno.test("lees: vallen de rechten weg na de eerste bladzijde, dan is er geen lijst (I6)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  // Precies 1000 rijen op de eerste bladzijde, en daarna toont de databank niets meer.
  const weg = tabel([rijen(1000), []], { totaal: 1503, account: () => json(403, { code: "42501", message: "MT: geen toegang" }) });
  const r = await metFetch(weg.haal, () => leesProef());
  assert.equal(r.ok, false, "een afgekapte lijst van 1000 rijen telde als volledig");
  assert.equal(r.soort, "rechten");
  // De aanmelding is nog in orde, maar de lijst klopt twee keer niet met het totaal: geen lijst.
  const schuift = tabel([rijen(1000), []], { totaal: 1503 });
  const s = await metFetch(schuift.haal, () => leesProef());
  assert.equal(s.ok, false);
  assert.match(s.tekst, /wijzigde terwijl/);
  assert.equal(schuift.gezien.filter((g) => g.offset === "0").length, 2, "de MT las niet één keer opnieuw");
});

Deno.test("lees: één keer opnieuw lezen volstaat als de lijst dan wel klopt", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const t = tabel([rijen(3), rijen(4)], { totaal: 4 });
  const r = await metFetch(t.haal, () => leesProef());
  assert.equal(r.ok, true);
  assert.equal(r.gegevens.length, 4);
});

Deno.test("lees: een lege lijst telt enkel voor wie de rol nog heeft die het scherm eist (I6)", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const lezer = { account: () => json(200, { id: "g1", rol: "leerkracht" }), totaal: 0 };
  assert.equal((await metFetch(tabel([[]], lezer).haal, () => leesProef("beheerder"))).soort, "rechten", "wie geen beheerder meer is, kreeg een lege lijst als antwoord");
  assert.deepEqual(await metFetch(tabel([[]], lezer).haal, () => leesProef(["beheerder", "leerkracht"])), { ok: true, gegevens: [] });
  assert.deepEqual(await metFetch(tabel([[]], lezer).haal, () => leesProef()), { ok: true, gegevens: [] }, "zonder geëiste rol volstaat een aanmelding die in orde is");
});

Deno.test("lees: zonder de kop met het totaal werkt het lezen zoals voorheen", async () => {
  stel(PROJECT);
  stelToken(() => Promise.resolve("a.b.c"));
  const t = tabel([rijen(7)]);
  const r = await metFetch(t.haal, () => leesProef());
  assert.equal(r.gegevens.length, 7);
  assert.equal(t.gezien.length, 1, "een korte lijst op één bladzijde vraagt geen extra oproep");
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
