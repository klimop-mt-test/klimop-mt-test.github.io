// MT · tests/browser/naspelen.js
// De pagina van de MT naspelen in een echte Chromium (17.12; review 2: R2-19). De browser krijgt de
// bestanden van deze repository op het testadres; Supabase en de uitstappentool zijn nagebootst
// (tests/nabootsing.js). De serverfunctie mt-uitstappen draait echt: haar eigen bestand, met het
// nagebootste netwerk erachter. Zo loopt een verzoek van de pagina door dezelfde code als in Supabase,
// en valt op als de pagina iets anders verwacht dan de functie teruggeeft.
//
// Wat het script nakijkt: wat de startpagina toont voor een beheerder en voor een leerkracht, op 1366,
// 768 en 390 pixels breed, zonder zijwaarts scrollen; de rem (B225) met haar knop; de meldingen als de
// serverfunctie ontbreekt, niet antwoordt, ouder is of halverwege strandde; de rekentest, ook als de
// code fout rekent; en dat de pagina zelf nooit de uitstappentool aanspreekt, ook niet als ze het zou
// proberen (de CSP).
//
// Dit script hoort niet bij de gewone tests: het haalt puppeteer en Chromium op van npm (de versies
// hieronder) en start een browser. Daarom krijgt het alle rechten. Vanuit de hoofdmap van de repository:
//   deno run --allow-all tests/browser/naspelen.js <map voor de schermafbeeldingen> [scenario]
// Het eindigt met het aantal controles en het aantal fouten; bij een fout is de uitgang 1.

import chromium from "npm:@sparticuz/chromium@153.0.0";
import puppeteer from "npm:puppeteer-core@25.17.0";
import { ACCOUNTFUNCTIE_VERSIE, omgeving, UITSTAPFUNCTIE_VERSIE } from "../../code/config.js";
import { REKENVERSIE } from "../../code/rekenen.js";
import { ID, nep, OORSPRONG as SITE, URL_MT as MT } from "../nabootsing.js";
import { UITSTAPPENTOOL } from "../../functies/mt-uitstappen/index.ts";

const REPO = decodeURIComponent(new URL("../../", import.meta.url).pathname).replace(/\/$/, "");
const UIT = Deno.args[0];
const ENKEL = Deno.args[1] || null;
if (!UIT) {
  console.log("gebruik: deno run --allow-all tests/browser/naspelen.js <map voor de schermafbeeldingen> [scenario]");
  Deno.exit(2);
}
await Deno.mkdir(UIT, { recursive: true });

const BRON = UITSTAPPENTOOL.url;
const PUBLIEK_PAGINA = omgeving(SITE.replace(/^https:\/\//, "")).mt.sleutel;

const b64 = (tekst) => btoa(tekst).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Een toegangsbewijs zoals Supabase het geeft, met twee stappen: de pagina leest eruit of de app gebruikt is. */
function maakToken(n, nu) {
  const s = Math.floor(nu / 1000);
  const claims = {
    sub: ID(n), aud: "authenticated", role: "authenticated", email: "proef" + n + "@school.voorbeeld", iat: s - 60, exp: s + 3600, aal: "aal2", session_id: ID(7000 + n),
    amr: [{ method: "totp", timestamp: s - 30 }, { method: "password", timestamp: s - 60 }],
  };
  return b64('{"alg":"ES256","typ":"JWT"}') + "." + b64(JSON.stringify(claims)) + "." + b64("handtekening");
}

/**
 * Een nagebootste wereld voor één scenario: de nabootsing van de serverfunctie (tests/nabootsing.js),
 * met erbij wat de browser zelf aan het project van de MT vraagt.
 */
function wereld({ rol = "beheerder", schooljaar = "2026-2027", klassen = ["4A", "4B", "1KA"] } = {}) {
  const s = nep();
  s.nu = Date.now();
  s.rol = rol;
  s.lopend = schooljaar;
  if (schooljaar) s.schooljaar(schooljaar, "lopend", klassen);
  s.token = maakToken(1, s.nu);
  s.sessies.set(s.token, ID(1));
  s.gebruikers.set(ID(1), { rol });
  /** (verzoek) → een eigen antwoord van de serverfunctie, "gooi" voor geen antwoord, of niets: dan antwoordt de echte functie. */
  s.functieAntwoord = null;
  /** () → een eigen antwoord van mt_mijn_account, of niets. */
  s.accountFout = null;
  /** Alles wat de browser zelf vroeg, aan het project van de MT of aan de uitstappentool. */
  s.vanPagina = [];

  const json = (status, lichaam, koppen = {}) => new Response(JSON.stringify(lichaam), { status, headers: { "content-type": "application/json", ...koppen } });
  const pg = (code, message, status = 400) => json(status, { code, message: "MT: " + message });
  const naam = rol === "beheerder" ? "Proef Beheerder" : "Proef Leerkracht";
  const account = () => ({
    id: ID(1), naam, email: "proef1@school.voorbeeld", rol, schooljaar: s.lopend,
    klassen: rol === "leerkracht" ? [{ id: ID(101), naam: "4A" }] : [],
    instellingen: { afmelden_na_minuten: 30, code_geldig_dagen: 14, wachtwoord_min_lengte: 12, tijdelijk_wachtwoord_uren: 48, aangemeld_blijven: true },
  });
  const tabellen = () => ({
    gebruikers: [{ id: ID(1), naam, email: "proef1@school.voorbeeld", rol, actief: true, wachtwoord_tijdelijk: false, tijdelijk_tot: null, eerste_aanmelding_afgerond: true, app_koppelen: false, open_operatie: null, revisie: 1 }],
    schooljaren: s.lopend ? [{ schooljaar: s.lopend, stand: "lopend" }] : [],
    klassen: [],
    klastoewijzingen: [],
    account_operaties: [],
  });

  /** Een tabel lezen zoals data.js dat doet: op de sleutel, met een grens, en met het aantal dat nog volgt. */
  function tabel(url) {
    const rijenVan = tabellen()[url.pathname.replace("/rest/v1/", "")];
    if (!rijenVan) return json(404, { message: "niet nagebootst: " + url.pathname });
    let rijen = rijenVan;
    for (const [kolom, waarde] of url.searchParams) {
      if (["select", "order", "limit"].includes(kolom)) continue;
      const punt = waarde.indexOf(".");
      const [op, w] = [waarde.slice(0, punt), waarde.slice(punt + 1)];
      if (op === "eq") rijen = rijen.filter((r) => String(r[kolom]) === w);
      else if (op === "gt") rijen = rijen.filter((r) => String(r[kolom]) > w);
      else if (op === "gte") rijen = rijen.filter((r) => String(r[kolom]) >= w);
      else if (op === "is" && w === "null") rijen = rijen.filter((r) => r[kolom] === null);
      else if (op === "in") rijen = rijen.filter((r) => w.slice(1, -1).split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(r[kolom])));
      else return json(400, { message: "de nabootsing kent deze filter niet: " + kolom + "=" + waarde });
    }
    const orde = (url.searchParams.get("order") || "").split(",").map((deel) => deel.split(".")[0]).filter(Boolean);
    rijen = [...rijen].sort((a, b) => {
      for (const kolom of orde) if (a[kolom] !== b[kolom]) return a[kolom] < b[kolom] ? -1 : 1;
      return 0;
    });
    const stuk = rijen.slice(0, Number(url.searchParams.get("limit") || 1000));
    return json(stuk.length < rijen.length ? 206 : 200, stuk, { "content-range": (stuk.length ? "0-" + (stuk.length - 1) : "*") + "/" + rijen.length });
  }

  /** "Ze zijn echt weg" (B225), zoals mt_verdwenen_bevestigen in sql/006_review2.sql. */
  function bevestigVerdwenen(lichaam) {
    if (rol !== "beheerder") return pg("42501", "geen rechten voor deze handeling", 403);
    const taak = s.taken.find((t) => t.id === lichaam.p_taak);
    if (!taak) return pg("MT422", "deze taak bestaat niet");
    if (taak.stand !== "open") return pg("MT409", "deze taak is al afgehandeld");
    if (lichaam.p_aantal !== taak.uitstappen.length) return pg("MT409", "de lijst wijzigde intussen. Lees opnieuw; er is niets gewijzigd.");
    let aantal = 0;
    for (const id of taak.uitstappen) {
      const act = s.activiteiten.get(id);
      if (act && act.stand === "actief") {
        act.stand = "niet_gevonden";
        aantal++;
      }
    }
    taak.stand = "bevestigd";
    for (const l of s.lezingen) if (l.stand === "klaar") l.verouderd = true;
    return json(200, { niet_gevonden: aantal });
  }

  /** Wat de browser zelf vraagt aan het project van de MT. */
  s.mt = async (verzoek) => {
    const url = new URL(verzoek.url);
    const cors = { "access-control-allow-origin": SITE, "access-control-expose-headers": "content-range", vary: "Origin" };
    const met = (antwoord) => {
      const k = new Headers(antwoord.headers);
      for (const [kop, waarde] of Object.entries(cors)) if (!k.has(kop)) k.set(kop, waarde);
      return new Response(antwoord.body, { status: antwoord.status, headers: k });
    };
    if (url.pathname === "/functions/v1/mt-uitstappen") {
      if (s.functieAntwoord) {
        const eigen = await s.functieAntwoord(verzoek);
        if (eigen === "gooi") return "gooi";
        if (eigen) return met(eigen);
      }
      // De echte serverfunctie, met haar eigen antwoord op de voorvraag van de browser (CORS).
      return s.behandel(new Request(verzoek.url, { method: verzoek.method, headers: verzoek.headers, body: verzoek.method === "POST" ? verzoek.body : undefined }));
    }
    if (verzoek.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, prefer, accept", "access-control-allow-methods": "GET, POST, OPTIONS" } });
    }
    const lichaam = verzoek.body ? JSON.parse(verzoek.body) : {};
    if (url.pathname === "/functions/v1/mt-accounts") return met(json(200, { ok: true, versie: ACCOUNTFUNCTIE_VERSIE, bekend: true, account: {}, instellingen: account().instellingen }));
    if (url.pathname === "/rest/v1/rpc/mt_ping") return met(json(200, true));
    if (url.pathname === "/rest/v1/rpc/mt_mijn_account") return met((s.accountFout && s.accountFout()) || json(200, account()));
    if (url.pathname === "/rest/v1/rpc/mt_account_afwijkingen") return met(json(200, []));
    if (url.pathname === "/rest/v1/rpc/mt_verdwenen_bevestigen") return met(bevestigVerdwenen(lichaam));
    if (url.pathname.startsWith("/rest/v1/rpc/")) return met(json(404, { code: "PGRST202", message: "niet nagebootst: " + url.pathname }));
    if (url.pathname.startsWith("/rest/v1/")) return met(tabel(url));
    if (url.pathname.startsWith("/auth/v1/user")) return met(json(200, { id: ID(1), email: "proef1@school.voorbeeld", factors: [{ id: ID(900), factor_type: "totp", status: "verified" }] }));
    if (url.pathname.startsWith("/auth/v1/logout")) return met(new Response(null, { status: 204 }));
    return met(json(404, { message: "niet nagebootst: " + url.pathname }));
  };
  return s;
}

/** Een uitstappentool met twee schooljaren, nascholingen, een prullenbak en wat niet klopt. */
function vul(s, { vreemd = true } = {}) {
  for (let i = 0; i < 44; i++) s.uitstap("a" + String(i).padStart(3, "0"), { v: 2, datumStart: "2026-0" + (1 + (i % 6)) + "-1" + (i % 9), klassen: ["4A"], planStatus: i % 11 ? "bevestigd" : "geannuleerd" });
  for (let i = 0; i < 87; i++) s.uitstap("b" + String(i).padStart(3, "0"), { v: 2, datumStart: "2026-1" + (i % 3) + "-1" + (i % 9), klassen: i % 2 ? ["4A", "4B"] : ["1KA"], planStatus: i % 4 === 0 ? "aangevraagd" : i % 13 === 0 ? "geannuleerd" : "bevestigd" });
  for (let i = 0; i < 12; i++) s.uitstap("n" + String(i).padStart(3, "0"), { v: 2, categorie: "nascholing", datumStart: "2026-11-2" + (i % 9), planStatus: "bevestigd" });
  for (let i = 0; i < 3; i++) s.uitstap("p" + i, { v: 2, datumStart: "2026-11-0" + (i + 2), klassen: ["4B"], planStatus: "bevestigd", verwijderdOp: "2026-11-01T10:00:00.000Z" });
  if (vreemd) {
    s.uitstap("x1", { v: 2, datumStart: "2026-12-01", klassen: ["Zonneklas"], planStatus: "bevestigd" });
    s.uitstap("x2", { v: 2, datumStart: "2026-12-02", klassen: ["Zonneklas", "4Z"], planStatus: "bevestigd" });
    s.uitstap("x3", { v: 3, datumStart: "2026-12-03", klassen: ["4A"], planStatus: "bevestigd" });
    s.uitstap("x4", { v: 2, datumStart: "2026-02-30", klassen: ["4A"], planStatus: "bevestigd" });
    s.uitstap("x5", { v: 2, datumStart: ["2026-12-05"], klassen: ["4A"], planStatus: "bevestigd" });
  }
  s.klassenlijst("1KA", "4A", "4B", "5A");
  return s;
}

const SOORT = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8" };

const browser = await puppeteer.launch({ args: chromium.args.filter((a) => a !== "--single-process"), executablePath: await chromium.executablePath(), headless: "shell" });
let fouten = 0;
let controles = 0;
function zeker(naam, voorwaarde, extra = "") {
  controles++;
  if (!voorwaarde) {
    fouten++;
    console.log("  FOUT: " + naam + (extra ? " → " + String(extra).replace(/\s+/g, " ").slice(0, 900) : ""));
  }
}

/** Opent de pagina in een nieuw tabblad, met een sessie in de opslag, en een nagebootst netwerk. */
async function open(s, { breedte = 1366, hoogte = 900, vervang = null } = {}) {
  const pagina = await browser.newPage();
  await pagina.setViewport({ width: breedte, height: hoogte, deviceScaleFactor: 1 });
  const log = { console: [], fouten: [], mislukt: [], naarBron: [] };
  pagina.on("console", (m) => {
    if (["error", "warning", "warn"].includes(m.type())) log.console.push(m.type() + ": " + m.text());
  });
  pagina.on("pageerror", (e) => log.fouten.push(String(e)));
  await pagina.setRequestInterception(true);
  pagina.on("request", async (verzoek) => {
    const url = new URL(verzoek.url());
    try {
      if (url.origin === SITE) {
        let pad = decodeURIComponent(url.pathname);
        if (pad === "/") pad = "/index.html";
        const bestand = REPO + pad;
        let inhoud;
        try {
          if (pad.includes("..")) throw new Error("buiten de repository");
          inhoud = await Deno.readFile(bestand);
        } catch {
          return verzoek.respond({ status: 404, contentType: "text/plain", body: "niet gevonden" });
        }
        if (vervang && vervang[pad]) inhoud = new TextEncoder().encode(vervang[pad](new TextDecoder().decode(inhoud)));
        return verzoek.respond({ status: 200, contentType: SOORT[pad.slice(pad.lastIndexOf("."))] || "application/octet-stream", body: inhoud, headers: { "cache-control": "max-age=600" } });
      }
      if (url.origin === BRON) {
        // De pagina hoort de uitstappentool nooit aan te spreken: de CSP laat het niet toe.
        log.naarBron.push(verzoek.method() + " " + url.pathname);
        return verzoek.abort("blockedbyclient");
      }
      if (url.origin === MT) {
        const nagebootst = { url: verzoek.url(), method: verzoek.method(), headers: verzoek.headers(), body: verzoek.postData() };
        s.vanPagina.push(nagebootst);
        const antwoord = await s.mt(nagebootst);
        if (antwoord === "gooi") return verzoek.abort("connectionfailed");
        const koppen = {};
        antwoord.headers.forEach((waarde, kop) => (koppen[kop] = waarde));
        return verzoek.respond({ status: antwoord.status, headers: koppen, body: new Uint8Array(await antwoord.arrayBuffer()) });
      }
      log.mislukt.push("naar buiten: " + verzoek.url());
      return verzoek.abort("blockedbyclient");
    } catch (fout) {
      log.mislukt.push(verzoek.url() + ": " + fout);
      return verzoek.abort("failed");
    }
  });
  const sessie = {
    access_token: s.token, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "verversing",
    user: { id: ID(1), aud: "authenticated", role: "authenticated", email: "proef1@school.voorbeeld", factors: [{ id: ID(900), factor_type: "totp", status: "verified" }] },
  };
  await pagina.evaluateOnNewDocument((bewaard, nu, site) => {
    if (location.origin !== site) return;
    if (!sessionStorage.getItem("mt_test_gezet")) {
      sessionStorage.setItem("mt_auth", bewaard);
      sessionStorage.setItem("mt_auth_actief", String(nu));
      sessionStorage.setItem("mt_test_gezet", "1");
    }
  }, JSON.stringify(sessie), Date.now(), SITE);
  await pagina.goto(SITE + "/", { waitUntil: "networkidle0", timeout: 30000 });
  return { pagina, log };
}

const tekstVan = (pagina, kiezer) => pagina.$eval(kiezer, (el) => el.innerText).catch(() => null);
const kaart = (pagina) => tekstVan(pagina, "#kaartUitstappentool");
/** Een schermafbeelding, na de overgang van een onderdeel (0,22 s). */
async function beeld(pagina, naam, opties = {}) {
  await new Promise((klaar) => setTimeout(klaar, 450));
  await pagina.screenshot({ path: UIT + "/" + naam, ...opties });
}
async function klik(pagina, kiezer) {
  const el = await pagina.waitForSelector(kiezer, { visible: true, timeout: 5000 });
  await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const vak = await el.boundingBox();
  await pagina.mouse.click(vak.x + vak.width / 2, vak.y + vak.height / 2);
}
const rust = (pagina) => pagina.waitForNetworkIdle({ idleTime: 400, timeout: 15000 }).catch(() => undefined);
const wachtOp = (pagina, patroon) => pagina.waitForFunction((bron) => new RegExp(bron).test(document.querySelector("#kaartUitstappentool").innerText), { timeout: 15000 }, patroon.source);
async function zonderZijwaartsScrollen(pagina, naam) {
  const [breed, venster] = await pagina.evaluate(() => [document.documentElement.scrollWidth, globalThis.innerWidth]);
  zeker(naam + ": niets scrolt zijwaarts", breed <= venster, breed + " > " + venster);
}
function schoon(log, naam, toegelaten = []) {
  const echt = log.console.filter((regel) => !toegelaten.some((t) => regel.includes(t)));
  zeker(naam + ": de console bleef leeg", echt.length === 0, echt.join(" | "));
  zeker(naam + ": geen fout in de pagina", log.fouten.length === 0, log.fouten.join(" | "));
  zeker(naam + ": niets ging naar een onbekend adres", log.mislukt.length === 0, log.mislukt.join(" | "));
  zeker(naam + ": de pagina sprak de uitstappentool niet aan", log.naarBron.length === 0, log.naarBron.join(" | "));
}
const naarFunctie = (s) => s.vanPagina.filter((o) => o.url.includes("/functions/v1/mt-uitstappen") && o.method === "POST");

const SCENARIOS = {
  // De beheerder, met een lopend schooljaar en van alles wat aandacht vraagt.
  async beheerder() {
    for (const breedte of [1366, 768, 390]) {
      const s = vul(wereld());
      const { pagina, log } = await open(s, { breedte });
      await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
      const blok = await kaart(pagina);
      zeker("de titel", (await tekstVan(pagina, "#startTitel")) === "Dag Proef Beheerder");
      zeker("de tabel telt per schooljaar", /2025-2026\s+40\s+0\s+4/.test(blok) && /2026-2027/.test(blok), blok);
      zeker("het lopende schooljaar is aangeduid", /2026-2027\s*lopend in de MT/.test(blok), blok);
      zeker("wat nooit meetelt", blok.includes("12 nascholingen, 3 uitstappen in de prullenbak en 1 uitstap zonder geldige datum"), blok);
      zeker("wat de MT volgt", /De MT volgt 89 uitstappen: 89 nieuw\./.test(blok), blok);
      zeker("buiten de open schooljaren", /44 uitstappen vallen buiten de schooljaren/.test(blok), blok);
      zeker("de klassen zijn bijgewerkt", /De klassen van 2026-2027 zijn bijgewerkt: 1 nieuw\./.test(blok), blok);
      zeker("klas onbekend, met het aantal uitstappen", /Zonneklas \(2 uitstappen\)/.test(blok) && /4Z \(1 uitstap\)/.test(blok), blok);
      zeker("een onbekende opbouw", /1 uitstap heeft een opbouw die deze versie van de MT niet kent/.test(blok), blok);
      zeker("een ongeldige datum", blok.includes("1 uitstap heeft geen geldige datum of gegevens: de MT neemt hem niet over. Kijk hem na in de uitstappentool."), blok);
      zeker("een rij die de MT niet kan lezen", blok.includes("1 uitstap staat in de uitstappentool in een vorm die de MT niet kan lezen. De MT neemt hem niet over, en houdt wat ze wist."), blok);
      zeker("wanneer er gelezen is", /Gelezen op [a-z]+ \d{1,2} [a-z]+ \d{4} om \d{2}:\d{2}\./.test(blok), blok);
      zeker("de kaarten van de beheerder", (await pagina.$eval("#kaartRekentest", (e) => !e.hidden)) && (await pagina.$eval("#kaartGebruikers", (e) => !e.hidden)));
      await zonderZijwaartsScrollen(pagina, "start " + breedte);
      await beeld(pagina, "beheerder-start-" + breedte + ".png", { fullPage: true });

      // Meteen opnieuw: binnen de dertig seconden leest de MT niet opnieuw, en de kaart zegt dat.
      const voor = naarFunctie(s).length;
      const lezingen = s.lezingen.length;
      await klik(pagina, '#kaartUitstappentool [data-doe="opnieuw"]');
      await wachtOp(pagina, /minder dan een halve minuut geleden/);
      zeker("opnieuw lezen vraagt de serverfunctie opnieuw", naarFunctie(s).length === voor + 1);
      zeker("binnen de dertig seconden komt er geen nieuwe lezing", s.lezingen.length === lezingen);
      zeker("de kaart toont dan nog altijd de vorige lezing", /De MT volgt 89 uitstappen: 89 nieuw\./.test(await kaart(pagina)), await kaart(pagina));
      if (breedte === 390) await beeld(pagina, "beheerder-recent-390.png", { fullPage: true });
      // Later: de tweede lezing vindt alles ongewijzigd.
      s.later();
      await klik(pagina, '#kaartUitstappentool [data-doe="opnieuw"]');
      await wachtOp(pagina, /89 ongewijzigd/);
      zeker("de tweede lezing is ongewijzigd", (await kaart(pagina)).includes("De MT volgt 89 uitstappen: 89 ongewijzigd."), await kaart(pagina));

      // De rekentest.
      await klik(pagina, "#naarRekentest");
      await pagina.waitForSelector("#view-rekentest.active .mt-geval", { timeout: 5000 });
      const test = await tekstVan(pagina, "#view-rekentest");
      zeker("de rekentest: alles klopt", new RegExp("Alle \\d+ controles in 17 gevallen kloppen met het rekencontract \\(versie \\d+, rekenversie " + REKENVERSIE + "\\)\\.").test(test), test.slice(0, 300));
      zeker("de rekentest: geen afwijking", !test.includes("wijkt af"));
      zeker("de rekentest: G1 met het bedrag", test.includes("activiteit € 8,15 · vervoer € 10,65 · totaal € 18,80"));
      zeker("de rekentest: een onbekende prijs is nooit € 0", test.includes("activiteit onbekend · vervoer € 7,27 · totaal onbekend"));
      zeker("de rekentest: 17 gevallen", (await pagina.$$eval("#view-rekentest .mt-geval", (els) => els.length)) === 17);
      await zonderZijwaartsScrollen(pagina, "rekentest " + breedte);
      await beeld(pagina, "rekentest-" + breedte + ".png", { fullPage: false });
      if (breedte === 1366) await beeld(pagina, "rekentest-volledig-1366.png", { fullPage: true });
      await klik(pagina, '#view-rekentest [data-doe="terug"]');
      await pagina.waitForSelector("#view-start.active", { timeout: 5000 });

      // Het scherm Gebruikers opent nog: de lijsten komen er op hun sleutel, met het aantal dat nog volgt.
      await klik(pagina, "#naarGebruikers");
      await pagina.waitForSelector("#view-gebruikers.active", { timeout: 5000 });
      await rust(pagina);
      zeker("Gebruikers opent nog", (await tekstVan(pagina, "#view-gebruikers")).includes("Proef Beheerder"), await tekstVan(pagina, "#view-gebruikers"));
      const lijsten = s.vanPagina.filter((o) => o.method === "GET" && o.url.includes("/rest/v1/gebruikers"));
      zeker("de lijst van de gebruikers is op haar sleutel gelezen", lijsten.length >= 1 && lijsten.every((o) => /[?&]order=id\.asc/.test(o.url) && /count=exact/.test(o.headers.prefer || "")), lijsten.map((o) => o.url).join(" | "));

      // Naar de serverfunctie ging niets dan de vraag, met het toegangsbewijs en de openbare sleutel van de MT.
      zeker("naar de serverfunctie: enkel de vraag", naarFunctie(s).length >= 3 && naarFunctie(s).every((o) => o.body === '{"actie":"bijwerken"}' && o.headers.authorization === "Bearer " + s.token && o.headers.apikey === PUBLIEK_PAGINA));
      // De serverfunctie zelf las de uitstappentool, met haar sleutel en zonder toegangsbewijs.
      zeker("de serverfunctie las de uitstappentool", s.naarBron().length >= 2 && s.naarBron().every((o) => o.sleutel === UITSTAPPENTOOL.sleutel && o.drager === null));
      schoon(log, "beheerder " + breedte);
      await pagina.close();
    }
  },

  // Een leerkracht: geen kaarten van de beheerder, gewone taal, en geen klassen bijwerken.
  async leerkracht() {
    const s = vul(wereld({ rol: "leerkracht", klassen: ["4A", "4B"] }));
    const { pagina, log } = await open(s, { breedte: 390, hoogte: 800 });
    await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
    const blok = await kaart(pagina);
    zeker("leerkracht: het blok staat er", blok.includes("De MT volgt 89 uitstappen"), blok);
    zeker("leerkracht: 1KA is onbekend, met wat ze eraan heeft", /1KA \(44 uitstappen\)/.test(blok) && /beheerder/.test(blok), blok);
    zeker("leerkracht: geen namen van de techniek", !/Supabase|Edge Functions|serverfunctie|index\.ts/.test(blok), blok);
    zeker("leerkracht: geen kaarten van de beheerder", (await pagina.$eval("#kaartRekentest", (e) => e.hidden)) && (await pagina.$eval("#kaartGebruikers", (e) => e.hidden)));
    zeker("leerkracht: de klassen zijn niet gelezen", !s.naarBron().some((o) => o.pad === "/rest/v1/instellingen"));
    await zonderZijwaartsScrollen(pagina, "leerkracht 390");
    await beeld(pagina, "leerkracht-390.png", { fullPage: true });
    schoon(log, "leerkracht");
    await pagina.close();
  },

  // Zoals het testproject nu is: nog geen schooljaar.
  async zonderSchooljaar() {
    const s = vul(wereld({ schooljaar: null }), { vreemd: false });
    const { pagina, log } = await open(s, { breedte: 1366 });
    await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
    const blok = await kaart(pagina);
    zeker("zonder schooljaar: de uitstappen wachten", blok.includes("In de MT is er nog geen lopend schooljaar: de uitstappen wachten tot het aangemaakt is."), blok);
    zeker("zonder schooljaar: geen waarschuwing", (await pagina.$$eval("#kaartUitstappentool .let-op, #kaartUitstappentool .mt-lijstfout", (els) => els.length)) === 0, blok);
    zeker("zonder schooljaar: de tabel staat er toch", /2026-2027\s+60\s+22\s+5/.test(blok), blok);
    await beeld(pagina, "zonder-schooljaar-1366.png", { fullPage: true });
    schoon(log, "zonder schooljaar");
    await pagina.close();
  },

  // De rem (B225): zes uitstappen die de MT nog meetelde, staan niet meer in de uitstappentool.
  async rem() {
    for (const [rol, breedte] of [["beheerder", 1366], ["beheerder", 390], ["leerkracht", 390]]) {
      const s = wereld({ rol, klassen: ["4A", "4B"] });
      for (let i = 1; i <= 9; i++) s.uitstap("r" + i, { v: 2, datumStart: "2026-12-0" + i, klassen: ["4A"], planStatus: "bevestigd" });
      s.klassenlijst("4A", "4B");
      const { pagina, log } = await open(s, { breedte });
      await wachtOp(pagina, /De MT volgt 9 uitstappen: 9 nieuw\./);
      // Zes van de negen verdwijnen.
      s.bron.uitstappen = s.bron.uitstappen.filter((r) => ["r1", "r2", "r3"].includes(r.id));
      s.later();
      await klik(pagina, '#kaartUitstappentool [data-doe="opnieuw"]');
      await wachtOp(pagina, /niet meer in de uitstappentool/);
      const blok = await kaart(pagina);
      const standen = () => [...s.activiteiten.values()].map((a) => a.stand).sort().join(",");
      zeker("rem " + rol + ": de MT telt ze verder mee", /de MT telt ze verder mee/.test(blok) && standen() === Array(9).fill("actief").join(","), blok);
      if (rol === "beheerder") {
        zeker("rem: de beheerder leest hoeveel en welke", /6 uitstappen die de MT nog meetelden, staan niet meer in de uitstappentool: 04\/12\/2026/.test(blok) && /09\/12\/2026/.test(blok), blok);
        zeker("rem: de knop staat er, als tekst", (await tekstVan(pagina, '#kaartUitstappentool [data-doe="verdwenen"]')) === "Ze zijn echt weg");
        await zonderZijwaartsScrollen(pagina, "rem " + breedte);
        await beeld(pagina, "rem-beheerder-" + breedte + ".png", { fullPage: true });
        // Eerst de vraag; "Nee" wijzigt niets.
        await klik(pagina, '#kaartUitstappentool [data-doe="verdwenen"]');
        await pagina.waitForSelector('.modal[role="dialog"]', { visible: true, timeout: 5000 });
        const vraag = await tekstVan(pagina, '.modal[role="dialog"]');
        zeker("rem: de vraag zegt wat er gebeurt", /6 uitstappen staan niet meer in de uitstappentool\. Bevestig je, dan telt de MT ze niet meer mee\./.test(vraag) && /Ja, ze zijn echt weg/.test(vraag) && /Nee, nog niet/.test(vraag), vraag);
        await zonderZijwaartsScrollen(pagina, "rem, de vraag " + breedte);
        await beeld(pagina, "rem-vraag-" + breedte + ".png");
        zeker("rem: \"Nee\" heeft de focus", await pagina.evaluate(() => document.activeElement && document.activeElement.dataset.keuze === "nee"));
        await klik(pagina, '.modal [data-keuze="nee"]');
        await new Promise((klaar) => setTimeout(klaar, 400));
        zeker("rem: na \"Nee\" is er niets gewijzigd", standen() === Array(9).fill("actief").join(",") && !s.vanPagina.some((o) => o.url.includes("mt_verdwenen_bevestigen")));
        // Dan "Ja": de MT telt ze niet meer mee, en leest meteen opnieuw.
        await klik(pagina, '#kaartUitstappentool [data-doe="verdwenen"]');
        await pagina.waitForSelector('.modal[role="dialog"]', { visible: true, timeout: 5000 });
        await klik(pagina, '.modal [data-keuze="ja"]');
        await pagina.waitForFunction(() => !/Ze zijn echt weg/.test(document.querySelector("#kaartUitstappentool").innerText), { timeout: 15000 });
        await rust(pagina);
        const bevestigd = s.vanPagina.filter((o) => o.url.includes("mt_verdwenen_bevestigen") && o.method === "POST");
        zeker("rem: de bevestiging draagt de taak en het aantal", bevestigd.length === 1 && JSON.parse(bevestigd[0].body).p_aantal === 6 && typeof JSON.parse(bevestigd[0].body).p_taak === "string", bevestigd.map((o) => o.body).join(" | "));
        zeker("rem: na de bevestiging telt de MT ze niet meer mee", standen() === [...Array(3).fill("actief"), ...Array(6).fill("niet_gevonden")].join(","), standen());
        const na = await kaart(pagina);
        zeker("rem: de kaart is opnieuw gelezen, zonder de rem", /De MT volgt 3 uitstappen: 3 ongewijzigd\./.test(na) && !/te veel om zomaar over te nemen/.test(na), na);
        await beeld(pagina, "rem-bevestigd-" + breedte + ".png", { fullPage: true });
      } else {
        zeker("rem: een leerkracht leest het in gewone taal, zonder knop", /6 uitstappen staan niet meer in de uitstappentool\. Dat zijn er veel tegelijk: de MT telt ze verder mee tot een beheerder dit nakijkt\./.test(blok) && (await pagina.$('#kaartUitstappentool [data-doe="verdwenen"]')) === null, blok);
        await zonderZijwaartsScrollen(pagina, "rem leerkracht " + breedte);
        await beeld(pagina, "rem-leerkracht-" + breedte + ".png", { fullPage: true });
      }
      schoon(log, "rem " + rol + " " + breedte);
      await pagina.close();
    }
  },

  // De serverfunctie staat er nog niet, antwoordt niet, is bezet, strandde halverwege, of is ouder.
  async functieFaalt() {
    const fout = (status, lichaam) => () => new Response(JSON.stringify(lichaam), { status, headers: { "content-type": "application/json" } });
    const gevallen = [
      ["ontbreekt", "beheerder", fout(404, { code: "NOT_FOUND", message: "Requested function was not found" }), /De serverfunctie mt-uitstappen staat nog niet in Supabase\. Plak functies\/mt-uitstappen\/index\.ts in Supabase, bij Edge Functions\./, ["404"]],
      ["stil", "beheerder", () => "gooi", /De MT kreeg geen antwoord op de vraag om de uitstappen bij te werken: de uitkomst is niet bekend\./, ["Failed to load resource", "net::ERR"]],
      ["stil", "leerkracht", () => "gooi", /de uitkomst is niet bekend\. Controleer je internetverbinding en probeer het opnieuw\./, ["Failed to load resource", "net::ERR"]],
      ["bezet", "beheerder", fout(503, { ok: false, code: "databank", melding: "De databank van de MT antwoordt niet. Probeer het over enkele minuten opnieuw.", deels: false }), /De MT is nu niet bijgewerkt met de uitstappentool\. De databank van de MT antwoordt niet\./, ["503"]],
      ["deels", "beheerder", fout(503, { ok: false, code: "databank", melding: "De databank van de MT antwoordt niet. Probeer het over enkele minuten opnieuw.", deels: true }), /Het bijwerken van de uitstappen is niet voltooid: een deel kan al bewaard zijn\. Probeer het opnieuw: de MT vult dan aan\./, ["503"]],
      ["deels", "leerkracht", fout(503, { ok: false, code: "databank", melding: "De databank van de MT antwoordt niet. Probeer het over enkele minuten opnieuw.", deels: true }), /een deel kan al bewaard zijn\. Probeer het opnieuw: de MT vult dan aan\. Blijft dit zo, meld het dan aan de beheerder\./, ["503"]],
      ["ingehaald", "beheerder", fout(409, { ok: false, code: "ingehaald", melding: "deze lezing is ingehaald door een nieuwere, of al afgesloten. Er is niets gewijzigd.", deels: false }), /Terwijl de MT de uitstappentool las, begon ze aan een nieuwere lezing\. Die geldt: deze lezing heeft niets gewijzigd\./, ["409"]],
    ];
    for (const [naam, rol, antwoord, verwacht, toegelaten] of gevallen) {
      const s = vul(wereld({ rol }), { vreemd: false });
      s.functieAntwoord = (v) => (v.method === "POST" ? antwoord() : null);
      const { pagina, log } = await open(s, { breedte: 768 });
      await pagina.waitForSelector("#kaartUitstappentool .mt-lijstfout", { timeout: 20000 });
      const blok = await kaart(pagina);
      zeker("functie " + naam + " (" + rol + "): de melding", verwacht.test(blok), blok);
      zeker("functie " + naam + " (" + rol + "): geen tabel met nullen", (await pagina.$("#kaartUitstappentool table")) === null, blok);
      if (rol !== "beheerder") zeker("functie " + naam + " (" + rol + "): geen namen van de techniek", !/Supabase|Edge Functions|serverfunctie|index\.ts/.test(blok), blok);
      await zonderZijwaartsScrollen(pagina, "functie " + naam);
      await beeld(pagina, "functie-" + naam + "-" + rol + "-768.png", { fullPage: true });
      // Daarna lukt het weer: opnieuw lezen toont alles.
      s.functieAntwoord = null;
      await klik(pagina, '#kaartUitstappentool [data-doe="opnieuw"]');
      await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
      zeker("functie " + naam + " (" + rol + "): na opnieuw lezen staat alles er", /De MT volgt 87 uitstappen: 87 nieuw\./.test(await kaart(pagina)) && (await pagina.$("#kaartUitstappentool .mt-lijstfout")) === null, await kaart(pagina));
      // En strandt het dan opnieuw, dan blijft de laatste goede lezing staan, onder de melding.
      s.functieAntwoord = (v) => (v.method === "POST" ? antwoord() : null);
      s.later();
      await klik(pagina, '#kaartUitstappentool [data-doe="opnieuw"]');
      await pagina.waitForSelector("#kaartUitstappentool .mt-lijstfout", { timeout: 20000 });
      zeker("functie " + naam + " (" + rol + "): de laatste goede lezing blijft staan onder de melding", verwacht.test(await kaart(pagina)) && (await pagina.$("#kaartUitstappentool table")) !== null, await kaart(pagina));
      if (naam === "deels" && rol === "beheerder") await beeld(pagina, "functie-deels-na-goede-lezing-768.png", { fullPage: true });
      schoon(log, "functie " + naam + " (" + rol + ")", toegelaten);
      await pagina.close();
    }
    // Een oudere versie in Supabase.
    const s = vul(wereld(), { vreemd: false });
    s.functieAntwoord = async (v) => {
      if (v.method !== "POST") return null;
      const echt = await s.behandel(new Request(v.url, { method: v.method, headers: v.headers, body: v.body }));
      return new Response(JSON.stringify({ ...(await echt.json()), versie: "0.7.1" }), { status: 200, headers: echt.headers });
    };
    const { pagina, log } = await open(s, { breedte: 390 });
    await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
    const blok = await kaart(pagina);
    zeker("oudere functie: de melding", blok.includes("In Supabase staat versie 0.7.1 van de serverfunctie mt-uitstappen; deze versie van de MT verwacht " + UITSTAPFUNCTIE_VERSIE + ". Plak functies/mt-uitstappen/index.ts opnieuw in Supabase, bij Edge Functions."), blok);
    await zonderZijwaartsScrollen(pagina, "oudere functie 390");
    await beeld(pagina, "functie-ouder-390.png", { fullPage: true });
    schoon(log, "oudere functie");
    await pagina.close();
  },

  // De uitstappentool antwoordt de serverfunctie niet: er wijzigt niets, en de kaart zegt het.
  async bronStil() {
    const s = vul(wereld());
    s.storing = (o) => (o.host === BRON ? "gooi" : null);
    const { pagina, log } = await open(s, { breedte: 1366 });
    await pagina.waitForSelector("#kaartUitstappentool .mt-lijstfout", { timeout: 20000 });
    const blok = await kaart(pagina);
    zeker("bron stil: de kaart zegt het", blok.includes("De uitstappentool antwoordt niet. De MT toont de stand van de vorige keer"), blok);
    zeker("bron stil: er ging niets naar de databank", s.activiteiten.size === 0 && s.naarDatabank().length === 0);
    zeker("bron stil: de lezing is afgebroken, zodat de volgende niet moet wachten", s.lezingen.length === 1 && s.lezingen[0].stand === "afgebroken");
    zeker("bron stil: geen tabel met nullen", (await pagina.$("#kaartUitstappentool table")) === null);
    await beeld(pagina, "bron-stil-1366.png", { fullPage: true });
    // Daarna antwoordt ze weer: opnieuw lezen herstelt alles, meteen.
    s.storing = null;
    await klik(pagina, '#kaartUitstappentool [data-doe="opnieuw"]');
    await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
    zeker("bron stil: na opnieuw lezen staat alles er", (await kaart(pagina)).includes("De MT volgt 89 uitstappen: 89 nieuw."), await kaart(pagina));
    schoon(log, "bron stil", ["Failed to load resource", "503"]);
    await pagina.close();
  },

  // Er loopt al een lezing, bv. van een collega: de kaart toont de vorige, en zegt dat er gelezen wordt.
  async bezig() {
    const s = vul(wereld(), { vreemd: false });
    const { pagina, log } = await open(s, { breedte: 390 });
    await wachtOp(pagina, /De MT volgt 87 uitstappen: 87 nieuw\./);
    // Een andere lezing begint, en is nog niet klaar.
    s.later();
    s.lezingen.push({ nummer: s.lezingen.length + 1, stand: "bezig", begonnen: s.nu, klaar: null, door: null, tellingen: null, uitkomst: null, verouderd: false });
    await klik(pagina, '#kaartUitstappentool [data-doe="opnieuw"]');
    await wachtOp(pagina, /leest de uitstappentool op dit moment opnieuw/);
    const blok = await kaart(pagina);
    zeker("bezig: de kaart toont de vorige lezing, met haar uur", /De MT leest de uitstappentool op dit moment opnieuw\. Hieronder staat de vorige lezing, van [a-z]+ \d{1,2} [a-z]+ \d{4} om \d{2}:\d{2}\./.test(blok) && /De MT volgt 87 uitstappen/.test(blok), blok);
    zeker("bezig: er kwam geen tweede lezing naast", s.lezingen.filter((l) => l.stand === "bezig").length === 1);
    await zonderZijwaartsScrollen(pagina, "bezig 390");
    await beeld(pagina, "bezig-390.png", { fullPage: true });
    schoon(log, "bezig");
    await pagina.close();
  },

  // De serverfunctie weigert de aanmelding. Aanvaardt de databank ze nog, dan herlaadt de pagina niet;
  // is ze ook daar niet meer in orde, dan herlaadt ze één keer, en vraagt het aanmeldscherm wat nodig is.
  async sessieVerlopen() {
    const weiger = (koppen = {}) => new Response('{"ok":false,"code":"sessie","melding":"Je sessie is verlopen. Meld opnieuw aan.","deels":false}', { status: 401, headers: { "content-type": "application/json", ...koppen } });
    const s = vul(wereld(), { vreemd: false });
    s.functieAntwoord = (v) => (v.method === "POST" ? weiger() : null);
    const { pagina, log } = await open(s, { breedte: 1366 });
    await pagina.waitForSelector("#kaartUitstappentool .mt-lijstfout", { timeout: 20000 });
    const blok = await kaart(pagina);
    zeker("functie weigert, databank niet: de melding", blok.includes("De serverfunctie mt-uitstappen aanvaardt je aanmelding niet: de MT is nu niet bijgewerkt met de uitstappentool."), blok);
    zeker("functie weigert, databank niet: de pagina herlaadde niet", naarFunctie(s).length === 1);
    schoon(log, "functie weigert", ["401"]);
    await pagina.close();

    const t = vul(wereld(), { vreemd: false });
    let geladen = 0;
    t.functieAntwoord = (v) => (v.method === "POST" ? weiger() : null);
    const echt = t.mt;
    // De eerste keer aanvaardt de databank de aanmelding nog (de pagina start); daarna niet meer.
    t.mt = (verzoek) => {
      const url = new URL(verzoek.url);
      const cors = { "access-control-allow-origin": SITE };
      if (verzoek.method !== "OPTIONS" && url.pathname === "/rest/v1/rpc/mt_mijn_account" && ++geladen > 1) return new Response('{"code":"PGRST301","message":"JWT expired"}', { status: 401, headers: { "content-type": "application/json", ...cors } });
      if (verzoek.method !== "OPTIONS" && url.pathname === "/functions/v1/mt-accounts" && geladen > 1) return weiger(cors);
      return echt(verzoek);
    };
    const tweede = await open(t, { breedte: 1366 });
    await tweede.pagina.waitForSelector("#view-aanmelden.active", { timeout: 20000 });
    await rust(tweede.pagina);
    zeker("sessie echt verlopen: het aanmeldscherm staat er", (await tekstVan(tweede.pagina, "#aanmeldKaart") || "").includes("Aanmelden"), await tekstVan(tweede.pagina, "#aanmeldKaart"));
    zeker("sessie echt verlopen: één keer herladen, niet blijven herladen", naarFunctie(t).length === 1);
    await beeld(tweede.pagina, "sessie-verlopen-1366.png");
    schoon(tweede.log, "sessie verlopen", ["401"]);
    await tweede.pagina.close();
  },

  // De pagina kan de uitstappentool niet aanspreken, ook niet als een script het zou proberen: de CSP weigert het.
  async csp() {
    const s = vul(wereld(), { vreemd: false });
    const { pagina, log } = await open(s, { breedte: 1366 });
    await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
    const uitkomst = await pagina.evaluate((adres) => fetch(adres + "/rest/v1/uitstappen?select=id", { headers: { apikey: "x" } }).then(() => "gelukt", () => "geweigerd"), BRON);
    zeker("csp: een oproep naar de uitstappentool wordt geweigerd", uitkomst === "geweigerd", uitkomst);
    zeker("csp: er vertrok niets", log.naarBron.length === 0, log.naarBron.join(" | "));
    zeker("csp: de browser meldt dat het de CSP is", log.console.some((regel) => /Content Security Policy/.test(regel) && /connect-src/.test(regel)), log.console.join(" | "));
    const elders = await pagina.evaluate(() => fetch("https://voorbeeld.test/", { mode: "no-cors" }).then(() => "gelukt", () => "geweigerd"));
    zeker("csp: ook een ander adres wordt geweigerd", elders === "geweigerd" && log.mislukt.length === 0, elders + " " + log.mislukt.join(" | "));
    await pagina.close();
  },

  // Rekent de code fout, dan toont de rekentest dat: hier met een afronding die de halve cent naar boven afrondt.
  async rekentestMetFout() {
    const s = vul(wereld(), { vreemd: false });
    const { pagina, log } = await open(s, {
      breedte: 1366,
      vervang: { "/code/rekenen.js": (tekst) => {
        if (!tekst.includes("const uit = 2n * r > n ? q + 1n : q;")) throw new Error("de regel van de afronding staat er niet meer zo");
        return tekst.replace("const uit = 2n * r > n ? q + 1n : q;", "const uit = 2n * r >= n ? q + 1n : q;");
      } },
    });
    await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
    await klik(pagina, "#naarRekentest");
    await pagina.waitForSelector("#view-rekentest.active .mt-geval", { timeout: 5000 });
    const test = await tekstVan(pagina, "#view-rekentest");
    zeker("rekentest met fout: de afwijkingen staan bovenaan", /\d+ van de \d+ controles wijken af\. Meld dit: de MT rekent dan niet zoals het rekencontract\./.test(test), test.slice(0, 200));
    zeker("rekentest met fout: G1d wijkt af, met beide bedragen", /€ 9,82[\s\S]{0,80}€ 9,83/.test(test));
    zeker("rekentest met fout: rode rijen", (await pagina.$$eval("#view-rekentest .mt-controle.fout", (els) => els.length)) >= 3);
    await pagina.evaluate(() => document.querySelector("#view-rekentest .mt-controle.fout").scrollIntoView({ block: "center" }));
    await beeld(pagina, "rekentest-fout-1366.png");
    schoon(log, "rekentest met fout");
    await pagina.close();
  },
};

if (ENKEL && !Object.hasOwn(SCENARIOS, ENKEL)) {
  console.log("onbekend scenario: " + ENKEL + ". Kies uit: " + Object.keys(SCENARIOS).join(", "));
  await browser.close();
  Deno.exit(2);
}
for (const [naam, speel] of Object.entries(SCENARIOS)) {
  if (ENKEL && naam !== ENKEL) continue;
  console.log("scenario: " + naam);
  try {
    await speel();
  } catch (fout) {
    fouten++;
    console.log("  FOUT: het scenario liep vast → " + (fout && fout.stack ? fout.stack.split("\n").slice(0, 4).join(" | ") : fout));
  }
}
await browser.close();
console.log(controles + " controles, " + fouten + " fout" + (fouten === 1 ? "" : "en"));
Deno.exit(fouten ? 1 : 0);
