// MT · tests/aanmelden_test.js
// Welke stap het aanmeldscherm toont (code/aanmelden.js), uit de stand van het account en het niveau
// van de sessie. Het scherm beslist niets over de toegang: dat doet de databank (T5).

import assert from "node:assert/strict";
import { reeksVoor, stapVoor } from "../code/aanmelden.js";

const account = (anders = {}) => ({
  bekend: true,
  account: { actief: true, bezig: false, wachtwoord_tijdelijk: false, tijdelijk_verlopen: false, eerste_aanmelding_afgerond: true, app_koppelen: false, ...anders },
});
const aal1 = { aal: "aal1", methodes: ["password"] };
const aal2 = { aal: "aal2", methodes: ["totp", "password"] };

Deno.test("stap: een account dat niet binnen mag, met de reden", () => {
  assert.equal(stapVoor(null, aal1), "geen_toegang");
  assert.equal(stapVoor({ bekend: false, account: null }, aal1), "geen_toegang");
  assert.equal(stapVoor(account({ actief: false }), aal2), "uitgeschakeld");
  assert.equal(stapVoor(account({ bezig: true }), aal2), "bezig");
  assert.equal(stapVoor(account({ wachtwoord_tijdelijk: true, tijdelijk_verlopen: true }), aal1), "verlopen");
  assert.equal(stapVoor(account({ actief: false, wachtwoord_tijdelijk: true, tijdelijk_verlopen: true }), aal1), "uitgeschakeld", "uitgeschakeld gaat voor");
});

Deno.test("stap: de eerste keer vier stappen, in deze volgorde", () => {
  const nieuw = { wachtwoord_tijdelijk: true, eerste_aanmelding_afgerond: false, app_koppelen: true };
  assert.equal(stapVoor(account(nieuw), aal1), "nieuw");
  assert.equal(stapVoor(account(nieuw), aal2), "nieuw", "eerst het eigen wachtwoord, ook met een code");
  assert.equal(stapVoor(account({ ...nieuw, wachtwoord_tijdelijk: false }), aal1), "app");
  assert.equal(stapVoor(account({ ...nieuw, wachtwoord_tijdelijk: false }), aal2), "afronden");
  assert.deepEqual(reeksVoor(account(nieuw), false), ["login", "nieuw", "koppel", "code"]);
});

Deno.test("stap: daarna twee stappen; na een nieuw wachtwoord of een nieuwe gsm wat nodig is", () => {
  assert.equal(stapVoor(account(), aal1), "app");
  assert.deepEqual(reeksVoor(account(), true), ["login", "code"]);
  assert.equal(stapVoor(account(), aal2), "app", "de databank weigerde, bv. een code van meer dan twee weken: opnieuw de code");
  assert.deepEqual(reeksVoor(account({ wachtwoord_tijdelijk: true }), true), ["login", "nieuw", "code"]);
  assert.equal(stapVoor(account({ app_koppelen: true }), aal2), "afronden");
  assert.equal(stapVoor(account({ app_koppelen: true }), { aal: "aal2", methodes: ["password"] }), "app", "aal2 zonder code uit de app telt niet");
  assert.deepEqual(reeksVoor(account({ app_koppelen: true }), false), ["login", "koppel", "code"]);
});
