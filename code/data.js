// MT · data.js · versie 0.6.2
// De verbinding met de eigen databank (17.1, 17.8). De schermen praten enkel via dit bestand met
// Supabase (regel 3). De publishable key gaat enkel als apikey mee; Authorization enkel met het
// toegangsbewijs van een aangemelde gebruiker (design system 1.13).
// Sinds stap 2: de databankfuncties (rpc/mt_…) en de serverfunctie voor de accounts, met de soort
// fout erbij, zodat een scherm weet wat er scheelt zonder de tekst te lezen (64.4).
// Sinds stap 2b: tabellen lezen met paginering (17.8), en de regel dat "geen rechten" nooit "geen
// gegevens" betekent (17.3).

import { ACCOUNTFUNCTIE } from "./config.js";

export const VERSIE = "0.6.2";

/** Zoals de REST-laag van de andere tools: na 12 seconden zonder antwoord is het een fout. */
const WACHTTIJD = 12000;
/** De serverfunctie roept zelf Supabase enkele keren op: zij krijgt langer. */
const WACHTTIJD_SERVER = 30000;

let mt = null;

/** Wie aangemeld is: auth.js geeft hier telkens het verse toegangsbewijs, of niets. */
let tokenBron = () => Promise.resolve(null);

/** Kiest de databank van de omgeving: de test of later de productie (config.js). */
export function stel(omgeving) {
  mt = omgeving.mt;
}

/** Koppelt de aanmelding: een functie die het toegangsbewijs geeft van wie aangemeld is. */
export function stelToken(bron) {
  tokenBron = bron;
}

/**
 * Eén oproep naar het project van de MT. Geeft altijd een antwoord terug, nooit een uitzondering:
 * { ok, status, gegevens, reden }. status 0 betekent: geen antwoord.
 */
async function roep(pad, { methode = "GET", lichaam, token, wachttijd = WACHTTIJD, extra = null } = {}) {
  if (!mt) return { ok: false, status: 0, gegevens: null, reden: "de MT kent haar databank nog niet" };
  const koppen = { apikey: mt.sleutel, Accept: "application/json", ...(extra || {}) };
  if (token) koppen.Authorization = "Bearer " + token;
  if (lichaam !== undefined) koppen["Content-Type"] = "application/json";
  const stopper = new AbortController();
  const klok = setTimeout(() => stopper.abort(), wachttijd);
  try {
    const antwoord = await fetch(mt.url + pad, {
      method: methode,
      headers: koppen,
      body: lichaam === undefined ? undefined : JSON.stringify(lichaam),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: stopper.signal,
    });
    const tekst = await antwoord.text();
    let gegevens = null;
    if (tekst) {
      try {
        gegevens = JSON.parse(tekst);
      } catch {
        gegevens = null;
      }
    }
    return { ok: antwoord.ok, status: antwoord.status, gegevens, reden: antwoord.ok ? null : redenVoor(antwoord.status), bereik: antwoord.headers.get("content-range") };
  } catch (fout) {
    const reden = fout && fout.name === "AbortError" ? "geen antwoord binnen " + Math.round(wachttijd / 1000) + " seconden" : "de databank is niet bereikbaar";
    return { ok: false, status: 0, gegevens: null, reden };
  } finally {
    clearTimeout(klok);
  }
}

/**
 * De sessie bij Supabase beëindigen, bij het afmelden. De browser kent ze dan al niet meer (auth.js):
 * dit wacht dus hoogstens anderhalve seconde en mag mislukken. Door keepalive loopt het verzoek door
 * als de pagina intussen herlaadt. Zonder verbinding blijft de sessie bij Supabase bestaan tot ze
 * vervalt, maar geen browser kent haar nog (review 1, I4).
 */
export async function afmeldenBijSupabase(token) {
  if (!mt || !token) return;
  const verzoek = fetch(mt.url + "/auth/v1/logout?scope=local", {
    method: "POST",
    headers: { apikey: mt.sleutel, Authorization: "Bearer " + token },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    keepalive: true,
  }).catch(() => undefined);
  let klok;
  await Promise.race([verzoek, new Promise((klaar) => (klok = setTimeout(klaar, 1500)))]);
  clearTimeout(klok);
}

/** Een begrijpelijke reden bij een fout van de databank. */
export function redenVoor(status) {
  if (status === 401 || status === 403) return "de databank weigert de sleutel of de rechten (" + status + ")";
  if (status === 404) return "de pingfunctie ontbreekt: voer sql/001_basis.sql uit in het testproject";
  if (status >= 500) return "de databank geeft een fout (" + status + ")";
  return "onverwacht antwoord van de databank (" + status + ")";
}

/** De pingfunctie (17.9): bereikbaar, en ze antwoordt true. Geeft { ok, reden }. */
export async function ping() {
  const antwoord = await roep("/rest/v1/rpc/mt_ping");
  if (antwoord.ok && antwoord.gegevens === true) return { ok: true, reden: null };
  return { ok: false, reden: antwoord.ok ? "onverwacht antwoord van de pingfunctie" : antwoord.reden };
}

// ---------- De databankfuncties en de serverfunctie ----------
// Elk antwoord is { ok: true, gegevens } of { ok: false, soort, tekst, status, extra }. De soort:
//   sessie      niet (meer) aangemeld: meld opnieuw aan
//   rechten     de databank weigert: geen rechten, of de tweestapsverificatie is niet in orde (42501)
//   gewijzigd   de stand wijzigde intussen: herlaad, er is niets overschreven (MT409)
//   kan_niet    het kan niet, om de reden in de tekst (MT422)
//   te_veel     te veel pogingen na elkaar (MT429)
//   oproep      een oproep die niet klopt: een fout in de pagina (22023)
//   ontbreekt   de functie bestaat niet: een script of de serverfunctie ontbreekt
//   verbinding  geen antwoord
//   fout        al de rest

const SOORT_PER_CODE = { "42501": "rechten", MT409: "gewijzigd", MT422: "kan_niet", MT429: "te_veel", "22023": "oproep" };
const SOORTEN = new Set(["sessie", "rechten", "gewijzigd", "kan_niet", "te_veel", "oproep"]);
const TEKST = {
  sessie: "Je sessie is verlopen. Meld opnieuw aan.",
  rechten: "Je hebt geen rechten voor deze handeling.",
  gewijzigd: "Iemand wijzigde dit intussen. Kijk het opnieuw na: er is niets overschreven.",
  kan_niet: "Dit kan niet.",
  te_veel: "Te veel pogingen na elkaar. Wacht tien minuten en probeer het opnieuw.",
  oproep: "Deze oproep klopt niet.",
  verbinding: "Geen verbinding met de databank. Controleer je internetverbinding en probeer het opnieuw.",
  fout: "De databank gaf een fout. Probeer het opnieuw.",
};

/** De tekst van de databank als een zin: met een hoofdletter en een punt. */
function zin(tekst) {
  const t = String(tekst).trim();
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : ".");
}

function mislukt(soort, tekst, status, extra = {}) {
  return { ok: false, soort, tekst: tekst ? zin(tekst) : TEKST[soort] || TEKST.fout, status, extra };
}

/**
 * Roept een databankfunctie op via haar doorgeefluik in public (64.3), als wie aangemeld is.
 * naam is de naam met mt_ ervoor, bv. "mt_mijn_account"; args zijn de parameters, met p_ ervoor.
 */
export async function rpc(naam, args = {}) {
  const token = await tokenBron();
  if (!token) return mislukt("sessie", null, 0);
  const antwoord = await roep("/rest/v1/rpc/" + naam, { methode: "POST", lichaam: args, token });
  if (antwoord.ok) return { ok: true, gegevens: antwoord.gegevens };
  if (antwoord.status === 0) return mislukt("verbinding", null, 0);
  const g = antwoord.gegevens && typeof antwoord.gegevens === "object" ? antwoord.gegevens : {};
  const code = typeof g.code === "string" ? g.code : "";
  const tekst = typeof g.message === "string" && g.message.startsWith("MT: ") ? g.message.slice(4) : null;
  if (Object.prototype.hasOwnProperty.call(SOORT_PER_CODE, code)) return mislukt(SOORT_PER_CODE[code], tekst, antwoord.status);
  // De databank wachtte te lang, op een slot of op een antwoord (de tijdslimieten van Supabase): er is niets gewijzigd.
  if (code === "55P03" || code === "57014") return mislukt("fout", "De databank is even bezet. Probeer het over enkele seconden opnieuw.", antwoord.status);
  if (antwoord.status === 401) return mislukt("sessie", null, 401);
  if (antwoord.status === 403) return mislukt("rechten", null, 403);
  // 404: de functie bestaat niet. PGRST202: ze bestaat niet met deze parameters, dus in een oudere versie.
  if (antwoord.status === 404 || code === "PGRST202") return mislukt("ontbreekt", "De databank kent deze functie niet: een SQL-script is nog niet uitgevoerd.", 404);
  return mislukt("fout", null, antwoord.status);
}

/** Roept de serverfunctie voor de accounts op (17.4), als wie aangemeld is. */
export async function serverfunctie(actie, invoer = {}) {
  const token = await tokenBron();
  if (!token) return mislukt("sessie", null, 0);
  const antwoord = await roep("/functions/v1/" + ACCOUNTFUNCTIE, { methode: "POST", lichaam: { ...invoer, actie }, token, wachttijd: WACHTTIJD_SERVER });
  const g = antwoord.gegevens && typeof antwoord.gegevens === "object" ? antwoord.gegevens : {};
  if (antwoord.ok && g.ok === true) return { ok: true, gegevens: g };
  if (antwoord.status === 0) return mislukt("verbinding", null, 0);
  if (antwoord.status === 404) return mislukt("ontbreekt", "De serverfunctie " + ACCOUNTFUNCTIE + " staat nog niet in Supabase.", 404);
  // onbekend: Supabase gaf geen antwoord, dus de wijziging kan toch gebeurd zijn (review 1, I2).
  const extra = { geblokkeerd: g.geblokkeerd === true, onbekend: g.onbekend === true };
  if (typeof g.code === "string" && typeof g.melding === "string") {
    return mislukt(SOORTEN.has(g.code) ? g.code : "fout", g.melding, antwoord.status, extra);
  }
  // Een antwoord van Supabase zelf, vóór de functie: het toegangsbewijs is geweigerd, of de functie viel uit.
  if (antwoord.status === 401) return mislukt("sessie", null, 401);
  return mislukt("fout", "De serverfunctie gaf een fout (" + antwoord.status + "). Probeer het opnieuw.", antwoord.status, extra);
}

// ---------- Tabellen lezen (17.8) ----------

/** De Data API geeft nooit meer dan 1000 rijen per vraag terug. */
const BLADZIJDE = 1000;
/** Na zoveel bladzijden stopt het lezen: zoveel rijen telt geen scherm van de MT. */
const MAX_BLADZIJDEN = 60;
const NAAM = /^[a-z][a-z0-9_]*$/;

/** Eén waarde in een lijst van een filter: tussen aanhalingstekens, zodat een komma of een haakje nooit de vraag wijzigt. */
function inLijst(w) {
  if (w === true || w === false || typeof w === "number") return String(w);
  return '"' + String(w).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Het totaal uit de kop Content-Range: het getal na de schuine streep, zoals in "0-999/1503". Niets als de kop ontbreekt. */
export function totaalUit(bereik) {
  const m = /\/(\d+)$/.exec(String(bereik ?? ""));
  return m ? Number(m[1]) : null;
}

/** Eén lezing van alle bladzijden. Geeft { rijen, totaal, bladzijden }, of { fout } met het antwoord voor het scherm. */
async function leesBladzijden(tabel, vraag) {
  const rijen = [];
  let totaal = null;
  for (let blad = 0; blad < MAX_BLADZIJDEN; blad++) {
    // Het toegangsbewijs per bladzijde: een lange lijst leest zo nooit met een bewijs dat intussen verliep.
    const token = await tokenBron();
    if (!token) return { fout: mislukt("sessie", null, 0) };
    // De eerste bladzijde vraagt ook het totaal: zo valt op dat een latere bladzijde ontbreekt (review 1, I6).
    const antwoord = await roep("/rest/v1/" + tabel + "?" + vraag.join("&") + "&limit=" + BLADZIJDE + "&offset=" + blad * BLADZIJDE,
      { token, extra: blad === 0 ? { Prefer: "count=exact" } : null });
    if (!antwoord.ok || !Array.isArray(antwoord.gegevens)) {
      if (antwoord.status === 0) return { fout: mislukt("verbinding", null, 0) };
      if (antwoord.status === 401) return { fout: mislukt("sessie", null, 401) };
      if (antwoord.status === 403) return { fout: mislukt("rechten", null, 403) };
      if (antwoord.status === 404) return { fout: mislukt("ontbreekt", "De databank kent deze tabel niet: een SQL-script is nog niet uitgevoerd.", 404) };
      // Een kolom die de databank nog niet kent: de pagina is nieuwer dan de databank.
      const code = antwoord.gegevens && typeof antwoord.gegevens === "object" && typeof antwoord.gegevens.code === "string" ? antwoord.gegevens.code : "";
      if (code === "42703" || code === "42P01") return { fout: mislukt("ontbreekt", "De databank is nog niet bijgewerkt: het laatste SQL-script is nog niet uitgevoerd.", antwoord.status) };
      return { fout: mislukt("fout", null, antwoord.status) };
    }
    if (blad === 0) totaal = totaalUit(antwoord.bereik);
    rijen.push(...antwoord.gegevens);
    if (antwoord.gegevens.length < BLADZIJDE) return { rijen, totaal, bladzijden: blad + 1 };
  }
  return { fout: mislukt("fout", "Deze lijst is te lang om in één keer te lezen.", 0) };
}

/**
 * Leest rijen uit een tabel van de MT, als wie aangemeld is. RLS beslist wat terugkomt.
 *   kolommen  de kolommen: ["id", "naam"]
 *   waar      { kolom: waarde } is gelijk aan; { kolom: [a, b] } is één van; { kolom: null } is leeg
 *   volgorde  ["naam", "id"]: verplicht, en eindigend op wat uniek is; anders verspringen de bladzijden
 *   rol       de rol die het scherm eist, bv. "beheerder" of ["beheerder", "lezer"]: wie die rol niet
 *             meer heeft, krijgt geen lijst
 * Een lijst is pas een lijst als ze volledig is (17.3, review 1: I6):
 *   - komt er niets terug, of telde de lijst meer dan één bladzijde, dan kijkt de MT na of de aanmelding
 *     nog in orde is, en of de rol nog klopt: zonder rechten toont de databank ook niets, en dat is
 *     geen lege of korte lijst;
 *   - het aantal rijen moet het totaal zijn dat de databank bij de eerste bladzijde meldde. Verschilt
 *     het, dan leest de MT één keer opnieuw; blijft het verschillen, dan is er geen lijst.
 */
export async function lees(tabel, { kolommen, waar = {}, volgorde, rol = null }) {
  const namen = [tabel, ...kolommen, ...Object.keys(waar), ...volgorde];
  if (!namen.every((n) => NAAM.test(n)) || !kolommen.length || !volgorde.length) return mislukt("oproep", null, 0);
  const vraag = ["select=" + kolommen.join(",")];
  for (const [kolom, w] of Object.entries(waar)) {
    if (w === null) vraag.push(kolom + "=is.null");
    else if (Array.isArray(w)) {
      if (!w.length) return { ok: true, gegevens: [] };
      vraag.push(kolom + "=in.(" + encodeURIComponent(w.map(inLijst).join(",")) + ")");
    } else vraag.push(kolom + "=eq." + encodeURIComponent(String(w)));
  }
  vraag.push("order=" + volgorde.map((kolom) => kolom + ".asc").join(","));

  let uit = await leesBladzijden(tabel, vraag);
  if (uit.fout) return uit.fout;
  let volledig = uit.totaal === null || uit.rijen.length === uit.totaal;
  if (!volledig) {
    uit = await leesBladzijden(tabel, vraag);
    if (uit.fout) return uit.fout;
    volledig = uit.totaal === null || uit.rijen.length === uit.totaal;
  }
  if (uit.rijen.length === 0 || uit.bladzijden > 1 || !volledig) {
    const nog = await rpc("mt_mijn_account");
    if (!nog.ok) return nog;
    const rollen = rol === null ? null : Array.isArray(rol) ? rol : [rol];
    if (rollen && !rollen.includes(nog.gegevens && nog.gegevens.rol)) return mislukt("rechten", null, 403);
  }
  if (!volledig) return mislukt("fout", "De lijst wijzigde terwijl de MT ze las. Probeer het opnieuw.", 0);
  return { ok: true, gegevens: uit.rijen };
}
