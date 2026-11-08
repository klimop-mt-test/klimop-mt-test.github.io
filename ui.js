// MT · ui.js · versie 0.1.0
// De gedeelde onderdelen van de schermen (17.1). Het enige bestand dat HTML in de pagina zet
// (regel 4, 17.10). Een scherm stelt zijn opbouw samen met het sjabloon html`…`: elke ingevoegde
// waarde wordt daarin standaard tekst, zodat een naam nooit als opmaak op het scherm komt. Enkel
// zet() hieronder schrijft die opbouw weg. Wat geen sjabloon is, wordt altijd gewone tekst.
// Later komen hier ook de statuslabels, het ballonnetje van de materialentool, de filterbalk,
// tabellen, vensters en meldingen, en het tonen van bedragen en datums.

export const VERSIE = "0.1.0";

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

// ---------- De start en de verbindingsbol ----------

const $ = (id) => document.getElementById(id);

/** Toont de MT na een geslaagde start. Stap 0: de pagina "in opbouw". */
export function toonStart({ versie, omgeving }) {
  $("standVersie").textContent = versie;
  $("standOmgeving").textContent = omgeving.label;
  const label = $("omgeving");
  label.textContent = omgeving.label;
  label.hidden = omgeving.naam === "productie";
  $("laden").hidden = true;
  $("app").hidden = false;
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
