// MT · tests/opbouw_test.js
// De opbouw van de repository (B206): in de hoofdmap enkel index.html, README.md en .nojekyll,
// en de mappen .github, code, opmaak, sql en tests. Staat er nog een ander bestand, dan zegt deze
// test welk, en dat het weg mag.

import assert from "node:assert/strict";
import { MAP } from "./hulp.js";

const BESTANDEN = new Set(["index.html", "README.md", ".nojekyll"]);
const MAPPEN = new Set([".github", "code", "opmaak", "sql", "tests"]);

Deno.test("de hoofdmap bevat enkel index.html, README.md, .nojekyll en de vijf mappen", () => {
  const teVeel = [];
  for (const item of Deno.readDirSync(MAP)) {
    if (item.name === ".git") continue;
    if (item.isDirectory ? !MAPPEN.has(item.name) : !BESTANDEN.has(item.name)) teVeel.push(item.name);
  }
  teVeel.sort();
  assert.deepEqual(teVeel, [], "In de hoofdmap staat nog: " + teVeel.join(", ") + ". Wis het in GitHub: open het bestand, kies de drie puntjes en Delete file.");
});

Deno.test("de mappen en bestanden van de opbouw bestaan", () => {
  const er = new Set([...Deno.readDirSync(MAP)].map((item) => item.name));
  for (const naam of [...BESTANDEN, ...MAPPEN]) assert.ok(er.has(naam), naam + " ontbreekt in de hoofdmap");
});
