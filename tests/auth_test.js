// MT · tests/auth_test.js
// De aanmelding (code/auth.js): waar de sessie staat, het afmelden na een tijd zonder activiteit, en
// hoe supabase-js ingesteld en opgeroepen wordt. De bibliotheek en de opslag zijn nagebootst.

import assert from "node:assert/strict";
import * as auth from "../code/auth.js";

function opslag() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

const kapot = { getItem() { throw new Error("geen opslag"); }, setItem() { throw new Error("geen opslag"); }, removeItem() { throw new Error("geen opslag"); } };

Deno.test("opslag: zonder aangemeld blijven staat de sessie enkel in dit tabblad", () => {
  const lokaal = opslag(), tab = opslag();
  const o = auth.maakOpslag(lokaal, tab);
  o.kies(false);
  o.setItem("mt_auth", "sessie");
  assert.equal(tab.m.get("mt_auth"), "sessie");
  assert.equal(lokaal.m.size, 0, "er staat iets blijvend in de browser");
  assert.equal(o.getItem("mt_auth"), "sessie");
  assert.equal(o.blijft(), false);
});

Deno.test("opslag: met aangemeld blijven staat de sessie blijvend, en niet dubbel", () => {
  const lokaal = opslag(), tab = opslag();
  const o = auth.maakOpslag(lokaal, tab);
  tab.setItem("mt_auth", "oud");
  o.kies(true);
  o.setItem("mt_auth", "sessie");
  assert.equal(lokaal.m.get("mt_auth"), "sessie");
  assert.equal(tab.m.has("mt_auth"), false);
  assert.equal(o.blijft(), true);
  o.kies(false);
  o.setItem("mt_auth", "nieuw");
  assert.equal(lokaal.m.has("mt_auth"), false, "na een aanmelding zonder aangemeld blijven staat de oude sessie er nog");
});

Deno.test("opslag: mag aangemeld blijven niet voor de rol, dan verhuist de sessie naar het tabblad (B148)", () => {
  const lokaal = opslag(), tab = opslag();
  const o = auth.maakOpslag(lokaal, tab);
  o.kies(true);
  o.setItem("mt_auth", "sessie");
  o.naarTab();
  assert.equal(o.blijft(), false);
  assert.equal(tab.m.get("mt_auth"), "sessie");
  assert.equal(lokaal.m.size, 0);
  o.setItem("mt_auth", "ververst");
  assert.equal(lokaal.m.size, 0, "een ververst toegangsbewijs kwam weer blijvend in de browser");
});

Deno.test("opslag: afmelden wist alles van de aanmelding, op beide plaatsen", () => {
  const lokaal = opslag(), tab = opslag();
  const o = auth.maakOpslag(lokaal, tab);
  o.kies(true);
  o.setItem("mt_auth", "sessie");
  o.raak(123);
  tab.setItem("mt_auth-code-verifier", "x");
  o.wis();
  assert.equal(lokaal.m.size, 0);
  assert.equal(tab.m.size, 0);
});

Deno.test("opslag: een browser zonder opslag geeft geen fout, enkel geen sessie", () => {
  const o = auth.maakOpslag(kapot, kapot);
  o.kies(true);
  o.setItem("mt_auth", "sessie");
  o.raak(1);
  o.wis();
  o.naarTab();
  assert.equal(o.getItem("mt_auth"), null);
  assert.equal(o.blijft(), false);
  assert.equal(o.laatste(), 0);
  assert.equal(o.leesBericht(), null);
});

Deno.test("stilte: na de ingestelde tijd, en ook als het tijdstip ontbreekt of de klok terugsprong", () => {
  const min = 60000;
  assert.equal(auth.teLangStil(1000 * min, 1029 * min, 30), false);
  assert.equal(auth.teLangStil(1000 * min, 1030 * min, 30), true);
  assert.equal(auth.teLangStil(1000 * min, 1014 * min, 15), false);
  assert.equal(auth.teLangStil(1000 * min, 1015 * min, 15), true);
  assert.equal(auth.teLangStil(0, 1000 * min, 30), true, "zonder tijdstip");
  assert.equal(auth.teLangStil(NaN, 1000 * min, 30), true);
  assert.equal(auth.teLangStil(1000 * min, 990 * min, 30), true, "de klok sprong terug");
  assert.equal(auth.teLangStil(1000 * min, 1000 * min - 5000, 30), false, "enkele seconden klokverschil");
});

Deno.test("de code: zes cijfers, met of zonder spaties; de sleutel in groepjes van vier", () => {
  assert.equal(auth.zesCijfers("123456"), "123456");
  assert.equal(auth.zesCijfers(" 123 456 "), "123456");
  assert.equal(auth.zesCijfers("012345"), "012345", "een voorloopnul verdween");
  for (const fout of ["12345", "1234567", "12a456", "", null, undefined, "١٢٣٤٥٦"]) assert.equal(auth.zesCijfers(fout), null, String(fout));
  assert.equal(auth.inGroepjes("KLMP7Q2XD4VN9HSA"), "KLMP 7Q2X D4VN 9HSA");
  assert.equal(auth.inGroepjes("ABCDE"), "ABCD E");
});

Deno.test("uitleg: een zin voor wie aanmeldt, nooit de tekst van Supabase", () => {
  assert.match(auth.uitleg({ code: "invalid_credentials", status: 400, message: "Invalid login credentials" }), /e-mailadres of het wachtwoord klopt niet/);
  assert.match(auth.uitleg({ code: "user_banned", status: 400 }), /uitgeschakeld/);
  assert.match(auth.uitleg({ code: "mfa_verification_failed", status: 422 }, "code"), /code klopt niet/);
  assert.match(auth.uitleg({ code: "over_request_rate_limit", status: 429 }), /Te veel pogingen/);
  assert.match(auth.uitleg({ code: "over_request_rate_limit", status: 429 }, "code"), /veel aangemeld vanop dit netwerk/);
  assert.match(auth.uitleg({ code: "email_not_confirmed", status: 400 }), /nog niet bevestigd/);
  assert.match(auth.uitleg({ status: 0, message: "Failed to fetch" }), /Geen verbinding/);
  assert.match(auth.uitleg({ code: "iets_nieuws", status: 400, message: "<b>secret</b>" }), /^Aanmelden lukte niet/);
  assert.match(auth.uitleg(null, "code"), /^De code werd niet aanvaard|Geen verbinding/);
});

// ---------- supabase-js, nagebootst ----------

function bibliotheek() {
  const s = { opties: null, oproepen: [], sessie: null, factoren: [], luisteraars: [] };
  const token = (claims) => "kop." + btoa(JSON.stringify(claims)) + ".handtekening";
  s.lib = {
    createClient(url, sleutel, opties) {
      Object.assign(s, { url, sleutel, opties });
      return {
        auth: {
          getSession: async () => ({ data: { session: s.sessie }, error: null }),
          async signInWithPassword(invoer) {
            s.oproepen.push(["signInWithPassword", invoer, opties.auth.storage.blijft()]);
            if (invoer.password !== "juist wachtwoord") return { data: { session: null }, error: { code: "invalid_credentials", status: 400, message: "Invalid login credentials" } };
            s.sessie = { access_token: token({ aal: "aal1" }), user: { email: invoer.email } };
            opties.auth.storage.setItem(opties.auth.storageKey, "sessie");
            return { data: { session: s.sessie }, error: null };
          },
          async signOut(o) {
            s.oproepen.push(["signOut", o]);
            s.sessie = null;
            for (const l of s.luisteraars) l("SIGNED_OUT", null);
            return { error: null };
          },
          onAuthStateChange(l) {
            s.luisteraars.push(l);
            return { data: { subscription: { unsubscribe() {} } } };
          },
          mfa: {
            getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: s.aal ?? "aal1", nextLevel: "aal2", currentAuthenticationMethods: s.amr ?? [{ method: "password", timestamp: 1000 }] }, error: null }),
            listFactors: async () => ({ data: { all: s.factoren, totp: s.factoren.filter((f) => f.status === "verified") }, error: null }),
            async unenroll(o) {
              s.oproepen.push(["unenroll", o]);
              s.factoren = s.factoren.filter((f) => f.id !== o.factorId);
              return { data: {}, error: null };
            },
            async enroll(o) {
              s.oproepen.push(["enroll", o]);
              if (s.factoren.some((f) => f.friendly_name === o.friendlyName)) return { data: null, error: { code: "mfa_factor_name_conflict", status: 422 } };
              s.factoren.push({ id: "nieuw", factor_type: "totp", status: "unverified", friendly_name: o.friendlyName });
              return { data: { id: "nieuw", totp: { qr_code: "data:image/svg+xml;utf-8,<svg/>", secret: "KLMP7Q2XD4VN9HSA" } }, error: null };
            },
            async challengeAndVerify(o) {
              s.oproepen.push(["challengeAndVerify", o]);
              return o.code === "123456" ? { data: {}, error: null } : { data: null, error: { code: "mfa_verification_failed", status: 422 } };
            },
          },
        },
      };
    },
  };
  return s;
}

const OMGEVING = { app: "Klim-Op MT test", mt: { url: "https://voorbeeldvoorbeeldvoorb.supabase.co", sleutel: "sb_publishable_voorbeeld" } };

Deno.test("supabase-js: zonder de bibliotheek start de aanmelding niet", () => {
  assert.equal(auth.stel(OMGEVING, { lib: undefined, lokaal: opslag(), tab: opslag() }), false);
  assert.equal(auth.stel(OMGEVING, { lib: {}, lokaal: opslag(), tab: opslag() }), false);
});

Deno.test("supabase-js: eigen sleutel in de opslag, en een link uit een mail meldt nooit aan", () => {
  const s = bibliotheek();
  assert.equal(auth.stel(OMGEVING, { lib: s.lib, lokaal: opslag(), tab: opslag() }), true);
  assert.equal(s.url, OMGEVING.mt.url);
  assert.equal(s.sleutel, OMGEVING.mt.sleutel);
  assert.equal(s.opties.auth.storageKey, "mt_auth");
  assert.notEqual(s.opties.auth.storageKey, "klimop_auth", "de MT deelt haar aanmelding niet met de andere tools (B17)");
  assert.equal(s.opties.auth.detectSessionInUrl, false);
  assert.equal(s.opties.auth.persistSession, true);
  assert.equal(s.opties.auth.autoRefreshToken, true);
});

Deno.test("aanmelden: de keuze aangemeld blijven geldt vóór de sessie bewaard wordt", async () => {
  for (const blijven of [true, false]) {
    const s = bibliotheek(), lokaal = opslag(), tab = opslag();
    auth.stel(OMGEVING, { lib: s.lib, lokaal, tab });
    const r = await auth.aanmelden("proef@voorbeeld.test", "juist wachtwoord", blijven);
    assert.deepEqual(r, { ok: true });
    assert.equal(s.oproepen[0][2], blijven, "de keuze kwam te laat");
    assert.equal((blijven ? lokaal : tab).m.get("mt_auth"), "sessie");
    assert.equal((blijven ? tab : lokaal).m.has("mt_auth"), false);
    assert.ok(auth.laatste() > 0, "de activiteit werd niet genoteerd");
    assert.equal(await auth.token(), s.sessie.access_token);
  }
});

Deno.test("aanmelden: een fout wachtwoord geeft een zin, en geen sessie", async () => {
  const s = bibliotheek(), lokaal = opslag(), tab = opslag();
  auth.stel(OMGEVING, { lib: s.lib, lokaal, tab });
  const r = await auth.aanmelden("proef@voorbeeld.test", "fout", false);
  assert.equal(r.ok, false);
  assert.match(r.tekst, /klopt niet/);
  assert.equal(await auth.token(), null);
  assert.equal((await auth.niveau()).aangemeld, false);
});

Deno.test("niveau: wat het toegangsbewijs zegt over het wachtwoord en de code", async () => {
  const s = bibliotheek();
  auth.stel(OMGEVING, { lib: s.lib, lokaal: opslag(), tab: opslag() });
  await auth.aanmelden("proef@voorbeeld.test", "juist wachtwoord", false);
  assert.deepEqual(await auth.niveau(), { aangemeld: true, email: "proef@voorbeeld.test", aal: "aal1", methodes: ["password"], codeOp: null });
  s.aal = "aal2";
  s.amr = [{ method: "totp", timestamp: 2000 }, { method: "password", timestamp: 1000 }, { method: "totp", timestamp: 1500 }];
  assert.deepEqual(await auth.niveau(), { aangemeld: true, email: "proef@voorbeeld.test", aal: "aal2", methodes: ["totp", "password", "totp"], codeOp: 2000000 });
});

Deno.test("koppelen: wat van een vorige poging bleef liggen, gaat eerst weg; de app toont de naam van de omgeving", async () => {
  const s = bibliotheek();
  auth.stel(OMGEVING, { lib: s.lib, lokaal: opslag(), tab: opslag() });
  await auth.aanmelden("proef@voorbeeld.test", "juist wachtwoord", false);
  s.factoren = [{ id: "oud", factor_type: "totp", status: "unverified", friendly_name: "Klim-Op MT test 1" }, { id: "telefoon", factor_type: "phone", status: "unverified" }];
  const r = await auth.koppel();
  assert.deepEqual(r, { ok: true, id: "nieuw", qr: "data:image/svg+xml;utf-8,<svg/>", sleutel: "KLMP7Q2XD4VN9HSA" });
  const namen = s.oproepen.map((o) => o[0]);
  assert.deepEqual(namen.slice(1), ["unenroll", "enroll"]);
  assert.deepEqual(s.oproepen[1][1], { factorId: "oud" });
  assert.equal(s.oproepen[2][1].factorType, "totp");
  assert.equal(s.oproepen[2][1].issuer, "Klim-Op MT test");
  assert.match(s.oproepen[2][1].friendlyName, /^Klim-Op MT test \d+$/);
  assert.deepEqual(await auth.koppelingen(), { ok: true, gekoppeld: [], open: ["nieuw"] });
  assert.deepEqual(await auth.geefCode("nieuw", "123456"), { ok: true });
  assert.match((await auth.geefCode("nieuw", "000000")).tekst, /code klopt niet/);
});

Deno.test("afmelden: eerst in deze browser: alles weg zonder netwerk, en daarna bewaart de opslag geen sessie meer (I4)", async () => {
  const s = bibliotheek(), lokaal = opslag(), tab = opslag();
  auth.stel(OMGEVING, { lib: s.lib, lokaal, tab });
  await auth.aanmelden("proef@voorbeeld.test", "juist wachtwoord", true);
  // Zoals supabase-js de sessie bewaart: als JSON, met het toegangsbewijs erin.
  lokaal.setItem("mt_auth", JSON.stringify({ access_token: "a.b.c", refresh_token: "vernieuwen" }));
  assert.equal(auth.heeftSessie(), true);
  const voor = s.oproepen.length;
  const token = auth.afmeldenLokaal("Je bent afgemeld: er gebeurde 30 minuten niets.");
  assert.equal(token, "a.b.c", "het toegangsbewijs komt terug, om de sessie ook bij Supabase te beëindigen");
  assert.equal(s.oproepen.length, voor, "afmelden in de browser wacht op geen enkele oproep");
  assert.equal(lokaal.m.size, 0);
  assert.deepEqual([...tab.m.keys()], ["mt_auth_bericht"]);
  assert.equal(auth.heeftSessie(), false);
  // Een oproep die nog onderweg was, zet de sessie niet terug.
  const kast = auth.maakOpslag(lokaal, tab);
  kast.setItem("mt_auth", '{"access_token":"a.b.c"}');
  assert.equal(kast.heeftSessie(), true, "een nieuwe opslag bewaart wel");
  kast.sluit();
  kast.setItem("mt_auth", '{"access_token":"a.b.c"}');
  kast.raak(123);
  assert.deepEqual([kast.heeftSessie(), kast.laatste(), kast.token()], [false, 0, null], "na het sluiten kwam er toch nog iets in de opslag");
  assert.equal(auth.haalBericht(), "Je bent afgemeld: er gebeurde 30 minuten niets.");
  assert.equal(auth.haalBericht(), null, "het bericht toont maar één keer");
});

Deno.test("afmelden: een ander tabblad hoort het, via supabase-js of doordat de gedeelde sessie verdween", async () => {
  const s = bibliotheek(), lokaal = opslag(), tab = opslag();
  auth.stel(OMGEVING, { lib: s.lib, lokaal, tab });
  await auth.aanmelden("proef@voorbeeld.test", "juist wachtwoord", true);
  let gehoord = 0;
  auth.opAfgemeld(() => gehoord++);
  const meld = (key, newValue) => globalThis.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));
  meld("mt_auth", '{"access_token":"x.y.z"}');
  meld("iets_anders", null);
  assert.equal(gehoord, 0, "een vernieuwde sessie of een andere sleutel is geen afmelding");
  meld("mt_auth", null);
  assert.equal(gehoord, 1);
});
