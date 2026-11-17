// MT · schooljaar.js · versie 0.9.0
// De regels rond schooljaren die meer dan één scherm nodig heeft (B132, B144, B164, B169): welke
// schooljaren open staan, welk schooljaar de MT aanmaakt, vanaf wanneer het kan starten, en hoe een
// stand heet. Zuivere functies: geen scherm, geen netwerk. De kop van de pagina, Instellingen en
// Gebruikers gebruiken ze; de databank beslist (sql/002_databank.sql, sql/007_schooljaar.sql).

export const VERSIE = "0.9.0";

const VORM = /^(\d{4})-(\d{4})$/;

/** Is dit een schooljaar zoals "2026-2027"? */
export function isSchooljaar(tekst) {
  const m = VORM.exec(String(tekst));
  return Boolean(m) && Number(m[2]) === Number(m[1]) + 1;
}

/** Het jaar waarin een schooljaar begint: 2026 voor "2026-2027". */
export function beginjaar(schooljaar) {
  return Number(String(schooljaar).slice(0, 4));
}

/** Het schooljaar dat in september van dat jaar begint. */
export function vanJaar(jaar) {
  return jaar + "-" + (jaar + 1);
}

/** Het schooljaar erna. */
export function volgende(schooljaar) {
  return vanJaar(beginjaar(schooljaar) + 1);
}

/**
 * De dag in Brussel, als "2026-11-17". De databank rekent met dezelfde dag (mt_intern.vandaag): om
 * middernacht in Brussel begint een nieuwe dag, niet om middernacht op de klok van de computer.
 */
export function dagInBrussel(ms) {
  const delen = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const deel = (soort) => delen.find((d) => d.type === soort).value;
  return deel("year") + "-" + deel("month") + "-" + deel("day");
}

/** De eerste dag waarop een schooljaar kan starten: 1 juli van het jaar waarin het begint (B169). */
export function startVanaf(schooljaar) {
  return beginjaar(schooljaar) + "-07-01";
}

/** Kan dit schooljaar vandaag starten? De databank beslist; de pagina zet enkel de knop aan of uit. */
export function magStarten(schooljaar, vandaag) {
  return String(vandaag) >= startVanaf(schooljaar);
}

/**
 * Het schooljaar dat de MT nu zou aanmaken. De MT leidt het zelf af: de beheerder kiest geen jaartal.
 *   - loopt er een schooljaar, dan het volgende;
 *   - anders het schooljaar van vandaag (1 september tot 31 augustus), en vanaf 1 juli al het schooljaar
 *     dat die september begint: dat kan vanaf dan starten (B169);
 *   - nooit een schooljaar vóór of gelijk aan een schooljaar dat al bestaat: de databank start geen
 *     ouder schooljaar meer.
 * Geeft null als er al een schooljaar "in te vullen" staat: er is er nooit meer dan één.
 *   jaren    de schooljaren uit de databank: [{ schooljaar, stand }]
 *   vandaag  de dag in Brussel, "2026-11-17"
 */
export function teMaken(jaren, vandaag) {
  if (jaren.some((j) => j.stand === "in_te_vullen")) return null;
  const lopend = jaren.find((j) => j.stand === "lopend");
  let kandidaat;
  if (lopend) kandidaat = volgende(lopend.schooljaar);
  else {
    const jaar = Number(String(vandaag).slice(0, 4));
    kandidaat = vanJaar(String(vandaag).slice(5) >= "07-01" ? jaar : jaar - 1);
  }
  const laatste = jaren.map((j) => j.schooljaar).filter(isSchooljaar).sort().pop();
  if (laatste && laatste >= kandidaat) kandidaat = volgende(laatste);
  return kandidaat;
}

/**
 * De schooljaren die open staan, voor de keuze in de kop (B132, B164): het lopende eerst, dan wat
 * voorbij is maar nog open, het recentste eerst. Wat in te vullen of afgesloten is, staat er niet bij.
 */
export function openJaren(jaren) {
  const lopend = jaren.filter((j) => j.stand === "lopend");
  const voorbij = jaren.filter((j) => j.stand === "voorbij").sort((a, b) => (a.schooljaar < b.schooljaar ? 1 : a.schooljaar > b.schooljaar ? -1 : 0));
  return [...lopend, ...voorbij];
}

/**
 * Het schooljaar waarin de schermen werken: wat gekozen was, als dat nog open staat; anders het
 * lopende, of het recentste dat open staat. Zonder open schooljaar: niets.
 *   open     de lijst van openJaren()
 *   gekozen  wat de gebruiker koos, of null
 */
export function kiesJaar(open, gekozen) {
  if (gekozen && open.some((j) => j.schooljaar === gekozen)) return gekozen;
  return open.length ? open[0].schooljaar : null;
}

/** Het vorige schooljaar van een schooljaar: het lopende als dat ouder is, anders het recentste oudere dat ooit startte. */
export function vorigVan(jaren, schooljaar) {
  const eerder = jaren
    .filter((j) => j.stand !== "in_te_vullen" && isSchooljaar(j.schooljaar) && j.schooljaar < schooljaar)
    .sort((a, b) => (a.schooljaar < b.schooljaar ? 1 : -1));
  return eerder.find((j) => j.stand === "lopend") || eerder[0] || null;
}

/** Hoe een stand heet op het scherm, en de kleur van haar label (design system: .pill). */
export const STANDNAAM = Object.freeze({ in_te_vullen: "In te vullen", lopend: "Lopend", voorbij: "Voorbij, nog open", afgesloten: "Afgesloten" });
export const STANDKLEUR = Object.freeze({ in_te_vullen: "open", lopend: "info", voorbij: "open", afgesloten: "muted" });

/** Een dag voluit: "1 juli 2027" voor "2027-07-01". */
export function dagVoluit(dag) {
  const [jaar, maand, nr] = String(dag).split("-").map(Number);
  const MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
  return nr + " " + MAANDEN[maand - 1] + " " + jaar;
}
