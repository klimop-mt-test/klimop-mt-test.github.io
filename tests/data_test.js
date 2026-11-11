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
    [403, { code: "42501", message: "MT: geen rechten voor deze handeling" }, "rechten", "geen rechten voor deze handeling"],
    [400, { code: "MT409", message: "MT: de lijst wijzigde intussen." }, "gewijzigd", "de lijst wijzigde intussen."],
    [400, { code: "MT422", message: "MT: enkel een leerkracht heeft klassen" }, "kan_niet", "enkel een leerkracht heeft klassen"],
    [400, { code: "MT429", message: "MT: te veel pogingen na elkaar." }, "te_veel", "te veel pogingen na elkaar."],
    [400, { code: "22023", message: "MT: deze accounthandeling klopt niet" }, "oproep", "deze accounthandeling klopt niet"],
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
    return json(200, { ok: true, versie: "0.4.0", bekend: true });
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
    [403, { ok: false, code: "rechten", melding: "geen rechten voor deze handeling" }, "rechten", /geen rechten/, false],
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
