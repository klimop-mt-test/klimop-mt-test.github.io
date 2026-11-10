// MT · app.js · versie 0.2.0
// De start (17.1): nooit in een andere pagina, dezelfde versie in alle bestanden, de omgeving uit
// het adres, en de verbinding met de databank. Later ook de tabbladen en de keuzebalk scherp of
// minder scherp (B75).
//
// app.js laadt de andere bestanden zelf, zodat een ontbrekend bestand een duidelijke melding geeft.
// Wijkt een versie af, door een vergeten bestand of een oude kopie in de browser (GitHub Pages laat
// die tot tien minuten toe), dan haalt de MT de bestanden één keer vers op en herlaadt. Lukt dat
// niet, dan start ze niet en zegt ze wat je kan doen.

export const VERSIE = "0.2.0";

/** De bestanden die de MT laadt. Elk heeft export const VERSIE; een test bewaakt deze lijst. */
const MODULES = ["./config.js", "./ui.js", "./data.js"];

/**
 * Alles wat vers opgehaald wordt als de versies verschillen. De adressen gelden ten opzichte van
 * dit bestand in code/, niet van de pagina: zo kloppen ze, waar de pagina ook staat.
 */
const PAGINA = ["./app.js", ...MODULES, "../opmaak/mt.css"].map((pad) => new URL(pad, import.meta.url).href);

/** Telt in deze sessie de pogingen om oude bestanden te vervangen: hoogstens één. */
const HERSTEL = "mt_versie_herstel_v1";

start();

async function start() {
  // 1. Nooit in een andere pagina (17.10): een CSP via <meta> kan frame-ancestors niet zetten.
  if (window.top !== window.self) {
    stop("De MT opent enkel in een eigen venster, niet in een andere pagina.");
    return;
  }

  // 2. De bestanden laden, en de versies vergelijken: elke module, index.html en mt.css.
  let geladen;
  try {
    geladen = await Promise.all(MODULES.map((pad) => import(pad)));
  } catch {
    await herstel("Een bestand van de MT ontbreekt of laadt niet.");
    return;
  }
  const versies = [...geladen.map((module) => module.VERSIE), versieVanHtml(), versieVanCss()];
  if (versies.some((v) => v !== VERSIE)) {
    await herstel("Niet alle bestanden van de MT hebben dezelfde versie.");
    return;
  }
  vergeetHerstel();
  const [config, ui, data] = geladen;

  // 3. De omgeving volgt uit het adres; een onbekend adres start niet (17.1).
  const omgeving = config.omgeving(location.hostname);
  if (!omgeving) {
    stop("Dit adres is onbekend voor de MT. Ze start enkel op haar eigen adres.");
    return;
  }

  // 4. Tonen, en de verbinding controleren. Een klik op de verbindingsbol controleert opnieuw.
  data.stel(omgeving);
  ui.toonStart({ versie: VERSIE, omgeving });
  ui.opVerbindingKlik(() => controleer(ui, data));
  await controleer(ui, data);
}

async function controleer(ui, data) {
  ui.zetVerbinding("bezig");
  const antwoord = await data.ping();
  ui.zetVerbinding(antwoord.ok ? "ok" : "fout", antwoord.reden);
}

function versieVanHtml() {
  const meta = document.querySelector('meta[name="mt-versie"]');
  return meta ? meta.getAttribute("content") : null;
}

function versieVanCss() {
  const waarde = getComputedStyle(document.documentElement).getPropertyValue("--mt-versie");
  return waarde.trim().replace(/^["']|["']$/g, "");
}

/** Haalt de bestanden één keer vers op en herlaadt; daarna geeft de MT het op. */
async function herstel(reden) {
  if (leesPogingen() < 1) {
    bewaarPogingen(1);
    const adressen = [location.pathname, ...PAGINA];
    await Promise.allSettled(adressen.map((adres) => fetch(adres, { cache: "reload" })));
    location.reload();
    return;
  }
  vergeetHerstel();
  stop(reden + " Vernieuw de pagina met Ctrl+F5. Blijft dit staan, laad dan alle bestanden van de MT opnieuw op in GitHub.");
}

/** Zonder browseropslag geen tweede poging: zo kan de MT nooit blijven herladen. */
function leesPogingen() {
  try {
    return Number(sessionStorage.getItem(HERSTEL) || 0);
  } catch {
    return 1;
  }
}

function bewaarPogingen(aantal) {
  try {
    sessionStorage.setItem(HERSTEL, String(aantal));
  } catch {
    // geen opslag: leesPogingen() geeft dan 1, en er komt geen tweede poging
  }
}

function vergeetHerstel() {
  try {
    sessionStorage.removeItem(HERSTEL);
  } catch {
    // niets te vergeten
  }
}

/** De MT start niet: enkel tekst, want ui.js is dan misschien niet geladen (regel 4). */
function stop(tekst) {
  const melding = document.getElementById("laden");
  if (!melding) return;
  melding.textContent = tekst;
  melding.classList.add("fout");
  melding.hidden = false;
}
