// MT · tests/config_test.js
// De omgeving volgt uit het adres; een onbekend adres start niet (17.1). Enkel publishable keys.

import assert from "node:assert/strict";
import { ACCOUNTFUNCTIE, alleOmgevingen, omgeving, UITSTAPPENTOOL } from "../code/config.js";
import { bestaat } from "./hulp.js";

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

Deno.test("elke omgeving heeft een eigen naam in de authenticator-app", () => {
  const namen = alleOmgevingen().map((o) => o.app);
  for (const naam of namen) assert.match(naam, /^Klim-Op MT( [a-z]+)?$/);
  assert.equal(new Set(namen).size, namen.length, "twee omgevingen dragen dezelfde naam in de app");
});

Deno.test("de serverfunctie voor de accounts staat in functies/, onder de naam die de pagina oproept", () => {
  assert.match(ACCOUNTFUNCTIE, /^[a-z][a-z0-9-]+$/);
  assert.ok(bestaat("functies/" + ACCOUNTFUNCTIE + "/index.ts"), "functies/" + ACCOUNTFUNCTIE + "/index.ts ontbreekt");
});
