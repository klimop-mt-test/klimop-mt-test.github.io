// MT · app.js · versie 0.4.0
// De start (17.1): nooit in een andere pagina, dezelfde versie in alle bestanden, de omgeving uit
// het adres, de verbinding met de databank, en sinds stap 2 de aanmelding en het afmelden (17.2).
// Later ook de tabbladen en de keuzebalk scherp of minder scherp (B75).
//
// app.js laadt de andere bestanden zelf, zodat een ontbrekend bestand een duidelijke melding geeft.
// Wijkt een versie af, door een vergeten bestand of een oude kopie in de browser (GitHub Pages laat
// die tot tien minuten toe), dan haalt de MT de bestanden één keer vers op en herlaadt. Lukt dat
// niet, dan start ze niet en zegt ze wat je kan doen.

export const VERSIE = "0.4.0";

/** De bestanden die de MT laadt. Elk heeft export const VERSIE; een test bewaakt deze lijst. */
const MODULES = ["./config.js", "./ui.js", "./data.js", "./auth.js", "./aanmelden.js"];

/**
 * Alles wat vers opgehaald wordt als de versies verschillen. De adressen gelden ten opzichte van
 * dit bestand in code/, niet van de pagina: zo kloppen ze, waar de pagina ook staat.
 */
const PAGINA = ["./app.js", ...MODULES, "../opmaak/mt.css"].map((pad) => new URL(pad, import.meta.url).href);

/** Telt in deze sessie de pogingen om oude bestanden te vervangen: hoogstens één. */
const HERSTEL = "mt_versie_herstel_v1";

/** Afmelden na zoveel minuten zonder activiteit, tot de instelling van de MT gekend is (B26, B172). */
let stilMinuten = 30;

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
  const [config, ui, data, auth, aanmelden] = geladen;

  // 3. De omgeving volgt uit het adres; een onbekend adres start niet (17.1).
  const omgeving = config.omgeving(location.hostname);
  if (!omgeving) {
    stop("Dit adres is onbekend voor de MT. Ze start enkel op haar eigen adres.");
    return;
  }

  // 4. De aanmelding: supabase-js uit de eigen repository (B158). Zonder kan niemand binnen.
  if (!auth.stel(omgeving)) {
    stop("De aanmelding van de MT laadt niet. Vernieuw de pagina met Ctrl+F5. Blijft dit staan, laad dan alle bestanden van de MT opnieuw op in GitHub.");
    return;
  }
  data.stel(omgeving);
  data.stelToken(auth.token);

  // 5. Tonen, en de verbinding controleren. Een klik op de verbindingsbol controleert opnieuw.
  ui.toonStart({ versie: VERSIE, omgeving });
  ui.opVerbindingKlik(() => controleer(ui, data));
  controleer(ui, data);

  // 6. Afmelden gebeurt op één plaats, en herlaadt de pagina: zo blijft er niets van de vorige
  //    aanmelding in het geheugen, ook geen geopend venster (T5).
  let weg = false;
  const afmelden = async (bericht = null) => {
    if (weg) return;
    weg = true;
    await auth.afmelden(bericht);
    location.reload();
  };
  auth.opAfgemeld(() => {
    if (!weg) location.reload();
  });
  bewaakStilte(auth, afmelden);

  // 7. Aanmelden: het scherm in stappen, tot de databank de aanmelding aanvaardt.
  ui.zetGebruiker(null);
  ui.toon("aanmelden");
  const uit = await aanmelden.start({
    kaart: document.getElementById("aanmeldKaart"),
    appNaam: omgeving.app,
    bericht: auth.haalBericht(),
    afmelden,
  });

  // 8. Aangemeld. De schermen volgen in de volgende stappen; tot dan toont de MT wie je bent.
  const account = uit.account;
  if (account.instellingen && account.instellingen.afmelden_na_minuten > 0) stilMinuten = account.instellingen.afmelden_na_minuten;
  ui.zetGebruiker(account.naam + ", " + account.rol, () => afmelden());
  ui.toonAccount({
    account,
    blijft: auth.blijft(),
    codeOp: uit.niveau.codeOp,
    melding: uit.nietBlijven ? "\"Aangemeld blijven\" staat uit voor jouw rol: de MT meldt je af als je een tijd niets doet." : null,
  });
  ui.toon("start");
}

async function controleer(ui, data) {
  ui.zetVerbinding("bezig");
  const antwoord = await data.ping();
  ui.zetVerbinding(antwoord.ok ? "ok" : "fout", antwoord.reden);
}

/**
 * Op een gedeelde computer (zonder "Aangemeld blijven") meldt de MT af na een tijd zonder activiteit
 * (B26). Niet enkel met een klok: ook bij het terugkeren naar het tabblad of na de slaapstand (T5).
 */
function bewaakStilte(auth, afmelden) {
  let laatst = 0;
  const activiteit = () => {
    const nu = Date.now();
    if (nu - laatst < 15000) return;
    laatst = nu;
    auth.raak(nu);
  };
  for (const soort of ["pointerdown", "keydown", "scroll", "touchstart"]) {
    window.addEventListener(soort, activiteit, { passive: true, capture: true });
  }
  const kijk = async () => {
    if (auth.blijft() || !(await auth.token())) return;
    if (auth.teLangStil(auth.laatste(), Date.now(), stilMinuten)) {
      await afmelden("Je bent afgemeld: er gebeurde " + stilMinuten + " minuten niets.");
    }
  };
  setInterval(kijk, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) kijk();
  });
  window.addEventListener("focus", kijk);
  window.addEventListener("pageshow", kijk);
  kijk();
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
