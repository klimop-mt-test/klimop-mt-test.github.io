// MT · tests/workflows_test.js
// De workflows in .github/workflows (17.1, 17.9, B220). Ze beginnen met een punt en komen dus niet mee
// met een upload: Pablo plakt ze met de hand. Deze test bewaakt wat er dan in de repository staat:
//   - elk onderdeel van GitHub Actions staat vast op een volledige commit, niet op een naam die kan wijzigen;
//   - een workflow krijgt enkel leesrechten, en gebruikt geen geheim;
//   - de wekelijkse vergelijking met de uitstappentool haalt enkel het ene vaste adres op, over https,
//     leest het als tekst, en geeft een kruisje als de vergelijking niet echt gelopen heeft.

import assert from "node:assert/strict";
import { lees } from "./hulp.js";

const MAP = new URL("../.github/workflows/", import.meta.url);
const namen = [...Deno.readDirSync(MAP)].filter((f) => f.isFile && /\.ya?ml$/.test(f.name)).map((f) => f.name).sort();
// Een bestand dat via de website geplakt werd, kan regeleinden van Windows hebben: die tellen hier niet.
const tekst = (naam) => lees(".github/workflows/" + naam).replace(/\r\n/g, "\n");
/** De regels die iets doen: zonder commentaar. */
const zonderCommentaar = (naam) => tekst(naam).split("\n").filter((regel) => !/^\s*#/.test(regel)).join("\n");

Deno.test("workflows: de tests, de keep-alive en de vergelijking met de uitstappentool staan er", () => {
  for (const naam of ["tests.yml", "keepalive.yml"]) assert.ok(namen.includes(naam), naam + " ontbreekt in .github/workflows");
  const vergelijking = namen.filter((naam) => tekst(naam).includes("MT_UITSTAPPEN_HTML"));
  assert.equal(vergelijking.length, 1,
    "er hoort precies één workflow te zijn die het echte uitstappen.html vergelijkt (B220). Maak .github/workflows/uitstappentool.yml aan via Add file → Create new file; de inhoud staat in 71.4 van het ontwerpdocument.");
});

Deno.test("workflows: elk onderdeel staat vast op een commit, met enkel leesrechten en zonder geheimen", () => {
  for (const naam of namen) {
    const t = zonderCommentaar(naam);
    const onderdelen = [...t.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    for (const onderdeel of onderdelen) {
      assert.match(onderdeel, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, naam + ": " + onderdeel + " staat niet vast op een volledige commit");
    }
    assert.match(t, /^permissions:\n  contents: read\n/m, naam + ": de workflow hoort enkel leesrechten te hebben");
    assert.equal([...t.matchAll(/^\s*permissions:/gm)].length, 1, naam + ": rechten horen op één plaats te staan, bovenaan");
    assert.doesNotMatch(t, /\bsecrets\s*\./, naam + ": een workflow van de MT gebruikt geen geheim");
    assert.doesNotMatch(t, /pull_request_target|workflow_run/, naam + ": deze starters geven een workflow meer rechten dan nodig");
  }
});

Deno.test("workflows: de vergelijking met de uitstappentool haalt enkel het ene vaste adres op, en een overgeslagen vergelijking is een kruisje (B220)", () => {
  const naam = namen.find((n) => tekst(n).includes("MT_UITSTAPPEN_HTML"));
  const t = zonderCommentaar(naam);
  // Elke week, en met de hand; nooit bij een upload: de workflow houdt niets tegen.
  assert.match(t, /^on:\n  schedule:\n    - cron: "\d+ \d+ \* \* [0-6]"\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(t, /^\s*(push|pull_request):/m);
  // Eén adres, over https, ook na een omleiding; het bestand komt in de tijdelijke map, niet in de repository.
  const adressen = [...t.matchAll(/https?:\/\/[^\s"']+/g)].map((m) => m[0]);
  assert.deepEqual(adressen, ["https://klim-op.github.io/klimop-software/uitstappen.html"]);
  assert.match(t, /curl --fail [^|;&]*--proto '=https' --proto-redir '=https'[^|;&]*--max-filesize \d+[^|;&]*--output "\$RUNNER_TEMP\/uitstappen\.html"/s);
  // Het bestand wordt enkel gelezen door de test: geen stap voert het uit of opent het anders.
  assert.equal([...t.matchAll(/uitstappen\.html/g)].length, 5,
    "uitstappen.html hoort op vijf plaatsen te staan: in de naam van de taak en van de stap, bij het ophalen (het adres en het doel), en in MT_UITSTAPPEN_HTML. Een nieuwe stap die het bestand gebruikt, is een bewuste keuze: pas dan deze test aan.");
  assert.match(t, /MT_UITSTAPPEN_HTML: \$\{\{ runner\.temp \}\}\/uitstappen\.html/);
  assert.match(t, /deno test --allow-read --allow-env=MT_UITSTAPPEN_HTML --no-prompt --filter "T1" tests\/adapter_test\.js/);
  // De controle dat de vergelijking echt liep, zoekt de naam van die test: bestaat die test nog onder die naam?
  const zoekt = /grep -q "([^"]+)" "\$RUNNER_TEMP\/uitkomst\.txt"/.exec(t);
  assert.ok(zoekt, "de workflow kijkt niet na of de vergelijking echt gelopen heeft");
  const patroon = new RegExp(zoekt[1]);
  const testnamen = [...lees("tests/adapter_test.js").matchAll(/Deno\.test\(\{?\s*(?:name:\s*)?"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const gevonden = testnamen.filter((n) => patroon.test(n + " ... ok (1ms)"));
  assert.equal(gevonden.length, 1, "de workflow zoekt een test die niet (meer) precies één keer bestaat in tests/adapter_test.js: " + zoekt[1]);
  assert.match(gevonden[0], /uitstappentool/);
  assert.doesNotMatch(patroon.source, /ignored/);
  assert.ok(!patroon.test(gevonden[0] + " ... ignored (0ms)") && !patroon.test(gevonden[0] + " ... FAILED (3ms)"), "een overgeslagen of mislukte vergelijking mag geen vinkje geven");
  // pipefail: mislukt de test, dan mislukt de stap, ook al slaagt tee.
  assert.match(t, /shell: bash\n[\s\S]*deno test/);
});
