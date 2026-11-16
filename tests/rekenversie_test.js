// MT · tests/rekenversie_test.js
// De rekenversie (17.1, 17.7): rekenen.js en adapter.js delen ze, en geen van beide wijzigt zonder een
// nieuwe rekenversie. Een momentopname houdt later de rekenversie waarmee ze gemaakt werd; de
// serverfunctie voor de uitstappen meldt de hare aan de pagina.
//
// Zo werkt het: van elke rekenversie staat hier de afdruk van beide bestanden samen, zonder hun eerste
// regel en zonder de regel met VERSIE (die wijzigen bij elke levering). Wijzigt er iets anders, al is
// het een commentaar, dan klopt de afdruk niet meer. Dan:
//   1. verhoog REKENVERSIE in rekenen.js en in adapter.js;
//   2. zet de tekst van adapter.js opnieuw in functies/mt-uitstappen/index.ts (tests/uitstapfunctie_test.js zegt hoe);
//   3. voeg hier een regel toe met de nieuwe rekenversie en de afdruk die deze test meldt. De oude regels blijven.

import assert from "node:assert/strict";
import { REKENVERSIE as VAN_ADAPTER } from "../code/adapter.js";
import { REKENVERSIE } from "../code/rekenen.js";
import { afdruk, CODE, lees } from "./hulp.js";

const AFDRUKKEN = {
  1: "eeaa21e2e011979e6e0777a0dad43d7104fea79e99e09c4b24ffc1116ed5719a",
};

/** Een bestand zonder zijn eerste regel (de naam en de versie van de levering) en zonder de regel met VERSIE. */
function kern(naam) {
  const regels = lees(CODE + naam).split("\n");
  assert.match(regels[0], /^\/\/ MT · \S+ · versie \d+\.\d+\.\d+$/, naam + " begint niet met zijn naam en versie");
  const zonder = regels.slice(1).filter((regel) => !/^export const VERSIE = "\d+\.\d+\.\d+";$/.test(regel));
  assert.equal(zonder.length, regels.length - 2, naam + " heeft niet precies één regel met VERSIE");
  return zonder.join("\n");
}

Deno.test("de rekenversie: dezelfde in rekenen.js en in adapter.js, een geheel getal vanaf 1", () => {
  assert.ok(Number.isInteger(REKENVERSIE) && REKENVERSIE >= 1);
  assert.equal(VAN_ADAPTER, REKENVERSIE, "rekenen.js en adapter.js hebben een andere rekenversie");
});

Deno.test("de rekenversie: rekenen.js en adapter.js wijzigen nooit zonder een nieuwe rekenversie", async () => {
  const nu = await afdruk(kern("rekenen.js") + "\n==== adapter.js ====\n" + kern("adapter.js"));
  const bekend = Object.prototype.hasOwnProperty.call(AFDRUKKEN, REKENVERSIE);
  assert.ok(bekend, "rekenversie " + REKENVERSIE + " heeft nog geen afdruk in deze test. Voeg toe: " + REKENVERSIE + ": \"" + nu + "\"");
  assert.equal(nu, AFDRUKKEN[REKENVERSIE],
    "rekenen.js of adapter.js wijzigde zonder nieuwe rekenversie. Verhoog REKENVERSIE in beide bestanden, zet adapter.js opnieuw in de serverfunctie, en voeg hier de nieuwe rekenversie toe met deze afdruk: " + nu);
});

Deno.test("de rekenversie: elke vroegere rekenversie houdt haar afdruk", () => {
  const nummers = Object.keys(AFDRUKKEN).map(Number);
  assert.deepEqual(nummers, Array.from({ length: REKENVERSIE }, (_, i) => i + 1), "de lijst van afdrukken telt niet elke rekenversie van 1 tot " + REKENVERSIE);
  assert.equal(new Set(Object.values(AFDRUKKEN)).size, nummers.length, "twee rekenversies met dezelfde afdruk");
});
