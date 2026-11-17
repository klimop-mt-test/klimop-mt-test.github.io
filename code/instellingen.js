// MT · instellingen.js · versie 0.9.0
// Het scherm Instellingen (5, 15, B144, B165, B169; canvas: bord "Instellingen"), deel 1: de beheerders,
// de schooljaren met hun plafonds, een nieuw schooljaar aanmaken, invullen en starten, en de weg naar
// Gebruikers en de Rekentest. Enkel voor een beheerder. De afwezigheidsstatussen, de berekening en het
// aanmelden volgen in deel 2; de facturatie en de minder scherpe maximumfactuur met hun fase.
//
// Het scherm beslist niets over rechten: de databank doet dat (17.3).
//   - lezen: de tabellen zelf, via data.lees();
//   - een schooljaar aanmaken en invullen: rechtstreeks in de tabel van de schooljaren, met voegToe en
//     wijzig van data.js. De regels per rij en de rechten per kolom staan in de databank
//     (sql/002_databank.sql): enkel een beheerder, en nooit de stand zelf;
//   - een schooljaar starten: de databankfunctie mt_schooljaar_bevestigen (sql/007_schooljaar.sql).
// Elk veld van het formulier wordt meteen bewaard, veld na veld, en het scherm toont wat de databank
// teruggeeft: niet wat het stuurde.
//
// Bovenaan staat wat zonder browser te testen valt; daaronder het scherm zelf.

import * as data from "./data.js";
import { bedragTekst, bedragUit, bevries, euro, html, knopBezig, meld, vraag, zet } from "./ui.js";
import { dagInBrussel, dagVoluit, magStarten, STANDKLEUR, STANDNAAM, startVanaf, teMaken, vorigVan } from "./schooljaar.js";
import { maakRijen } from "./gebruikers.js";

export const VERSIE = "0.9.0";

// ---------- Zonder browser te testen ----------

/** Wat Instellingen van een schooljaar leest. */
export const KOLOMMEN = Object.freeze([
  "schooljaar", "stand", "plafond_kleuter_cent", "plafond_lager_cent", "marge_kleuter_cent", "marge_lager_cent",
  "gratis_zwemjaar_leerjaar", "gratis_zwemjaar_toegang_aangerekend", "gratis_zwemjaar_bus", "prijs_per_kind_afwezigen",
]);

/** De bedragen van een schooljaar (B77, B154): de kolom, het label van het veld, en hoe een melding het noemt. */
export const BEDRAGEN = Object.freeze([
  { kolom: "plafond_kleuter_cent", label: "Plafond kleuterschool", kort: "het plafond van de kleuterschool" },
  { kolom: "plafond_lager_cent", label: "Plafond lagere school", kort: "het plafond van de lagere school" },
  { kolom: "marge_kleuter_cent", label: "Terugbetaling aan schoolverlaters, kleuterschool: niet tot en met", kort: "de terugbetaling aan schoolverlaters van de kleuterschool" },
  { kolom: "marge_lager_cent", label: "Terugbetaling aan schoolverlaters, lagere school: niet tot en met", kort: "de terugbetaling aan schoolverlaters van de lagere school" },
]);

const LEERJAREN = ["1ste", "2de", "3de", "4de", "5de", "6de"];
const BUS = { school: "voor de school, zoals de regelgeving vraagt", ouders: "aangerekend aan de ouders", geen: "geen bus" };

/** De drie vragen over het gratis zwemjaar (B103, B105, B163): de kolom, de vraag en de keuzes. */
export const ZWEMVRAGEN = Object.freeze([
  { kolom: "gratis_zwemjaar_leerjaar", vraag: "Welk leerjaar heeft het gratis zwemjaar?", keuzes: LEERJAREN.map((tekst, i) => ({ waarde: i + 1, tekst })) },
  { kolom: "gratis_zwemjaar_toegang_aangerekend", vraag: "Rekent het zwembad de toegang voor dat leerjaar aan?", keuzes: [{ waarde: false, tekst: "Nee" }, { waarde: true, tekst: "Ja" }] },
  { kolom: "gratis_zwemjaar_bus", vraag: "De bus van dat leerjaar", keuzes: [{ waarde: "school", tekst: "Voor de school" }, { waarde: "ouders", tekst: "Aangerekend aan de ouders" }, { waarde: "geen", tekst: "Geen bus" }] },
]);

/**
 * Wat ingevuld moet zijn vóór de knop "bevestigen" aangaat: de vier bedragen, die de databank eist, en
 * het leerjaar van het gratis zwemjaar. Zonder dat leerjaar zou het gratis zwemjaar stil niet gelden.
 */
export const VERPLICHT = Object.freeze([...BEDRAGEN.map((b) => b.kolom), "gratis_zwemjaar_leerjaar"]);

/** Een bedrag boven deze grens is haast zeker een tikfout: € 10.000. */
export const MAX_BEDRAG_CENT = 1000000;

/**
 * De rij waarmee een schooljaar aangemaakt wordt. Wat het formulier niet vraagt en per schooljaar geldt,
 * komt mee van het vorige schooljaar: de standaard voor een prijs per kind (B22). De rest krijgt de
 * standaard van de databank, tot het scherm ervoor bestaat.
 */
export function nieuweRij(schooljaar, vorig) {
  const rij = { schooljaar };
  if (vorig && typeof vorig.prijs_per_kind_afwezigen === "boolean") rij.prijs_per_kind_afwezigen = vorig.prijs_per_kind_afwezigen;
  return rij;
}

/** De kolommen die nog leeg zijn. */
export function ontbreekt(jaar) {
  return VERPLICHT.filter((kolom) => jaar[kolom] === null || jaar[kolom] === undefined);
}

/** "Alles is ingevuld.", of hoeveel velden nog ontbreken. */
export function ontbreektTekst(aantal) {
  if (aantal === 0) return "Alles is ingevuld.";
  return "Nog in te vullen: " + aantal + (aantal === 1 ? " veld." : " velden.");
}

/**
 * Wat onder een bedrag staat: wat in het vorige schooljaar gold (B144). Geeft { tekst, overnemen, anders },
 * of niets als er geen vorig schooljaar is.
 *   overnemen  het vorige schooljaar had een bedrag, en het veld heeft nu een ander of geen
 *   anders     het veld is ingevuld, en wijkt af van het vorige schooljaar
 */
export function hintBedrag(vorig, kolom, waarde) {
  if (!vorig) return null;
  const oud = typeof vorig[kolom] === "number" ? vorig[kolom] : null;
  return {
    tekst: vorig.schooljaar + ": " + (oud === null ? "geen" : euro(oud)),
    overnemen: oud !== null && waarde !== oud,
    anders: typeof waarde === "number" && waarde !== oud,
  };
}

/** Het antwoord op een vraag over het gratis zwemjaar, in woorden: voor het vorige schooljaar, en in de kaart. */
export function zwemAntwoord(kolom, waarde) {
  if (kolom === "gratis_zwemjaar_leerjaar") return Number.isInteger(waarde) && waarde >= 1 && waarde <= 6 ? LEERJAREN[waarde - 1] + " leerjaar" : "nog niet gekozen";
  if (kolom === "gratis_zwemjaar_toegang_aangerekend") return waarde === true ? "ja: de toegang is voor de school" : "nee: de toegang kost niets";
  return BUS[waarde] || "nog niet gekozen";
}

/** Wat de MT zegt nadat een veld bewaard is. */
export function bewaardTekst(kolom, waarde) {
  const bedrag = BEDRAGEN.find((b) => b.kolom === kolom);
  if (bedrag) return "Bewaard: " + bedrag.kort + (waarde === null ? " is leeg." : ", " + euro(waarde) + ".");
  if (kolom === "gratis_zwemjaar_leerjaar") return "Bewaard: het gratis zwemjaar is het " + zwemAntwoord(kolom, waarde) + ".";
  if (kolom === "gratis_zwemjaar_toegang_aangerekend") return "Bewaard: de toegang, " + zwemAntwoord(kolom, waarde) + ".";
  return "Bewaard: de bus, " + zwemAntwoord(kolom, waarde) + ".";
}

/**
 * Het vak bovenaan de kaart Schooljaren: wat er te doen is. Geeft { soort, schooljaar, tekst, knop, dringend }.
 *   soort     "invullen": er staat een schooljaar in te vullen; "aanmaken": de MT stelt er één voor
 *   dringend  het vak vraagt aandacht; anders is het een rustige regel
 *   jaren     de schooljaren uit de databank
 *   vandaag   de dag in Brussel, "2026-11-17"
 */
export function vakSchooljaren(jaren, vandaag) {
  const nieuw = jaren.find((j) => j.stand === "in_te_vullen");
  if (nieuw) {
    const aantal = ontbreekt(nieuw).length;
    const klaar = magStarten(nieuw.schooljaar, vandaag) ? "Alles is ingevuld: je kan het bevestigen." : "Alles is ingevuld. Bevestigen kan vanaf " + dagVoluit(startVanaf(nieuw.schooljaar)) + ".";
    return {
      soort: "invullen", schooljaar: nieuw.schooljaar, dringend: true, knop: "Verder invullen",
      tekst: nieuw.schooljaar + " is aangemaakt, maar nog niet bevestigd. " + (aantal ? ontbreektTekst(aantal) : klaar),
    };
  }
  const schooljaar = teMaken(jaren, vandaag);
  const basis = { soort: "aanmaken", schooljaar, knop: "Nieuw schooljaar aanmaken" };
  if (!jaren.some((j) => j.stand === "lopend")) {
    return { ...basis, dringend: true, tekst: "Er is nog geen lopend schooljaar. Maak schooljaar " + schooljaar + " aan: zodra het gestart is, neemt de MT de uitstappen van dat schooljaar over." };
  }
  if (magStarten(schooljaar, vandaag)) return { ...basis, dringend: true, tekst: "Schooljaar " + schooljaar + " is nog niet aangemaakt." };
  return { ...basis, dringend: false, tekst: "Het volgende schooljaar, " + schooljaar + ", kan je al aanmaken en invullen. Starten kan vanaf " + dagVoluit(startVanaf(schooljaar)) + "." };
}

/**
 * De vraag vóór het starten: { titel, tekst, slot, ja, nee }.
 *   lopend  het schooljaar dat nu loopt en open blijft, of niets
 */
export function vraagStarten(schooljaar, lopend) {
  return {
    titel: "Schooljaar " + schooljaar + " starten?",
    tekst: lopend
      ? schooljaar + " wordt het lopende schooljaar. Imports en aanwezigheden gaan voortaan daarheen. " + lopend + " blijft open tot alles gefactureerd, gecrediteerd of afgeboekt is."
      : schooljaar + " wordt het lopende schooljaar. De MT neemt dan de uitstappen van " + schooljaar + " over uit de uitstappentool.",
    slot: "Dit kan je niet ongedaan maken.",
    ja: "Ja, " + schooljaar + " starten",
    nee: "Nee, nog niet",
  };
}

/** De nota onder de knop "bevestigen". */
export function notaStarten(schooljaar, lopend, vandaag) {
  const wanneer = magStarten(schooljaar, vandaag) ? "" : "Bevestigen kan vanaf " + dagVoluit(startVanaf(schooljaar)) + ". ";
  if (lopend) {
    return wanneer + "Bevestigen kan ten vroegste vanaf 1 juli, als " + lopend + " voorbij is; later kan ook. Daarna gaan imports en aanwezigheden naar " + schooljaar + "; "
      + lopend + " blijft open tot alles rond is.";
  }
  return wanneer + "Na het bevestigen is " + schooljaar + " het lopende schooljaar: de MT neemt dan de uitstappen van " + schooljaar + " over uit de uitstappentool.";
}

/**
 * Wat de MT in de uitstappentool las, net na de start: één zin voor de melding.
 *   lezing  het antwoord van de serverfunctie (data.uitstappenBijwerken), of niets
 */
export function zinLezing(lezing) {
  const g = lezing && lezing.ok ? lezing.gegevens : null;
  if (!g) return "De uitstappentool lezen lukte nu niet. Kies op Overzicht \"Opnieuw lezen\": daar staat ook wat er scheelt.";
  if (g.stand !== "klaar" || !g.uitstappen || typeof g.uitstappen !== "object") return "De MT leest de uitstappentool op dit moment: het resultaat staat zo meteen op Overzicht.";
  const delen = [];
  const klassen = g.klassen && g.klassen.ok === true && Number.isInteger(g.klassen.nieuw) ? g.klassen.nieuw : 0;
  const uitstappen = Number.isInteger(g.uitstappen.nieuw) ? g.uitstappen.nieuw : 0;
  if (klassen) delen.push(klassen + (klassen === 1 ? " klas" : " klassen"));
  if (uitstappen) delen.push(uitstappen + (uitstappen === 1 ? " uitstap" : " uitstappen"));
  if (!delen.length) return "De MT las de uitstappentool opnieuw: er kwam niets bij. Het resultaat staat op Overzicht.";
  return "De MT las de uitstappentool opnieuw: " + delen.join(" en ") + (klassen + uitstappen === 1 ? " kwam erbij." : " kwamen erbij.") + " Het resultaat staat op Overzicht.";
}

/**
 * De melding na de start: de regels onder "Schooljaar … is gestart."
 *   gestart  { schooljaar, vorig, open, lezing }: het vorige schooljaar dat open blijft, hoeveel van zijn
 *            aanwezigheidslijsten nog open staan (niets als dat niet gekend is), en wat de MT daarna las
 */
export function gestartRegels({ schooljaar, vorig, open, lezing }) {
  const regels = [zinLezing(lezing)];
  regels.push("Volgende stap: de klassen van " + schooljaar + " aan de leerkrachten koppelen in Gebruikers. De leerlingenlijst uit Informat opladen kan vanaf een volgende versie van de MT.");
  if (vorig) {
    regels.push(vorig + " blijft open tot alles rond is: kies het bovenaan."
      + (Number.isInteger(open) && open > 0 ? " Nog open in " + vorig + ": " + open + (open === 1 ? " aanwezigheidslijst." : " aanwezigheidslijsten.") : ""));
  }
  return regels;
}

const aantal = (n, een, meer) => n + " " + (n === 1 ? een : meer);

/**
 * De kaart Beheerders: de beheerders zelf, wie er verder is, en wat aandacht vraagt.
 *   rijen  de rijen van het scherm Gebruikers (gebruikers.js: maakRijen)
 *   jaar   het schooljaar in de kop, of niets
 * Geeft { beheerders, verder, aandacht }.
 */
export function beheerOverzicht(rijen, jaar) {
  const tel = (voldoet) => rijen.filter(voldoet).length;
  const leerkrachten = tel((r) => r.g.rol === "leerkracht");
  const lezers = tel((r) => r.g.rol === "lezer");
  const delen = [];
  if (leerkrachten) delen.push(aantal(leerkrachten, "leerkracht", "leerkrachten"));
  if (lezers) delen.push(aantal(lezers, "lezer", "lezers"));
  const aandacht = [];
  const koppelen = tel((r) => r.teKoppelen);
  if (koppelen && jaar) aandacht.push(aantal(koppelen, "leerkracht", "leerkrachten") + ": klassen " + jaar + " nog te koppelen");
  const tijdelijk = tel((r) => r.toestand.soort === "tijdelijk" || r.toestand.soort === "verlopen");
  if (tijdelijk) aandacht.push(aantal(tijdelijk, "tijdelijk wachtwoord", "tijdelijke wachtwoorden"));
  const app = tel((r) => r.toestand.soort === "app");
  if (app) aandacht.push(aantal(app, "app te koppelen", "apps te koppelen"));
  const hangt = tel((r) => r.toestand.soort === "hangt");
  if (hangt) aandacht.push(aantal(hangt, "wijziging niet afgerond", "wijzigingen niet afgerond"));
  return {
    beheerders: rijen.filter((r) => r.g.rol === "beheerder"),
    verder: delen.length ? "Verder: " + delen.join(" en ") + "." : "Verder zijn er nog geen leerkrachten of lezers.",
    aandacht,
  };
}

// ---------- Het scherm ----------

/**
 * Start het scherm in een onderdeel van de pagina.
 *   deel            het element van het scherm
 *   ik              het id van wie aangemeld is
 *   jaar            geeft het schooljaar dat in de kop van de pagina gekozen is, of niets
 *   naarGebruikers  opent het scherm Gebruikers: naarGebruikers(null), ({ toevoegen: true }) of ({ wijzig: id })
 *   naarRekentest   opent de Rekentest
 *   opGestart       een schooljaar is gestart: de pagina werkt de kop en het account bij en leest de
 *                   uitstappentool opnieuw. Geeft een belofte met het antwoord van die lezing
 *   herstart        de aanmelding is niet meer in orde: de pagina herlaadt en vraagt wat nodig is
 * Geeft { herlaad, jaarGewijzigd }.
 */
export function start({ deel, ik, jaar, naarGebruikers, naarRekentest, opGestart, herstart }) {
  const s = { laden: true, fout: null, jaren: [], formOpen: false, gestart: null, bezig: false, beheer: { laden: true, fout: null, rijen: [] } };
  const q = (kiezer) => deel.querySelector(kiezer);
  const vak = (naam) => q('[data-vak="' + naam + '"]');
  const vandaag = () => dagInBrussel(Date.now());
  const nieuw = () => s.jaren.find((j) => j.stand === "in_te_vullen") || null;
  const lopend = () => s.jaren.find((j) => j.stand === "lopend") || null;
  const vorigVanNieuw = () => (nieuw() ? vorigVan(s.jaren, nieuw().schooljaar) : null);
  const gekozen = () => s.jaren.find((j) => j.schooljaar === jaar()) || lopend();

  // Wat bewaard wordt, gaat veld na veld naar de databank: zo komt een ouder antwoord nooit na een nieuwer.
  let wachtrij = Promise.resolve();
  const naElkaar = (werk) => (wachtrij = wachtrij.then(werk, werk));

  zet(deel, html`
    <div class="page-head big">
      <div>
        <h2 tabindex="-1">Instellingen</h2>
        <p>De beheerders, de schooljaren met hun plafonds en hoe de MT rekent. Enkel zichtbaar voor de beheerders. Wat per schooljaar geldt, toont het gekozen schooljaar. De afwezigheidsstatussen, de keuzes bij de berekening en het aanmelden volgen in een volgende versie van de MT.</p>
      </div>
    </div>
    <div data-vak="gestart" hidden></div>
    <section class="card mt-jform" data-vak="formulier" aria-labelledby="instFormTitel" hidden></section>
    <section class="card set-card mt-inst" aria-labelledby="instBeheerTitel">
      <div class="mt-instkop">
        <div>
          <h3 class="legend" id="instBeheerTitel"><span class="dot" aria-hidden="true"></span>Beheerders</h3>
          <p class="hint">Alle gebruikers, ook de leerkrachten en de lezers, en hun klassen per schooljaar, staan in Gebruikers.</p>
        </div>
        <div class="mt-instknoppen">
          <button class="btn btn-ghost btn-sm" type="button" data-doe="toevoegen">Gebruiker toevoegen</button>
          <button class="btn btn-primary btn-sm" type="button" data-doe="gebruikers">Alle gebruikers</button>
        </div>
      </div>
      <div class="mt-instlijst" data-vak="beheerders"></div>
    </section>
    <div class="set-grid mt-instgrid">
      <section class="card set-card mt-inst" aria-labelledby="instRekenTitel">
        <h3 class="legend" id="instRekenTitel"><span class="dot" aria-hidden="true"></span>Berekening</h3>
        <div class="mt-instblok">
          <h4>Afronding</h4>
          <p>Op de dichtstbijzijnde cent: tot en met de halve cent naar beneden, in het voordeel van de ouders, daarboven naar boven. Activiteit en vervoer worden per leerling samen één keer afgerond. Het verschil is voor of van de school.</p>
        </div>
        <div class="mt-instblok">
          <h4>Scherpe of minder scherpe maximumfactuur</h4>
          <p>Afgeleid uit dag of meerdaags in de uitstappentool. Per activiteit kan een meerdaagse uitstap naar scherp, met een reden. Een daguitstap is altijd scherp. Een meerdaagse uitstap van een kleuterklas wordt nooit aangerekend: de kost is voor de school.</p>
        </div>
        <div class="mt-instblok mt-instrij">
          <div>
            <h4>Rekentest</h4>
            <p>De testgevallen van het rekencontract, uitgerekend door deze browser: het verwachte bedrag naast het berekende.</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-doe="rekentest">Rekentest</button>
        </div>
      </section>
      <div class="mt-instkolom">
        <section class="card set-card mt-inst" aria-labelledby="instJarenTitel">
          <div>
            <h3 class="legend" id="instJarenTitel"><span class="dot" aria-hidden="true"></span>Schooljaren</h3>
            <p class="hint">De plafonds van de scherpe maximumfactuur, elk jaar geïndexeerd. Een afgesloten schooljaar houdt zijn eigen bedragen.</p>
          </div>
          <div class="mt-instlijst" data-vak="schooljaren"></div>
        </section>
        <section class="card set-card mt-inst" data-vak="zwemjaar" aria-labelledby="instZwemTitel" hidden></section>
      </div>
    </div>`);

  deel.addEventListener("click", (gebeurtenis) => {
    const knop = gebeurtenis.target instanceof Element ? gebeurtenis.target.closest("[data-doe]") : null;
    if (!knop || !deel.contains(knop) || knop.disabled) return;
    const doe = knop.dataset.doe;
    if (doe === "opnieuw") laad();
    else if (doe === "gebruikers") naarGebruikers(null);
    else if (doe === "toevoegen") naarGebruikers({ toevoegen: true });
    else if (doe === "wijzig") naarGebruikers({ wijzig: knop.dataset.id });
    else if (doe === "rekentest") naarRekentest();
    else if (doe === "aanmaken") maakAan(knop);
    else if (doe === "invullen") openFormulier();
    else if (doe === "sluit-formulier") sluitFormulier();
    else if (doe === "sluit-gestart") sluitGestart();
    else if (doe === "neem") neemOver(knop.dataset.kolom);
    else if (doe === "kies") kies(knop.dataset.kolom, knop.dataset.waarde);
    else if (doe === "bevestig") bevestig();
  });
  // Een bedrag wordt bewaard zodra je het veld verlaat; Enter doet hetzelfde.
  deel.addEventListener("change", (gebeurtenis) => {
    const veld = gebeurtenis.target;
    if (veld instanceof HTMLInputElement && veld.dataset.bedrag) bewaarBedrag(veld);
  });
  deel.addEventListener("keydown", (gebeurtenis) => {
    const veld = gebeurtenis.target;
    if (gebeurtenis.key === "Enter" && veld instanceof HTMLInputElement && veld.dataset.bedrag) veld.blur();
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

  /** Leest de schooljaren en de gebruikers opnieuw. Geeft true als de schooljaren gelezen zijn. */
  async function laad() {
    s.laden = true;
    s.fout = null;
    if (!s.jaren.length) tekenJaren();
    laadBeheerders();
    const r = await data.lees("schooljaren", { kolommen: [...KOLOMMEN], volgorde: ["schooljaar"], sleutel: ["schooljaar"], rol: "beheerder" });
    if (!r.ok) {
      if (!(await nogBinnen(r))) return false;
      s.laden = false;
      s.fout = r.tekst;
      tekenJaren();
      return false;
    }
    s.jaren = r.gegevens;
    s.laden = false;
    if (!nieuw()) s.formOpen = false;
    tekenAlles();
    return true;
  }

  async function laadBeheerders() {
    s.beheer.laden = true;
    s.beheer.fout = null;
    if (!s.beheer.rijen.length) tekenBeheerders();
    const [g, k, t] = await Promise.all([
      data.lees("gebruikers", {
        kolommen: ["id", "naam", "email", "rol", "actief", "wachtwoord_tijdelijk", "tijdelijk_tot", "eerste_aanmelding_afgerond", "app_koppelen", "open_operatie",
          "herstel_wachtwoord", "herstel_app"],
        volgorde: ["naam", "id"], rol: "beheerder",
      }),
      data.lees("klassen", { kolommen: ["id", "schooljaar", "naam", "volgorde"], volgorde: ["schooljaar", "volgorde", "naam", "id"], rol: "beheerder" }),
      data.lees("klastoewijzingen", { kolommen: ["gebruiker_id", "klas_id", "schooljaar"], volgorde: ["gebruiker_id", "klas_id"], sleutel: ["gebruiker_id", "klas_id"], rol: "beheerder" }),
    ]);
    const mis = [g, k, t].find((antwoord) => !antwoord.ok);
    s.beheer.laden = false;
    if (mis) {
      if (!(await nogBinnen(mis))) return;
      s.beheer.fout = mis.tekst;
      tekenBeheerders();
      return;
    }
    s.beheer.bron = { gebruikers: g.gegevens, klassen: k.gegevens, toewijzingen: t.gegevens };
    herrekenBeheerders();
    tekenBeheerders();
  }

  function herrekenBeheerders() {
    if (!s.beheer.bron) return;
    s.beheer.rijen = maakRijen({ ...s.beheer.bron, jaar: jaar(), ik, nu: Date.now() });
  }

  // ---------- Tekenen ----------

  function tekenAlles() {
    tekenGestart();
    tekenFormulier();
    tekenJaren();
    tekenZwemjaar();
  }

  function tekenGestart() {
    const doel = vak("gestart");
    doel.hidden = !s.gestart;
    if (!s.gestart) {
      doel.replaceChildren();
      return;
    }
    zet(doel, html`
      <div class="mt-gestart" role="status" tabindex="-1">
        <div>
          <p><b>${"Schooljaar " + s.gestart.schooljaar + " is gestart."}</b></p>
          ${gestartRegels(s.gestart).map((regel) => html`<p>${regel}</p>`)}
        </div>
        <button class="btn-link" type="button" data-doe="sluit-gestart">Sluiten</button>
      </div>`);
  }

  function tekenBeheerders() {
    const doel = vak("beheerders");
    if (s.beheer.fout) {
      zet(doel, html`<div class="form-alert mt-lijstfout" role="alert"><span><b>De gebruikers zijn niet geladen.</b> ${s.beheer.fout}</span><button class="btn btn-ghost btn-sm" type="button" data-doe="opnieuw">Opnieuw proberen</button></div>`);
      return;
    }
    if (s.beheer.laden && !s.beheer.rijen.length) {
      zet(doel, html`<div class="mt-laadt" role="status" aria-label="De beheerders worden geladen"><div class="skeleton"></div><div class="skeleton"></div></div>`);
      return;
    }
    const o = beheerOverzicht(s.beheer.rijen, jaar());
    zet(doel, html`
      <div class="mt-rij mt-rijkop" aria-hidden="true"><span>Naam en e-mailadres</span><span>Rol</span><span>Klassen</span><span>Account</span><span></span></div>
      ${o.beheerders.map((r) => html`
        <div class="mt-rij" data-rij="${r.g.id}">
          <span class="mt-wie"><b>${r.g.naam}${r.eigen ? html` <span class="mt-jij">(jij)</span>` : null}</b><small>${r.g.email}</small></span>
          <span data-label="Rol"><span class="pill vol">Beheerder</span></span>
          <span class="mt-klassen" data-label="Klassen"><span class="klas-tags"><span class="klas-tag grijs">alles</span></span></span>
          <span data-label="Account"><span class="${"pill " + r.toestand.kleur}">${r.toestand.tekst}</span></span>
          <span class="mt-actie">${r.eigen ? null : html`<button class="btn btn-ghost btn-sm" type="button" data-doe="wijzig" data-id="${r.g.id}">Wijzigen</button>`}</span>
        </div>`)}
      <div class="mt-lijstvoet mt-instvoet"><span>${o.verder}</span>${o.aandacht.length ? html`<span class="mt-pillen">${o.aandacht.map((tekst) => html`<span class="pill open">${tekst}</span>`)}</span>` : null}</div>`);
  }

  function tekenJaren() {
    const doel = vak("schooljaren");
    if (s.fout) {
      zet(doel, html`<div class="form-alert mt-lijstfout" role="alert"><span><b>De schooljaren zijn niet geladen.</b> ${s.fout}</span><button class="btn btn-ghost btn-sm" type="button" data-doe="opnieuw">Opnieuw proberen</button></div>`);
      return;
    }
    if (s.laden && !s.jaren.length) {
      zet(doel, html`<div class="mt-laadt" role="status" aria-label="De schooljaren worden geladen"><div class="skeleton"></div><div class="skeleton"></div></div>`);
      return;
    }
    const v = vakSchooljaren(s.jaren, vandaag());
    const rijen = [...s.jaren].sort((a, b) => (a.schooljaar < b.schooljaar ? 1 : -1));
    const bedrag = (cent) => (typeof cent === "number" ? euro(cent) : html`<span class="muted">nog in te vullen</span>`);
    const toon = gekozen();
    zet(doel, html`
      <div class="${"mt-jvak" + (v.dringend ? " dringend" : "")}">
        <span>${v.tekst}</span>
        <button class="${"btn btn-sm " + (v.soort === "aanmaken" && v.dringend ? "btn-primary" : "btn-ghost")}" type="button" data-doe="${v.soort}">${v.knop}</button>
      </div>
      ${rijen.length ? html`
        <table class="mt-tabel mt-jarentabel">
          <caption class="sr-only">De schooljaren met hun plafonds</caption>
          <thead><tr><th scope="col">Schooljaar</th><th scope="col" class="num">Kleuterschool</th><th scope="col" class="num">Lagere school</th><th scope="col">Stand</th></tr></thead>
          <tbody>${rijen.map((j) => html`
            <tr><th scope="row">${j.schooljaar}</th><td class="num">${bedrag(j.plafond_kleuter_cent)}</td><td class="num">${bedrag(j.plafond_lager_cent)}</td>
              <td><span class="${"pill " + (STANDKLEUR[j.stand] || "muted")}">${STANDNAAM[j.stand] || j.stand}</span></td></tr>`)}
          </tbody>
        </table>` : html`<div class="mt-leeg">Er zijn nog geen schooljaren.</div>`}
      ${toon ? html`
        <div class="mt-lijstvoet mt-instvoet">
          <span><b>${"Terugbetaling aan schoolverlaters in " + toon.schooljaar + ": niet tot en met"}</b></span>
          <span>${"Kleuterschool: "}${bedrag(toon.marge_kleuter_cent)}${" · Lagere school: "}${bedrag(toon.marge_lager_cent)}</span>
          <span>Een bedrag, geen percentage. Het geldt enkel voor wie de school verlaat; wie blijft, krijgt altijd een credit op de volgende factuur.</span>
        </div>` : null}`);
  }

  function tekenZwemjaar() {
    const doel = vak("zwemjaar");
    const toon = s.fout ? null : gekozen();
    doel.hidden = !toon;
    if (!toon) {
      doel.replaceChildren();
      return;
    }
    zet(doel, html`
      <h3 class="legend" id="instZwemTitel"><span class="dot" aria-hidden="true"></span>${"Gratis zwemjaar in " + toon.schooljaar}</h3>
      <dl class="mt-instdl">
        <div><dt>Leerjaar</dt><dd>${zwemAntwoord("gratis_zwemjaar_leerjaar", toon.gratis_zwemjaar_leerjaar)}</dd></div>
        <div><dt>Rekent het zwembad de toegang voor dat leerjaar aan?</dt><dd>${zwemAntwoord("gratis_zwemjaar_toegang_aangerekend", toon.gratis_zwemjaar_toegang_aangerekend)}</dd></div>
        <div><dt>De bus van dat leerjaar</dt><dd>${zwemAntwoord("gratis_zwemjaar_bus", toon.gratis_zwemjaar_bus)}</dd></div>
      </dl>
      <p class="hint">Geldt voor lopende activiteiten met het vakje "zwemmen". Rekent het zwembad de toegang niet aan, dan kost ze niets, ook niet voor de school.</p>
      <p class="hint">De bedragen en het gratis zwemjaar van een gestart schooljaar wijzigen kan vanaf de volgende versie van de MT.</p>`);
  }

  // ---------- Het formulier van een nieuw schooljaar ----------

  const veldId = (kolom) => "sjf-" + kolom;

  function tekenFormulier() {
    const doel = vak("formulier");
    const rij = nieuw();
    doel.hidden = !rij || !s.formOpen;
    if (!rij || !s.formOpen) {
      doel.replaceChildren();
      return;
    }
    const vorig = vorigVanNieuw();
    zet(doel, html`
      <div class="mt-jkop">
        <h3 id="instFormTitel" tabindex="-1">${"Nieuw schooljaar " + rij.schooljaar}</h3>
        <span class="pill open">In te vullen</span>
      </div>
      <p class="mt-jintro">${"Vul in wat in " + rij.schooljaar + " geldt. "
        + (vorig ? "Onder elk veld staat in het klein wat in " + vorig.schooljaar + " gold: neem het over, of wijk bewust af. " : "")
        + "Alles wordt meteen bewaard; met \"Sluiten\" werk je later verder."}</p>
      <div class="mt-jgroepen">
        <fieldset class="mt-jgroep">
          <legend class="legend">Scherpe maximumfactuur</legend>
          <p class="hint">Het plafond per leerling, en tot welk bedrag een schoolverlater niets terugkrijgt.</p>
          <div class="mt-jvelden">${BEDRAGEN.map((b) => html`
            <div class="field mt-jveld" data-veld="${b.kolom}">
              <label for="${veldId(b.kolom)}">${b.label}</label>
              <span class="euro-field mt-jeuro"><span class="pre" aria-hidden="true">€</span><input id="${veldId(b.kolom)}" class="ctrl num" type="text" inputmode="decimal" autocomplete="off" placeholder="0,00" data-bedrag="${b.kolom}" aria-describedby="${veldId(b.kolom) + "-fout " + veldId(b.kolom) + "-hint"}"></span>
              <p class="ferr" id="${veldId(b.kolom) + "-fout"}" data-fout hidden></p>
              <p class="hint mt-jhint" id="${veldId(b.kolom) + "-hint"}" data-hint></p>
            </div>`)}
          </div>
        </fieldset>
        <fieldset class="mt-jgroep">
          <legend class="legend">Gratis zwemjaar</legend>
          <p class="hint">Geldt voor lopende activiteiten met het vakje "zwemmen". Rekent het zwembad de toegang niet aan, dan kost ze niets, ook niet voor de school.</p>
          <div class="mt-jvragen">${ZWEMVRAGEN.map((z) => html`
            <div class="mt-jvraag" data-veld="${z.kolom}">
              <span class="flabel" id="${veldId(z.kolom)}">${z.vraag}</span>
              <span class="seg sm" role="group" aria-labelledby="${veldId(z.kolom)}">${z.keuzes.map((k) => html`<button type="button" data-doe="kies" data-kolom="${z.kolom}" data-waarde="${String(k.waarde)}">${k.tekst}</button>`)}</span>
              <span class="hint mt-jhint" data-hint></span>
            </div>`)}
          </div>
        </fieldset>
      </div>
      <div class="mt-jvoet">
        <div class="mt-jstand"><b data-vak="ontbreekt"></b><span class="hint" data-vak="bewaard" role="status"></span></div>
        <div class="mt-jknoppen">
          <button class="btn-link" type="button" data-doe="sluit-formulier">Sluiten</button>
          <button class="btn btn-primary" type="button" data-doe="bevestig">Aanmaak nieuw schooljaar bevestigen</button>
        </div>
        <p class="hint mt-jnota" data-vak="nota"></p>
      </div>`);
    for (const b of BEDRAGEN) werkVeldBij(b.kolom, true);
    for (const z of ZWEMVRAGEN) werkVeldBij(z.kolom, true);
    werkVoetBij(null);
  }

  /** Eén veld van het formulier bijwerken met wat in de databank staat. Zo blijft wat iemand intussen elders intikt, staan. */
  function werkVeldBij(kolom, ookWaarde = false) {
    const rij = nieuw();
    const blok = q('[data-veld="' + kolom + '"]');
    if (!rij || !blok) return;
    const vorig = vorigVanNieuw();
    const waarde = rij[kolom];
    const hint = blok.querySelector("[data-hint]");
    if (BEDRAGEN.some((b) => b.kolom === kolom)) {
      const veld = blok.querySelector("input");
      // Wie op dit moment in het veld tikt, houdt wat er staat.
      if (ookWaarde || document.activeElement !== veld) veld.value = bedragTekst(waarde);
      toonVeldFout(kolom, null);
      const h = hintBedrag(vorig, kolom, waarde);
      blok.classList.toggle("leeg", waarde === null);
      blok.classList.toggle("anders", Boolean(h && h.anders));
      zet(hint, h ? html`${h.tekst}${h.overnemen ? html` · <button class="btn-link" type="button" data-doe="neem" data-kolom="${kolom}">overnemen</button>` : null}${h.anders ? html`<span class="mt-janders">${"Anders dan in " + vorig.schooljaar}</span>` : null}` : null);
      hint.hidden = !h;
      return;
    }
    for (const knop of blok.querySelectorAll("[data-waarde]")) {
      const aan = knop.dataset.waarde === String(waarde);
      knop.classList.toggle("on", aan);
      knop.setAttribute("aria-pressed", String(aan));
    }
    blok.classList.toggle("leeg", waarde === null);
    zet(hint, vorig ? vorig.schooljaar + ": " + zwemAntwoord(kolom, vorig[kolom]) : null);
    hint.hidden = !vorig;
  }

  /** De voet van het formulier: wat nog ontbreekt, of bevestigen al kan, en wat net bewaard is. */
  function werkVoetBij(bewaard) {
    const rij = nieuw();
    const doel = q('[data-vak="ontbreekt"]');
    if (!rij || !doel) return;
    const open = ontbreekt(rij).length;
    doel.textContent = ontbreektTekst(open);
    doel.classList.toggle("klaar", open === 0);
    const knop = q('[data-doe="bevestig"]');
    knop.disabled = s.bezig || open > 0 || !magStarten(rij.schooljaar, vandaag());
    q('[data-vak="nota"]').textContent = notaStarten(rij.schooljaar, lopend() ? lopend().schooljaar : null, vandaag());
    if (bewaard !== undefined) q('[data-vak="bewaard"]').textContent = bewaard || "";
  }

  function toonVeldFout(kolom, tekst) {
    const blok = q('[data-veld="' + kolom + '"]');
    if (!blok) return;
    const fout = blok.querySelector("[data-fout]");
    const veld = blok.querySelector("input");
    if (!fout || !veld) return;
    fout.textContent = tekst || "";
    fout.hidden = !tekst;
    veld.classList.toggle("invalid", Boolean(tekst));
    if (tekst) veld.setAttribute("aria-invalid", "true");
    else veld.removeAttribute("aria-invalid");
  }

  function openFormulier() {
    if (!nieuw()) return;
    s.formOpen = true;
    tekenFormulier();
    const titel = q("#instFormTitel");
    if (titel) titel.focus();
  }

  function sluitFormulier() {
    s.formOpen = false;
    tekenFormulier();
    const knop = q('[data-doe="invullen"]');
    if (knop) knop.focus();
  }

  function sluitGestart() {
    s.gestart = null;
    tekenGestart();
    const titel = q("h2");
    if (titel) titel.focus();
  }

  // ---------- Bewaren ----------

  function bewaarBedrag(veld) {
    const kolom = veld.dataset.bedrag;
    const gelezen = bedragUit(veld.value);
    if (!gelezen.ok) {
      toonVeldFout(kolom, "Geef een bedrag in euro, zoals 55 of 55,50.");
      return;
    }
    if (gelezen.cent !== null && gelezen.cent > MAX_BEDRAG_CENT) {
      toonVeldFout(kolom, "Dat bedrag is hoger dan " + euro(MAX_BEDRAG_CENT) + ". Kijk het na.");
      return;
    }
    bewaar(kolom, gelezen.cent);
  }

  function neemOver(kolom) {
    const vorig = vorigVanNieuw();
    if (!vorig || typeof vorig[kolom] !== "number") return;
    bewaar(kolom, vorig[kolom], true);
  }

  function kies(kolom, tekst) {
    const vraagVan = ZWEMVRAGEN.find((z) => z.kolom === kolom);
    const keuze = vraagVan ? vraagVan.keuzes.find((k) => String(k.waarde) === tekst) : null;
    if (keuze) bewaar(kolom, keuze.waarde);
  }

  /** Bewaart één veld van het schooljaar dat in te vullen is, en toont wat de databank teruggeeft. */
  function bewaar(kolom, waarde, ookWaarde = false) {
    return naElkaar(async () => {
      const rij = nieuw();
      if (!rij) return;
      if (rij[kolom] === waarde) {
        werkVeldBij(kolom, true);
        return;
      }
      const r = await data.wijzig("schooljaren", { sleutel: { schooljaar: rij.schooljaar }, wijziging: { [kolom]: waarde }, als: { stand: "in_te_vullen" }, kolommen: [...KOLOMMEN] });
      if (r.ok) {
        s.jaren = s.jaren.map((j) => (j.schooljaar === r.gegevens.schooljaar ? r.gegevens : j));
        werkVeldBij(kolom, ookWaarde);
        werkVoetBij(bewaardTekst(kolom, r.gegevens[kolom]));
        tekenJaren();
        return;
      }
      if (!(await nogBinnen(r))) return;
      if (r.soort === "gewijzigd") {
        meld("Dit schooljaar wijzigde intussen. De MT toont wat er nu staat.", "err");
        await laad();
        return;
      }
      if (r.extra && r.extra.onbekend) {
        // Niet zeker of het bewaard is: het scherm leest wat er nu staat.
        const gelezen = await laad();
        meld(gelezen ? "De MT kreeg geen antwoord bij het bewaren. Het scherm toont wat er nu in de databank staat: kijk het na." : r.tekst, "err");
        return;
      }
      if (BEDRAGEN.some((b) => b.kolom === kolom)) toonVeldFout(kolom, "Niet bewaard. " + r.tekst);
      else meld("Niet bewaard. " + r.tekst, "err");
    });
  }

  // ---------- Aanmaken en starten ----------

  async function maakAan(knop) {
    const schooljaar = teMaken(s.jaren, vandaag());
    if (!schooljaar || s.bezig) return;
    s.bezig = true;
    const klaar = knopBezig(knop, "Bezig…");
    const r = await data.voegToe("schooljaren", nieuweRij(schooljaar, vorigVan(s.jaren, schooljaar)), { kolommen: [...KOLOMMEN] });
    klaar();
    s.bezig = false;
    if (r.ok) {
      s.jaren = [...s.jaren.filter((j) => j.schooljaar !== r.gegevens.schooljaar), r.gegevens];
      s.formOpen = true;
      // Het formulier dat opent, is zelf de bevestiging: geen melding erbovenop.
      tekenAlles();
      const eerste = q('[data-bedrag="' + BEDRAGEN[0].kolom + '"]');
      if (eerste) eerste.focus();
      return;
    }
    if (!(await nogBinnen(r))) return;
    // Bestaat het al, of kwam er geen antwoord: lezen wat er nu staat.
    if (r.soort === "gewijzigd" || (r.extra && r.extra.onbekend)) {
      const gelezen = await laad();
      if (gelezen && nieuw()) {
        openFormulier();
        meld(r.soort === "gewijzigd" ? "Dit schooljaar was al aangemaakt. Vul het verder in." : "De MT kreeg geen antwoord, maar het schooljaar is aangemaakt. Vul het in.", r.soort === "gewijzigd" ? "" : "ok");
        return;
      }
    }
    meld("Het schooljaar is niet aangemaakt. " + r.tekst, "err");
  }

  /** "Aanmaak nieuw schooljaar bevestigen": één poging tegelijk, ook als iemand twee keer klikt. */
  async function bevestig() {
    if (!nieuw() || s.bezig) return;
    s.bezig = true;
    const gestart = await probeerStart();
    s.bezig = false;
    if (!gestart) werkVoetBij();
  }

  /** Vraagt het, en start het schooljaar. Geeft true als het gestart is. */
  async function probeerStart() {
    // Eerst alles wat nog bewaard wordt: de databank beslist op wat er echt staat.
    await wachtrij;
    const rij = nieuw();
    if (!rij || ontbreekt(rij).length || !magStarten(rij.schooljaar, vandaag())) return false;
    const vorig = lopend() ? lopend().schooljaar : null;
    const v = vraagStarten(rij.schooljaar, vorig);
    if (!(await vraag({ titel: v.titel, tekst: html`${v.tekst} <strong class="mt-definitief">${v.slot}</strong>`, ja: v.ja, nee: v.nee }))) return false;
    // Tijdens het starten wijzigt er niets meer in het formulier.
    const klaar = knopBezig(q('[data-doe="bevestig"]'), "Bezig met starten…");
    const vrij = bevries(vak("formulier"));
    const los = () => {
      vrij();
      klaar();
    };
    const r = await data.rpc("mt_schooljaar_bevestigen", { p_schooljaar: rij.schooljaar });
    if (r.ok) {
      const g = r.gegevens && typeof r.gegevens === "object" ? r.gegevens : {};
      await naStart({ schooljaar: rij.schooljaar, vorig: typeof g.vorig === "string" ? g.vorig : null, open: Number.isInteger(g.open_lijsten_vorig) ? g.open_lijsten_vorig : null });
      return true;
    }
    if (!(await nogBinnen(r))) return false;
    // Geen antwoord, of iemand startte het intussen: lezen wat er nu staat.
    if (r.soort === "verbinding" || r.soort === "gewijzigd") {
      const gelezen = await laad();
      const nu = s.jaren.find((j) => j.schooljaar === rij.schooljaar);
      if (gelezen && nu && nu.stand === "lopend") {
        await naStart({ schooljaar: rij.schooljaar, vorig, open: null });
        return true;
      }
      if (!gelezen) los();
      meld(r.soort === "gewijzigd" ? r.tekst
        : gelezen ? "Het schooljaar is niet gestart: de MT kreeg geen antwoord. Probeer het opnieuw."
        : "De MT kreeg geen antwoord: het is niet zeker of het schooljaar gestart is. Controleer je verbinding en open Instellingen opnieuw.", "err");
      return false;
    }
    los();
    meld("Het schooljaar is niet gestart. " + r.tekst, "err");
    return false;
  }

  /** Het schooljaar is gestart: de kop, het account en de uitstappentool volgen, en het scherm leest opnieuw. */
  async function naStart(info) {
    const lezing = await opGestart();
    s.gestart = { ...info, lezing };
    s.formOpen = false;
    await laad();
    tekenGestart();
    const melding = q(".mt-gestart");
    if (melding) melding.focus();
  }

  /** Het schooljaar in de kop wijzigde: de blokken per schooljaar volgen. */
  function jaarGewijzigd() {
    herrekenBeheerders();
    if (s.beheer.bron && !s.beheer.fout) tekenBeheerders();
    if (!s.laden && !s.fout) {
      tekenJaren();
      tekenZwemjaar();
    }
  }

  laad();
  const titel = q("h2");
  if (titel) titel.focus();
  return { herlaad: laad, jaarGewijzigd };
}
