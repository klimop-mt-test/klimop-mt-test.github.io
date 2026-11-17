// MT · uitstappentool.js · versie 0.9.0
// Wat de MT uit de uitstappentool leest, op de startpagina van de testversie (stap 3; hoofdstuk 4, B212).
//
// De pagina leest de uitstappentool niet zelf (review 2). Bij het openen vraagt ze de serverfunctie
// mt-uitstappen om de uitstappentool te lezen en de MT bij te werken. Het antwoord zegt wat de functie
// las (het overzicht per schooljaar) en wat de databank ermee deed: alles wat hier staat, komt dus uit
// één lezing. Las de MT minder dan een halve minuut geleden, of leest ze op dat moment al, dan komt de
// uitkomst van die lezing terug. Daarna leest de MT opnieuw als je erom vraagt, of als je na een tijd
// naar het tabblad terugkeert.
//
// Wat hier gemeld wordt, is afgeleid en nergens bewaard (64.4): een klas die de MT niet kent, een
// uitstap met een onbekende schemaversie. Is het opgelost, dan verdwijnt de melding vanzelf. Eén melding
// vraagt een handeling: verdwijnen er veel uitstappen tegelijk, dan telt de MT ze verder mee tot een
// beheerder bevestigt dat ze echt weg zijn (B225).
//
// Bovenaan staat wat zonder browser te testen valt; daaronder het blok op de startpagina. De echte
// schermen met de uitstappen volgen in stap 5 en 6.

import { UITSTAPFUNCTIE, UITSTAPFUNCTIE_VERSIE } from "./config.js";
import * as data from "./data.js";
import { REKENVERSIE } from "./rekenen.js";
import { datumEnUur, html, knopBezig, meld, vraag, zet } from "./ui.js";

export const VERSIE = "0.9.0";

/** Na zoveel minuten leest de MT opnieuw als je naar het tabblad terugkeert. */
const OPNIEUW_NA_MINUTEN = 10;
/** Zoveel verdwenen uitstappen noemt de melding bij naam van hun datum; de rest telt ze. */
const MAX_NOEMEN = 10;

// ---------- Zonder browser te testen ----------

const telwoord = (n, een, meer) => n + " " + (n === 1 ? een : meer);
const klein = (tekst) => tekst.charAt(0).toLowerCase() + tekst.slice(1);

/** Een opsomming als zin: "a", "a en b", "a, b en c". */
function opsomming(delen) {
  if (delen.length < 2) return delen.join("");
  return delen.slice(0, -1).join(", ") + " en " + delen[delen.length - 1];
}

/** Een kalenderdatum jjjj-mm-dd als dd/mm/jjjj. */
function dag(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return m ? m[3] + "/" + m[2] + "/" + m[1] : "zonder datum";
}

/** Eén uitstap is "hem", meer uitstappen zijn "ze". */
const hemOfZe = (aantal) => (aantal === 1 ? "hem" : "ze");

/**
 * De klassen die de MT niet kent, per schooljaar en per naam, met het aantal uitstappen:
 * [{ schooljaar, naam, aantal }]. Het jongste schooljaar eerst, en daarbinnen de meeste uitstappen eerst.
 * lijst is wat de serverfunctie teruggeeft: [{ uitstap, schooljaar, klassen: [namen] }].
 */
export function onbekendeKlassen(lijst) {
  const tel = new Map();
  for (const item of Array.isArray(lijst) ? lijst : []) {
    const schooljaar = item && typeof item.schooljaar === "string" ? item.schooljaar : "";
    for (const naam of new Set(item && Array.isArray(item.klassen) ? item.klassen : [])) {
      const sleutel = schooljaar + "\n" + naam;
      if (!tel.has(sleutel)) tel.set(sleutel, { schooljaar, naam, aantal: 0 });
      tel.get(sleutel).aantal++;
    }
  }
  return [...tel.values()].sort((a, b) => {
    if (a.schooljaar !== b.schooljaar) return a.schooljaar < b.schooljaar ? 1 : -1;
    return b.aantal - a.aantal || (a.naam < b.naam ? -1 : 1);
  });
}

/**
 * Waarom het bijwerken niet lukte, in gewone taal. Een beheerder leest erbij wat hij eraan doet; wie
 * geen beheerder is, leest wat het voor hem betekent, zonder de namen van de techniek (review 2: R2-15).
 * Brak het bijwerken af terwijl een deel al bewaard kan zijn, dan zegt de zin dat, en nooit dat er niets
 * gewijzigd is (review 2: R07).
 */
function zinBijFout(functie, beheerder) {
  const plak = " Plak functies/" + UITSTAPFUNCTIE + "/index.ts in Supabase, bij Edge Functions.";
  const meldHet = " Blijft dit zo, meld het dan aan de beheerder.";
  const nuNiet = "De MT kon de uitstappen nu niet bijwerken.";
  if (functie.soort === "ontbreekt") return beheerder ? functie.tekst + plak : nuNiet + " Meld het aan de beheerder.";
  if (functie.soort === "verbinding") {
    return "De MT kreeg geen antwoord op de vraag om de uitstappen bij te werken: de uitkomst is niet bekend."
      + (beheerder
        ? " Staat de serverfunctie " + UITSTAPFUNCTIE + " nog niet in Supabase, plak dan functies/" + UITSTAPFUNCTIE + "/index.ts bij Edge Functions. Anders is het de verbinding: probeer het opnieuw."
        : " Controleer je internetverbinding en probeer het opnieuw." + meldHet);
  }
  if (functie.extra && functie.extra.deels) {
    return "Het bijwerken van de uitstappen is niet voltooid: een deel kan al bewaard zijn. Probeer het opnieuw: de MT vult dan aan."
      + (beheerder ? " De reden: " + klein(functie.tekst) : meldHet);
  }
  if (functie.soort === "bron") return functie.tekst;
  if (functie.soort === "ingehaald") return "Terwijl de MT de uitstappentool las, begon ze aan een nieuwere lezing. Die geldt: deze lezing heeft niets gewijzigd. Probeer het zo meteen opnieuw.";
  if (functie.soort === "sessie" || functie.soort === "rechten") {
    return (beheerder
      ? "De serverfunctie " + UITSTAPFUNCTIE + " aanvaardt je aanmelding niet: de MT is nu niet bijgewerkt met de uitstappentool."
      : "De MT kon de uitstappen nu niet bijwerken: je aanmelding werd niet aanvaard.") + " Meld af en opnieuw aan." + meldHet;
  }
  if (functie.soort === "kan_niet") return "De MT is niet bijgewerkt met de uitstappentool: " + klein(functie.tekst);
  return beheerder ? "De MT is nu niet bijgewerkt met de uitstappentool. " + functie.tekst : nuNiet + " Probeer het later opnieuw." + meldHet;
}

/** Eén verdwenen uitstap, zoals de beheerder hem herkent: de datum, en de klassen als de MT ze kent. */
function zinVerdwenen(u) {
  const wanneer = u.tot && u.tot !== u.van ? dag(u.van) + " tot " + dag(u.tot) : dag(u.van);
  const klassen = Array.isArray(u.klassen) ? u.klassen.filter((naam) => typeof naam === "string" && naam) : [];
  return wanneer + (klassen.length ? " (" + klassen.join(", ") + ")" : "");
}

/**
 * De regels onder de tabel: wat de serverfunctie deed, en wat aandacht vraagt. Elke regel is
 * { soort, tekst }, met als soort "info", "let_op" of "fout". Een regel met knop: "verdwenen" vraagt een
 * handeling van de beheerder (B225).
 *   functie     het antwoord van data.uitstappenBijwerken()
 *   rol         de rol van wie aangemeld is
 *   schooljaar  het lopende schooljaar in de MT, of null
 */
export function regels({ functie, rol, schooljaar }) {
  const beheerder = rol === "beheerder";
  if (!functie.ok) return [{ soort: "fout", tekst: zinBijFout(functie, beheerder) }];
  const g = functie.gegevens;
  const voorop = [];
  const uit = [];

  // De serverfunctie in Supabase is niet die van deze versie: ze las met andere code dan de pagina verwacht.
  if (g.versie !== UITSTAPFUNCTIE_VERSIE || g.rekenversie !== REKENVERSIE) {
    voorop.push({
      soort: "let_op",
      tekst: beheerder
        ? "In Supabase staat versie " + (g.versie || "onbekend") + " van de serverfunctie " + UITSTAPFUNCTIE + "; deze versie van de MT verwacht " + UITSTAPFUNCTIE_VERSIE
          + ". Plak functies/" + UITSTAPFUNCTIE + "/index.ts opnieuw in Supabase, bij Edge Functions."
        : "De MT is nog niet helemaal bijgewerkt naar haar nieuwste versie: wat hier staat, kan onvolledig zijn. Meld het aan de beheerder.",
    });
  }

  // Er loopt een lezing, en er is nog geen vorige om te tonen.
  if (!g.uitstappen || typeof g.uitstappen !== "object") {
    return [...voorop, { soort: "info", tekst: "De MT leest de uitstappentool op dit moment. Probeer het over enkele seconden opnieuw." }];
  }
  const u = g.uitstappen;
  const n = (naam) => (Number.isInteger(u[naam]) ? u[naam] : 0);

  // Wat de databank deed.
  const gevolgd = n("nieuw") + n("gewijzigd") + n("ongewijzigd");
  if (gevolgd || n("weg") || n("niet_gevonden") || n("tegengehouden")) {
    const delen = [];
    if (n("nieuw")) delen.push(n("nieuw") + " nieuw");
    if (n("gewijzigd")) delen.push(n("gewijzigd") + " gewijzigd");
    if (n("ongewijzigd")) delen.push(n("ongewijzigd") + " ongewijzigd");
    uit.push({ soort: "info", tekst: "De MT volgt " + telwoord(gevolgd, "uitstap", "uitstappen") + (delen.length ? ": " + opsomming(delen) + "." : ".") });
  } else if (!schooljaar) {
    uit.push({
      soort: "info",
      tekst: beheerder
        ? "In de MT is er nog geen lopend schooljaar: de uitstappen wachten tot het aangemaakt en gestart is. Dat doe je in Instellingen."
        : "De MT volgt de uitstappen zodra de beheerder het schooljaar aanmaakt.",
    });
  } else {
    uit.push({ soort: "info", tekst: "De MT volgt nog geen uitstappen van " + schooljaar + "." });
  }
  if (n("weg")) uit.push({ soort: "info", tekst: telwoord(n("weg"), "uitstap is", "uitstappen zijn") + " in de uitstappentool verwijderd of een nascholing geworden: de MT telt ze niet meer mee." });
  if (n("niet_gevonden")) uit.push({ soort: "let_op", tekst: telwoord(n("niet_gevonden"), "uitstap staat", "uitstappen staan") + " niet meer in de uitstappentool: de MT telt ze niet meer mee." });

  // De rem (B225): ongewoon veel uitstappen verdwenen tegelijk. De MT neemt dat niet zomaar over.
  if (n("tegengehouden")) {
    const tegen = n("tegengehouden");
    if (beheerder) {
      const lijst = (Array.isArray(g.verdwenen) ? g.verdwenen : []).slice(0, MAX_NOEMEN).map(zinVerdwenen);
      const rest = tegen - lijst.length;
      const welke = lijst.length ? ": " + lijst.join(", ") + (rest > 0 ? ", en " + telwoord(rest, "andere", "andere") : "") : "";
      const regel = {
        soort: "let_op",
        tekst: telwoord(tegen, "uitstap die de MT nog meetelde, staat", "uitstappen die de MT nog meetelden, staan") + " niet meer in de uitstappentool" + welke
          + ". Dat zijn er te veel om zomaar over te nemen: de MT telt ze verder mee. Kijk in de uitstappentool na of ze echt weg zijn.",
      };
      if (typeof g.verdwenen_taak === "string" && g.verdwenen_taak) regel.knop = "verdwenen";
      uit.push(regel);
    } else {
      uit.push({ soort: "let_op", tekst: telwoord(tegen, "uitstap staat", "uitstappen staan") + " niet meer in de uitstappentool. Dat zijn er veel tegelijk: de MT telt ze verder mee tot een beheerder dit nakijkt." });
    }
  }
  if (n("buiten") && (gevolgd || schooljaar)) {
    uit.push({ soort: "info", tekst: telwoord(n("buiten"), "uitstap valt", "uitstappen vallen") + " buiten de schooljaren die in de MT open staan." });
  }
  if (n("ongeldig")) {
    uit.push({ soort: "let_op", tekst: telwoord(n("ongeldig"), "uitstap heeft", "uitstappen hebben") + " geen geldige datum of gegevens: de MT neemt " + hemOfZe(n("ongeldig")) + " niet over. Kijk " + hemOfZe(n("ongeldig")) + " na in de uitstappentool." });
  }

  // Wat aandacht vraagt.
  if (Array.isArray(g.onbruikbaar) && g.onbruikbaar.length) {
    uit.push({
      soort: "let_op",
      tekst: telwoord(g.onbruikbaar.length, "uitstap staat", "uitstappen staan") + " in de uitstappentool in een vorm die de MT niet kan lezen. De MT neemt " + hemOfZe(g.onbruikbaar.length) + " niet over, en houdt wat ze wist."
        + (beheerder ? " Kijk in de uitstappentool na of er een aanvraag bij staat die er niet hoort." : ""),
    });
  }
  if (g.klassen && g.klassen.ok === false && !(g.klassen.melding || "").includes("nog geen lopend schooljaar")) {
    uit.push({ soort: "let_op", tekst: "De klassen zijn niet bijgewerkt: " + g.klassen.melding });
  }
  if (g.klassen && g.klassen.ok === true && (g.klassen.nieuw || g.klassen.gewijzigd || g.klassen.uitgezet)) {
    const delen = [];
    if (g.klassen.nieuw) delen.push(g.klassen.nieuw + " nieuw");
    if (g.klassen.gewijzigd) delen.push(g.klassen.gewijzigd + " gewijzigd");
    if (g.klassen.uitgezet) delen.push(g.klassen.uitgezet + " uitgezet");
    uit.push({ soort: "info", tekst: "De klassen van " + g.klassen.schooljaar + " zijn bijgewerkt: " + opsomming(delen) + "." });
  }
  // Een klas die de MT niet kent: per schooljaar. Enkel de klassen van het lopende schooljaar werkt de MT bij.
  const onbekend = onbekendeKlassen(g.onbekende_klassen);
  for (const jaar of [...new Set(onbekend.map((k) => k.schooljaar))]) {
    const klassen = onbekend.filter((k) => k.schooljaar === jaar);
    const deze = klassen.length === 1 ? "deze klas" : "deze klassen";
    const namen = opsomming(klassen.map((k) => k.naam + " (" + telwoord(k.aantal, "uitstap", "uitstappen") + ")"));
    let tekst = "Klas onbekend" + (jaar ? " in " + jaar : "") + ": " + namen + ". ";
    if (jaar && schooljaar && jaar !== schooljaar) {
      tekst += "Dat is niet het lopende schooljaar: de MT werkt de klassen ervan niet meer bij, en maakt voor " + deze + " geen lijst."
        + (beheerder ? " Klopt de naam niet, verbeter ze dan in de uitstappentool." : "");
    } else {
      tekst += "De MT kent " + deze + " niet in het schooljaar van de uitstap, en maakt er geen lijst voor. "
        + (beheerder ? "Kijk de naam na in de uitstappentool." : "Een nieuwe klas komt erbij zodra een beheerder de MT opent.");
    }
    uit.push({ soort: "let_op", tekst });
  }
  if (Array.isArray(g.wacht) && g.wacht.length) {
    uit.push({ soort: "let_op", tekst: "Bij " + telwoord(g.wacht.length, "uitstap", "uitstappen") + " wijzigde de datum terwijl er al iets vastligt in de MT: de MT houdt de datum van toen, tot de beheerder beslist." });
  }
  if (Array.isArray(g.onbekende_versie) && g.onbekende_versie.length) {
    uit.push({ soort: "let_op", tekst: telwoord(g.onbekende_versie.length, "uitstap heeft", "uitstappen hebben") + " een opbouw die deze versie van de MT niet kent. De MT leest " + hemOfZe(g.onbekende_versie.length) + " niet, en houdt wat ze wist, tot ze bijgewerkt is." });
  }
  // Voor de beheerder: hoe lang de lezing duurde. Via de API stopt een vraag aan de databank na 8 seconden (17.4).
  if (beheerder && Number.isFinite(g.duur_ms) && g.gelezen && Number.isInteger(g.gelezen.uitstappen)) {
    const seconden = (Math.round(g.duur_ms / 100) / 10).toFixed(1).replace(".", ",");
    uit.push({ soort: "info", tekst: "De serverfunctie las " + telwoord(g.gelezen.uitstappen, "uitstap", "uitstappen") + " en werkte de MT bij in " + seconden + " seconden." });
  }
  // Eerst wat er gebeurde, dan wat aandacht vraagt; een oudere serverfunctie blijft bovenaan.
  return [...voorop, ...uit.filter((lijn) => lijn.soort === "info"), ...uit.filter((lijn) => lijn.soort !== "info")];
}

/**
 * Wanneer de MT de uitstappentool las: de regel boven de meldingen. Niets als er nog geen lezing is.
 * Het uur is dat van de lezing zelf, ook als de MT nu niet opnieuw las.
 */
export function zinGelezen(g) {
  const ms = g && typeof g.klaar_op === "string" ? Date.parse(g.klaar_op) : NaN;
  if (Number.isNaN(ms)) return null;
  const telt = " Enkel bevestigde uitstappen tellen mee; aangevraagde komen apart in de prognose.";
  if (g.stand === "bezig") return "De MT leest de uitstappentool op dit moment opnieuw. Hieronder staat de vorige lezing, van " + datumEnUur(ms) + "." + telt;
  if (g.stand === "recent") return "Gelezen op " + datumEnUur(ms) + ". Dat is minder dan een halve minuut geleden: de MT leest niet opnieuw." + telt;
  return "Gelezen op " + datumEnUur(ms) + "." + telt;
}

/** Wat niet in de MT komt, als één zin; niets als er niets is. */
export function zinNietInDeMT(telling) {
  const delen = [];
  if (telling.nascholingen) delen.push(telwoord(telling.nascholingen, "nascholing", "nascholingen"));
  if (telling.verwijderd) delen.push(telwoord(telling.verwijderd, "uitstap in de prullenbak", "uitstappen in de prullenbak"));
  if (telling.zonderDatum) delen.push(telwoord(telling.zonderDatum, "uitstap zonder geldige datum", "uitstappen zonder geldige datum"));
  return delen.length ? "Niet in de tabel, en nooit meegeteld: " + opsomming(delen) + "." : null;
}

/** Het overzicht per schooljaar uit het antwoord van de serverfunctie, of null als het ontbreekt of niet klopt. */
export function overzichtUit(g) {
  const o = g && g.overzicht;
  if (!o || typeof o !== "object" || !Array.isArray(o.jaren)) return null;
  const getal = (waarde) => (Number.isInteger(waarde) && waarde >= 0 ? waarde : 0);
  return {
    jaren: o.jaren.filter((jaar) => jaar && typeof jaar.schooljaar === "string")
      .map((jaar) => ({ schooljaar: jaar.schooljaar, bevestigd: getal(jaar.bevestigd), aangevraagd: getal(jaar.aangevraagd), geannuleerd: getal(jaar.geannuleerd) })),
    nascholingen: getal(o.nascholingen),
    verwijderd: getal(o.verwijderd),
    zonderDatum: getal(o.zonderDatum),
  };
}

/** De vraag aan de beheerder vóór hij bevestigt dat de uitstappen echt weg zijn (B225). */
export function vraagVerdwenen(aantal) {
  return {
    titel: "Echt weg?",
    tekst: telwoord(aantal, "uitstap staat", "uitstappen staan") + " niet meer in de uitstappentool. Bevestig je, dan telt de MT "
      + hemOfZe(aantal) + " niet meer mee. Wat er al bij ingegeven was, blijft bewaard. Staat een uitstap later weer in de uitstappentool, dan telt de MT hem opnieuw mee.",
    ja: "Ja, ze zijn echt weg",
    nee: "Nee, nog niet",
  };
}

/** Weigert dit antwoord de aanmelding: niet (meer) aangemeld, of geen rechten? */
const weigertAanmelding = (antwoord) => Boolean(antwoord) && antwoord.ok === false && (antwoord.soort === "sessie" || antwoord.soort === "rechten");

/**
 * Herladen of niet, als de serverfunctie de aanmelding weigert? De databank beslist. Weigert ook zij, dan
 * herlaadt de pagina, en vraagt het aanmeldscherm wat nodig is. Aanvaardt zij de aanmelding, of antwoordt
 * ze niet, dan herlaadt de pagina niet: anders zou ze blijven herladen. De melding zegt dan wat er scheelt.
 *   functie   het antwoord van de serverfunctie
 *   databank  het antwoord van mt_mijn_account, of null als dat niet gevraagd is
 */
export function moetHerstarten(functie, databank) {
  return weigertAanmelding(functie) && weigertAanmelding(databank);
}

/** Moet de MT de databank vragen of de aanmelding nog in orde is? Enkel als de serverfunctie ze weigert. */
export function moetNavragen(functie) {
  return weigertAanmelding(functie);
}

/**
 * Leest de MT opnieuw bij het terugkeren naar het tabblad? Enkel als het tabblad zichtbaar is, er al een
 * vraag was, en die langer dan tien minuten geleden is: niet bij elk wisselen van tabblad.
 */
export function opnieuwNodig({ verborgen, gevraagdOp, nu }) {
  return !verborgen && gevraagdOp !== null && nu - gevraagdOp > OPNIEUW_NA_MINUTEN * 60000;
}

/**
 * Eén tegelijk, en daarna nog één keer als er intussen opnieuw om gevraagd is: wat al onderweg was, kan van
 * vóór die vraag zijn, bv. van vóór de start van een schooljaar. Geeft een functie; elke oproep ervan geeft
 * de belofte van de lopende reeks, met de uitkomst van het laatste werk. Geeft werk() false terug, dan
 * volgt er niets meer.
 */
export function eenTegelijk(werk) {
  let lopend = null;
  let nogEens = false;
  return () => {
    if (lopend) {
      nogEens = true;
      return lopend;
    }
    lopend = (async () => {
      let uit;
      let verder = true;
      while (verder) {
        nogEens = false;
        uit = await werk();
        verder = uit !== false && nogEens;
      }
      return uit;
    })().finally(() => {
      lopend = null;
    });
    return lopend;
  };
}

// ---------- Het blok op de startpagina ----------

/**
 * Start het blok in een onderdeel van de pagina.
 *   deel      het element van het blok
 *   account   wie aangemeld is (mt_mijn_account)
 *   herstart  de pagina opnieuw laden: het aanmeldscherm vraagt dan wat nodig is
 * Geeft { herlaad }: herlaad() vraagt een nieuwe lezing en geeft een belofte met het antwoord van de
 * serverfunctie, of false als de pagina herlaadt. account wordt bij elke tekening opnieuw gelezen: wijzigt
 * het lopende schooljaar, dan volgt het blok.
 */
export function start({ deel, account, herstart }) {
  // functie: het laatste antwoord. goed: het laatste antwoord met een lezing erin: dat blijft staan als een latere vraag geen lezing meebrengt.
  const s = { bezig: false, gevraagdOp: null, functie: null, goed: null };

  deel.hidden = false;
  zet(deel, html`
    <div class="mt-lijstkop">
      <h3 id="bronTitel">Uitstappentool</h3>
      <button class="btn btn-ghost btn-sm" type="button" data-doe="opnieuw">Opnieuw lezen</button>
    </div>
    <div data-vak="inhoud"></div>`);
  const vak = deel.querySelector('[data-vak="inhoud"]');
  const knop = deel.querySelector('[data-doe="opnieuw"]');
  knop.addEventListener("click", () => ververs());
  vak.addEventListener("click", (gebeurtenis) => {
    const doel = gebeurtenis.target instanceof Element ? gebeurtenis.target.closest('[data-doe="verdwenen"]') : null;
    if (doel) bevestigVerdwenen(doel);
  });

  function teken() {
    knop.disabled = s.bezig;
    if (!s.functie) {
      zet(vak, html`<div class="mt-laadt" role="status" aria-label="De uitstappentool wordt gelezen"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`);
      return;
    }
    const klasse = { info: "mt-bronregel", let_op: "mt-bronregel let-op", fout: "mt-bronregel fout" };
    const context = { rol: account.rol, schooljaar: account.schooljaar || null };
    // Bracht het laatste antwoord geen lezing mee (een fout, of de MT leest nog), dan staat dat bovenaan, en
    // blijft de vorige lezing eronder staan, zonder haar knoppen: een handeling hoort bij de stand van nu.
    const actueel = s.goed === s.functie;
    const nu = actueel ? [] : regels({ functie: s.functie, ...context });
    const lijnen = s.goed ? regels({ functie: s.goed, ...context }).map((lijn) => (actueel ? lijn : { soort: lijn.soort, tekst: lijn.tekst })) : [];
    const regel = (lijn) => html`<p class="${klasse[lijn.soort]}">${lijn.tekst}${lijn.knop === "verdwenen"
      ? html` <button class="btn btn-ghost btn-sm" type="button" data-doe="verdwenen">Ze zijn echt weg</button>` : null}</p>`;
    const bovenaan = nu.map((lijn) => (lijn.soort === "fout" ? html`<div class="form-alert mt-lijstfout" role="alert"><span>${lijn.tekst}</span></div>` : regel(lijn)));
    const g = s.goed ? s.goed.gegevens : null;
    const telling = overzichtUit(g);
    if (!telling) {
      zet(vak, html`${bovenaan}<div class="mt-lijstvoet">${lijnen.map(regel)}</div>`);
      return;
    }
    const gelezen = zinGelezen(g);
    const niet = zinNietInDeMT(telling);
    zet(vak, html`
      ${bovenaan}
      ${telling.jaren.length ? html`
        <table class="mt-tabel">
          <caption class="sr-only">Uitstappen in de uitstappentool, per schooljaar</caption>
          <thead><tr><th scope="col">Schooljaar</th><th scope="col" class="num">Bevestigd</th><th scope="col" class="num">Aangevraagd</th><th scope="col" class="num">Geannuleerd</th></tr></thead>
          <tbody>${telling.jaren.map((jaar) => html`
            <tr><th scope="row">${jaar.schooljaar}${jaar.schooljaar === account.schooljaar ? html` <span class="pill sm info">lopend in de MT</span>` : null}</th>
              <td class="num">${jaar.bevestigd}</td><td class="num">${jaar.aangevraagd}</td><td class="num">${jaar.geannuleerd}</td></tr>`)}
          </tbody>
        </table>` : html`<div class="mt-leeg">In de uitstappentool staan geen uitstappen.</div>`}
      <div class="mt-lijstvoet">
        ${gelezen ? html`<p class="mt-bronregel">${gelezen}</p>` : null}
        ${niet ? html`<p class="mt-bronregel">${niet}</p>` : null}
        ${lijnen.map(regel)}
      </div>`);
  }

  /** Eén vraag aan de serverfunctie. Geeft haar antwoord, of false als de pagina herlaadt. */
  async function eenLezing() {
    s.bezig = true;
    teken();
    // De serverfunctie leest de uitstappentool, werkt de MT bij, en zegt wat ze las.
    const functie = await data.uitstappenBijwerken();
    // Weigert de serverfunctie de aanmelding, dan beslist de databank: is de aanmelding daar ook niet meer
    // in orde, dan herlaadt de pagina en vraagt het aanmeldscherm wat nodig is. Aanvaardt de databank ze
    // wel, dan herlaadt de pagina niet: anders zou ze blijven herladen. De melding zegt dan wat er scheelt.
    if (moetNavragen(functie) && moetHerstarten(functie, await data.rpc("mt_mijn_account"))) {
      herstart();
      return false;
    }
    s.bezig = false;
    s.functie = functie;
    if (functie.ok && functie.gegevens && functie.gegevens.uitstappen) s.goed = functie;
    s.gevraagdOp = Date.now();
    teken();
    return functie;
  }

  // Eén vraag tegelijk. Vraagt iets om een nieuwe lezing terwijl de MT nog leest, bv. net na de start van
  // een schooljaar, dan leest ze daarna nog één keer.
  const ververs = eenTegelijk(eenLezing);

  /** De beheerder bevestigt dat de tegengehouden uitstappen echt weg zijn (B225). Daarna leest de MT opnieuw. */
  async function bevestigVerdwenen(doel) {
    const g = s.functie && s.functie.ok ? s.functie.gegevens : null;
    if (s.bezig || !g || !g.verdwenen_taak || !g.uitstappen) return;
    const aantal = g.uitstappen.tegengehouden;
    if (!(await vraag(vraagVerdwenen(aantal)))) return;
    const klaar = knopBezig(doel, "Bezig…");
    const r = await data.rpc("mt_verdwenen_bevestigen", { p_taak: g.verdwenen_taak, p_aantal: aantal });
    klaar();
    if (r.ok) meld("De MT telt " + telwoord(aantal, "uitstap", "uitstappen") + " niet meer mee.");
    else meld(r.tekst, "err");
    // Gelukt of niet: de stand van nu tonen. De databank laat de volgende vraag meteen opnieuw lezen.
    ververs();
  }

  // Terug op het tabblad na een tijd: opnieuw lezen, zonder dat iemand erom moet vragen.
  document.addEventListener("visibilitychange", () => {
    if (opnieuwNodig({ verborgen: document.hidden, gevraagdOp: s.gevraagdOp, nu: Date.now() })) ververs();
  });

  ververs();
  return { herlaad: ververs };
}
