// MT · tests/config_test.js
// De omgeving volgt uit het adres; een onbekend adres start niet (17.1). Enkel publishable keys.

import assert from "node:assert/strict";
import { alleOmgevingen, omgeving, UITSTAPPENTOOL } from "../config.js";

Deno.test("het testadres geeft de testomgeving", () => {
  const o = omgeving("klimop-mt-test.github.io");
  assert.equal(o.naam, "test");
  assert.equal(o.label, "Testversie");
});

Deno.test("een onbekend adres geeft geen omgeving", () => {
  for (const adres of ["klim-op.github.io", "localhost", "127.0.0.1", "", "__proto__", "constructor", "toString"]) {
    assert.equal(omgeving(adres), null, adres);
  }
});

Deno.test("elke sleutel is een publishable key, en elk adres een project van Supabase", () => {
  for (const project of [UITSTAPPENTOOL, ...alleOmgevingen().map((o) => o.mt)]) {
    assert.match(project.sleutel, /^sb_publishable_[A-Za-z0-9_-]+$/);
    assert.match(project.url, /^https:\/\/[a-z0-9]{20}\.supabase\.co$/);
  }
});

Deno.test("de omgevingen kunnen niet gewijzigd worden", () => {
  const o = omgeving("klimop-mt-test.github.io");
  assert.ok(Object.isFrozen(o) && Object.isFrozen(o.mt) && Object.isFrozen(UITSTAPPENTOOL));
});
