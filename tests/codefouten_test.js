// MT · tests/codefouten_test.js
// De bewust ingebouwde fouten in de code (tests/codefouten.js), één per keer: vindt een test over het
// gedrag ze? Zo is nagekeken dat de tests niet enkel slagen, maar ook afgaan wanneer het misloopt
// (17.12; review 2: R11, R2-19). Voor de databank doet tests/databank_test.js hetzelfde.
//
// Voor elke fout: het bestand krijgt de fout, op een kopie van de repository in een tijdelijke map, en
// de tests van dat bestand draaien daar. De fout telt als gevonden als minstens één test over het gedrag
// faalt. Een test die enkel bewaakt dát een tekst wijzigde, telt niet mee. Laat een fout de code niet
// meer laden, dan is ze geen proef op de tests: ook dat meldt de test.
//
// Draait enkel met MT_CODEFOUTEN=1 en de nodige rechten, vanuit de hoofdmap van de repository:
//   MT_CODEFOUTEN=1 deno test --allow-read --allow-write --allow-env --allow-run --no-prompt tests/codefouten_test.js
// Zonder die instelling staat de test op "ignored", zodat de gewone tests niets extra vragen.
// MT_CODEFOUTEN_ENKEL beperkt de fouten tot wie die tekst in haar bestand of naam draagt, bv. rekenen.js.
// Of elke fout haar plaats nog vindt, gaat tests/fouten_test.js na, bij elke upload.

import assert from "node:assert/strict";
import { FOUTEN, TESTS, WACHTERS } from "./codefouten.js";
import { lees, MAP } from "./hulp.js";

function instelling(naam) {
  try {
    return Deno.env.get(naam) ?? null;
  } catch {
    return null;
  }
}

const AAN = instelling("MT_CODEFOUTEN") === "1";
const ENKEL = instelling("MT_CODEFOUTEN_ENKEL");
/** Zoveel fouten tegelijk, elk op een eigen kopie. */
const GELIJK = Math.max(1, Math.min(4, Number(instelling("MT_FOUTEN_GELIJK") || navigator.hardwareConcurrency || 2) || 1));
const ADAPTER = "code/adapter.js";
const FUNCTIE = "functies/mt-uitstappen/index.ts";

/** Een map kopiëren, met alles erin, zonder de geschiedenis van git. */
async function kopieer(van, naar) {
  await Deno.mkdir(naar, { recursive: true });
  for await (const item of Deno.readDir(van)) {
    if (item.name === ".git") continue;
    if (item.isDirectory) await kopieer(van + "/" + item.name, naar + "/" + item.name);
    else if (item.isFile) await Deno.copyFile(van + "/" + item.name, naar + "/" + item.name);
  }
}

/** De tests van één fout, in de kopie. Geeft de namen van de tests die faalden, en of de code nog laadde. */
async function draai(kopie, tests) {
  const uit = await new Deno.Command(Deno.execPath(), {
    args: ["test", "--allow-read", "--no-prompt", ...tests],
    cwd: kopie,
    env: { NO_COLOR: "1" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const tekst = new TextDecoder().decode(uit.stdout) + new TextDecoder().decode(uit.stderr);
  const gefaald = [...tekst.matchAll(/^(.+?) \.\.\. FAILED/gm)].map((m) => m[1]);
  const geslaagd = /^.+ \.\.\. ok/m.test(tekst);
  return { code: uit.code, gefaald, laadde: gefaald.length > 0 || geslaagd, tekst };
}

Deno.test({
  name: "codefouten: elke bewust ingebouwde fout in de code wordt gevonden door een test over het gedrag",
  ignore: !AAN,
  async fn() {
    const bron = decodeURIComponent(MAP.pathname).replace(/\/$/, "");
    const fouten = FOUTEN.filter((f) => !ENKEL || f.bestand.includes(ENKEL) || f.naam.includes(ENKEL));
    assert.ok(fouten.length > 0, "geen fouten om in te bouwen");
    const werk = await Deno.makeTempDir({ prefix: "mt-codefouten-" });
    const nietGevonden = [];
    const laadtNiet = [];
    try {
      // Zonder fout slagen de tests: anders bewijst een falende test niets.
      await kopieer(bron, werk + "/0");
      const schoon = await draai(werk + "/0", [...new Set(fouten.flatMap((f) => TESTS[f.bestand]))]);
      assert.equal(schoon.code, 0, "de tests slagen niet zonder ingebouwde fout:\n" + schoon.tekst.slice(-2000));

      const wachtrij = [...fouten];
      const werker = async (nr) => {
        const kopie = werk + "/" + nr;
        if (nr > 0) await kopieer(bron, kopie);
        for (let f = wachtrij.shift(); f; f = wachtrij.shift()) {
          // De fout in haar bestand, en in de serverfunctie als die dezelfde tekst van de adapter draagt.
          const bestanden = [f.bestand];
          if (f.bestand === ADAPTER && lees(FUNCTIE).split(f.oud).length === 2) bestanden.push(FUNCTIE);
          for (const bestand of bestanden) await Deno.writeTextFile(kopie + "/" + bestand, lees(bestand).replace(f.oud, () => f.nieuw));
          const tests = [...new Set(bestanden.flatMap((bestand) => TESTS[bestand]))];
          const r = await draai(kopie, tests);
          for (const bestand of bestanden) await Deno.writeTextFile(kopie + "/" + bestand, lees(bestand));
          const gedrag = r.gefaald.filter((naam) => !WACHTERS.some((w) => naam.includes(w)));
          if (!r.laadde) laadtNiet.push(f.bestand + ": " + f.naam);
          else if (gedrag.length === 0) nietGevonden.push(f.bestand + ": " + f.naam);
        }
      };
      await Promise.all(Array.from({ length: GELIJK }, (_, nr) => werker(nr)));
      console.log(fouten.length + (ENKEL ? " van de " + FOUTEN.length : "") + " fouten ingebouwd in de code; niet gevonden: " + nietGevonden.length);
      assert.deepEqual(laadtNiet, [], "deze fouten laten de code niet meer laden, en zijn dus geen proef op de tests:\n" + laadtNiet.join("\n"));
      assert.deepEqual(nietGevonden, [], "niet gevonden door een test over het gedrag:\n" + nietGevonden.join("\n"));
    } finally {
      await Deno.remove(werk, { recursive: true });
    }
  },
});
