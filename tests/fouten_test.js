// MT · tests/fouten_test.js
// De lijst van bewust ingebouwde fouten (tests/databank/fouten.js) blijft kloppen met de SQL-scripts:
// elke fout hoort bij een bestaand script, en haar plaats is eenduidig. Wijzigt een script, dan meldt
// deze test welke fout haar plaats niet meer vindt. Of elke fout ook gevonden wordt, gaat de
// databanktest na (tests/databank_test.js), op een nagebootste Supabase.
// Hetzelfde voor de fouten in de code (tests/codefouten.js): of de tests ze vinden, gaat
// tests/codefouten_test.js na.

import assert from "node:assert/strict";
import { bestaat, lees, sqlScripts } from "./hulp.js";
import { FOUTEN as CODEFOUTEN, TESTS, WACHTERS } from "./codefouten.js";
import { FOUTEN } from "./databank/fouten.js";

Deno.test("fouten: elke ingebouwde fout hoort bij een bestaand script, en haar plaats is eenduidig", () => {
  const scripts = new Set(sqlScripts());
  assert.ok(FOUTEN.length >= 50, "te weinig ingebouwde fouten");
  const namen = new Set();
  for (const f of FOUTEN) {
    assert.ok(scripts.has("sql/" + f.script), f.naam + ": " + f.script + " bestaat niet");
    const aantal = lees("sql/" + f.script).split(f.oud).length - 1;
    assert.equal(aantal, 1, f.naam + ": de plaats van de fout komt " + aantal + " keer voor in " + f.script);
    assert.notEqual(f.oud, f.nieuw, f.naam + ": de fout wijzigt niets");
    assert.ok(!namen.has(f.naam), f.naam + " staat er twee keer");
    namen.add(f.naam);
  }
});

Deno.test("codefouten: elke ingebouwde fout in de code hoort bij een bestaand bestand met tests, en haar plaats is eenduidig", () => {
  assert.ok(CODEFOUTEN.length >= 100, "te weinig ingebouwde fouten in de code");
  const namen = new Set();
  for (const f of CODEFOUTEN) {
    assert.ok(bestaat(f.bestand), f.naam + ": " + f.bestand + " bestaat niet");
    assert.ok(Array.isArray(TESTS[f.bestand]) && TESTS[f.bestand].length > 0, f.naam + ": voor " + f.bestand + " staan er geen tests in de lijst");
    const aantal = lees(f.bestand).split(f.oud).length - 1;
    assert.equal(aantal, 1, f.naam + ": de plaats van de fout komt " + aantal + " keer voor in " + f.bestand);
    assert.notEqual(f.oud, f.nieuw, f.naam + ": de fout wijzigt niets");
    assert.ok(!namen.has(f.naam), f.naam + " staat er twee keer");
    namen.add(f.naam);
  }
  // Elk bestand met tests in de lijst krijgt minstens één fout, en elke test bestaat.
  for (const [bestand, tests] of Object.entries(TESTS)) {
    assert.ok(CODEFOUTEN.some((f) => f.bestand === bestand), bestand + " heeft geen enkele ingebouwde fout");
    for (const test of tests) assert.ok(bestaat(test), test + " bestaat niet");
  }
  // Een wachter is een test die echt bestaat: anders telt de lijst een test over het gedrag stil niet mee.
  const alleTests = [...new Set(Object.values(TESTS).flat())].map(lees).join("\n");
  for (const wachter of WACHTERS) assert.ok(alleTests.includes('Deno.test("' + wachter) || alleTests.includes('name: "' + wachter), "geen test begint met: " + wachter);
});
