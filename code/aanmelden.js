// MT · aanmelden.js · versie 0.5.0
// Het aanmeldscherm (17.2, canvas: bord "Aanmelden met tweestapsverificatie"). De eerste keer vier
// stappen: tijdelijk wachtwoord, eigen wachtwoord kiezen, app koppelen, code. Daarna twee: wachtwoord
// en code. Welke stap volgt, beslist dit scherm niet zelf: het vraagt de stand van het account aan de
// serverfunctie (17.4), en de databank beslist of de aanmelding in orde is (T5).
//
// Dit bestand praat met Supabase enkel via auth.js (de aanmelding) en data.js (de databank en de
// serverfunctie), en schrijft zijn opbouw enkel weg met zet() van ui.js (regels 3 en 4).

import * as auth from "./auth.js";
import * as data from "./data.js";
import { ACCOUNTFUNCTIE, ACCOUNTFUNCTIE_VERSIE, MAILVOORBEELD } from "./config.js";
import { html, zet } from "./ui.js";

export const VERSIE = "0.5.0";

// ---------- Welke stap volgt ----------

/**
 * De volgende stap, uit de stand van het account (de serverfunctie) en het niveau van de sessie.
 *   geen_toegang, uitgeschakeld, bezig, verlopen   aanmelden kan nu niet, met de reden
 *   nieuw      een eigen wachtwoord kiezen
 *   afronden   de code is gegeven: de eerste aanmelding of de nieuwe koppeling afronden
 *   app        de code geven, of eerst de app koppelen
 */
export function stapVoor(stand, n) {
  if (!stand || stand.bekend !== true || !stand.account) return "geen_toegang";
  const a = stand.account;
  if (a.actief !== true) return "uitgeschakeld";
  if (a.bezig === true) return "bezig";
  if (a.wachtwoord_tijdelijk === true) return a.tijdelijk_verlopen === true ? "verlopen" : "nieuw";
  const metCode = n.aal === "aal2" && n.methodes.includes("totp");
  if (metCode && (a.app_koppelen === true || a.eerste_aanmelding_afgerond !== true)) return "afronden";
  return "app";
}

/** De stappen die deze aanmelding telt, voor "Stap 2 van 4". */
export function reeksVoor(stand, gekoppeld) {
  const tijdelijk = Boolean(stand && stand.account && stand.account.wachtwoord_tijdelijk === true);
  return ["login", ...(tijdelijk ? ["nieuw"] : []), ...(gekoppeld ? [] : ["koppel"]), "code"];
}

const NAMEN = {
  login: "e-mailadres en wachtwoord",
  nieuw: "eigen wachtwoord kiezen",
  koppel: "app koppelen, eenmalig",
  code: "code uit de app",
};

const KAN_NIET = {
  geen_toegang: ["Geen toegang tot de MT", "Dit account heeft geen toegang tot de MT. Vraag het na bij de beheerder of het secretariaat."],
  uitgeschakeld: ["Dit account is uitgeschakeld", "Vraag het na bij de beheerder of het secretariaat."],
  verlopen: ["Je tijdelijke wachtwoord is verlopen", "Vraag een nieuw tijdelijk wachtwoord aan de beheerder of het secretariaat."],
  bezig: ["Er loopt een wijziging aan je account", "De beheerder of het secretariaat wijzigt je account, of rondde dat nog niet af. Probeer het over enkele minuten opnieuw, of vraag het na."],
};

// ---------- Het scherm ----------

/**
 * Start het aanmelden in de kaart. De belofte komt uit met het eigen account (mt_mijn_account) zodra
 * de databank de aanmelding aanvaardt. afmelden(bericht) meldt af en herlaadt de pagina: zo blijft er
 * niets van een vorige aanmelding in het geheugen (app.js).
 */
export function start({ kaart, appNaam, bericht = null, afmelden }) {
  /** Wat het scherm onthoudt, enkel in het geheugen van dit tabblad. Een wachtwoord blijft er zo kort mogelijk. */
  const z = { email: null, tijdelijk: null, reeks: null, stand: null, koppeling: null, gekoppeld: [], codesZonderToegang: 0, melding: null };
  let klaar;
  const belofte = new Promise((uit) => (klaar = uit));

  const q = (kiezer) => kaart.querySelector(kiezer);

  /** De kop met "Stap 2 van 4" en de balk. Op het eerste scherm is het aantal stappen nog niet gekend. */
  function kop(stap) {
    const reeks = z.reeks;
    const nr = reeks ? Math.max(1, reeks.indexOf(stap) + 1) : 1;
    const totaal = reeks ? reeks.length : 0;
    return html`
      <div>
        <div class="mt-stap"><span>${totaal ? "Stap " + nr + " van " + totaal : "Stap 1"}</span><span>${NAMEN[stap]}</span></div>
        <div class="mt-stapbalk" aria-hidden="true"><span data-deel="${totaal ? nr / totaal : 0.2}"></span></div>
      </div>`;
  }

  /** Schrijft een stap weg, en zet de balk en de focus. */
  function teken(opmaak, focus) {
    zet(kaart, opmaak);
    const balk = q(".mt-stapbalk span");
    if (balk) balk.style.width = Math.round(Number(balk.dataset.deel) * 100) + "%";
    const doel = focus ? q(focus) : q("h2");
    if (doel) doel.focus();
  }

  function fout(tekst) {
    const vak = q(".mt-fout");
    if (!vak) return;
    vak.textContent = tekst || "";
    vak.hidden = !tekst;
  }

  /** De knop van de stap: tijdens een oproep kan je niet nog eens klikken. */
  function bezig(aan, tekst) {
    const knop = q("button[type=submit]");
    if (!knop) return;
    if (aan) knop.dataset.tekst = knop.textContent;
    knop.disabled = aan;
    knop.classList.toggle("busy", aan);
    knop.textContent = aan ? tekst : knop.dataset.tekst || knop.textContent;
  }

  function wachten(tekst) {
    teken(html`<h2 tabindex="-1">Even geduld</h2><p class="sub" role="status">${tekst}</p>`);
  }

  // ---------- Stap 1: e-mailadres en wachtwoord ----------

  function toonLogin(melding) {
    z.melding = null;
    z.reeks = null;
    z.koppeling = null;
    z.tijdelijk = null;
    teken(html`
      ${kop("login")}
      <form novalidate>
        <div><h2 tabindex="-1">Aanmelden</h2><p class="sub">Met je e-mailadres van de school.</p></div>
        <p class="finfo mt-bericht" ${melding ? "" : "hidden"}>${melding || ""}</p>
        <div class="field">
          <label for="amMail">E-mailadres</label>
          <input id="amMail" class="ctrl" type="email" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="${MAILVOORBEELD}">
        </div>
        <div class="field">
          <label for="amWw">Wachtwoord</label>
          <input id="amWw" class="ctrl" type="password" name="password" autocomplete="current-password">
          <span class="hint">Eerste keer? Gebruik het tijdelijke wachtwoord dat je van de beheerder of het secretariaat kreeg.</span>
        </div>
        <div>
          <label class="check-row" for="amBlijven"><input id="amBlijven" type="checkbox"> Aangemeld blijven op dit toestel</label>
          <span class="hint mt-inspring">Niet aanvinken op een gedeelde klascomputer: daar meldt de MT je vanzelf af als je een tijd niets doet. Op een eigen toestel vraagt de MT geregeld opnieuw de code uit je app.</span>
        </div>
        <p class="ferr mt-fout" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Volgende</button>
        <p class="voet">Wachtwoord vergeten? De beheerder of het secretariaat geeft je een nieuw tijdelijk wachtwoord.</p>
      </form>`, "#amMail");
    if (z.email) {
      q("#amMail").value = z.email;
      q("#amWw").focus();
    }
    q("form").addEventListener("submit", async (gebeurtenis) => {
      gebeurtenis.preventDefault();
      const email = q("#amMail").value.trim().toLowerCase();
      const wachtwoord = q("#amWw").value;
      if (!email || !wachtwoord) return fout("Vul je e-mailadres en je wachtwoord in.");
      fout(null);
      bezig(true, "Aanmelden…");
      const r = await auth.aanmelden(email, wachtwoord, q("#amBlijven").checked);
      if (!r.ok) {
        bezig(false);
        q("#amWw").value = "";
        q("#amWw").focus();
        return fout(r.tekst);
      }
      z.email = email;
      z.tijdelijk = wachtwoord;
      z.codesZonderToegang = 0;
      await bepaal();
    });
  }

  // ---------- Stap 2: een eigen wachtwoord kiezen ----------

  function toonNieuw() {
    const minimum = (z.stand.instellingen && z.stand.instellingen.wachtwoord_min_lengte) || 12;
    teken(html`
      ${kop("nieuw")}
      <form novalidate>
        <div><h2 tabindex="-1">Kies je eigen wachtwoord</h2>
          <p class="sub">Je meldde aan met een tijdelijk wachtwoord. Kies nu een eigen wachtwoord. Niemand anders kent het, ook de beheerder niet.</p></div>
        <input class="sr-only" type="text" name="username" autocomplete="username" tabindex="-1" aria-hidden="true" value="${z.email || ""}" readonly>
        <div class="field">
          <label for="amNieuw1">Nieuw wachtwoord</label>
          <input id="amNieuw1" class="ctrl" type="password" name="new-password" autocomplete="new-password" placeholder="${"Minstens " + minimum + " tekens"}">
          <span class="hint">Een zin van enkele woorden is makkelijk te onthouden en moeilijk te raden.</span>
        </div>
        <div class="field">
          <label for="amNieuw2">Herhaal het nieuwe wachtwoord</label>
          <input id="amNieuw2" class="ctrl" type="password" name="new-password-2" autocomplete="new-password" placeholder="Nog eens hetzelfde">
        </div>
        <p class="ferr mt-fout" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Wachtwoord bewaren</button>
        <p class="voet">Zolang je dit niet gedaan hebt, toont de MT niets.</p>
      </form>
      ${terugKnop("Terug")}`, "#amNieuw1");
    koppelTerug(opnieuwBeginnen);
    q("form").addEventListener("submit", async (gebeurtenis) => {
      gebeurtenis.preventDefault();
      const nieuw = q("#amNieuw1").value;
      if ([...nieuw].length < minimum) return fout("Kies een wachtwoord van minstens " + minimum + " tekens.");
      if (nieuw !== q("#amNieuw2").value) return fout("De twee wachtwoorden zijn niet gelijk.");
      if (z.tijdelijk !== null && nieuw === z.tijdelijk) return fout("Kies een ander wachtwoord dan je tijdelijke wachtwoord.");
      fout(null);
      bezig(true, "Bewaren…");
      const blijven = auth.blijft();
      const r = await data.serverfunctie("wachtwoord_kiezen", { operatie: crypto.randomUUID(), wachtwoord: nieuw });
      if (!r.ok) {
        if (r.soort === "sessie") return opnieuwBeginnen(r.tekst);
        bezig(false);
        return fout(r.tekst);
      }
      // Supabase beëindigde alle sessies van dit account: meteen opnieuw aanmelden, met het nieuwe wachtwoord.
      z.tijdelijk = null;
      const opnieuw = await auth.aanmelden(z.email, nieuw, blijven);
      if (!opnieuw.ok) return toonLogin("Je wachtwoord is gewijzigd. Meld aan met je nieuwe wachtwoord.");
      await bepaal();
    });
  }

  // ---------- Stap 3: de app koppelen ----------

  async function toonKoppel() {
    if (!z.koppeling) {
      wachten("De code voor je app wordt gemaakt.");
      const r = await auth.koppel();
      if (!r.ok) return toonKanNiet("Koppelen lukte niet", r.tekst, true);
      z.koppeling = { id: r.id, qr: r.qr, sleutel: r.sleutel };
    }
    teken(html`
      ${kop("koppel")}
      <div><h2 tabindex="-1">Koppel je authenticator-app</h2>
        <p class="sub">Dit doe je maar één keer. Open Google Authenticator, Microsoft Authenticator of een andere authenticator-app op je gsm, en scan deze code.</p></div>
      <div class="mt-qr"><img alt="QR-code om te scannen met je authenticator-app" width="180" height="180"></div>
      <p class="hint">Lukt scannen niet? Typ deze sleutel in de app:</p>
      <p class="mt-sleutel">${auth.inGroepjes(z.koppeling.sleutel)}</p>
      <form novalidate><button class="btn btn-primary" type="submit">Ik heb de code gescand</button></form>
      ${terugKnop("Terug")}`);
    // De QR-code komt van Supabase als een beeld; het staat enkel in dit <img>, nooit als opmaak in de pagina.
    q(".mt-qr img").src = z.koppeling.qr;
    koppelTerug(opnieuwBeginnen);
    q("form").addEventListener("submit", (gebeurtenis) => {
      gebeurtenis.preventDefault();
      toonCode();
    });
  }

  // ---------- Stap 4, of stap 2: de code uit de app ----------

  function toonCode() {
    const eerste = Boolean(z.koppeling);
    teken(html`
      ${kop("code")}
      <form novalidate>
        <div><h2 tabindex="-1">Code uit je app</h2>
          <p class="sub">Typ de 6 cijfers die je app nu toont bij "${appNaam}". De code verandert elke 30 seconden.</p></div>
        <div class="mt-code" role="group" aria-label="Code van 6 cijfers">
          ${[1, 2, 3, 4, 5, 6].map((i) => html`<input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="${i === 1 ? "one-time-code" : "off"}" aria-label="${"Cijfer " + i + " van 6"}">`)}
        </div>
        <p class="ferr mt-fout" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Aanmelden</button>
        <p class="voet">Toestel kwijt of nieuw? De beheerder of het secretariaat stelt je koppeling opnieuw in.</p>
      </form>
      ${terugKnop("Terug")}`, ".mt-code input");
    koppelTerug(eerste ? toonKoppel : opnieuwBeginnen);
    const vakken = [...kaart.querySelectorAll(".mt-code input")];
    const lees = () => vakken.map((vak) => vak.value).join("");
    const verdeel = (cijfers, vanaf) => {
      for (let k = 0; k < cijfers.length && vanaf + k < 6; k++) vakken[vanaf + k].value = cijfers[k];
      vakken[Math.min(vanaf + cijfers.length, 5)].focus();
    };
    let onderweg = false;
    const verstuur = async () => {
      if (onderweg) return;
      const code = auth.zesCijfers(lees());
      if (!code) return fout("Typ de 6 cijfers uit je app.");
      onderweg = true;
      fout(null);
      bezig(true, "Nakijken…");
      const r = await auth.geefCode(eerste ? z.koppeling.id : z.gekoppeld[0], code);
      if (!r.ok) {
        onderweg = false;
        bezig(false);
        for (const vak of vakken) vak.value = "";
        vakken[0].focus();
        return fout(r.tekst);
      }
      z.koppeling = null;
      z.codesZonderToegang++;
      await bepaal();
    };
    vakken.forEach((vak, i) => {
      vak.addEventListener("input", () => {
        const cijfers = vak.value.replace(/\D/g, "");
        vak.value = cijfers.slice(0, 1);
        if (cijfers.length > 1) verdeel(cijfers, i);
        else if (cijfers && i < 5) vakken[i + 1].focus();
        if (lees().length === 6) verstuur();
      });
      vak.addEventListener("keydown", (gebeurtenis) => {
        if (gebeurtenis.key === "Backspace" && !vak.value && i > 0) {
          gebeurtenis.preventDefault();
          vakken[i - 1].value = "";
          vakken[i - 1].focus();
        } else if (gebeurtenis.key === "ArrowLeft" && i > 0) vakken[i - 1].focus();
        else if (gebeurtenis.key === "ArrowRight" && i < 5) vakken[i + 1].focus();
      });
      vak.addEventListener("paste", (gebeurtenis) => {
        const tekst = gebeurtenis.clipboardData ? gebeurtenis.clipboardData.getData("text").replace(/\D/g, "") : "";
        if (!tekst) return;
        gebeurtenis.preventDefault();
        verdeel(tekst, tekst.length >= 6 ? 0 : i);
        if (lees().length === 6) verstuur();
      });
      vak.addEventListener("focus", () => vak.select());
    });
    q("form").addEventListener("submit", (gebeurtenis) => {
      gebeurtenis.preventDefault();
      verstuur();
    });
  }

  // ---------- Als aanmelden nu niet kan ----------

  function terugKnop(tekst) {
    return html`<button class="btn-link mt-terug" type="button">${tekst}</button>`;
  }

  function koppelTerug(actie) {
    const knop = q(".mt-terug");
    if (knop) knop.addEventListener("click", () => actie());
  }

  /** Afmelden en terug naar stap 1: de pagina herlaadt, met het bericht erbij. */
  async function opnieuwBeginnen(melding) {
    wachten("Je wordt afgemeld.");
    await afmelden(typeof melding === "string" ? melding : null);
  }

  function toonKanNiet(titel, tekst, metOpnieuw) {
    teken(html`
      <div><h2 tabindex="-1">${titel}</h2><p class="sub">${tekst}</p></div>
      ${metOpnieuw ? html`<button class="btn btn-primary mt-opnieuw" type="button">Opnieuw proberen</button>` : null}
      ${terugKnop("Terug naar aanmelden")}`);
    koppelTerug(opnieuwBeginnen);
    const knop = q(".mt-opnieuw");
    if (knop) knop.addEventListener("click", () => bepaal());
  }

  // ---------- Waar staat deze aanmelding ----------

  async function bepaal() {
    wachten("De MT kijkt je aanmelding na.");
    const n = await auth.niveau();
    if (!n.aangemeld) return toonLogin(z.melding);
    z.email = z.email || n.email;
    // Enkel een sessie die met het wachtwoord begon, telt (B5): de databank weigert elke andere.
    if (!n.methodes.includes("password")) return opnieuwBeginnen("Meld aan met je e-mailadres en je wachtwoord.");

    if (n.aal === "aal2") {
      const account = await data.rpc("mt_mijn_account");
      if (account.ok) return klaar({ account: account.gegevens, niveau: n, nietBlijven: z.nietBlijven === true });
      if (account.soort === "verbinding") return toonKanNiet("Geen verbinding", account.tekst, true);
      if (account.soort === "ontbreekt") return toonKanNiet("De databank is nog niet bijgewerkt", "Voer sql/004_accounts.sql uit in Supabase, en probeer het dan opnieuw.", true);
    }

    const s = await data.serverfunctie("stand");
    if (!s.ok) {
      if (s.soort === "sessie") return opnieuwBeginnen(s.tekst);
      if (s.soort === "ontbreekt") {
        return toonKanNiet("De serverfunctie ontbreekt", "De serverfunctie " + ACCOUNTFUNCTIE + " staat nog niet in Supabase, of onder een andere naam. Zonder haar kan niemand aanmelden.", true);
      }
      return toonKanNiet("Aanmelden lukt nu niet", s.tekst, true);
    }
    if (s.gegevens.versie !== ACCOUNTFUNCTIE_VERSIE) {
      return toonKanNiet("De serverfunctie is niet bijgewerkt", "In Supabase staat versie " + (s.gegevens.versie || "onbekend") + " van de serverfunctie " + ACCOUNTFUNCTIE
        + "; deze versie van de MT verwacht " + ACCOUNTFUNCTIE_VERSIE + ". Plak functies/" + ACCOUNTFUNCTIE + "/index.ts opnieuw in Supabase, bij Edge Functions.", true);
    }
    z.stand = s.gegevens;
    // "Aangemeld blijven" mag niet voor elke rol (B148): dan blijft de sessie in dit tabblad.
    if (auth.blijft() && s.gegevens.instellingen && s.gegevens.instellingen.aangemeld_blijven === false) {
      auth.naarTab();
      z.nietBlijven = true;
    }

    const stap = stapVoor(s.gegevens, n);
    if (Object.prototype.hasOwnProperty.call(KAN_NIET, stap)) return toonKanNiet(KAN_NIET[stap][0], KAN_NIET[stap][1], stap === "bezig");
    if (stap === "afronden") {
      const r = await data.serverfunctie("afronden");
      if (!r.ok) return r.soort === "sessie" ? opnieuwBeginnen(r.tekst) : toonKanNiet("Afronden lukte niet", r.tekst, true);
      z.codesZonderToegang = 0;
      return bepaal();
    }

    const k = await auth.koppelingen();
    if (!k.ok) return toonKanNiet("Aanmelden lukt nu niet", k.tekst, true);
    z.gekoppeld = k.gekoppeld;
    if (!z.reeks) z.reeks = reeksVoor(s.gegevens, k.gekoppeld.length > 0);
    if (stap === "nieuw") return toonNieuw();
    // De code is al gegeven en alles lijkt in orde, maar de databank weigert: niet blijven herhalen.
    if (z.codesZonderToegang >= 2) {
      z.codesZonderToegang = 0;
      return toonKanNiet("De databank weigert de toegang", "Je code klopte, maar de databank laat je niet binnen. Meld opnieuw aan. Blijft dit zo, vraag het dan na bij de beheerder.", false);
    }
    return k.gekoppeld.length > 0 ? toonCode() : toonKoppel();
  }

  z.melding = bericht;
  bepaal();
  return belofte;
}
