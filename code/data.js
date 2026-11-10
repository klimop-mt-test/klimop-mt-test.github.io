// MT · data.js · versie 0.2.0
// De verbinding met de eigen databank (17.1, 17.8). De schermen praten enkel via dit bestand met
// Supabase (regel 3). De publishable key gaat enkel als apikey mee; Authorization enkel met het
// toegangsbewijs van een aangemelde gebruiker (design system 1.13).
// Later komen hier de paginering, de databankfuncties en de serverfuncties, en de regel dat
// "geen rechten" nooit "geen gegevens" betekent (17.3).

export const VERSIE = "0.2.0";

/** Zoals de REST-laag van de andere tools: na 12 seconden zonder antwoord is het een fout. */
const WACHTTIJD = 12000;

let mt = null;

/** Kiest de databank van de omgeving: de test of later de productie (config.js). */
export function stel(omgeving) {
  mt = omgeving.mt;
}

/**
 * Eén oproep naar de REST-laag van de MT. Geeft altijd een antwoord terug, nooit een uitzondering:
 * { ok, status, gegevens, reden }. status 0 betekent: geen antwoord.
 */
async function roep(pad, { methode = "GET", lichaam, token } = {}) {
  if (!mt) return { ok: false, status: 0, gegevens: null, reden: "de MT kent haar databank nog niet" };
  const koppen = { apikey: mt.sleutel, Accept: "application/json" };
  if (token) koppen.Authorization = "Bearer " + token;
  if (lichaam !== undefined) koppen["Content-Type"] = "application/json";
  const stopper = new AbortController();
  const klok = setTimeout(() => stopper.abort(), WACHTTIJD);
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
    return { ok: antwoord.ok, status: antwoord.status, gegevens, reden: antwoord.ok ? null : redenVoor(antwoord.status) };
  } catch (fout) {
    const reden = fout && fout.name === "AbortError" ? "geen antwoord binnen 12 seconden" : "de databank is niet bereikbaar";
    return { ok: false, status: 0, gegevens: null, reden };
  } finally {
    clearTimeout(klok);
  }
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
