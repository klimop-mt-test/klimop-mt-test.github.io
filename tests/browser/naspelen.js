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
// Sinds stap 4a ook de tabbladen, het schooljaar in de kop, en Instellingen: een schooljaar aanmaken,
// invullen en starten, tot de klassen en de uitstappen er staan; een volgend schooljaar met wat vorig jaar
// gold; en wat er misloopt bij het bewaren en het starten. De nabootsing schrijft en start schooljaren
// zoals de databank (sql/002_databank.sql, sql/007_schooljaar.sql).
//
// Dit script hoort niet bij de gewone tests: het haalt puppeteer en Chromium op van npm (de versies
// hieronder) en start een browser. Daarom krijgt het alle rechten. Vanuit de hoofdmap van de repository:
//   deno run --allow-all tests/browser/naspelen.js <map voor de schermafbeeldingen> [scenario]
// Het eindigt met het aantal controles en het aantal fouten; bij een fout is de uitgang 1.

import chromium from "npm:@sparticuz/chromium@153.0.0";
import puppeteer from "npm:puppeteer-core@25.17.0";
import { ACCOUNTFUNCTIE_VERSIE, omgeving, UITSTAPFUNCTIE_VERSIE } from "../../code/config.js";
import { REKENVERSIE } from "../../code/rekenen.js";
import { beginjaar, dagInBrussel, teMaken, vanJaar, volgende } from "../../code/schooljaar.js";
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
function wereld({ rol = "beheerder", schooljaar = "2026-2027", klassen = ["4A", "4B", "1KA"], collegas = false } = {}) {
  const s = nep();
  s.nu = Date.now();
  s.rol = rol;
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
  const naam = rol === "beheerder" ? "Proef Beheerder" : rol === "lezer" ? "Proef Lezer" : "Proef Leerkracht";

  // ---------- De schooljaren, zoals de pagina ze leest en schrijft (stap 4a) ----------
  // De nabootsing volgt de databank: de regels per rij en de rechten per kolom van sql/002_databank.sql, en
  // het starten van sql/007_schooljaar.sql. De echte databank wordt nagekeken in tests/databank/proef.sql.
  const SCHRIJFBAAR = ["plafond_kleuter_cent", "plafond_lager_cent", "marge_kleuter_cent", "marge_lager_cent", "minder_scherp_opvolgen", "plafond_minder_scherp_cent",
    "gwp_credit_vanaf_cent", "gwp_bijbetalen_vanaf_cent", "voorschotten_gebruiken", "minimumbedrag_cent", "credit_standaard", "prijs_per_kind_afwezigen",
    "gratis_zwemjaar_leerjaar", "gratis_zwemjaar_toegang_aangerekend", "gratis_zwemjaar_bus"];
  const leegJaar = (jaar) => ({
    schooljaar: jaar, plafond_kleuter_cent: null, plafond_lager_cent: null, marge_kleuter_cent: null, marge_lager_cent: null,
    gratis_zwemjaar_leerjaar: null, gratis_zwemjaar_toegang_aangerekend: false, gratis_zwemjaar_bus: "school", prijs_per_kind_afwezigen: false,
  });
  s.jaarRijen = new Map();
  /** De bedragen en de keuzes van een schooljaar dat al bestaat. */
  s.vulJaar = (jaar, waarden = {}) => {
    s.jaarRijen.set(jaar, { ...leegJaar(jaar), plafond_kleuter_cent: 5500, plafond_lager_cent: 11000, marge_kleuter_cent: 0, marge_lager_cent: 400, gratis_zwemjaar_leerjaar: 1, ...waarden });
  };
  const jaarRij = (jaar) => ({ ...(s.jaarRijen.get(jaar) || leegJaar(jaar)), stand: s.jaren.get(jaar) });
  const lopendNu = () => {
    const lopend = [...s.jaren].find(([, stand]) => stand === "lopend");
    return lopend ? lopend[0] : null;
  };
  /** Hoeveel aanwezigheidslijsten van het vorige schooljaar nog open staan: wat de databank bij de start teruggeeft. */
  s.openLijsten = 0;
  /** (verzoek) → een eigen antwoord op een schrijfvraag of op het starten, "gooi" voor geen antwoord, of niets. */
  s.schrijfAntwoord = null;
  const ruw = (code, message, status = 400) => json(status, { code, message, details: null, hint: null });
  const klasIds = new Map();
  const klasId = (jaar, naamVanKlas) => {
    const sleutel = jaar + ":" + naamVanKlas;
    if (!klasIds.has(sleutel)) klasIds.set(sleutel, ID(5000 + klasIds.size));
    return klasIds.get(sleutel);
  };

  /** De filters van een vraag, zoals de Data API: gelijk aan, groter dan, leeg, of één van. Geeft de rijen, of een fout. */
  function gefilterd(rijenVan, url) {
    let rijen = rijenVan;
    for (const [kolom, waarde] of url.searchParams) {
      if (["select", "order", "limit", "columns"].includes(kolom)) continue;
      const punt = waarde.indexOf(".");
      const [op, w] = [waarde.slice(0, punt), waarde.slice(punt + 1)];
      if (op === "eq") rijen = rijen.filter((r) => String(r[kolom]) === w);
      else if (op === "gt") rijen = rijen.filter((r) => String(r[kolom]) > w);
      else if (op === "gte") rijen = rijen.filter((r) => String(r[kolom]) >= w);
      else if (op === "is" && w === "null") rijen = rijen.filter((r) => r[kolom] === null);
      else if (op === "in") rijen = rijen.filter((r) => w.slice(1, -1).split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(r[kolom])));
      else return { fout: json(400, { message: "de nabootsing kent deze filter niet: " + kolom + "=" + waarde }) };
    }
    return { rijen };
  }

  /** Een schooljaar aanmaken: enkel een beheerder, enkel "in te vullen", en nooit twee tegelijk. */
  function voegJaarToe(url, lichaam) {
    if (rol !== "beheerder") return ruw("42501", 'new row violates row-level security policy for table "schooljaren"', 403);
    const kolommen = (url.searchParams.get("columns") || Object.keys(lichaam).join(",")).split(",");
    if (kolommen.some((kolom) => kolom !== "schooljaar" && !SCHRIJFBAAR.includes(kolom))) return ruw("42501", "permission denied for table schooljaren", 403);
    const jaar = String(lichaam.schooljaar);
    if (!/^\d{4}-\d{4}$/.test(jaar) || Number(jaar.slice(5)) !== Number(jaar.slice(0, 4)) + 1) return ruw("23514", 'new row for relation "schooljaren" violates check constraint "schooljaren_schooljaar_check"');
    if (s.jaren.has(jaar)) return ruw("23505", 'duplicate key value violates unique constraint "schooljaren_pkey"', 409);
    if ([...s.jaren.values()].includes("in_te_vullen")) return ruw("23505", 'duplicate key value violates unique constraint "schooljaren_een_in_te_vullen"', 409);
    const rij = leegJaar(jaar);
    for (const kolom of kolommen) if (kolom !== "schooljaar") rij[kolom] = lichaam[kolom];
    s.jaarRijen.set(jaar, rij);
    s.schooljaar(jaar, "in_te_vullen");
    return json(201, [jaarRij(jaar)]);
  }

  /** Een schooljaar wijzigen: zonder rechten of in een afgesloten schooljaar wijzigt er stil niets; de stand zelf nooit. */
  function wijzigJaar(url, lichaam) {
    if (Object.keys(lichaam).some((kolom) => !SCHRIJFBAAR.includes(kolom))) return ruw("42501", "permission denied for table schooljaren", 403);
    for (const [kolom, w] of Object.entries(lichaam)) {
      const fout = (kolom.endsWith("_cent") && w !== null && !(Number.isInteger(w) && w >= 0))
        || (kolom === "gratis_zwemjaar_leerjaar" && w !== null && !(Number.isInteger(w) && w >= 1 && w <= 6))
        || (kolom === "gratis_zwemjaar_bus" && !["school", "ouders", "geen"].includes(w))
        || (kolom === "gratis_zwemjaar_toegang_aangerekend" && typeof w !== "boolean");
      if (fout) return ruw("23514", 'new row for relation "schooljaren" violates check constraint "schooljaren_' + kolom + '_check"');
    }
    const f = gefilterd([...s.jaren.keys()].map(jaarRij), url);
    if (f.fout) return f.fout;
    const rijen = rol === "beheerder" ? f.rijen.filter((r) => r.stand !== "afgesloten") : [];
    for (const r of rijen) s.jaarRijen.set(r.schooljaar, { ...(s.jaarRijen.get(r.schooljaar) || leegJaar(r.schooljaar)), ...lichaam });
    return json(200, rijen.map((r) => jaarRij(r.schooljaar)));
  }

  /** Een schooljaar starten, zoals mt_schooljaar_bevestigen in sql/007_schooljaar.sql. */
  function bevestigJaar(lichaam) {
    if (rol !== "beheerder") return pg("42501", "geen rechten voor deze handeling", 403);
    const jaar = String(lichaam.p_schooljaar);
    if (s.jaren.get(jaar) !== "in_te_vullen") return pg("MT409", 'dit schooljaar staat niet (meer) op "in te vullen"');
    const rij = jaarRij(jaar);
    if ([rij.plafond_kleuter_cent, rij.plafond_lager_cent, rij.marge_kleuter_cent, rij.marge_lager_cent].some((w) => w === null)) return pg("MT422", "vul eerst de plafonds en de marges in");
    if (dagInBrussel(s.nu) < jaar.slice(0, 4) + "-07-01") return pg("MT422", "een nieuw schooljaar bevestigen kan ten vroegste vanaf 1 juli (B169)");
    if ([...s.jaren].some(([ander, stand]) => ander > jaar && stand !== "in_te_vullen")) return pg("MT422", "er is al een later schooljaar gestart");
    const vorig = lopendNu();
    if (vorig) s.jaren.set(vorig, "voorbij");
    s.jaren.set(jaar, "lopend");
    // De lezingen van de uitstappentool: wat bezig is, breekt af; wat klaar is, geldt niet meer als recent.
    for (const l of s.lezingen) {
      if (l.stand === "bezig") Object.assign(l, { stand: "afgebroken", reden: "een nieuw schooljaar is gestart" });
      else if (l.stand === "klaar") l.verouderd = true;
    }
    return json(200, { schooljaar: jaar, vorig, open_lijsten_vorig: vorig ? s.openLijsten : 0, klassen: null });
  }
  if (schooljaar) s.vulJaar(schooljaar);

  const account = () => ({
    id: ID(1), naam, email: "proef1@school.voorbeeld", rol, schooljaar: lopendNu(),
    klassen: rol === "leerkracht" ? [{ id: ID(101), naam: "4A" }] : [],
    instellingen: { afmelden_na_minuten: 30, code_geldig_dagen: 14, wachtwoord_min_lengte: 12, tijdelijk_wachtwoord_uren: 48, aangemeld_blijven: true },
  });
  const mens = (n, naamVan, rolVan, extra = {}) => ({
    id: ID(n), naam: naamVan, email: "proef" + n + "@school.voorbeeld", rol: rolVan, actief: true, wachtwoord_tijdelijk: false, tijdelijk_tot: null, eerste_aanmelding_afgerond: true,
    app_koppelen: false, open_operatie: null, herstel_wachtwoord: false, herstel_app: false, revisie: 1, ...extra,
  });
  const tabellen = () => ({
    // Met collega's: een tweede beheerder met een tijdelijk wachtwoord, drie leerkrachten en een lezer.
    gebruikers: [mens(1, naam, rol), ...(collegas ? [
      mens(2, "Tweede Beheerder", "beheerder", { wachtwoord_tijdelijk: true, tijdelijk_tot: new Date(s.nu + 30 * 3600000).toISOString(), eerste_aanmelding_afgerond: false }),
      mens(11, "Juf Een", "leerkracht"), mens(12, "Juf Twee", "leerkracht"), mens(13, "Meester Drie", "leerkracht"), mens(21, "Lezer Een", "lezer"),
    ] : [])],
    schooljaren: [...s.jaren.keys()].sort().map(jaarRij),
    klassen: [...s.klassen].flatMap(([jaar, namen]) => [...namen].sort().map((naamVanKlas, i) => ({
      id: klasId(jaar, naamVanKlas), schooljaar: jaar, bron_id: "k-" + naamVanKlas, naam: naamVanKlas, groep: /K/.test(naamVanKlas) ? "Kleuter" : "Lager",
      leerjaar: /^[1-6]/.test(naamVanKlas) && !/K/.test(naamVanKlas) ? Number(naamVanKlas[0]) : null, actief: true, volgorde: i + 1,
    }))),
    klastoewijzingen: [],
    account_operaties: [],
  });

  /** Een tabel lezen zoals data.js dat doet: op de sleutel, met een grens, en met het aantal dat nog volgt. */
  function tabel(url) {
    const rijenVan = tabellen()[url.pathname.replace("/rest/v1/", "")];
    if (!rijenVan) return json(404, { message: "niet nagebootst: " + url.pathname });
    const f = gefilterd(rijenVan, url);
    if (f.fout) return f.fout;
    let rijen = f.rijen;
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
      return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, prefer, accept", "access-control-allow-methods": "GET, POST, PATCH, OPTIONS" } });
    }
    const lichaam = verzoek.body ? JSON.parse(verzoek.body) : {};
    // Een schooljaar aanmaken, wijzigen of starten (stap 4a).
    const schrijft = url.pathname === "/rest/v1/schooljaren" && ["POST", "PATCH"].includes(verzoek.method);
    const start = url.pathname === "/rest/v1/rpc/mt_schooljaar_bevestigen";
    if (s.schrijfAntwoord && (schrijft || start)) {
      const eigen = await s.schrijfAntwoord(verzoek);
      if (eigen === "gooi") return "gooi";
      if (eigen) return met(eigen);
    }
    if (start) return met(bevestigJaar(lichaam));
    if (schrijft) return met(verzoek.method === "POST" ? voegJaarToe(url, lichaam) : wijzigJaar(url, lichaam));
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
const inst = (pagina) => tekstVan(pagina, "#view-instellingen");
/** Tikt een waarde in een veld van Instellingen en verlaat het: zo bewaart het formulier. */
async function typ(pagina, kiezer, tekst) {
  const veld = await pagina.waitForSelector("#view-instellingen " + kiezer, { visible: true, timeout: 5000 });
  await veld.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await veld.focus();
  // Alles wat er stond, selecteren: wat getikt wordt, vervangt het.
  await pagina.keyboard.down("Control");
  await pagina.keyboard.press("a");
  await pagina.keyboard.up("Control");
  await pagina.keyboard.type(tekst);
  await pagina.keyboard.press("Tab");
}
/** Wacht tot het formulier zegt wat het bewaarde. */
const bewaard = (pagina, patroon) => pagina.waitForFunction((bron) => new RegExp(bron).test(document.querySelector('#view-instellingen [data-vak="bewaard"]').textContent), { timeout: 10000 }, patroon.source);
const waarde = (pagina, kolom) => pagina.$eval('#view-instellingen [data-bedrag="' + kolom + '"]', (e) => e.value);
/** Staat dit in de tekst van het scherm? Zonder op hoofdletters te letten: de titel van een kaart staat in hoofdletters. */
const heeft = (tekst, deel) => String(tekst).toLowerCase().includes(deel.toLowerCase());
/** De kop van de lijst van Gebruikers. Op een smal scherm staat hij niet in beeld: daarom de tekst zelf. */
const kopVanGebruikers = (pagina) => pagina.$eval("#view-gebruikers .mt-rijkop", (e) => e.textContent);
/** Van Overzicht naar Instellingen, tot het scherm geladen is. */
async function naarInstellingen(pagina) {
  await klik(pagina, '#tabbladen [data-tab="instellingen"]');
  await pagina.waitForSelector("#view-instellingen.active .mt-jvak", { timeout: 10000 });
  await rust(pagina);
}

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
      zeker("de tabbladen van de beheerder, en het schooljaar in de kop", (await pagina.$$eval("#tabbladen:not([hidden]) .tab", (els) => els.map((e) => e.textContent).join("|"))) === "Overzicht|Instellingen"
        && (await tekstVan(pagina, "#kopJaar")) === "Schooljaar 2026-2027" && (await pagina.$eval("#band", (e) => e.hidden)));
      zeker("de startpagina zegt waar het beheer staat", (await tekstVan(pagina, "#startIntro")).includes("Het schooljaar, de gebruikers en de Rekentest staan in Instellingen."));
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

      // Instellingen, met een schooljaar dat loopt.
      await naarInstellingen(pagina);
      const instellingen = await inst(pagina);
      zeker("instellingen: het lopende schooljaar met zijn plafonds, en wat erin geldt", /2026-2027\s+€ 55,00\s+€ 110,00\s+Lopend/.test(instellingen)
        && instellingen.includes("Terugbetaling aan schoolverlaters in 2026-2027: niet tot en met") && heeft(instellingen, "Gratis zwemjaar in 2026-2027") && instellingen.includes("1ste leerjaar"), instellingen);
      zeker("instellingen: de kaart Beheerders, zonder knop voor het eigen account", instellingen.includes("Proef Beheerder") && instellingen.includes("(jij)") && (await pagina.$('#view-instellingen [data-doe="wijzig"]')) === null, instellingen);
      await zonderZijwaartsScrollen(pagina, "instellingen " + breedte);
      await beeld(pagina, "inst-lopend-" + breedte + ".png", { fullPage: true });

      // De rekentest, vanuit Instellingen.
      await klik(pagina, '#view-instellingen [data-doe="rekentest"]');
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
      zeker("de rekentest: Instellingen blijft het tabblad", (await pagina.$eval('#tabbladen [aria-current="page"]', (e) => e.textContent)) === "Instellingen");
      await klik(pagina, '#view-rekentest [data-doe="terug"]');
      await pagina.waitForSelector("#view-instellingen.active", { timeout: 5000 });
      await rust(pagina);

      // Het scherm Gebruikers opent nog, vanuit Instellingen: de lijsten komen er op hun sleutel, met het aantal dat nog volgt.
      await klik(pagina, '#view-instellingen [data-doe="gebruikers"]');
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
    zeker("leerkracht: geen tabbladen, wel het schooljaar in de kop", (await pagina.$eval("#tabbladen", (e) => e.hidden)) && (await tekstVan(pagina, "#kopJaar")) === "Schooljaar 2026-2027");
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
    zeker("zonder schooljaar: de uitstappen wachten", blok.includes("In de MT is er nog geen lopend schooljaar: de uitstappen wachten tot het aangemaakt en gestart is. Dat doe je in Instellingen."), blok);
    zeker("zonder schooljaar: geen schooljaar in de kop", await pagina.$eval("#kopJaar", (e) => e.hidden));
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
    await naarInstellingen(pagina);
    await klik(pagina, '#view-instellingen [data-doe="rekentest"]');
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

  // Stap 4a: van "nog geen schooljaar" tot "de uitstappen staan er", zoals in het testproject. De beheerder maakt
  // het schooljaar aan, vult het in, start het, en ziet de klassen en de uitstappen binnenkomen.
  async schooljaarStarten() {
    for (const breedte of [1366, 768, 390]) {
      // Het schooljaar dat de MT vandaag voorstelt: zo klopt het scenario op elke dag.
      const jaar = teMaken([], dagInBrussel(Date.now()));
      const begin = beginjaar(jaar);
      const s = wereld({ schooljaar: null, collegas: true });
      for (let i = 1; i <= 5; i++) s.uitstap("s" + i, { v: 2, datumStart: begin + "-10-1" + i, klassen: [["4A"], ["4B"], ["1KA"], ["4A", "4B"], ["5A"]][i - 1], planStatus: "bevestigd" });
      s.uitstap("s6", { v: 2, datumStart: begin + "-12-01", klassen: ["4A"], planStatus: "aangevraagd" });
      s.uitstap("s7", { v: 2, datumStart: begin + "-12-02", klassen: ["Zonneklas"], planStatus: "bevestigd" });
      for (let i = 1; i <= 2; i++) s.uitstap("o" + i, { v: 2, datumStart: begin + "-03-1" + i, klassen: ["4A"], planStatus: "bevestigd" });
      s.klassenlijst("1KA", "4A", "4B", "5A");
      const { pagina, log } = await open(s, { breedte });
      await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
      zeker("start: zonder schooljaar staat er geen schooljaar in de kop", await pagina.$eval("#kopJaar", (e) => e.hidden));
      zeker("start: de beheerder heeft twee tabbladen", (await pagina.$$eval("#tabbladen:not([hidden]) .tab", (els) => els.map((e) => e.textContent).join("|"))) === "Overzicht|Instellingen");
      zeker("start: Overzicht staat open", (await pagina.$eval('#tabbladen [aria-current="page"]', (e) => e.textContent)) === "Overzicht");
      zeker("start: de uitstappen wachten op het schooljaar, en de kaart zegt waar het moet", (await kaart(pagina)).includes("de uitstappen wachten tot het aangemaakt en gestart is. Dat doe je in Instellingen."), await kaart(pagina));
      await klik(pagina, '#tabbladen [data-tab="instellingen"]');
      await pagina.waitForSelector("#view-instellingen.active .mt-jvak", { timeout: 10000 });
      await rust(pagina);
      let scherm = await inst(pagina);
      zeker("instellingen: het tabblad staat open", (await pagina.$eval('#tabbladen [aria-current="page"]', (e) => e.textContent)) === "Instellingen");
      zeker("instellingen: het vak zegt wat er te doen is", scherm.includes("Er is nog geen lopend schooljaar. Maak schooljaar " + jaar + " aan: zodra het gestart is, neemt de MT de uitstappen van dat schooljaar over."), scherm);
      zeker("instellingen: nog geen schooljaren", scherm.includes("Er zijn nog geen schooljaren.") && !heeft(scherm, "Gratis zwemjaar in"), scherm);
      zeker("instellingen: de kaart Beheerders", scherm.includes("Proef Beheerder") && scherm.includes("Tweede Beheerder") && scherm.includes("Verder: 3 leerkrachten en 1 lezer.") && scherm.includes("1 tijdelijk wachtwoord") && !scherm.includes("nog te koppelen"), scherm);
      zeker("instellingen: het eigen account heeft geen knop Wijzigen", (await pagina.$$eval('#view-instellingen [data-doe="wijzig"]', (els) => els.length)) === 1);
      await zonderZijwaartsScrollen(pagina, "instellingen leeg " + breedte);
      await beeld(pagina, "inst-leeg-" + breedte + ".png", { fullPage: true });

      // Aanmaken: enkel het schooljaar gaat naar de databank, en het formulier opent.
      await klik(pagina, '#view-instellingen [data-doe="aanmaken"]');
      await pagina.waitForSelector('#view-instellingen [data-vak="formulier"]:not([hidden]) input', { timeout: 10000 });
      const aangemaakt = s.vanPagina.filter((o) => o.method === "POST" && o.url.includes("/rest/v1/schooljaren"));
      zeker("aanmaken: één rij, enkel het schooljaar, en de rij komt terug", aangemaakt.length === 1 && aangemaakt[0].body === JSON.stringify({ schooljaar: jaar })
        && /[?&]columns=schooljaar&select=/.test(aangemaakt[0].url) && aangemaakt[0].headers.prefer === "return=representation" && aangemaakt[0].headers.authorization === "Bearer " + s.token,
      aangemaakt.map((o) => o.url + " " + o.body).join(" | "));
      zeker("aanmaken: het eerste veld heeft de focus", await pagina.evaluate(() => document.activeElement && document.activeElement.dataset.bedrag === "plafond_kleuter_cent"));
      scherm = await inst(pagina);
      zeker("formulier: de titel, het label en wat ontbreekt", scherm.includes("Nieuw schooljaar " + jaar) && scherm.includes("In te vullen") && scherm.includes("Nog in te vullen: 5 velden."), scherm);
      zeker("formulier: bevestigen kan nog niet", await pagina.$eval('[data-doe="bevestig"]', (e) => e.disabled));
      zeker("formulier: zonder vorig schooljaar valt er niets over te nemen", (await pagina.$('#view-instellingen [data-doe="neem"]')) === null && !scherm.includes("neem het over"), scherm);
      zeker("formulier: de nota zegt wat het starten doet", scherm.includes("Na het bevestigen is " + jaar + " het lopende schooljaar: de MT neemt dan de uitstappen van " + jaar + " over uit de uitstappentool."), scherm);
      await zonderZijwaartsScrollen(pagina, "formulier leeg " + breedte);
      await beeld(pagina, "inst-formulier-leeg-" + breedte + ".png", { fullPage: true });

      // Invullen: elk veld wordt bewaard zodra je het verlaat, en toont daarna wat de MT las.
      const patches = () => s.vanPagina.filter((o) => o.method === "PATCH" && o.url.includes("/rest/v1/schooljaren"));
      await typ(pagina, '[data-bedrag="plafond_kleuter_cent"]', "55");
      await bewaard(pagina, /Bewaard: het plafond van de kleuterschool, € 55,00\./);
      zeker("invullen: het veld toont wat de MT las", (await waarde(pagina, "plafond_kleuter_cent")) === "55,00");
      zeker("invullen: het bedrag in centen, voor dit schooljaar, enkel zolang het in te vullen is", patches().length === 1 && patches()[0].body === '{"plafond_kleuter_cent":5500}'
        && patches()[0].url.includes("stand=eq.in_te_vullen&schooljaar=eq." + jaar + "&select=") && patches()[0].headers.prefer === "return=representation", patches().map((o) => o.url + " " + o.body).join(" | "));
      // Iets dat geen bedrag is: een melding bij het veld, en er vertrekt niets.
      await typ(pagina, '[data-bedrag="plafond_lager_cent"]', "honderd tien");
      await pagina.waitForSelector('[data-veld="plafond_lager_cent"] [data-fout]:not([hidden])', { timeout: 5000 });
      zeker("invullen: wat geen bedrag is, krijgt een melding en wordt niet bewaard", (await tekstVan(pagina, '[data-veld="plafond_lager_cent"] [data-fout]')) === "Geef een bedrag in euro, zoals 55 of 55,50."
        && patches().length === 1 && (await pagina.$eval('[data-bedrag="plafond_lager_cent"]', (e) => e.getAttribute("aria-invalid"))) === "true");
      if (breedte === 1366) await beeld(pagina, "inst-formulier-fout-1366.png", { fullPage: true });
      await typ(pagina, '[data-bedrag="plafond_lager_cent"]', "110,00");
      await bewaard(pagina, /het plafond van de lagere school, € 110,00\./);
      zeker("invullen: de melding verdwijnt na een geldig bedrag", await pagina.$eval('[data-veld="plafond_lager_cent"] [data-fout]', (e) => e.hidden));
      await typ(pagina, '[data-bedrag="marge_kleuter_cent"]', "0");
      await bewaard(pagina, /van de kleuterschool, € 0,00\./);
      await typ(pagina, '[data-bedrag="marge_lager_cent"]', "4.5");
      await bewaard(pagina, /van de lagere school, € 4,50\./);
      zeker("invullen: elk veld toont zijn bedrag met twee decimalen", (await waarde(pagina, "plafond_lager_cent")) === "110,00" && (await waarde(pagina, "marge_kleuter_cent")) === "0,00" && (await waarde(pagina, "marge_lager_cent")) === "4,50");
      zeker("invullen: nul is een bedrag", (await inst(pagina)).includes("Nog in te vullen: 1 veld."), await inst(pagina));
      zeker("invullen: bevestigen kan nog niet zonder het leerjaar van het gratis zwemjaar", await pagina.$eval('[data-doe="bevestig"]', (e) => e.disabled));
      await klik(pagina, '[data-kolom="gratis_zwemjaar_leerjaar"][data-waarde="1"]');
      await bewaard(pagina, /Bewaard: het gratis zwemjaar is het 1ste leerjaar\./);
      await klik(pagina, '[data-kolom="gratis_zwemjaar_bus"][data-waarde="geen"]');
      await bewaard(pagina, /Bewaard: de bus, geen bus\./);
      zeker("zwemjaar: de keuzes staan aan", (await pagina.$eval('[data-kolom="gratis_zwemjaar_leerjaar"][data-waarde="1"]', (e) => e.getAttribute("aria-pressed"))) === "true"
        && (await pagina.$eval('[data-kolom="gratis_zwemjaar_bus"][data-waarde="geen"]', (e) => e.classList.contains("on")))
        && (await pagina.$eval('[data-kolom="gratis_zwemjaar_bus"][data-waarde="school"]', (e) => e.getAttribute("aria-pressed"))) === "false"
        && (await pagina.$eval('[data-kolom="gratis_zwemjaar_toegang_aangerekend"][data-waarde="false"]', (e) => e.getAttribute("aria-pressed"))) === "true");
      scherm = await inst(pagina);
      zeker("formulier: alles is ingevuld, en bevestigen kan", scherm.includes("Alles is ingevuld.") && !(await pagina.$eval('[data-doe="bevestig"]', (e) => e.disabled)), scherm);
      zeker("de kaart Schooljaren volgt wat bewaard is", scherm.includes(jaar + " is aangemaakt, maar nog niet bevestigd. Alles is ingevuld: je kan het bevestigen.") && /€ 55,00\s+€ 110,00\s+In te vullen/.test(scherm), scherm);
      zeker("wat de databank bewaarde", JSON.stringify(s.jaarRijen.get(jaar)) === JSON.stringify({ schooljaar: jaar, plafond_kleuter_cent: 5500, plafond_lager_cent: 11000, marge_kleuter_cent: 0, marge_lager_cent: 450,
        gratis_zwemjaar_leerjaar: 1, gratis_zwemjaar_toegang_aangerekend: false, gratis_zwemjaar_bus: "geen", prijs_per_kind_afwezigen: false }), JSON.stringify(s.jaarRijen.get(jaar)));
      await zonderZijwaartsScrollen(pagina, "formulier ingevuld " + breedte);
      await beeld(pagina, "inst-formulier-vol-" + breedte + ".png", { fullPage: true });

      // Sluiten en later verder werken: alles staat er nog, uit de databank.
      await klik(pagina, '[data-doe="sluit-formulier"]');
      await pagina.waitForSelector('#view-instellingen [data-vak="formulier"][hidden]', { timeout: 5000 });
      zeker("sluiten: de focus gaat naar \"Verder invullen\"", await pagina.evaluate(() => document.activeElement && document.activeElement.dataset.doe === "invullen"));
      await klik(pagina, '#view-instellingen [data-doe="invullen"]');
      await pagina.waitForSelector('#view-instellingen [data-vak="formulier"]:not([hidden]) input', { timeout: 5000 });
      zeker("verder invullen: de velden tonen wat bewaard is", (await waarde(pagina, "plafond_kleuter_cent")) === "55,00" && (await waarde(pagina, "marge_lager_cent")) === "4,50"
        && (await pagina.$eval('[data-kolom="gratis_zwemjaar_bus"][data-waarde="geen"]', (e) => e.classList.contains("on"))));

      // Bevestigen: eerst de vraag; "Nee" wijzigt niets.
      await klik(pagina, '[data-doe="bevestig"]');
      await pagina.waitForSelector('.modal[role="dialog"]', { visible: true, timeout: 5000 });
      const vraag = await tekstVan(pagina, '.modal[role="dialog"]');
      zeker("starten: de vraag zegt wat er gebeurt, en dat het niet terug kan", vraag.includes("Schooljaar " + jaar + " starten?")
        && vraag.includes(jaar + " wordt het lopende schooljaar. De MT neemt dan de uitstappen van " + jaar + " over uit de uitstappentool.") && vraag.includes("Dit kan je niet ongedaan maken.")
        && vraag.includes("Ja, " + jaar + " starten") && vraag.includes("Nee, nog niet"), vraag);
      zeker("starten: \"Nee\" heeft de focus", await pagina.evaluate(() => document.activeElement && document.activeElement.dataset.keuze === "nee"));
      await zonderZijwaartsScrollen(pagina, "de vraag bij het starten " + breedte);
      await beeld(pagina, "inst-vraag-" + breedte + ".png");
      await klik(pagina, '.modal [data-keuze="nee"]');
      await new Promise((klaar) => setTimeout(klaar, 400));
      zeker("starten: na \"Nee\" is er niets gestart", !s.vanPagina.some((o) => o.url.includes("mt_schooljaar_bevestigen")) && s.jaren.get(jaar) === "in_te_vullen");
      // Dan "Ja": het schooljaar start, en de MT leest de uitstappentool meteen opnieuw, zonder de halve minuut rust.
      const lezingenVoor = s.lezingen.length;
      const vragenVoor = naarFunctie(s).length;
      await klik(pagina, '[data-doe="bevestig"]');
      await pagina.waitForSelector('.modal[role="dialog"]', { visible: true, timeout: 5000 });
      await klik(pagina, '.modal [data-keuze="ja"]');
      await pagina.waitForSelector("#view-instellingen .mt-gestart", { timeout: 20000 });
      await rust(pagina);
      scherm = await inst(pagina);
      const gestart = s.vanPagina.filter((o) => o.url.includes("mt_schooljaar_bevestigen") && o.method === "POST");
      zeker("gestart: de databank kreeg enkel het schooljaar", gestart.length === 1 && gestart[0].body === JSON.stringify({ p_schooljaar: jaar }), gestart.map((o) => o.body).join(" | "));
      zeker("gestart: de melding zegt wat er binnenkwam en wat de volgende stap is", scherm.includes("Schooljaar " + jaar + " is gestart.")
        && scherm.includes("De MT las de uitstappentool opnieuw: 4 klassen en 7 uitstappen kwamen erbij. Het resultaat staat op Overzicht.")
        && scherm.includes("Volgende stap: de klassen van " + jaar + " aan de leerkrachten koppelen in Gebruikers.") && !scherm.includes("blijft open tot alles rond is"), scherm);
      zeker("gestart: de MT las meteen opnieuw, zonder de halve minuut rust", s.lezingen.length === lezingenVoor + 1 && s.lezingen.at(-1).stand === "klaar" && naarFunctie(s).length === vragenVoor + 1,
        s.lezingen.map((l) => l.stand + (l.verouderd ? "*" : "")).join(",") + " " + naarFunctie(s).length);
      zeker("gestart: de melding heeft de focus", await pagina.evaluate(() => document.activeElement && document.activeElement.classList.contains("mt-gestart")));
      zeker("gestart: het formulier is weg en het schooljaar loopt", (await pagina.$eval('#view-instellingen [data-vak="formulier"]', (e) => e.hidden)) && /€ 55,00\s+€ 110,00\s+Lopend/.test(scherm), scherm);
      zeker("gestart: de kop toont het schooljaar", (await tekstVan(pagina, "#kopJaar")) === "Schooljaar " + jaar && !(await pagina.$eval("#kopJaar", (e) => e.hidden)) && (await pagina.$eval("#band", (e) => e.hidden)));
      zeker("gestart: de kaart Beheerders zegt wie nog klassen moet krijgen", scherm.includes("3 leerkrachten: klassen " + jaar + " nog te koppelen"), scherm);
      zeker("gestart: het volgende schooljaar kan al, zonder aandrang", scherm.includes("Het volgende schooljaar, " + volgende(jaar) + ", kan je al aanmaken en invullen. Starten kan vanaf 1 juli " + (begin + 1) + ".")
        && (await pagina.$eval("#view-instellingen .mt-jvak", (e) => !e.classList.contains("dringend"))), scherm);
      zeker("gestart: wat in het schooljaar geldt", scherm.includes("Terugbetaling aan schoolverlaters in " + jaar + ": niet tot en met") && /Kleuterschool: € 0,00 · Lagere school: € 4,50/.test(scherm)
        && heeft(scherm, "Gratis zwemjaar in " + jaar) && scherm.includes("1ste leerjaar") && scherm.includes("nee: de toegang kost niets") && scherm.includes("geen bus"), scherm);
      await zonderZijwaartsScrollen(pagina, "na de start " + breedte);
      await beeld(pagina, "inst-gestart-" + breedte + ".png", { fullPage: true });

      // Overzicht: de klassen en de uitstappen van het nieuwe schooljaar staan er.
      await klik(pagina, '#tabbladen [data-tab="overzicht"]');
      await pagina.waitForSelector("#view-start.active", { timeout: 5000 });
      const blok = await kaart(pagina);
      zeker("overzicht: de MT volgt de uitstappen van het nieuwe schooljaar", /De MT volgt 7 uitstappen: 7 nieuw\./.test(blok) && blok.includes("De klassen van " + jaar + " zijn bijgewerkt: 4 nieuw.")
        && new RegExp(jaar + "\\s*lopend in de MT").test(blok) && /Zonneklas \(1 uitstap\)/.test(blok) && /2 uitstappen vallen buiten/.test(blok), blok);
      zeker("overzicht: de kaart met het account kent het schooljaar niet meer als ontbrekend", !(await tekstVan(pagina, "#view-start")).includes("nog geen lopend schooljaar"), await tekstVan(pagina, "#view-start"));
      await zonderZijwaartsScrollen(pagina, "overzicht na de start " + breedte);
      await beeld(pagina, "overzicht-na-start-" + breedte + ".png", { fullPage: true });

      // Gebruikers, vanuit Instellingen: de klassen van het nieuwe schooljaar zijn te koppelen.
      await klik(pagina, '#tabbladen [data-tab="instellingen"]');
      await pagina.waitForSelector("#view-instellingen.active", { timeout: 5000 });
      await rust(pagina);
      zeker("terug in Instellingen: de melding staat er nog, tot ze gesloten wordt", (await inst(pagina)).includes("Schooljaar " + jaar + " is gestart."));
      await klik(pagina, '#view-instellingen [data-doe="sluit-gestart"]');
      zeker("de melding sluit", (await pagina.$("#view-instellingen .mt-gestart")) === null);
      await klik(pagina, '#view-instellingen [data-doe="gebruikers"]');
      await pagina.waitForSelector("#view-gebruikers.active .mt-rij", { timeout: 10000 });
      await rust(pagina);
      const gb = await tekstVan(pagina, "#view-gebruikers");
      zeker("gebruikers: opent vanuit Instellingen, voor het nieuwe schooljaar", gb.includes("← Instellingen") && (await kopVanGebruikers(pagina)).includes("Klassen " + jaar) && gb.includes("3 leerkrachten nog te koppelen aan klassen van " + jaar), gb);
      zeker("gebruikers: Instellingen blijft het tabblad", (await pagina.$eval('#tabbladen [aria-current="page"]', (e) => e.textContent)) === "Instellingen");
      await zonderZijwaartsScrollen(pagina, "gebruikers na de start " + breedte);
      if (breedte !== 768) await beeld(pagina, "gebruikers-na-start-" + breedte + ".png", { fullPage: true });
      // Een leerkracht wijzigen: de klassen van het nieuwe schooljaar staan klaar om te koppelen.
      await klik(pagina, '#view-gebruikers [data-rij="' + ID(11) + '"] [data-doe="wijzig"]');
      await pagina.waitForSelector('.modal[role="dialog"] [data-klas]', { visible: true, timeout: 10000 });
      const venster = await tekstVan(pagina, '.modal[role="dialog"]');
      zeker("gebruikers: de klassen van het nieuwe schooljaar zijn te kiezen", ["1KA", "4A", "4B", "5A"].every((klas) => venster.includes(klas)), venster);
      await pagina.keyboard.press("Escape");
      await pagina.waitForSelector('.modal[role="dialog"]', { hidden: true, timeout: 5000 });
      await klik(pagina, '#view-gebruikers [data-doe="terug"]');
      await pagina.waitForSelector("#view-instellingen.active", { timeout: 5000 });
      await rust(pagina);
      // "Wijzigen" bij de andere beheerder, en "Gebruiker toevoegen": het venster opent meteen, in Gebruikers.
      await klik(pagina, '#view-instellingen [data-doe="wijzig"]');
      await pagina.waitForSelector('.modal[role="dialog"]', { visible: true, timeout: 10000 });
      zeker("beheerders: Wijzigen opent het venster van die gebruiker, in Gebruikers", (await tekstVan(pagina, '.modal[role="dialog"]')).includes("Tweede Beheerder") && (await pagina.$("#view-gebruikers.active")) !== null,
        await tekstVan(pagina, '.modal[role="dialog"]'));
      await pagina.keyboard.press("Escape");
      await pagina.waitForSelector('.modal[role="dialog"]', { hidden: true, timeout: 5000 });
      await klik(pagina, '#view-gebruikers [data-doe="terug"]');
      await pagina.waitForSelector("#view-instellingen.active", { timeout: 5000 });
      await rust(pagina);
      await klik(pagina, '#view-instellingen [data-doe="toevoegen"]');
      await pagina.waitForSelector('.modal[role="dialog"]', { visible: true, timeout: 10000 });
      zeker("beheerders: Gebruiker toevoegen opent het venster, in Gebruikers", /Gebruiker toevoegen/.test(await tekstVan(pagina, '.modal[role="dialog"]')), await tekstVan(pagina, '.modal[role="dialog"]'));
      await pagina.keyboard.press("Escape");
      await pagina.waitForSelector('.modal[role="dialog"]', { hidden: true, timeout: 5000 });
      schoon(log, "schooljaar starten " + breedte);
      await pagina.close();
    }
  },

  // Stap 4a: een volgend schooljaar, terwijl het vorige nog loopt en een ouder nog open staat (B132, B144, B164).
  async volgendSchooljaar() {
    for (const breedte of [1366, 390]) {
      const nieuw = teMaken([], dagInBrussel(Date.now()));
      const lopend = vanJaar(beginjaar(nieuw) - 1);
      const oud = vanJaar(beginjaar(nieuw) - 2);
      const s = wereld({ schooljaar: lopend, klassen: ["4A", "4B", "1KA"], collegas: true });
      s.schooljaar(oud, "voorbij", ["4A"]);
      s.vulJaar(oud, { plafond_kleuter_cent: 5000, plafond_lager_cent: 10000, marge_kleuter_cent: 100, marge_lager_cent: 300, gratis_zwemjaar_leerjaar: 2, gratis_zwemjaar_toegang_aangerekend: true, gratis_zwemjaar_bus: "ouders" });
      s.openLijsten = 2;
      s.uitstap("v1", { v: 2, datumStart: beginjaar(lopend) + "-10-10", klassen: ["4A"], planStatus: "bevestigd" });
      s.uitstap("v2", { v: 2, datumStart: beginjaar(nieuw) + "-10-10", klassen: ["4A"], planStatus: "bevestigd" });
      s.klassenlijst("1KA", "4A", "4B");
      const { pagina, log } = await open(s, { breedte });
      await pagina.waitForSelector("#kaartUitstappentool table", { timeout: 15000 });
      await rust(pagina);

      // De kop: twee open schooljaren, dus een schakelaar; bij het oude een band.
      const knoppen = () => pagina.$$eval("#kopJaar [data-jaar]", (els) => els.map((e) => e.textContent.trim() + (e.getAttribute("aria-pressed") === "true" ? "*" : "")).join("|"));
      zeker("kop: de schakelaar toont het lopende en het oude schooljaar", (await knoppen()) === lopend + "*|" + oud + " · nog open", await knoppen());
      zeker("kop: bij het lopende schooljaar staat er geen band", await pagina.$eval("#band", (e) => e.hidden));
      await klik(pagina, '#kopJaar [data-jaar="' + oud + '"]');
      await pagina.waitForSelector("#band:not([hidden])", { timeout: 5000 });
      zeker("kop: bij het oude schooljaar zegt de band waarin je werkt", (await tekstVan(pagina, "#band")) === "Je werkt in schooljaar " + oud + ", dat nog open staat. Wat hier verandert, geldt enkel voor " + oud + "."
        && (await knoppen()) === lopend + "|" + oud + " · nog open*", await tekstVan(pagina, "#band"));
      await zonderZijwaartsScrollen(pagina, "de kop met twee schooljaren " + breedte);
      await beeld(pagina, "kop-oud-schooljaar-" + breedte + ".png");

      // Instellingen en Gebruikers volgen de keuze in de kop.
      await klik(pagina, '#tabbladen [data-tab="instellingen"]');
      await pagina.waitForSelector("#view-instellingen.active .mt-jvak", { timeout: 10000 });
      await rust(pagina);
      let scherm = await inst(pagina);
      zeker("instellingen: wat per schooljaar geldt, toont het gekozen schooljaar", scherm.includes("Terugbetaling aan schoolverlaters in " + oud + ": niet tot en met") && /Kleuterschool: € 1,00 · Lagere school: € 3,00/.test(scherm)
        && heeft(scherm, "Gratis zwemjaar in " + oud) && scherm.includes("2de leerjaar") && scherm.includes("ja: de toegang is voor de school") && scherm.includes("aangerekend aan de ouders"), scherm);
      zeker("instellingen: de tabel toont elk schooljaar met zijn stand", new RegExp(lopend + "\\s+€ 55,00\\s+€ 110,00\\s+Lopend").test(scherm) && new RegExp(oud + "\\s+€ 50,00\\s+€ 100,00\\s+Voorbij, nog open").test(scherm), scherm);
      await klik(pagina, '#view-instellingen [data-doe="gebruikers"]');
      await pagina.waitForSelector("#view-gebruikers.active .mt-rij", { timeout: 10000 });
      await rust(pagina);
      zeker("gebruikers: de klassen van het gekozen schooljaar", (await kopVanGebruikers(pagina)).includes("Klassen " + oud), await kopVanGebruikers(pagina));
      await klik(pagina, '#kopJaar [data-jaar="' + lopend + '"]');
      await pagina.waitForFunction((tekst) => document.querySelector("#view-gebruikers .mt-rijkop").textContent.includes(tekst), { timeout: 5000 }, "Klassen " + lopend);
      zeker("gebruikers: volgt de schakelaar zonder opnieuw te laden, en de band verdwijnt", await pagina.$eval("#band", (e) => e.hidden));
      await klik(pagina, '#view-gebruikers [data-doe="terug"]');
      await pagina.waitForSelector("#view-instellingen.active .mt-jvak", { timeout: 5000 });
      await rust(pagina);

      // Het volgende schooljaar kan al starten: het vak vraagt aandacht.
      scherm = await inst(pagina);
      zeker("volgend schooljaar: het vak vraagt aandacht", scherm.includes("Schooljaar " + nieuw + " is nog niet aangemaakt.") && (await pagina.$eval("#view-instellingen .mt-jvak", (e) => e.classList.contains("dringend"))), scherm);
      await klik(pagina, '#view-instellingen [data-doe="aanmaken"]');
      await pagina.waitForSelector('#view-instellingen [data-vak="formulier"]:not([hidden]) input', { timeout: 10000 });
      const aangemaakt = s.vanPagina.filter((o) => o.method === "POST" && o.url.includes("/rest/v1/schooljaren"));
      zeker("volgend schooljaar: de standaard voor een prijs per kind gaat mee van het vorige", aangemaakt.length === 1 && aangemaakt[0].body === JSON.stringify({ schooljaar: nieuw, prijs_per_kind_afwezigen: false }), aangemaakt.map((o) => o.body).join(" | "));
      scherm = await inst(pagina);
      zeker("volgend schooljaar: onder elk veld staat wat vorig jaar gold", scherm.includes("Onder elk veld staat in het klein wat in " + lopend + " gold: neem het over, of wijk bewust af.")
        && scherm.includes(lopend + ": € 55,00") && scherm.includes(lopend + ": € 110,00") && scherm.includes(lopend + ": € 0,00") && scherm.includes(lopend + ": € 4,00")
        && scherm.includes(lopend + ": 1ste leerjaar") && scherm.includes(lopend + ": nee: de toegang kost niets") && scherm.includes(lopend + ": voor de school, zoals de regelgeving vraagt")
        && (await pagina.$$eval('#view-instellingen [data-doe="neem"]', (els) => els.length)) === 4, scherm);
      // Overnemen, of bewust afwijken.
      await klik(pagina, '[data-doe="neem"][data-kolom="plafond_kleuter_cent"]');
      await bewaard(pagina, /het plafond van de kleuterschool, € 55,00\./);
      zeker("overnemen: het veld krijgt het bedrag van vorig jaar, en de knop verdwijnt", (await waarde(pagina, "plafond_kleuter_cent")) === "55,00" && (await pagina.$('[data-doe="neem"][data-kolom="plafond_kleuter_cent"]')) === null);
      await typ(pagina, '[data-bedrag="plafond_lager_cent"]', "120");
      await bewaard(pagina, /het plafond van de lagere school, € 120,00\./);
      zeker("afwijken: het veld zegt dat het anders is dan vorig jaar, en overnemen kan nog", (await tekstVan(pagina, '[data-veld="plafond_lager_cent"] [data-hint]')).includes("Anders dan in " + lopend)
        && (await pagina.$('[data-doe="neem"][data-kolom="plafond_lager_cent"]')) !== null && (await pagina.$eval('[data-veld="plafond_lager_cent"]', (e) => e.classList.contains("anders"))));
      await klik(pagina, '[data-doe="neem"][data-kolom="marge_kleuter_cent"]');
      await bewaard(pagina, /van de kleuterschool, € 0,00\./);
      await klik(pagina, '[data-doe="neem"][data-kolom="marge_lager_cent"]');
      await bewaard(pagina, /van de lagere school, € 4,00\./);
      await klik(pagina, '[data-kolom="gratis_zwemjaar_leerjaar"][data-waarde="1"]');
      await bewaard(pagina, /het gratis zwemjaar is het 1ste leerjaar\./);
      scherm = await inst(pagina);
      zeker("volgend schooljaar: de nota noemt het schooljaar dat open blijft", scherm.includes("Bevestigen kan ten vroegste vanaf 1 juli, als " + lopend + " voorbij is; later kan ook. Daarna gaan imports en aanwezigheden naar " + nieuw + "; " + lopend + " blijft open tot alles rond is."), scherm);
      await zonderZijwaartsScrollen(pagina, "formulier volgend schooljaar " + breedte);
      await beeld(pagina, "inst-volgend-formulier-" + breedte + ".png", { fullPage: true });
      await klik(pagina, '[data-doe="bevestig"]');
      await pagina.waitForSelector('.modal[role="dialog"]', { visible: true, timeout: 5000 });
      const vraag = await tekstVan(pagina, '.modal[role="dialog"]');
      zeker("volgend schooljaar: de vraag zegt dat het vorige open blijft", vraag.includes(nieuw + " wordt het lopende schooljaar. Imports en aanwezigheden gaan voortaan daarheen. " + lopend + " blijft open tot alles gefactureerd, gecrediteerd of afgeboekt is.")
        && vraag.includes("Dit kan je niet ongedaan maken."), vraag);
      if (breedte === 390) await beeld(pagina, "inst-volgend-vraag-390.png");
      await klik(pagina, '.modal [data-keuze="ja"]');
      await pagina.waitForSelector("#view-instellingen .mt-gestart", { timeout: 20000 });
      await rust(pagina);
      scherm = await inst(pagina);
      zeker("volgend schooljaar: de melding noemt wat open blijft, met het aantal lijsten", scherm.includes("Schooljaar " + nieuw + " is gestart.")
        && scherm.includes(lopend + " blijft open tot alles rond is: kies het bovenaan. Nog open in " + lopend + ": 2 aanwezigheidslijsten."), scherm);
      zeker("volgend schooljaar: de kop toont drie open schooljaren, het nieuwe gekozen, zonder band", (await knoppen()) === nieuw + "*|" + lopend + " · nog open|" + oud + " · nog open" && (await pagina.$eval("#band", (e) => e.hidden)), await knoppen());
      zeker("volgend schooljaar: wat per schooljaar geldt, toont nu het nieuwe", scherm.includes("Terugbetaling aan schoolverlaters in " + nieuw) && heeft(scherm, "Gratis zwemjaar in " + nieuw), scherm);
      zeker("volgend schooljaar: de standen in de databank", s.jaren.get(nieuw) === "lopend" && s.jaren.get(lopend) === "voorbij" && s.jaren.get(oud) === "voorbij");
      await zonderZijwaartsScrollen(pagina, "na de start van een volgend schooljaar " + breedte);
      await beeld(pagina, "inst-volgend-gestart-" + breedte + ".png", { fullPage: true });
      schoon(log, "volgend schooljaar " + breedte);
      await pagina.close();
    }
  },

  // Stap 4a: wat er misloopt. Het schooljaar kan nog niet starten; de databank antwoordt niet bij het bewaren;
  // iemand anders startte het schooljaar intussen; de databank weigert de start; het antwoord op de start gaat verloren.
  async schooljaarFouten() {
    const vandaag = dagInBrussel(Date.now());
    const lopend = teMaken([], vandaag);
    const nieuw = volgende(lopend);
    // 1. Het volgende schooljaar aanmaken kan al, starten nog niet: de knop blijft uit, en de nota zegt vanaf wanneer.
    {
      const s = wereld({ schooljaar: lopend, collegas: true });
      s.klassenlijst("1KA", "4A", "4B");
      const { pagina, log } = await open(s, { breedte: 1366 });
      await pagina.waitForSelector("#kaartUitstappentool .mt-lijstvoet", { timeout: 15000 });
      await klik(pagina, '#tabbladen [data-tab="instellingen"]');
      await pagina.waitForSelector("#view-instellingen.active .mt-jvak", { timeout: 10000 });
      await rust(pagina);
      zeker("nog niet starten: het vak is rustig", (await inst(pagina)).includes("Het volgende schooljaar, " + nieuw + ", kan je al aanmaken en invullen.") && !(await pagina.$eval("#view-instellingen .mt-jvak", (e) => e.classList.contains("dringend"))));
      await klik(pagina, '#view-instellingen [data-doe="aanmaken"]');
      await pagina.waitForSelector('#view-instellingen [data-vak="formulier"]:not([hidden]) input', { timeout: 10000 });
      for (const kolom of ["plafond_kleuter_cent", "plafond_lager_cent", "marge_kleuter_cent", "marge_lager_cent"]) {
        await klik(pagina, '[data-doe="neem"][data-kolom="' + kolom + '"]');
        await pagina.waitForFunction((k) => document.querySelector('[data-doe="neem"][data-kolom="' + k + '"]') === null, { timeout: 5000 }, kolom);
      }
      await klik(pagina, '[data-kolom="gratis_zwemjaar_leerjaar"][data-waarde="3"]');
      await bewaard(pagina, /het gratis zwemjaar is het 3de leerjaar\./);
      let scherm = await inst(pagina);
      zeker("nog niet starten: alles is ingevuld, maar de knop blijft uit, en de nota zegt vanaf wanneer", scherm.includes("Alles is ingevuld.") && (await pagina.$eval('[data-doe="bevestig"]', (e) => e.disabled))
        && scherm.includes("Bevestigen kan vanaf 1 juli " + beginjaar(nieuw) + ". Bevestigen kan ten vroegste vanaf 1 juli, als " + lopend + " voorbij is")
        && scherm.includes(nieuw + " is aangemaakt, maar nog niet bevestigd. Alles is ingevuld. Bevestigen kan vanaf 1 juli " + beginjaar(nieuw) + "."), scherm);
      await beeld(pagina, "inst-nog-niet-starten-1366.png", { fullPage: true });

      // 2. De databank antwoordt niet bij het bewaren: het scherm leest wat er echt staat, en zegt het.
      s.schrijfAntwoord = (v) => (v.method === "PATCH" ? "gooi" : null);
      await typ(pagina, '[data-bedrag="plafond_lager_cent"]', "125");
      await pagina.waitForSelector("#meldingen .toast.err", { timeout: 20000 });
      zeker("geen antwoord bij het bewaren: de melding zegt het, en het veld toont wat in de databank staat", (await tekstVan(pagina, "#meldingen")).includes("De MT kreeg geen antwoord bij het bewaren. Het scherm toont wat er nu in de databank staat: kijk het na.")
        && (await waarde(pagina, "plafond_lager_cent")) === "110,00" && s.jaarRijen.get(nieuw).plafond_lager_cent === 11000, await tekstVan(pagina, "#meldingen"));
      s.schrijfAntwoord = null;
      // De databank weigert een waarde: de melding staat bij het veld, en wat er stond, blijft bewaard.
      s.schrijfAntwoord = (v) => (v.method === "PATCH" ? new Response(JSON.stringify({ code: "23514", message: "new row violates check constraint" }), { status: 400, headers: { "content-type": "application/json" } }) : null);
      await typ(pagina, '[data-bedrag="plafond_lager_cent"]', "126");
      await pagina.waitForSelector('[data-veld="plafond_lager_cent"] [data-fout]:not([hidden])', { timeout: 10000 });
      zeker("de databank weigert een waarde: de melding staat bij het veld", (await tekstVan(pagina, '[data-veld="plafond_lager_cent"] [data-fout]')) === "Niet bewaard. De databank weigert deze waarde." && s.jaarRijen.get(nieuw).plafond_lager_cent === 11000);
      s.schrijfAntwoord = null;

      // 3. Iemand anders startte het schooljaar intussen: wat hier nog bewaard wordt, wijzigt niets meer.
      s.jaren.set(lopend, "voorbij");
      s.jaren.set(nieuw, "lopend");
      await typ(pagina, '[data-bedrag="plafond_lager_cent"]', "130");
      await pagina.waitForSelector('#view-instellingen [data-vak="formulier"][hidden]', { timeout: 20000 });
      await rust(pagina);
      scherm = await inst(pagina);
      zeker("intussen gestart: niets overschreven, het formulier is weg, en de melding zegt waarom", s.jaarRijen.get(nieuw).plafond_lager_cent === 11000
        && (await tekstVan(pagina, "#meldingen")).includes("Dit schooljaar wijzigde intussen. De MT toont wat er nu staat.") && new RegExp(nieuw + "\\s+€ 55,00\\s+€ 110,00\\s+Lopend").test(scherm), scherm);
      schoon(log, "schooljaar: fouten bij het bewaren", ["Failed to load resource", "net::ERR", "400"]);
      await pagina.close();
    }

    // 4. De databank weigert de start: het formulier blijft staan, en de melding geeft de reden van de databank.
    {
      const s = wereld({ schooljaar: null });
      s.klassenlijst("1KA", "4A", "4B");
      s.schooljaar(lopend, "in_te_vullen");
      s.vulJaar(lopend);
      const { pagina, log } = await open(s, { breedte: 390 });
      await pagina.waitForSelector("#kaartUitstappentool .mt-lijstvoet", { timeout: 15000 });
      await klik(pagina, '#tabbladen [data-tab="instellingen"]');
      await pagina.waitForSelector("#view-instellingen.active .mt-jvak", { timeout: 10000 });
      await rust(pagina);
      zeker("een schooljaar dat al in te vullen staat: het vak biedt \"Verder invullen\", het formulier staat nog dicht",
        (await inst(pagina)).includes(lopend + " is aangemaakt, maar nog niet bevestigd. Alles is ingevuld: je kan het bevestigen.") && (await pagina.$eval('#view-instellingen [data-vak="formulier"]', (e) => e.hidden)));
      await klik(pagina, '#view-instellingen [data-doe="invullen"]');
      await pagina.waitForSelector('#view-instellingen [data-vak="formulier"]:not([hidden]) input', { timeout: 5000 });
      zeker("verder invullen: de titel van het formulier heeft de focus", await pagina.evaluate(() => document.activeElement && document.activeElement.id === "instFormTitel"));
      s.schrijfAntwoord = (v) => (v.url.includes("mt_schooljaar_bevestigen")
        ? new Response(JSON.stringify({ code: "MT422", message: "MT: een nieuw schooljaar bevestigen kan ten vroegste vanaf 1 juli (B169)" }), { status: 400, headers: { "content-type": "application/json" } }) : null);
      await klik(pagina, '[data-doe="bevestig"]');
      await pagina.waitForSelector('.modal[role="dialog"]', { visible: true, timeout: 5000 });
      await klik(pagina, '.modal [data-keuze="ja"]');
      await pagina.waitForSelector("#meldingen .toast.err", { timeout: 20000 });
      zeker("de databank weigert de start: de reden van de databank, en er is niets gestart", (await tekstVan(pagina, "#meldingen")).includes("Het schooljaar is niet gestart. Een nieuw schooljaar bevestigen kan ten vroegste vanaf 1 juli (B169).")
        && s.jaren.get(lopend) === "in_te_vullen" && !(await pagina.$eval('#view-instellingen [data-vak="formulier"]', (e) => e.hidden))
        && !(await pagina.$eval('[data-doe="bevestig"]', (e) => e.disabled)) && (await tekstVan(pagina, '[data-doe="bevestig"]')) === "Aanmaak nieuw schooljaar bevestigen", await tekstVan(pagina, "#meldingen"));
      await zonderZijwaartsScrollen(pagina, "de start geweigerd 390");
      await beeld(pagina, "inst-start-geweigerd-390.png", { fullPage: true });

      // 5. Het antwoord op de start gaat verloren, maar het schooljaar is gestart: de MT leest na, en gaat verder.
      s.schrijfAntwoord = async (v) => {
        if (!v.url.includes("mt_schooljaar_bevestigen")) return null;
        s.schrijfAntwoord = null;
        await s.mt(v);
        return "gooi";
      };
      await klik(pagina, '[data-doe="bevestig"]');
      await pagina.waitForSelector('.modal[role="dialog"]', { visible: true, timeout: 5000 });
      await klik(pagina, '.modal [data-keuze="ja"]');
      await pagina.waitForSelector("#view-instellingen .mt-gestart", { timeout: 30000 });
      await rust(pagina);
      zeker("het antwoord op de start ging verloren: de MT las na dat het schooljaar gestart is, en gaat verder", (await inst(pagina)).includes("Schooljaar " + lopend + " is gestart.")
        && (await tekstVan(pagina, "#kopJaar")) === "Schooljaar " + lopend && s.vanPagina.filter((o) => o.url.includes("mt_schooljaar_bevestigen") && o.method === "POST").length === 2, await inst(pagina));
      schoon(log, "schooljaar: fouten bij het starten", ["Failed to load resource", "net::ERR", "400"]);
      await pagina.close();
    }

    // 6. Een leerkracht en een lezer hebben geen tabbladen en geen Instellingen; het schooljaar staat wel in de kop.
    for (const rol of ["leerkracht", "lezer"]) {
      const s = wereld({ rol, schooljaar: lopend, klassen: ["4A", "4B"] });
      s.klassenlijst("4A", "4B");
      const { pagina, log } = await open(s, { breedte: 390 });
      await pagina.waitForSelector("#kaartUitstappentool .mt-lijstvoet", { timeout: 15000 });
      zeker(rol + ": geen tabbladen, geen Instellingen, wel het schooljaar in de kop", (await pagina.$eval("#tabbladen", (e) => e.hidden)) && (await pagina.$eval("#view-instellingen", (e) => e.childElementCount === 0))
        && (await tekstVan(pagina, "#kopJaar")) === "Schooljaar " + lopend && !(await tekstVan(pagina, "#startIntro")).includes("Instellingen"));
      zeker(rol + ": de pagina vroeg niets van Instellingen", !s.vanPagina.some((o) => /\/rest\/v1\/(gebruikers|klastoewijzingen)/.test(o.url) || o.method === "PATCH"));
      schoon(log, "schooljaar: " + rol);
      await pagina.close();
    }
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
    // Wat er op dat moment op het scherm stond: een beeld per open tabblad, en de meldingen onderaan.
    for (const [nr, pagina] of (await browser.pages()).entries()) {
      if (!pagina.url().startsWith(SITE)) continue;
      await pagina.screenshot({ path: UIT + "/vastgelopen-" + naam + "-" + nr + ".png", fullPage: true }).catch(() => undefined);
      console.log("  op het scherm: " + String(await pagina.$eval("#meldingen", (e) => e.innerText).catch(() => "")).replace(/\s+/g, " ").slice(0, 300));
      await pagina.close().catch(() => undefined);
    }
  }
}
await browser.close();
console.log(controles + " controles, " + fouten + " fout" + (fouten === 1 ? "" : "en"));
Deno.exit(fouten ? 1 : 0);
