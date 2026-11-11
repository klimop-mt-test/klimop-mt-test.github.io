// MT · tests/fouten_test.js
// De lijst van bewust ingebouwde fouten (tests/databank/fouten.js) blijft kloppen met de SQL-scripts:
// elke fout hoort bij een bestaand script, en haar plaats is eenduidig. Wijzigt een script, dan meldt
// deze test welke fout haar plaats niet meer vindt. Of elke fout ook gevonden wordt, gaat de
// databanktest na (tests/databank_test.js), op een nagebootste Supabase.

import assert from "node:assert/strict";
import { lees, sqlScripts } from "./hulp.js";
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
