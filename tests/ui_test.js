// MT · tests/ui_test.js
// Het sjabloon html`…` van ui.js zet elke ingevoegde waarde om naar tekst (regel 4, 17.10).

import assert from "node:assert/strict";
import { bedragTekst, bedragUit, esc, euro, html } from "../code/ui.js";

Deno.test("esc zet de vijf gevaarlijke tekens om", () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(esc(42), "42");
});

Deno.test("html: een naam wordt nooit opmaak", () => {
  const naam = `<img src=x onerror="alert(1)">`;
  assert.equal(String(html`<b>${naam}</b>`), "<b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b>");
});

Deno.test("html: geneste opmaak blijft opmaak, een lijst komt achter elkaar", () => {
  const namen = ["Lena", "Noah & Mila"];
  const lijst = html`<ul>${namen.map((n) => html`<li>${n}</li>`)}</ul>`;
  assert.equal(String(lijst), "<ul><li>Lena</li><li>Noah &amp; Mila</li></ul>");
});

Deno.test("html: null, undefined en false worden niets; 0 blijft 0", () => {
  assert.equal(String(html`[${null}${undefined}${false}${0}]`), "[0]");
});

Deno.test("html: een gewone tekst die op opmaak lijkt, blijft tekst", () => {
  const nep = { html: "<b>vals</b>", toString: () => "<b>vals</b>" };
  assert.equal(String(html`${nep}`), "&lt;b&gt;vals&lt;/b&gt;");
});


// ---------- Bedragen (stap 4) ----------

Deno.test("een bedrag lezen: zoals iemand het intikt, met een komma, een punt of een euroteken", () => {
  const goed = [
    ["55", 5500], ["55,5", 5550], ["55,50", 5550], ["55.50", 5550], ["55.5", 5550], ["0", 0], ["0,00", 0], ["0,05", 5], ["€ 55,00", 5500], [" 110 ", 11000],
    ["1.250", 125000], ["1.250,00", 125000], ["€ 1.250,5", 125050], ["1 250,00", 125000], ["1\u00a0250", 125000], ["12.345.678,90", 1234567890], ["007", 700],
  ];
  for (const [tekst, cent] of goed) assert.deepEqual(bedragUit(tekst), { ok: true, cent }, JSON.stringify(tekst));
  // Een leeg veld is geen fout: het veld is leeg.
  for (const leeg of ["", "   ", "€", null, undefined]) assert.deepEqual(bedragUit(leeg), { ok: true, cent: null }, JSON.stringify(leeg));
  // Geen bedrag: negatief, drie decimalen, letters, twee komma's, of duizendtallen die niet kloppen.
  for (const fout of ["-5", "55,555", "55.555,5.5", "abc", "55 euro", "5,5,0", "1,250.00", "12.34.56", "55,", ",50", ".5", "5..5", "1e3", "0x10", "+5", "55,5O"]) {
    assert.deepEqual(bedragUit(fout), { ok: false }, JSON.stringify(fout));
  }
});

Deno.test("een bedrag tonen in een veld: wat de MT las, met twee decimalen; lezen en tonen keren naar elkaar terug", () => {
  assert.equal(bedragTekst(5500), "55,00");
  assert.equal(bedragTekst(0), "0,00");
  assert.equal(bedragTekst(5), "0,05");
  assert.equal(bedragTekst(null), "");
  assert.equal(bedragTekst(undefined), "");
  assert.equal(bedragTekst(Number.NaN), "");
  for (const cent of [0, 1, 99, 100, 5500, 11000, 125000, 999999, 1000000, 123456789]) {
    assert.deepEqual(bedragUit(bedragTekst(cent)), { ok: true, cent }, String(cent));
    assert.deepEqual(bedragUit(euro(cent)), { ok: true, cent }, euro(cent));
  }
});
