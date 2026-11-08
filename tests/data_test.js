// MT · tests/data_test.js
// De REST-laag: de publishable key enkel als apikey, en een begrijpelijke reden bij een fout.
// fetch wordt nagebootst; er gaat niets over het netwerk.

import assert from "node:assert/strict";
import { ping, redenVoor, stel } from "../data.js";

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
