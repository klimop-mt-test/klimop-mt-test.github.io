// MT · ui.js · versie 0.6.2
// De gedeelde onderdelen van de schermen (17.1). Het enige bestand dat HTML in de pagina zet
// (regel 4, 17.10). Een scherm stelt zijn opbouw samen met het sjabloon html`…`: elke ingevoegde
// waarde wordt daarin standaard tekst, zodat een naam nooit als opmaak op het scherm komt. Enkel
// zet() hieronder schrijft die opbouw weg. Wat geen sjabloon is, wordt altijd gewone tekst.
// Sinds stap 2 ook de onderdelen van de pagina, wie aangemeld is, de vensters, de beslissingsvraag en
// de meldingen onderaan. Later komen hier de statuslabels, het ballonnetje van de materialentool, de
// filterbalk, tabellen en bedragen.

export const VERSIE = "0.6.2";

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
/**
 * Bij het afmelden: meteen niets van de MT meer in beeld, geen scherm en geen venster, nog vóór de
 * pagina herlaadt. Zo blijft er niets leesbaar terwijl het netwerk traag is (review 1, I4).
 * Het scherm is eerst leeg; de tekst komt er pas bij als het afmelden langer dan een halve seconde
 * duurt. Zo flitst er bij een gewone afmelding niets voorbij (B217).
 */
export function vergrendel() {
  $("vensters").replaceChildren();
  $("meldingen").replaceChildren();
  $("app").hidden = true;
  const laden = $("laden");
  laden.textContent = "";
  laden.hidden = false;
  setTimeout(() => {
    laden.textContent = "Je wordt afgemeld.";
  }, 500);
}

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

/** De kaart naar het scherm Gebruikers, enkel voor een beheerder. Later bereik je het scherm via Instellingen (B165). */
export function toonNaarGebruikers(actie) {
  $("kaartGebruikers").hidden = false;
  $("naarGebruikers").addEventListener("click", actie);
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

// ---------- Vensters (design system: .overlay + .modal) ----------
// Een venster houdt de focus binnen, sluit met Escape, en geeft de focus terug aan wat het opende.
// Een klik naast het venster sluit het niet: zo gaat er geen invoer verloren door een misklik.

const FOCUSBAAR = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const open = [];
let vensterNr = 0;

/**
 * Opent een venster. inhoud en voet zijn opmaak uit html`…`.
 *   breed       "" (560 px), "mid" (700 px) of "wide" (980 px)
 *   magSluiten  een functie die true geeft als het venster dicht mag (bv. na een vraag bij onbewaarde wijzigingen)
 *   focus       een kiezer voor het element dat de focus krijgt; anders het eerste veld
 *   terugNaar   een functie die het element geeft dat na het sluiten de focus krijgt. Zonder: wat de
 *               focus had bij het openen. Nodig als de lijst erachter intussen opnieuw getekend is.
 * Geeft { el, sluit, vraagSluiten }: el is het venster zelf, sluit() sluit het zonder vraag.
 */
export function venster({ titel, sub = null, breed = "", inhoud, voet = null, magSluiten = null, focus = null, terugNaar = null }) {
  const houder = $("vensters");
  const vorige = document.activeElement;
  const id = "vensterTitel" + ++vensterNr;
  const laag = document.createElement("div");
  laag.className = "overlay open";
  zet(laag, html`
    <div class="${"modal" + (breed ? " " + breed : "")}" role="dialog" aria-modal="true" aria-labelledby="${id}">
      <div class="modal-head">
        <div><h3 id="${id}">${titel}</h3>${sub ? html`<div class="mh-sub">${sub}</div>` : null}</div>
        <button class="modal-close" type="button" aria-label="Sluiten"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg></button>
      </div>
      <div class="modal-body">${inhoud}</div>
      ${voet ? html`<div class="modal-foot">${voet}</div>` : null}
    </div>`);
  houder.appendChild(laag);
  document.body.classList.add("mt-venster-open");
  const el = laag.firstElementChild;
  let dicht = false;
  const sluit = () => {
    if (dicht) return;
    dicht = true;
    laag.remove();
    open.splice(open.indexOf(ik), 1);
    if (!open.length) document.body.classList.remove("mt-venster-open");
    const terug = (terugNaar && terugNaar()) || vorige;
    if (terug && typeof terug.focus === "function" && document.contains(terug)) terug.focus();
  };
  const vraagSluiten = async () => {
    if (!magSluiten || (await magSluiten())) sluit();
  };
  const ik = { el, sluit, vraagSluiten };
  open.push(ik);
  el.querySelector(".modal-close").addEventListener("click", vraagSluiten);
  laag.addEventListener("keydown", (gebeurtenis) => {
    if (open[open.length - 1] !== ik) return;
    if (gebeurtenis.key === "Escape") {
      gebeurtenis.preventDefault();
      vraagSluiten();
      return;
    }
    if (gebeurtenis.key !== "Tab") return;
    const lijst = [...el.querySelectorAll(FOCUSBAAR)].filter((e) => e.offsetParent !== null);
    if (!lijst.length) return;
    const eerste = lijst[0], laatste = lijst[lijst.length - 1];
    if (gebeurtenis.shiftKey && document.activeElement === eerste) {
      gebeurtenis.preventDefault();
      laatste.focus();
    } else if (!gebeurtenis.shiftKey && document.activeElement === laatste) {
      gebeurtenis.preventDefault();
      eerste.focus();
    }
  });
  const doel = (focus && el.querySelector(focus)) || el.querySelector(".modal-body input, .modal-body select, .modal-body textarea") || el.querySelector(".modal-foot button") || el.querySelector(".modal-close");
  if (doel) doel.focus();
  return ik;
}

/**
 * De beslissingsvraag (design system): een bewuste "Ja, …" en een "Nee, …" die de focus heeft. Enter en
 * Escape kiezen "Nee". Geeft true bij ja. Vragen komen na elkaar: de tweede wacht op de eerste.
 */
let vorigeVraag = Promise.resolve();
export function vraag({ titel, tekst, ja, nee }) {
  const beurt = vorigeVraag.then(() => new Promise((antwoord) => {
    let gekozen = false;
    const v = venster({
      titel,
      inhoud: html`<p class="mt-vraag">${tekst}</p>`,
      voet: html`<button class="btn btn-ghost" type="button" data-keuze="ja">${ja}</button><button class="btn btn-primary" type="button" data-keuze="nee">${nee}</button>`,
      focus: '[data-keuze="nee"]',
      magSluiten: () => {
        if (!gekozen) antwoord(false);
        gekozen = true;
        return true;
      },
    });
    for (const knop of v.el.querySelectorAll("[data-keuze]")) {
      knop.addEventListener("click", () => {
        gekozen = true;
        v.sluit();
        antwoord(knop.dataset.keuze === "ja");
      });
    }
  }));
  vorigeVraag = beurt.catch(() => undefined);
  return beurt;
}

/** Een melding onderaan (design system: .toast): soort "ok", "err" of niets. Een fout blijft langer staan. */
export function meld(tekst, soort = "") {
  const vak = document.createElement("div");
  vak.className = "toast" + (soort ? " " + soort : "");
  vak.textContent = tekst;
  $("meldingen").appendChild(vak);
  setTimeout(() => {
    vak.classList.add("out");
    setTimeout(() => vak.remove(), 300);
  }, soort === "err" ? 9000 : 4500);
}

/** Een knop tijdens een actie (design system): niet opnieuw te klikken, met "Bezig met …". */
/**
 * Zet een venster vast terwijl een oproep loopt: geen veld en geen knop reageert nog, ook het kruisje
 * niet. Zo wijzigt de invoer niet meer terwijl ze bewaard wordt (review 1, I7). Geeft de functie terug
 * die alles weer vrijgeeft; wat al uit stond, blijft uit.
 */
export function bevries(el) {
  const vast = [...el.querySelectorAll("button, input, select, textarea")].filter((e) => !e.disabled);
  for (const e of vast) e.disabled = true;
  return () => {
    for (const e of vast) e.disabled = false;
  };
}

export function knopBezig(knop, tekst) {
  if (!knop) return () => undefined;
  const vorig = knop.textContent;
  knop.disabled = true;
  knop.classList.add("busy");
  knop.textContent = tekst;
  return () => {
    knop.disabled = false;
    knop.classList.remove("busy");
    knop.textContent = vorig;
  };
}
