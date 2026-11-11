// MT · ui.js · versie 0.4.0
// De gedeelde onderdelen van de schermen (17.1). Het enige bestand dat HTML in de pagina zet
// (regel 4, 17.10). Een scherm stelt zijn opbouw samen met het sjabloon html`…`: elke ingevoegde
// waarde wordt daarin standaard tekst, zodat een naam nooit als opmaak op het scherm komt. Enkel
// zet() hieronder schrijft die opbouw weg. Wat geen sjabloon is, wordt altijd gewone tekst.
// Sinds stap 2 ook de onderdelen van de pagina en wie aangemeld is. Later komen hier de statuslabels,
// het ballonnetje van de materialentool, de filterbalk, tabellen, vensters en meldingen, en bedragen.

export const VERSIE = "0.4.0";

// ---------- Tekst en opmaak ----------

const TEKENS = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Zet een waarde om naar tekst die veilig in HTML staat. */
export function esc(waarde) {
  return String(waarde).replace(/[&<>"']/g, (teken) => TEKENS[teken]);
}

/** Opmaak die door html`…` gemaakt is: enkel die wordt als HTML weggeschreven. */
class Opmaak {
  #html;
  constructor(tekst) {
    this.#html = tekst;
  }
  get html() {
    return this.#html;
  }
  toString() {
    return this.#html;
  }
}

/**
 * Het sjabloon. html`<b>${naam}</b>` zet naam om naar tekst. Een geneste html`…` blijft opmaak,
 * een lijst wordt achter elkaar gezet, en null, undefined of false worden niets.
 */
export function html(delen, ...waarden) {
  let uit = delen[0];
  for (let i = 0; i < waarden.length; i++) uit += omzetten(waarden[i]) + delen[i + 1];
  return new Opmaak(uit);
}

function omzetten(waarde) {
  if (waarde instanceof Opmaak) return waarde.html;
  if (Array.isArray(waarde)) return waarde.map(omzetten).join("");
  if (waarde === null || waarde === undefined || waarde === false) return "";
  return esc(waarde);
}

/** Schrijft inhoud in een element: opmaak uit html`…` als HTML, al de rest als gewone tekst. */
export function zet(element, inhoud) {
  if (inhoud instanceof Opmaak) element.innerHTML = inhoud.html;
  else element.textContent = inhoud === null || inhoud === undefined ? "" : String(inhoud);
}

// ---------- De pagina, de onderdelen en de hoofding ----------

const $ = (id) => document.getElementById(id);

/** Toont de MT na een geslaagde start: de hoofding, met de versie en de omgeving. */
export function toonStart({ versie, omgeving }) {
  $("standVersie").textContent = versie;
  $("standOmgeving").textContent = omgeving.label;
  const label = $("omgeving");
  label.textContent = omgeving.label;
  label.hidden = omgeving.naam === "productie";
  $("laden").hidden = true;
  $("app").hidden = false;
}

/** Toont één onderdeel van de pagina (view-…), en verbergt de andere. */
export function toon(naam) {
  for (const deel of document.querySelectorAll("main .view")) deel.classList.toggle("active", deel.id === "view-" + naam);
  window.scrollTo(0, 0);
}

/** Wie aangemeld is, rechts in de hoofding. De knop meldt af; zonder naam staat er "Niet aangemeld". */
export function zetGebruiker(tekst, opAfmelden) {
  const knop = $("wie");
  $("nietAangemeld").hidden = Boolean(tekst);
  knop.hidden = !tekst;
  knop.textContent = tekst ? tekst + " · afmelden" : "";
  knop.onclick = tekst && opAfmelden ? opAfmelden : null;
}

const ROLLEN = { beheerder: "beheerder", leerkracht: "leerkracht", lezer: "lezer" };

/** Een datum en uur voluit, in de tijd van Brussel: "dinsdag 24 november 2026 om 09:15". */
export function datumEnUur(ms) {
  const d = new Date(ms);
  const dag = d.toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Brussels" });
  const uur = d.toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" });
  return dag + " om " + uur;
}

/**
 * De pagina na het aanmelden (stap 2): wie je bent, je rol en je klassen, en wanneer de MT je afmeldt.
 * De schermen zelf volgen in de volgende stappen.
 */
export function toonAccount({ account, blijft, codeOp, melding }) {
  const instellingen = account.instellingen || {};
  $("startTitel").textContent = "Dag " + account.naam;
  $("standNaam").textContent = account.naam + " · " + account.email;
  $("standRol").textContent = ROLLEN[account.rol] || account.rol;
  const klassen = Array.isArray(account.klassen) ? account.klassen.map((k) => k.naam) : [];
  $("rijKlassen").hidden = account.rol !== "leerkracht";
  $("standKlassen").textContent = klassen.length
    ? klassen.join(", ") + (account.schooljaar ? " (" + account.schooljaar + ")" : "")
    : "nog geen klassen" + (account.schooljaar ? " in " + account.schooljaar : ": er is nog geen lopend schooljaar");
  let afmelden = "na " + instellingen.afmelden_na_minuten + " minuten zonder activiteit, of als je dit tabblad sluit";
  if (blijft) {
    afmelden = "je blijft aangemeld op dit toestel";
    if (codeOp && instellingen.code_geldig_dagen) {
      afmelden += "; de MT vraagt de code uit je app opnieuw op " + datumEnUur(codeOp + instellingen.code_geldig_dagen * 86400000);
    }
  }
  $("standAfmelden").textContent = afmelden;
  const vak = $("startMelding");
  vak.textContent = melding || "";
  vak.hidden = !melding;
}

const STANDEN = {
  bezig: { tekst: "verbinden…", titel: "De MT controleert de verbinding met de databank.", stand: "controleren…" },
  ok: { tekst: "verbonden", titel: "Verbonden met de databank. Klik om opnieuw te controleren.", stand: "verbonden" },
  fout: { tekst: "geen verbinding", titel: "Geen verbinding met de databank. Klik om opnieuw te proberen.", stand: "geen verbinding" },
};

/** De verbindingsbol in de hoofding, en de regel Databank: bezig, ok of fout, met de reden. */
export function zetVerbinding(stand, reden) {
  const s = STANDEN[stand];
  const knop = $("conn");
  knop.classList.toggle("busy", stand === "bezig");
  knop.classList.toggle("off", stand === "fout");
  knop.title = s.titel;
  knop.setAttribute("aria-label", s.titel);
  $("connTxt").textContent = s.tekst;
  const regel = $("standDatabank");
  regel.textContent = stand === "fout" && reden ? s.stand + ": " + reden : s.stand;
  regel.classList.toggle("ok", stand === "ok");
  regel.classList.toggle("fout", stand === "fout");
}

/** Een klik op de verbindingsbol. */
export function opVerbindingKlik(actie) {
  $("conn").addEventListener("click", actie);
}
