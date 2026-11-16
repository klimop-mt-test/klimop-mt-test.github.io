// MT · uitstappentool.js · versie 0.7.1
// Wat de MT uit de uitstappentool leest, op de startpagina van de testversie (stap 3; hoofdstuk 4, B212).
//
// Bij het openen gebeurt twee keer hetzelfde lezen, met dezelfde code (adapter.js):
//   - de serverfunctie mt-uitstappen leest de uitstappentool en werkt de MT bij. Wat in de MT komt, is
//     zo wat de bron zegt, en niet wat deze browser meldt;
//   - de pagina leest zelf, om te tonen: hoeveel uitstappen er per schooljaar zijn, en wat niet meetelt.
// Daarna leest de MT opnieuw als je erom vraagt, of als je na een tijd naar het tabblad terugkeert.
//
// Wat hier gemeld wordt, is afgeleid en nergens bewaard (64.4): een klas die de MT niet kent, een
// uitstap met een onbekende schemaversie. Is het opgelost, dan verdwijnt de melding vanzelf.
//
// Bovenaan staat wat zonder browser te testen valt; daaronder het blok op de startpagina. De echte
// schermen met de uitstappen volgen in stap 5 en 6.

import { overzicht } from "./adapter.js";
import { UITSTAPFUNCTIE, UITSTAPFUNCTIE_VERSIE } from "./config.js";
import * as data from "./data.js";
import { REKENVERSIE } from "./rekenen.js";
import { datumEnUur, html, zet } from "./ui.js";

export const VERSIE = "0.7.1";

/** Na zoveel minuten leest de MT opnieuw als je naar het tabblad terugkeert. */
const OPNIEUW_NA_MINUTEN = 10;

// ---------- Zonder browser te testen ----------

const telwoord = (n, een, meer) => n + " " + (n === 1 ? een : meer);

/** Een opsomming als zin: "a", "a en b", "a, b en c". */
function opsomming(delen) {
  if (delen.length < 2) return delen.join("");
  return delen.slice(0, -1).join(", ") + " en " + delen[delen.length - 1];
}

/**
 * De klassen die de MT niet kent, per naam, met het aantal uitstappen: [{ naam, aantal }], de meeste
 * eerst. lijst is wat de serverfunctie teruggeeft: [{ uitstap, klassen: [namen] }].
 */
export function onbekendeKlassen(lijst) {
  const tel = new Map();
  for (const item of Array.isArray(lijst) ? lijst : []) {
    for (const naam of new Set(Array.isArray(item.klassen) ? item.klassen : [])) tel.set(naam, (tel.get(naam) || 0) + 1);
  }
  return [...tel].map(([naam, aantal]) => ({ naam, aantal })).sort((a, b) => b.aantal - a.aantal || (a.naam < b.naam ? -1 : 1));
}

/** Waarom de serverfunctie niet antwoordde zoals het hoort, in gewone taal, met wat een beheerder eraan doet. */
function zinBijFout(functie, beheerder) {
  const plak = " Plak functies/" + UITSTAPFUNCTIE + "/index.ts in Supabase, bij Edge Functions.";
  if (functie.soort === "ontbreekt") return functie.tekst + (beheerder ? plak : " Meld het aan de beheerder.");
  if (functie.soort === "verbinding") {
    return "De serverfunctie " + UITSTAPFUNCTIE + " gaf geen antwoord: de MT is nu niet bijgewerkt met de uitstappentool."
      + (beheerder ? " Staat ze nog niet in Supabase, plak dan functies/" + UITSTAPFUNCTIE + "/index.ts bij Edge Functions. Anders is het de verbinding: probeer het opnieuw." : " Probeer het opnieuw.");
  }
  if (functie.soort === "bron") return functie.tekst;
  if (functie.soort === "sessie" || functie.soort === "rechten") {
    return "De serverfunctie " + UITSTAPFUNCTIE + " aanvaardt je aanmelding niet: de MT is nu niet bijgewerkt met de uitstappentool. Meld af en opnieuw aan. Blijft dit zo, meld het dan aan de beheerder.";
  }
  if (functie.soort === "kan_niet") return "De MT is niet bijgewerkt met de uitstappentool: " + functie.tekst.charAt(0).toLowerCase() + functie.tekst.slice(1);
  return "De MT is nu niet bijgewerkt met de uitstappentool. " + functie.tekst;
}

/**
 * De regels onder de tabel: wat de serverfunctie deed, en wat aandacht vraagt. Elke regel is
 * { soort, tekst }, met als soort "info", "let_op" of "fout".
 *   functie     het antwoord van data.uitstappenBijwerken()
 *   rol         de rol van wie aangemeld is
 *   schooljaar  het lopende schooljaar in de MT, of null
 */
export function regels({ functie, rol, schooljaar }) {
  const beheerder = rol === "beheerder";
  if (!functie.ok) return [{ soort: "fout", tekst: zinBijFout(functie, beheerder) }];
  const g = functie.gegevens;
  const u = g.uitstappen || {};
  const uit = [];
  const n = (naam) => (Number.isInteger(u[naam]) ? u[naam] : 0);

  // De serverfunctie in Supabase is niet die van deze versie: ze las met andere code dan de pagina.
  if (g.versie !== UITSTAPFUNCTIE_VERSIE || g.rekenversie !== REKENVERSIE) {
    uit.push({
      soort: "let_op",
      tekst: "In Supabase staat versie " + (g.versie || "onbekend") + " van de serverfunctie " + UITSTAPFUNCTIE + "; deze versie van de MT verwacht " + UITSTAPFUNCTIE_VERSIE + "."
        + (beheerder ? " Plak functies/" + UITSTAPFUNCTIE + "/index.ts opnieuw in Supabase, bij Edge Functions." : " Meld het aan de beheerder."),
    });
  }

  // Wat de databank deed.
  const gevolgd = n("nieuw") + n("gewijzigd") + n("ongewijzigd");
  if (gevolgd || n("weg") || n("niet_gevonden")) {
    const delen = [];
    if (n("nieuw")) delen.push(n("nieuw") + " nieuw");
    if (n("gewijzigd")) delen.push(n("gewijzigd") + " gewijzigd");
    if (n("ongewijzigd")) delen.push(n("ongewijzigd") + " ongewijzigd");
    uit.push({ soort: "info", tekst: "De MT volgt " + telwoord(gevolgd, "uitstap", "uitstappen") + (delen.length ? ": " + opsomming(delen) + "." : ".") });
  } else if (!schooljaar) {
    uit.push({ soort: "info", tekst: "In de MT is er nog geen lopend schooljaar: de uitstappen wachten tot het aangemaakt is in Instellingen (stap 4)." });
  } else {
    uit.push({ soort: "info", tekst: "De MT volgt nog geen uitstappen van " + schooljaar + "." });
  }
  if (n("weg")) uit.push({ soort: "info", tekst: telwoord(n("weg"), "uitstap is", "uitstappen zijn") + " in de uitstappentool verwijderd of een nascholing geworden: de MT telt ze niet meer mee." });
  if (n("niet_gevonden")) uit.push({ soort: "let_op", tekst: telwoord(n("niet_gevonden"), "uitstap staat", "uitstappen staan") + " niet meer in de uitstappentool: de MT telt ze niet meer mee." });
  if (n("buiten") && (gevolgd || schooljaar)) {
    uit.push({ soort: "info", tekst: telwoord(n("buiten"), "uitstap valt", "uitstappen vallen") + " buiten de schooljaren die in de MT open staan." });
  }
  if (n("ongeldig")) uit.push({ soort: "let_op", tekst: telwoord(n("ongeldig"), "uitstap heeft", "uitstappen hebben") + " geen geldige datum of gegevens: de MT neemt ze niet over. Kijk ze na in de uitstappentool." });

  // Wat aandacht vraagt.
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
  const klassen = onbekendeKlassen(g.onbekende_klassen);
  if (klassen.length) {
    uit.push({
      soort: "let_op",
      tekst: "Klas onbekend: " + opsomming(klassen.map((k) => k.naam + " (" + telwoord(k.aantal, "uitstap", "uitstappen") + ")")) + ". De MT kent "
        + (klassen.length === 1 ? "deze klas" : "deze klassen") + " niet in het schooljaar van de uitstap, en maakt er geen lijst voor. "
        + (beheerder ? "Kijk de naam na in de uitstappentool." : "Een nieuwe klas komt erbij zodra een beheerder de MT opent."),
    });
  }
  if (Array.isArray(g.wacht) && g.wacht.length) {
    uit.push({ soort: "let_op", tekst: "Bij " + telwoord(g.wacht.length, "uitstap", "uitstappen") + " wijzigde de datum terwijl er al iets vastligt in de MT: de MT houdt de datum van toen, tot de beheerder beslist." });
  }
  if (Array.isArray(g.onbekende_versie) && g.onbekende_versie.length) {
    uit.push({ soort: "let_op", tekst: telwoord(g.onbekende_versie.length, "uitstap heeft", "uitstappen hebben") + " een opbouw die deze versie van de MT niet kent. De MT leest ze niet, en houdt wat ze wist, tot ze bijgewerkt is." });
  }
  // Voor de beheerder: hoe lang de serverfunctie erover deed. Via de API stopt een vraag aan de databank na 8 seconden (17.4).
  if (beheerder && Number.isFinite(g.duur_ms) && g.gelezen && Number.isInteger(g.gelezen.uitstappen)) {
    const seconden = (Math.round(g.duur_ms / 100) / 10).toFixed(1).replace(".", ",");
    uit.push({ soort: "info", tekst: "De serverfunctie las " + telwoord(g.gelezen.uitstappen, "uitstap", "uitstappen") + " en werkte de MT bij in " + seconden + " seconden." });
  }
  // Eerst wat er gebeurde, dan wat aandacht vraagt; een oudere serverfunctie blijft bovenaan.
  const oudereFunctie = uit.length && uit[0].tekst.startsWith("In Supabase staat versie") ? uit.slice(0, 1) : [];
  const rest = uit.slice(oudereFunctie.length);
  return [...oudereFunctie, ...rest.filter((lijn) => lijn.soort === "info"), ...rest.filter((lijn) => lijn.soort !== "info")];
}

/** Wat niet in de MT komt, als één zin; niets als er niets is. */
export function zinNietInDeMT(telling) {
  const delen = [];
  if (telling.nascholingen) delen.push(telwoord(telling.nascholingen, "nascholing", "nascholingen"));
  if (telling.verwijderd) delen.push(telwoord(telling.verwijderd, "uitstap in de prullenbak", "uitstappen in de prullenbak"));
  if (telling.zonderDatum) delen.push(telwoord(telling.zonderDatum, "uitstap zonder geldige datum", "uitstappen zonder geldige datum"));
  return delen.length ? "Niet in de tabel, en nooit meegeteld: " + opsomming(delen) + "." : null;
}

// ---------- Het blok op de startpagina ----------

/**
 * Start het blok in een onderdeel van de pagina.
 *   deel      het element van het blok
 *   account   wie aangemeld is (mt_mijn_account)
 *   herstart  de pagina opnieuw laden: het aanmeldscherm vraagt dan wat nodig is
 */
export function start({ deel, account, herstart }) {
  const s = { bezig: false, gelezenOp: null, functie: null, eigen: null };

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

  function teken() {
    knop.disabled = s.bezig;
    if (s.bezig && !s.eigen) {
      zet(vak, html`<div class="mt-laadt" role="status" aria-label="De uitstappentool wordt gelezen"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`);
      return;
    }
    const lijnen = s.functie ? regels({ functie: s.functie, rol: account.rol, schooljaar: account.schooljaar || null }) : [];
    const klasse = { info: "mt-bronregel", let_op: "mt-bronregel let-op", fout: "mt-bronregel fout" };
    const onder = html`${lijnen.map((lijn) => html`<p class="${klasse[lijn.soort]}">${lijn.tekst}</p>`)}`;
    if (!s.eigen.ok) {
      zet(vak, html`
        <div class="form-alert mt-lijstfout" role="alert"><span><b>De uitstappentool is niet gelezen.</b> ${s.eigen.reden === "verbinding"
          ? "Ze antwoordt niet vanuit deze browser. Controleer je internetverbinding en probeer het opnieuw."
          : "De MT kon de lijst niet volledig lezen. Probeer het opnieuw."}</span></div>
        <div class="mt-lijstvoet">${onder}</div>`);
      return;
    }
    const telling = overzicht(s.eigen.rijen);
    const niet = zinNietInDeMT(telling);
    zet(vak, html`
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
        <p class="mt-bronregel">Gelezen op ${datumEnUur(s.gelezenOp)}. Enkel bevestigde uitstappen tellen mee; aangevraagde komen apart in de prognose.</p>
        ${niet ? html`<p class="mt-bronregel">${niet}</p>` : null}
        ${onder}
      </div>`);
  }

  async function ververs() {
    if (s.bezig) return;
    s.bezig = true;
    teken();
    // De serverfunctie werkt de MT bij; de pagina leest intussen zelf, om te tonen.
    const [functie, eigen] = await Promise.all([data.uitstappenBijwerken(), data.leesUitstappentool()]);
    // Weigert de serverfunctie de aanmelding, dan beslist de databank: is de aanmelding daar ook niet meer
    // in orde, dan herlaadt de pagina en vraagt het aanmeldscherm wat nodig is. Aanvaardt de databank ze
    // wel, dan herlaadt de pagina niet: anders zou ze blijven herladen. De melding zegt dan wat er scheelt.
    if (functie.soort === "sessie" || functie.soort === "rechten") {
      const nog = await data.rpc("mt_mijn_account");
      if (!nog.ok && (nog.soort === "sessie" || nog.soort === "rechten")) {
        herstart();
        return;
      }
    }
    s.bezig = false;
    s.functie = functie;
    s.eigen = eigen;
    s.gelezenOp = Date.now();
    teken();
  }

  // Terug op het tabblad na een tijd: opnieuw lezen, zonder dat iemand erom moet vragen.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && s.gelezenOp !== null && Date.now() - s.gelezenOp > OPNIEUW_NA_MINUTEN * 60000) ververs();
  });

  ververs();
  return { herlaad: ververs };
}
