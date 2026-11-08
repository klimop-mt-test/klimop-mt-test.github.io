// MT · tests/ui_test.js
// Het sjabloon html`…` van ui.js zet elke ingevoegde waarde om naar tekst (regel 4, 17.10).

import assert from "node:assert/strict";
import { esc, html } from "../ui.js";

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
