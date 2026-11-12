// MT · gebruikers.js · versie 0.5.1
// Het scherm Gebruikers (3, 15, B165, B170; canvas: bord "Gebruikers"): iedereen die kan aanmelden,
// met de rol, de klassen per schooljaar en de stand van het account. Enkel voor een beheerder.
//
// Het scherm beslist niets over rechten: de databank en de serverfunctie doen dat (17.3, 17.4).
//   - lezen: de tabellen zelf, via data.lees();
//   - naam, rol en klassen: de databankfuncties mt_gebruiker_wijzigen en mt_klassen_toewijzen;
//   - alles wat een wachtwoord, een app-koppeling of het e-mailadres raakt: de serverfunctie.
// Een tijdelijk wachtwoord komt één keer terug van de serverfunctie: dit scherm toont het één keer en
// bewaart het nergens.
//
// Bovenaan staat wat zonder browser te testen valt; daaronder het scherm zelf.

import * as data from "./data.js";
import { ACCOUNTFUNCTIE, ACCOUNTFUNCTIE_VERSIE, SCHOOLDOMEIN } from "./config.js";
import { datumEnUur, html, knopBezig, meld, venster, vraag, zet } from "./ui.js";

export const VERSIE = "0.5.1";

// ---------- Zonder browser te testen ----------

const ROLLEN = ["beheerder", "leerkracht", "lezer"];
const ROLNAAM = { beheerder: "Beheerder", leerkracht: "Leerkracht", lezer: "Lezer" };
const ROLKLEUR = { beheerder: "vol", leerkracht: "info", lezer: "muted" };
const ROLUITLEG = {
  leerkracht: "Vult de aanwezigheden in voor de eigen klassen, en leest wat die klassen aangaat.",
  lezer: "Leest alles en wijzigt niets, bv. de directie of de boekhouding.",
  beheerder: "Doet alles, ook de accounts en de instellingen.",
};
const HANDELING = {
  aanmaken: "het account aanmaken",
  tijdelijk_wachtwoord: "een nieuw tijdelijk wachtwoord",
  uitschakelen: "uitschakelen",
  inschakelen: "weer inschakelen",
  email_wijzigen: "een ander e-mailadres",
  wachtwoord_kiezen: "een eigen wachtwoord kiezen",
};
const MAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Voor het zoeken: kleine letters, zonder accenten. */
export function norm(tekst) {
  return String(tekst ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/** "nog 31 uur", of in minuten binnen het laatste uur. */
export function resterend(tot, nu) {
  const minuten = Math.floor((tot - nu) / 60000);
  if (minuten < 1) return "nog minder dan een minuut";
  if (minuten < 60) return "nog " + minuten + (minuten === 1 ? " minuut" : " minuten");
  return "nog " + Math.floor(minuten / 60) + " uur";
}

/**
 * De stand van een account, voor het label in de lijst: { soort, tekst, kleur, aandacht }.
 * "aandacht": de gebruiker kan nu niet gewoon aanmelden, en er is iets te doen.
 */
export function toestandVan(g, nu) {
  if (g.open_operatie) return { soort: "hangt", tekst: "Wijziging niet afgerond", kleur: "warn", aandacht: true };
  if (!g.actief) return { soort: "uit", tekst: "Uitgeschakeld", kleur: "muted", aandacht: false };
  if (g.wachtwoord_tijdelijk) {
    const tot = g.tijdelijk_tot ? Date.parse(g.tijdelijk_tot) : 0;
    if (!(tot > nu)) return { soort: "verlopen", tekst: "Tijdelijk wachtwoord verlopen", kleur: "warn", aandacht: true };
    return { soort: "tijdelijk", tekst: "Tijdelijk wachtwoord, " + resterend(tot, nu), kleur: "open", aandacht: true };
  }
  if (g.app_koppelen || !g.eerste_aanmelding_afgerond) {
    return { soort: "app", tekst: g.eerste_aanmelding_afgerond ? "App opnieuw te koppelen" : "App nog te koppelen", kleur: "open", aandacht: true };
  }
  return { soort: "actief", tekst: "Actief", kleur: "done", aandacht: false };
}

const opVolgorde = (a, b) => a.volgorde - b.volgorde || a.naam.localeCompare(b.naam, "nl");

/** De klassen van een gebruiker in een schooljaar, in de volgorde van de klassenlijst. */
export function klassenVan(gebruiker, schooljaar, toewijzingen, klasPerId) {
  return toewijzingen
    .filter((t) => t.gebruiker_id === gebruiker && t.schooljaar === schooljaar)
    .map((t) => klasPerId.get(t.klas_id))
    .filter(Boolean)
    .sort(opVolgorde);
}

/** Het recentste eerdere schooljaar waarin de gebruiker klassen had: { schooljaar, klassen }, of niets. */
export function vorigeKlassen(gebruiker, schooljaar, toewijzingen, klasPerId) {
  const jaren = [...new Set(toewijzingen.filter((t) => t.gebruiker_id === gebruiker && t.schooljaar < schooljaar).map((t) => t.schooljaar))].sort();
  if (!jaren.length) return null;
  const jaar = jaren[jaren.length - 1];
  const klassen = klassenVan(gebruiker, jaar, toewijzingen, klasPerId);
  return klassen.length ? { schooljaar: jaar, klassen } : null;
}

/**
 * "Overnemen" (B170): dezelfde klassen in een ander schooljaar, herkend aan het klas-id van de
 * uitstappentool. Geeft { ids, namen, ontbreekt }: ontbreekt zijn de klassen die er niet meer zijn.
 */
export function overnemen(vorige, klassenNu) {
  const perBron = new Map(klassenNu.filter((k) => k.actief !== false).map((k) => [k.bron_id, k]));
  const uit = { ids: [], namen: [], ontbreekt: [] };
  for (const k of vorige) {
    const nu = perBron.get(k.bron_id);
    if (nu) {
      uit.ids.push(nu.id);
      uit.namen.push(nu.naam);
    } else uit.ontbreekt.push(k.naam);
  }
  return uit;
}

/** De rijen van de lijst: per gebruiker de stand, de klassen in het gekozen schooljaar en wat nog te koppelen is. */
export function maakRijen({ gebruikers, toewijzingen, klassen, jaar, ik, nu }) {
  const klasPerId = new Map(klassen.map((k) => [k.id, k]));
  return gebruikers.map((g) => {
    const eigenKlassen = jaar && g.rol === "leerkracht" ? klassenVan(g.id, jaar, toewijzingen, klasPerId) : [];
    const teKoppelen = Boolean(jaar) && g.rol === "leerkracht" && g.actief && eigenKlassen.length === 0;
    return {
      g,
      eigen: g.id === ik,
      toestand: toestandVan(g, nu),
      klassen: eigenKlassen,
      teKoppelen,
      vorig: teKoppelen ? vorigeKlassen(g.id, jaar, toewijzingen, klasPerId) : null,
    };
  });
}

/** De rijen die aan het zoekveld en de filters voldoen. */
export function kiesRijen(rijen, { zoek = "", rol = "alle", toestand = "alle" }) {
  const z = norm(zoek);
  return rijen.filter((r) =>
    (rol === "alle" || r.g.rol === rol)
    && (toestand === "alle" || (toestand === "koppelen" && r.teKoppelen) || (toestand === "aandacht" && r.toestand.aandacht))
    && (!z || norm(r.g.naam + " " + r.g.email).includes(z)));
}

/**
 * Kijkt de naam, het e-mailadres en de rol na, zoals de databank het doet, met een fout per veld.
 * vreemd: een geldig adres dat niet van de school is. Dat mag, maar het scherm vraagt het eerst na.
 */
export function keur({ naam, email, rol }) {
  const uit = { naam: String(naam ?? "").trim().replace(/\s+/g, " "), email: String(email ?? "").trim().toLowerCase(), rol, fouten: {} };
  if (!uit.naam) uit.fouten.naam = "Vul een naam in.";
  else if (uit.naam.length > 80) uit.fouten.naam = "De naam telt hoogstens 80 tekens.";
  if (!uit.email) uit.fouten.email = "Vul een e-mailadres in.";
  else if (!MAIL.test(uit.email) || uit.email.length > 254) uit.fouten.email = "Dit is geen geldig e-mailadres.";
  if (!ROLLEN.includes(rol)) uit.fouten.rol = "Kies een rol.";
  uit.vreemd = !uit.fouten.email && !uit.email.endsWith("@" + SCHOOLDOMEIN);
  uit.ok = Object.keys(uit.fouten).length === 0;
  return uit;
}

/** De klassen van een schooljaar in groepen, voor de keuze: kleuters, per leerjaar, en de rest. */
export function klasGroepen(klassen, jaar, gekozen) {
  const lijst = klassen.filter((k) => k.schooljaar === jaar && (k.actief !== false || gekozen.has(k.id))).sort(opVolgorde);
  const groepen = new Map();
  for (const k of lijst) {
    const titel = k.groep === "Kleuter" ? "Kleuters" : k.groep === "Andere" ? "Andere" : k.leerjaar ? k.leerjaar + "e leerjaar" : "Lager";
    if (!groepen.has(titel)) groepen.set(titel, []);
    groepen.get(titel).push(k);
  }
  const volgorde = (titel) => (titel === "Kleuters" ? 0 : titel === "Andere" ? 9 : titel === "Lager" ? 8 : Number(titel[0]));
  return [...groepen.entries()].sort((a, b) => volgorde(a[0]) - volgorde(b[0]));
}

const gelijk = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// ---------- Het scherm ----------

/**
 * Start het scherm in een onderdeel van de pagina.
 *   deel      het element van het scherm
 *   ik        het id van wie aangemeld is: het eigen account wijzig je hier niet (17.4)
 *   terug     terug naar waar je vandaan kwam
 *   herstart  de aanmelding is niet meer in orde: de pagina herlaadt en vraagt wat nodig is
 */
export function start({ deel, ik, terug, herstart }) {
  const s = {
    laden: true, fout: null, gebruikers: [], schooljaren: [], klassen: [], toewijzingen: [], operaties: new Map(),
    rijen: [], jaren: [], jaar: null, zoek: "", rol: "alle", toestand: "alle", uren: 48,
  };
  let formNr = 0;
  const q = (kiezer) => deel.querySelector(kiezer);

  zet(deel, html`
    <button class="btn-link" type="button" data-doe="terug">← Terug</button>
    <div class="page-head big mt-gbkop">
      <div>
        <h2 tabindex="-1">Gebruikers</h2>
        <p>Iedereen die kan aanmelden, met de klassen per schooljaar. Enkel wie hier staat, kan aanmelden: met het e-mailadres van de school en een code uit een authenticator-app.</p>
      </div>
      <div class="ph-actions"><button class="btn btn-primary" type="button" data-doe="toevoegen">Gebruiker toevoegen</button></div>
    </div>
    <p class="fwarn mt-melding" data-vak="waarschuwing" hidden></p>
    <div class="card mt-filter">
      <label class="sr-only" for="gbZoek">Zoeken op naam of e-mailadres</label>
      <input id="gbZoek" class="ctrl" type="search" placeholder="Zoeken op naam of e-mailadres" autocomplete="off">
      <span class="mt-filters" data-vak="filters"></span>
    </div>
    <div class="card mt-lijst" data-vak="lijst"></div>`);

  deel.addEventListener("click", (gebeurtenis) => {
    const knop = gebeurtenis.target.closest("[data-doe]");
    if (!knop || !deel.contains(knop)) return;
    const doe = knop.dataset.doe;
    if (doe === "terug") terug();
    else if (doe === "opnieuw") laad();
    else if (doe === "toevoegen") openToevoegen();
    else if (doe === "wijzig") openWijzigen(knop.dataset.id);
    else if (doe === "neem") neemOver(knop.dataset.id, knop);
    else if (doe === "rol" || doe === "toestand" || doe === "jaar") {
      s[doe] = knop.dataset.waarde;
      if (doe === "jaar") herreken();
      tekenFilters();
      tekenLijst();
    }
  });
  q("#gbZoek").addEventListener("input", (gebeurtenis) => {
    s.zoek = gebeurtenis.target.value;
    tekenLijst();
  });

  // ---------- Lezen ----------

  /** De aanmelding is niet meer in orde, bv. een code van meer dan twee weken: opnieuw via het aanmeldscherm. */
  async function nogBinnen(antwoord) {
    if (antwoord.soort === "sessie") {
      herstart();
      return false;
    }
    if (antwoord.soort === "rechten" && !(await data.rpc("mt_mijn_account")).ok) {
      herstart();
      return false;
    }
    return true;
  }

  function herreken() {
    s.rijen = maakRijen({ gebruikers: s.gebruikers, toewijzingen: s.toewijzingen, klassen: s.klassen, jaar: s.jaar, ik, nu: Date.now() });
  }

  async function laad() {
    s.laden = true;
    s.fout = null;
    tekenLijst();
    const [g, sj, k, t, stand] = await Promise.all([
      data.lees("gebruikers", {
        kolommen: ["id", "naam", "email", "rol", "actief", "wachtwoord_tijdelijk", "tijdelijk_tot", "eerste_aanmelding_afgerond", "app_koppelen", "open_operatie"],
        volgorde: ["naam", "id"],
      }),
      data.lees("schooljaren", { kolommen: ["schooljaar", "stand"], volgorde: ["schooljaar"] }),
      data.lees("klassen", { kolommen: ["id", "schooljaar", "bron_id", "naam", "groep", "leerjaar", "actief", "volgorde"], volgorde: ["schooljaar", "volgorde", "naam", "id"] }),
      data.lees("klastoewijzingen", { kolommen: ["gebruiker_id", "klas_id", "schooljaar"], volgorde: ["gebruiker_id", "klas_id"] }),
      data.serverfunctie("stand"),
    ]);
    const mis = [g, sj, k, t].find((antwoord) => !antwoord.ok);
    if (mis) {
      if (!(await nogBinnen(mis))) return;
      s.laden = false;
      s.fout = mis.tekst;
      tekenLijst();
      return;
    }
    s.gebruikers = g.gegevens;
    s.klassen = k.gegevens;
    s.toewijzingen = t.gegevens;
    // De schooljaren waarin klassen te koppelen zijn: het lopende, en een vorig dat nog open staat.
    s.jaren = sj.gegevens.filter((j) => j.stand === "lopend" || j.stand === "voorbij").sort((a, b) => (a.schooljaar < b.schooljaar ? 1 : -1));
    if (!s.jaren.some((j) => j.schooljaar === s.jaar)) {
      const lopend = s.jaren.find((j) => j.stand === "lopend") || s.jaren[0];
      s.jaar = lopend ? lopend.schooljaar : null;
    }
    const open = s.gebruikers.map((x) => x.open_operatie).filter(Boolean);
    s.operaties = new Map();
    if (open.length) {
      const o = await data.lees("account_operaties", { kolommen: ["id", "soort", "begonnen_op", "afgerond_op", "resultaat"], waar: { id: open }, volgorde: ["id"] });
      if (o.ok) s.operaties = new Map(o.gegevens.map((x) => [x.id, x]));
    }
    const waarschuwing = q('[data-vak="waarschuwing"]');
    let tekst = "";
    if (!stand.ok) tekst = "De serverfunctie " + ACCOUNTFUNCTIE + " antwoordt niet: een account toevoegen of wijzigen lukt nu niet. " + stand.tekst;
    else if (stand.gegevens.versie !== ACCOUNTFUNCTIE_VERSIE) {
      tekst = "In Supabase staat versie " + (stand.gegevens.versie || "onbekend") + " van de serverfunctie " + ACCOUNTFUNCTIE + "; deze versie van de MT verwacht "
        + ACCOUNTFUNCTIE_VERSIE + ". Plak functies/" + ACCOUNTFUNCTIE + "/index.ts opnieuw in Supabase, bij Edge Functions.";
    } else if (stand.gegevens.instellingen && stand.gegevens.instellingen.tijdelijk_wachtwoord_uren > 0) s.uren = stand.gegevens.instellingen.tijdelijk_wachtwoord_uren;
    waarschuwing.textContent = tekst;
    waarschuwing.hidden = !tekst;
    s.laden = false;
    herreken();
    tekenFilters();
    tekenLijst();
  }

  // ---------- De filters en de lijst ----------

  function tekenFilters() {
    const tel = (voldoet) => s.rijen.filter(voldoet).length;
    const groep = (naam, label, opties) => html`
      <span class="seg sm" role="group" aria-label="${label}">${opties.map(([waarde, tekst, aantal]) => html`<button type="button" class="${s[naam] === waarde ? "on" : ""}" aria-pressed="${s[naam] === waarde}" data-doe="${naam}" data-waarde="${waarde}">${tekst}${aantal === null ? null : html`<span class="c">${aantal}</span>`}</button>`)}</span>`;
    zet(q('[data-vak="filters"]'), html`
      ${groep("rol", "Rol", [["alle", "Iedereen", s.rijen.length], ["beheerder", "Beheerders", tel((r) => r.g.rol === "beheerder")], ["leerkracht", "Leerkrachten", tel((r) => r.g.rol === "leerkracht")], ["lezer", "Lezers", tel((r) => r.g.rol === "lezer")]])}
      ${groep("toestand", "Toestand", [["alle", "Alle", null], ["koppelen", "Nog te koppelen", tel((r) => r.teKoppelen)], ["aandacht", "Account vraagt aandacht", tel((r) => r.toestand.aandacht)]])}
      ${s.jaren.length > 1 ? groep("jaar", "Schooljaar", s.jaren.map((j) => [j.schooljaar, j.schooljaar + (j.stand === "voorbij" ? " · nog open" : ""), null])) : null}`);
  }

  function klassenCel(r) {
    if (r.g.rol !== "leerkracht") return html`<span class="klas-tags"><span class="klas-tag grijs">${r.g.rol === "lezer" ? "alles lezen" : "alles"}</span></span>`;
    if (!s.jaar) return html`<span class="klas-tags"><span class="klas-tag grijs">nog geen schooljaar</span></span>`;
    if (r.klassen.length) return html`<span class="klas-tags">${r.klassen.map((k) => html`<span class="klas-tag">${k.naam}</span>`)}</span>`;
    if (!r.teKoppelen) return html`<span class="klas-tags"><span class="klas-tag grijs">geen</span></span>`;
    return html`
      <span class="klas-tags"><span class="klas-tag open">nog te koppelen</span></span>
      ${r.vorig ? html`<span class="mt-vorig">${r.vorig.schooljaar + ": " + r.vorig.klassen.map((k) => k.naam).join(" ")} · <button class="btn-link" type="button" data-doe="neem" data-id="${r.g.id}">overnemen</button></span>` : null}`;
  }

  /** De knop van een rij, ook nadat de lijst opnieuw getekend is. */
  const knopVan = (doe, id) => q('[data-doe="' + doe + '"]' + (id ? '[data-id="' + id + '"]' : ""));

  function tekenLijst() {
    const vak = q('[data-vak="lijst"]');
    // Wie met het toetsenbord werkt, blijft op dezelfde knop staan als de lijst opnieuw getekend wordt.
    const actief = document.activeElement && vak.contains(document.activeElement) ? document.activeElement.dataset : null;
    const houFocus = actief && actief.doe ? [actief.doe, actief.id] : null;
    tekenLijstInhoud(vak);
    const zelfde = houFocus ? knopVan(houFocus[0], houFocus[1]) : null;
    if (zelfde) zelfde.focus();
  }

  function tekenLijstInhoud(vak) {
    if (s.laden) {
      zet(vak, html`<div class="mt-laadt" role="status" aria-label="De gebruikers worden geladen"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`);
      return;
    }
    if (s.fout) {
      zet(vak, html`<div class="form-alert mt-lijstfout" role="alert"><span><b>De gebruikers zijn niet geladen.</b> ${s.fout}</span><button class="btn btn-ghost btn-sm" type="button" data-doe="opnieuw">Opnieuw proberen</button></div>`);
      return;
    }
    const rijen = kiesRijen(s.rijen, s);
    const teKoppelen = s.rijen.filter((r) => r.teKoppelen).length;
    const koppelTekst = !s.jaar ? "Er is nog geen schooljaar met klassen: de klassen koppel je zodra het schooljaar gestart is."
      : teKoppelen === 0 ? "Alle leerkrachten hebben klassen in " + s.jaar + "."
      : teKoppelen + (teKoppelen === 1 ? " leerkracht" : " leerkrachten") + " nog te koppelen aan klassen van " + s.jaar;
    zet(vak, html`
      <div class="mt-lijstkop"><span><b>${rijen.length + (rijen.length === 1 ? " gebruiker" : " gebruikers")}</b></span><span>${koppelTekst}</span></div>
      <div class="mt-rij mt-rijkop" aria-hidden="true"><span>Naam en e-mailadres</span><span>Rol</span><span>${"Klassen" + (s.jaar ? " " + s.jaar : "")}</span><span>Account</span><span></span></div>
      ${rijen.map((r) => html`
        <div class="mt-rij" data-rij="${r.g.id}">
          <span class="mt-wie"><b>${r.g.naam}${r.eigen ? html` <span class="mt-jij">(jij)</span>` : null}</b><small>${r.g.email}</small></span>
          <span data-label="Rol"><span class="${"pill " + ROLKLEUR[r.g.rol]}">${ROLNAAM[r.g.rol]}</span></span>
          <span class="mt-klassen" data-label="Klassen">${klassenCel(r)}</span>
          <span data-label="Account"><span class="${"pill " + r.toestand.kleur}">${r.toestand.tekst}</span></span>
          <span class="mt-actie">${r.eigen ? null : html`<button class="btn btn-ghost btn-sm" type="button" data-doe="wijzig" data-id="${r.g.id}">Wijzigen</button>`}</span>
        </div>`)}
      ${rijen.length ? null : html`<div class="mt-leeg">${s.rijen.length ? "Niemand voldoet aan deze filters." : "Er zijn nog geen gebruikers."}</div>`}
      <div class="mt-lijstvoet">
        <span>Wijzigen: de naam, de rol en de klassen per schooljaar, een nieuw tijdelijk wachtwoord (bv. als iemand zijn wachtwoord vergat), de app opnieuw koppelen (bv. bij een nieuwe gsm), of het account uitschakelen. De serverfunctie van de MT voert uit wat een wachtwoord raakt, en alles komt in het logboek.</span>
        <span>${"Een tijdelijk wachtwoord geldt " + s.uren + " uur. Bij de eerste aanmelding kiest de gebruiker zelf een nieuw; tot dan toont de databank niets. Je kent het definitieve wachtwoord nooit."}</span>
        <span>"Overnemen" koppelt de klassen van het vorige schooljaar opnieuw; kijk ze na, want leerkrachten wisselen soms van klas. Je eigen account wijzigt de andere beheerder.</span>
      </div>`);
  }

  // ---------- Klassen kiezen, in een venster ----------

  function klaskiezer(gekozen, jaar) {
    const groepen = klasGroepen(s.klassen, jaar, gekozen);
    if (!groepen.length) return html`<p class="hint">${"In " + jaar + " zijn er nog geen klassen."}</p>`;
    return html`<div class="mt-klaskies">${groepen.map(([titel, klassen]) => html`
      <div class="mt-kgroep"><span class="mt-kgroeptitel">${titel}</span><span class="klas-tags">${klassen.map((k) => html`<button type="button" class="${"mt-kkies" + (gekozen.has(k.id) ? " on" : "")}" aria-pressed="${gekozen.has(k.id)}" data-klas="${k.id}">${k.naam}</button>`)}</span></div>`)}</div>`;
  }

  /** Het deel "Klassen" van een venster, opnieuw getekend als de rol of de keuze wijzigt. */
  function klassenDeel(m, gebruikerId) {
    if (m.rol !== "leerkracht") return html`<p class="hint">${ROLNAAM[m.rol] + ": " + (m.rol === "lezer" ? "leest alles, zonder klassen." : "werkt voor alle klassen.")}</p>`;
    if (!s.jaar) return html`<p class="hint">Er is nog geen schooljaar met klassen. De klassen koppel je zodra het schooljaar gestart is.</p>`;
    const klasPerId = new Map(s.klassen.map((k) => [k.id, k]));
    const vorig = gebruikerId ? vorigeKlassen(gebruikerId, s.jaar, s.toewijzingen, klasPerId) : null;
    return html`
      ${klaskiezer(m.klassen, s.jaar)}
      ${vorig ? html`<p class="hint">${"In " + vorig.schooljaar + ": " + vorig.klassen.map((k) => k.naam).join(", ") + " · "}<button class="btn-link" type="button" data-doe="neem-venster">overnemen</button></p>` : null}`;
  }

  function koppelKlassen(v, m, gebruikerId) {
    const vak = v.el.querySelector('[data-vak="klassen"]');
    const teken = () => zet(vak, klassenDeel(m, gebruikerId));
    vak.addEventListener("click", (gebeurtenis) => {
      const klas = gebeurtenis.target.closest("[data-klas]");
      if (klas) {
        const id = klas.dataset.klas;
        if (m.klassen.has(id)) m.klassen.delete(id);
        else m.klassen.add(id);
        klas.classList.toggle("on", m.klassen.has(id));
        klas.setAttribute("aria-pressed", String(m.klassen.has(id)));
        return;
      }
      if (gebeurtenis.target.closest('[data-doe="neem-venster"]')) {
        const klasPerId = new Map(s.klassen.map((k) => [k.id, k]));
        const vorig = vorigeKlassen(gebruikerId, s.jaar, s.toewijzingen, klasPerId);
        const over = overnemen(vorig.klassen, s.klassen.filter((k) => k.schooljaar === s.jaar));
        m.klassen = new Set(over.ids);
        teken();
        if (over.ontbreekt.length) meld(over.ontbreekt.join(", ") + " bestaat niet meer in " + s.jaar + ".");
      }
    });
    return teken;
  }

  function rolKeuze(m) {
    return html`<span class="seg full" role="group" aria-label="Rol">${["leerkracht", "lezer", "beheerder"].map((rol) => html`<button type="button" class="${m.rol === rol ? "on" : ""}" aria-pressed="${m.rol === rol}" data-rol="${rol}">${ROLNAAM[rol]}</button>`)}</span>`;
  }

  function koppelRol(v, m, naWijziging) {
    const vak = v.el.querySelector('[data-vak="rol"]');
    const uitleg = v.el.querySelector('[data-vak="roluitleg"]');
    vak.addEventListener("click", (gebeurtenis) => {
      const knop = gebeurtenis.target.closest("[data-rol]");
      if (!knop) return;
      m.rol = knop.dataset.rol;
      for (const k of vak.querySelectorAll("[data-rol]")) {
        k.classList.toggle("on", k === knop);
        k.setAttribute("aria-pressed", String(k === knop));
      }
      uitleg.textContent = ROLUITLEG[m.rol];
      naWijziging();
    });
  }

  function toonFouten(v, fouten) {
    for (const veld of ["naam", "email"]) {
      const vak = v.el.querySelector('[data-fout="' + veld + '"]');
      const invoer = v.el.querySelector('[data-veld="' + veld + '"]');
      vak.textContent = fouten[veld] || "";
      vak.hidden = !fouten[veld];
      invoer.classList.toggle("invalid", Boolean(fouten[veld]));
    }
    const eerste = ["naam", "email"].find((veld) => fouten[veld]);
    if (eerste) v.el.querySelector('[data-veld="' + eerste + '"]').focus();
  }

  /** Een veld volgt het model bij elke toets; de fout van dat veld verdwijnt zodra je het aanpast. */
  function koppelVelden(v, m) {
    for (const invoer of v.el.querySelectorAll('[data-veld="naam"], [data-veld="email"]')) {
      invoer.addEventListener("input", () => {
        m[invoer.dataset.veld] = invoer.value;
        const vak = v.el.querySelector('[data-fout="' + invoer.dataset.veld + '"]');
        vak.textContent = "";
        vak.hidden = true;
        invoer.classList.remove("invalid");
      });
    }
  }

  function alarm(v, tekst) {
    const vak = v.el.querySelector('[data-vak="alarm"]');
    vak.textContent = tekst || "";
    vak.hidden = !tekst;
    if (tekst) vak.scrollIntoView({ block: "nearest" });
  }

  const vreemdAdres = (email) => vraag({
    titel: "Geen adres van de school",
    tekst: email + " eindigt niet op @" + SCHOOLDOMEIN + ". Wie dit adres kent, meldt ermee aan. Toch gebruiken?",
    ja: "Ja, toch gebruiken",
    nee: "Nee, aanpassen",
  });

  // ---------- Het tijdelijke wachtwoord, één keer ----------

  function toonWachtwoord({ naam, wachtwoord, geldig_tot, uren, app_gewist, nieuw, gebruiker }) {
    const termijn = geldig_tot ? "tot " + datumEnUur(Date.parse(geldig_tot)) : (uren || s.uren) + " uur";
    const v = venster({
      titel: "Tijdelijk wachtwoord voor " + naam,
      inhoud: html`
        <p class="mt-ww">${wachtwoord}</p>
        <div class="mt-wwknop"><button class="btn btn-ghost btn-sm" type="button" data-doe="kopieer">Kopiëren</button><span class="hint" data-vak="gekopieerd" role="status"></span></div>
        <p class="finfo">${"Geldig " + termijn + ". Geef het persoonlijk door aan " + naam + ". De MT toont het maar één keer en bewaart het niet: na het sluiten van dit venster is het weg."}</p>
        <p class="hint">${naam + (nieuw || app_gewist
          ? " meldt aan met dit wachtwoord, kiest dan een eigen wachtwoord en koppelt de authenticator-app."
          : " meldt aan met dit wachtwoord en kiest dan een eigen wachtwoord. De app blijft gekoppeld.")}</p>`,
      voet: html`<button class="btn btn-primary" type="button" data-doe="klaar">Ik heb het doorgegeven</button>`,
      focus: '[data-doe="klaar"]',
      terugNaar: () => knopVan("wijzig", gebruiker) || knopVan("toevoegen"),
    });
    v.el.querySelector('[data-doe="klaar"]').addEventListener("click", v.sluit);
    v.el.querySelector('[data-doe="kopieer"]').addEventListener("click", async () => {
      const vak = v.el.querySelector('[data-vak="gekopieerd"]');
      try {
        await navigator.clipboard.writeText(wachtwoord);
        vak.textContent = "Gekopieerd.";
      } catch {
        vak.textContent = "Kopiëren lukte niet: selecteer het wachtwoord en kopieer het zelf.";
      }
    });
  }

  // ---------- Gebruiker toevoegen ----------

  function openToevoegen() {
    const m = { naam: "", email: "", rol: "leerkracht", klassen: new Set() };
    const form = "gbForm" + ++formNr;
    const vuil = () => Boolean(m.naam.trim() || m.email.trim() || m.klassen.size);
    const v = venster({
      titel: "Gebruiker toevoegen",
      sub: "Het account krijgt een tijdelijk wachtwoord, dat je daarna één keer te zien krijgt. Bij de eerste aanmelding kiest de gebruiker een eigen wachtwoord en koppelt hij een authenticator-app.",
      breed: "mid",
      inhoud: html`
        <form id="${form}" class="mt-form" novalidate>
          <p class="form-alert" data-vak="alarm" role="alert" hidden></p>
          <div class="field mt-half"><label for="${form + "n"}">Naam</label>
            <input id="${form + "n"}" class="ctrl" type="text" data-veld="naam" autocomplete="off" maxlength="120">
            <span class="ferr" data-fout="naam" hidden></span></div>
          <div class="field mt-half"><label for="${form + "e"}">E-mailadres</label>
            <input id="${form + "e"}" class="ctrl" type="email" data-veld="email" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="${"voornaam.familienaam@" + SCHOOLDOMEIN}">
            <span class="hint">Daarmee meldt de gebruiker aan. Er gaan geen mails naartoe.</span>
            <span class="ferr" data-fout="email" hidden></span></div>
          <div class="field"><span class="flabel">Rol</span>
            <span data-vak="rol">${rolKeuze(m)}</span>
            <span class="hint" data-vak="roluitleg">${ROLUITLEG[m.rol]}</span></div>
          <div class="field"><span class="flabel">${"Klassen" + (s.jaar ? " in " + s.jaar : "")}</span>
            <div data-vak="klassen"></div></div>
        </form>`,
      voet: html`<button class="btn btn-ghost" type="button" data-doe="annuleer">Annuleren</button><button class="btn btn-primary" type="submit" form="${form}">Toevoegen</button>`,
      magSluiten: () => !vuil() || vraag({ titel: "Niet toegevoegd", tekst: "Sluiten zonder de gebruiker toe te voegen?", ja: "Ja, sluiten", nee: "Nee, verder werken" }),
      terugNaar: () => knopVan("toevoegen"),
    });
    const tekenKlassen = koppelKlassen(v, m, null);
    tekenKlassen();
    koppelRol(v, m, tekenKlassen);
    koppelVelden(v, m);
    v.el.querySelector('[data-doe="annuleer"]').addEventListener("click", v.vraagSluiten);
    v.el.querySelector("form").addEventListener("submit", async (gebeurtenis) => {
      gebeurtenis.preventDefault();
      const k = keur(m);
      toonFouten(v, k.fouten);
      alarm(v, null);
      if (!k.ok) return;
      if (k.vreemd && !(await vreemdAdres(k.email))) return;
      const klaar = knopBezig(v.el.querySelector('button[type="submit"]'), "Bezig met toevoegen…");
      const r = await data.serverfunctie("aanmaken", { operatie: crypto.randomUUID(), naam: k.naam, email: k.email, rol: k.rol });
      if (!r.ok) {
        klaar();
        if (!(await nogBinnen(r))) return;
        alarm(v, "Niet toegevoegd. " + r.tekst + " Je gegevens blijven staan.");
        return;
      }
      let klasFout = null;
      if (k.rol === "leerkracht" && s.jaar && m.klassen.size) {
        const kr = await data.rpc("mt_klassen_toewijzen", { p_gebruiker: r.gegevens.gebruiker, p_schooljaar: s.jaar, p_klassen: [...m.klassen] });
        if (!kr.ok) klasFout = kr.tekst;
      }
      v.sluit();
      await laad();
      toonWachtwoord({ naam: k.naam, ...r.gegevens, nieuw: true });
      if (klasFout) meld("Het account is gemaakt, maar de klassen zijn niet bewaard: " + klasFout, "err");
    });
  }

  // ---------- Wijzigen ----------

  function openWijzigen(id) {
    const rij = s.rijen.find((r) => r.g.id === id);
    if (!rij || rij.eigen) return;
    const g = rij.g;
    const begin = { naam: g.naam, email: g.email, rol: g.rol, klassen: new Set(rij.klassen.map((k) => k.id)) };
    const m = { naam: g.naam, email: g.email, rol: g.rol, klassen: new Set(begin.klassen) };
    const klassenTellen = () => m.rol === "leerkracht" && Boolean(s.jaar);
    const vuil = () => keur(m).naam !== begin.naam || keur(m).email !== begin.email || m.rol !== begin.rol || (klassenTellen() && !gelijk(m.klassen, begin.klassen));
    const form = "gbForm" + ++formNr;
    const op = g.open_operatie ? s.operaties.get(g.open_operatie) : null;
    const hangt = g.open_operatie
      ? "Een wijziging aan dit account is niet afgerond" + (op ? ": " + (HANDELING[op.soort] || op.soort) + ", begonnen op " + datumEnUur(Date.parse(op.begonnen_op)) : "")
        + ". Tot dan kan " + g.naam + " niet aanmelden. Herhaal de handeling hieronder; lukt dat niet meteen, probeer het dan na drie minuten opnieuw."
      : null;
    const v = venster({
      titel: g.naam + " wijzigen",
      sub: html`${g.email} · <span class="${"pill sm " + rij.toestand.kleur}">${rij.toestand.tekst}</span>`,
      breed: "mid",
      inhoud: html`
        <form id="${form}" class="mt-form" novalidate>
          <p class="form-alert" data-vak="alarm" role="alert" hidden></p>
          <div class="field mt-half"><label for="${form + "n"}">Naam</label>
            <input id="${form + "n"}" class="ctrl" type="text" data-veld="naam" autocomplete="off" maxlength="120" value="${g.naam}">
            <span class="ferr" data-fout="naam" hidden></span></div>
          <div class="field mt-half"><label for="${form + "e"}">E-mailadres</label>
            <input id="${form + "e"}" class="ctrl" type="email" data-veld="email" autocomplete="off" autocapitalize="none" spellcheck="false" value="${g.email}">
            <span class="hint">Daarmee meldt de gebruiker aan. Het wachtwoord en de app blijven dezelfde.</span>
            <span class="ferr" data-fout="email" hidden></span></div>
          <div class="field"><span class="flabel">Rol</span>
            <span data-vak="rol">${rolKeuze(m)}</span>
            <span class="hint" data-vak="roluitleg">${ROLUITLEG[m.rol]}</span></div>
          <div class="field"><span class="flabel">${"Klassen" + (s.jaar ? " in " + s.jaar : "")}</span>
            <div data-vak="klassen"></div></div>
        </form>
        <div class="mt-account">
          <span class="flabel">Account</span>
          ${hangt ? html`<p class="warnbox">${hangt}</p>` : null}
          <p class="fwarn" data-vak="eerst" hidden>Bewaar of annuleer eerst je wijzigingen hierboven.</p>
          <label class="check-row"><input type="checkbox" data-veld="app"> Ook de app opnieuw koppelen, bv. bij een nieuwe of verloren gsm</label>
          <div class="mt-accountknoppen">
            ${g.actief
              ? html`<button class="btn btn-ghost" type="button" data-actie="tijdelijk_wachtwoord">Nieuw tijdelijk wachtwoord</button><button class="btn-txt-del" type="button" data-actie="uitschakelen">Uitschakelen</button>`
              : html`<button class="btn btn-ghost" type="button" data-actie="inschakelen">Weer inschakelen</button>`}
          </div>
          <span class="hint">${g.actief
            ? "Een nieuw tijdelijk wachtwoord meldt " + g.naam + " overal af; het vorige wachtwoord werkt dan niet meer. De app opnieuw koppelen gaat altijd samen met een nieuw tijdelijk wachtwoord."
            : "Weer inschakelen geeft " + g.naam + " een nieuw tijdelijk wachtwoord."}</span>
        </div>`,
      voet: html`<button class="btn btn-ghost" type="button" data-doe="annuleer">Annuleren</button><button class="btn btn-primary" type="submit" form="${form}">Opslaan</button>`,
      magSluiten: () => !vuil() || vraag({ titel: "Wijzigingen niet bewaard", tekst: "Sluiten zonder te bewaren?", ja: "Ja, sluiten", nee: "Nee, verder werken" }),
      terugNaar: () => knopVan("wijzig", g.id),
    });
    const tekenKlassen = koppelKlassen(v, m, g.id);
    tekenKlassen();
    koppelRol(v, m, tekenKlassen);
    koppelVelden(v, m);
    v.el.querySelector('[data-doe="annuleer"]').addEventListener("click", v.vraagSluiten);

    // Opslaan: eerst de naam en de rol, dan de klassen, dan het e-mailadres. Wat lukte, blijft bewaard.
    v.el.querySelector("form").addEventListener("submit", async (gebeurtenis) => {
      gebeurtenis.preventDefault();
      const k = keur(m);
      toonFouten(v, k.fouten);
      alarm(v, null);
      if (!k.ok) return;
      if (!vuil()) return v.sluit();
      const nieuwAdres = k.email !== begin.email;
      if (nieuwAdres && k.vreemd && !(await vreemdAdres(k.email))) return;
      const klaar = knopBezig(v.el.querySelector('button[type="submit"]'), "Bezig met opslaan…");
      const bewaard = [];
      const mislukt = async (wat, r) => {
        klaar();
        if (!(await nogBinnen(r))) return;
        alarm(v, (bewaard.length ? "Bewaard: " + bewaard.join(", ") + ". " : "") + "Niet bewaard: " + wat + ". " + r.tekst
          + (r.extra && r.extra.geblokkeerd ? " Het account blijft geblokkeerd tot je de handeling herhaalt." : ""));
        laad();
      };
      if (k.naam !== begin.naam || k.rol !== begin.rol) {
        const r = await data.rpc("mt_gebruiker_wijzigen", { p_gebruiker: g.id, p_naam: k.naam, p_rol: k.rol });
        if (!r.ok) return mislukt("de naam en de rol", r);
        begin.naam = k.naam;
        begin.rol = k.rol;
        bewaard.push("de naam en de rol");
      }
      if (klassenTellen() && !gelijk(m.klassen, begin.klassen)) {
        const r = await data.rpc("mt_klassen_toewijzen", { p_gebruiker: g.id, p_schooljaar: s.jaar, p_klassen: [...m.klassen] });
        if (!r.ok) return mislukt("de klassen", r);
        begin.klassen = new Set(m.klassen);
        bewaard.push("de klassen");
      }
      if (nieuwAdres) {
        const r = await data.serverfunctie("email_wijzigen", { operatie: crypto.randomUUID(), gebruiker: g.id, email: k.email });
        if (!r.ok) return mislukt("het e-mailadres", r);
        begin.email = k.email;
      }
      v.sluit();
      meld("Bewaard.", "ok");
      laad();
    });

    // Wat een wachtwoord of een koppeling raakt: telkens eerst een bewuste vraag.
    for (const knop of v.el.querySelectorAll("[data-actie]")) {
      knop.addEventListener("click", async () => {
        const actie = knop.dataset.actie;
        const eerst = v.el.querySelector('[data-vak="eerst"]');
        eerst.hidden = !vuil();
        if (vuil()) return;
        const app = v.el.querySelector('[data-veld="app"]').checked;
        const teksten = {
          tijdelijk_wachtwoord: ["Nieuw tijdelijk wachtwoord voor " + g.naam + "?",
            "Het huidige wachtwoord van " + g.naam + " werkt daarna niet meer, en " + g.naam + " wordt overal afgemeld. "
            + (app ? "Ook de app-koppeling wordt gewist: " + g.naam + " doorloopt opnieuw de vier stappen van de eerste keer." : "De app blijft gekoppeld."),
            app ? "Ja, nieuw wachtwoord en app opnieuw" : "Ja, nieuw wachtwoord"],
          uitschakelen: [g.naam + " uitschakelen?",
            g.naam + " kan daarna niet meer aanmelden en wordt overal afgemeld. Wat " + g.naam + " invulde, blijft bewaard. Weer inschakelen kan altijd, met een nieuw tijdelijk wachtwoord.",
            "Ja, uitschakelen"],
          inschakelen: [g.naam + " weer inschakelen?",
            g.naam + " krijgt een nieuw tijdelijk wachtwoord." + (app ? " Ook de app-koppeling wordt gewist." : " De app blijft gekoppeld, als die er was."),
            "Ja, inschakelen"],
        }[actie];
        if (!(await vraag({ titel: teksten[0], tekst: teksten[1], ja: teksten[2], nee: "Nee" }))) return;
        const klaar = knopBezig(knop, "Bezig…");
        const invoer = { operatie: crypto.randomUUID(), gebruiker: g.id };
        if (actie !== "uitschakelen") invoer.app_wissen = app;
        const r = await data.serverfunctie(actie, invoer);
        if (!r.ok) {
          klaar();
          if (!(await nogBinnen(r))) return;
          alarm(v, "Niet gelukt. " + r.tekst + (r.extra && r.extra.geblokkeerd ? " Het account blijft geblokkeerd tot je de handeling herhaalt." : ""));
          laad();
          return;
        }
        v.sluit();
        await laad();
        if (actie === "uitschakelen") meld(g.naam + " is uitgeschakeld.", "ok");
        else toonWachtwoord({ naam: g.naam, ...r.gegevens });
      });
    }
  }

  // ---------- Overnemen, in de lijst ----------

  async function neemOver(id, knop) {
    const rij = s.rijen.find((r) => r.g.id === id);
    if (!rij || !rij.vorig || !s.jaar) return;
    const over = overnemen(rij.vorig.klassen, s.klassen.filter((k) => k.schooljaar === s.jaar));
    if (!over.ids.length) {
      meld("Geen enkele klas van " + rij.vorig.schooljaar + " bestaat nog in " + s.jaar + ": kies de klassen bij Wijzigen.", "err");
      return;
    }
    const klaar = knopBezig(knop, "bezig…");
    const r = await data.rpc("mt_klassen_toewijzen", { p_gebruiker: id, p_schooljaar: s.jaar, p_klassen: over.ids });
    if (!r.ok) {
      klaar();
      if (!(await nogBinnen(r))) return;
      meld("Niet overgenomen. " + r.tekst, "err");
      return;
    }
    meld(rij.g.naam + ": " + over.namen.join(", ") + " overgenomen." + (over.ontbreekt.length ? " " + over.ontbreekt.join(", ") + " bestaat niet meer in " + s.jaar + "." : " Kijk na of het nog klopt."), "ok");
    await laad();
  }

  tekenFilters();
  laad();
  const titel = q("h2");
  if (titel) titel.focus();
  return { herlaad: laad };
}
