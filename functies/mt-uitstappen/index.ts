// MT · functies/mt-uitstappen/index.ts · versie 0.7.0
// De serverfunctie voor de uitstappen (17.4, B212): een Edge Function in het Supabase-project van de MT.
//
// Waarom ze bestaat. De MT moet weten welke uitstappen er zijn, met hun datum, hun klassen en hun stand
// in de planning. Vroeger meldde de browser dat aan de databank; de databank kon niet nagaan of het
// klopte. Nu leest deze functie de uitstappentool zelf, en geeft ze door wat ze las. Wat in de MT
// binnenkomt, is zo wat de bron zegt, en niet wat een sessie meldt (review 1, B212).
//
// Wat ze doet, en niets anders:
//   1. het toegangsbewijs van de vrager echt nakijken bij Supabase, voor dit project;
//   2. aan de databank vragen of de vrager een gebruiker van de MT is (mt_mijn_account), met zijn
//      eigen toegangsbewijs: de databank beslist, niet deze functie;
//   3. de uitstappentool lezen, enkel lezen: de uitstappen, en voor een beheerder ook de klassenlijst.
//      Dat is een ander project van Supabase: daarheen gaat enkel de publishable key van dat project,
//      die openbaar is. Nooit de secret key, nooit het toegangsbewijs van de vrager;
//   4. voor een beheerder: de klassen van het lopende schooljaar bijwerken (mt_klassen_bijwerken), met
//      zijn eigen toegangsbewijs. Zo zijn nieuwe klassen gekend vóór hun lijsten ontstaan;
//   5. de uitstappen doorgeven aan mt_uitstappen_bijwerken, met de secret key: die databankfunctie
//      bestaat enkel voor deze serverfunctie. Ze slaat over wat ouder of ongewijzigd is, en wist of
//      verschuift nooit afwezigheden (sql/005_review1.sql).
//
// Met de secret key doet deze functie dus precies één ding: mt_uitstappen_bijwerken oproepen, in het
// eigen project. Op tabellen heeft ze geen enkel recht.
//
// Het lezen zelf gebeurt met de tekst van code/adapter.js: dezelfde als in de pagina, woord voor woord
// (B69, B212). Hij staat verderop tussen twee merktekens; een test vergelijkt beide. Wijzigt
// code/adapter.js onder zijn streep, dan komt die tekst hier opnieuw, zonder het woord "export".
//
// Nooit in een antwoord of in het logboek van de functie: een toegangsbewijs of een sleutel.
//
// Zo plaats je ze: Supabase → project → Edge Functions → Deploy a new function → Via Editor → de
// naam mt-uitstappen → dit hele bestand plakken → Deploy function. "Verify JWT" blijft aan staan.
// Wijzigt dit bestand, dan plak je het opnieuw. Test en productie krijgen hetzelfde bestand.
//
// Het stuk uit adapter.js is gewone JavaScript, woord voor woord uit de uitstappentool: TypeScript kan
// dat niet nakijken. Daarom staat de controle van TypeScript voor dit hele bestand uit, en is ook de
// rest gewone JavaScript. Wat de functie doet, bewaken de tests (tests/uitstapfunctie_test.js).
// @ts-nocheck

export const VERSIE = "0.7.0";

/**
 * De pagina van de MT per project van Supabase. Enkel dat adres mag deze functie vanuit een browser
 * oproepen. Een test vergelijkt deze lijst met code/config.js. De productie komt erbij bij de livegang.
 */
export const PAGINA = Object.freeze({
  "https://ayszixqnuktogzjtreyy.supabase.co": "https://klimop-mt-test.github.io",
});

/**
 * De uitstappentool (project klimop-software): het adres en de publishable key, die openbaar zijn en
 * ook in code/config.js staan. Een test vergelijkt beide. De functie leest er enkel.
 */
export const UITSTAPPENTOOL = Object.freeze({
  url: "https://vmvxawjfryaijkhhnnyr.supabase.co",
  sleutel: "sb_publishable_Xg0ezCxtbHfReSOcigRXvw_j5fwRjqg",
});

// ==== adapter: begin ====
/**
 * De rekenversie (17.1): dezelfde als in rekenen.js; een test bewaakt dat. Ze gaat omhoog bij elke
 * wijziging aan rekenen.js of aan dit bestand die een uitkomst kan wijzigen. De serverfunctie meldt
 * haar rekenversie aan de pagina: verschilt ze, dan staat in Supabase een oudere serverfunctie.
 */
const REKENVERSIE = 1;

/** De ruwe schemaversies van de uitstappentool die de MT begrijpt (T1). Zonder versie: van vóór de versies. */
const BEKENDE_VERSIES = Object.freeze([1, 2]);

/** De twee tabellen van de uitstappentool die de MT leest, en de ene rij met de instellingen (hoofdstuk 4). */
const TABEL_UITSTAPPEN = "uitstappen";
const TABEL_INSTELLINGEN = "instellingen";
const INSTELLINGEN_ID = "klimop";

/** De Data API geeft hoogstens 1000 rijen per vraag terug. */
const BLADZIJDE = 1000;
/** Na zoveel bladzijden stopt het lezen: zoveel uitstappen telt de uitstappentool nooit. */
const MAX_BLADZIJDEN = 50;

/**
 * Wat de serverfunctie van elke uitstap leest: enkel wat de databank van de MT nodig heeft (64.3), en
 * de ruwe schemaversie. Met -> houdt elke waarde haar soort: een lijst blijft een lijst.
 */
const VELDEN_KORT = ["v", "categorie", "type", "datumStart", "datumEind", "klassen", "planStatus", "verwijderdOp"];

// ---- uitstappentool: begin ----
// Woord voor woord uit uitstappen.html (V20, V22, T1), met de hulpfuncties en constanten waarvan
// norm() en kosten() afhangen. Hier wijzigt niemand iets met de hand: tests/adapter_test.js
// vergelijkt dit blok met de uitstappentool.
const SCHEMA      = 2;
const GROEPEN     = ["Kleuter","Lager","Andere"];
const r2 = n => Math.round(n*100)/100;
function parseISO(s){ if(!s||!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null; const [y,m,d]=s.split("-").map(Number); const x=new Date(y,m-1,d); return (x.getMonth()===m-1&&x.getDate()===d)?x:null; }
function schooljaarVan(iso){ const d=parseISO(iso); if(!d) return ""; const y=d.getFullYear(); return d.getMonth()>=8 ? `${y}-${y+1}` : `${y-1}-${y}`; }
const toNum = v => (v===""||v==null||isNaN(Number(v))) ? null : Number(v);
const NASCH_FIELDS = ["titel","plaats","deelnemersGroep","deelnemers","aantalDeelnemers","opvangNodig","inschrijving","inschrijfStatus","inschrijvenVoor","inschrijfLink","ingeschrevenOp",
  "bestelbon","bestelbonStatus","bestelbonDoorgegevenOp"];
const DN_VERV_KEYS = ["wagen","meerijden","openbaar","actief"];
function normNascholing(t){
  t.type="dag"; t.datumEind=null;
  t.klassen=[]; t.aantalLln=0; t.aantalBegeleiders=0; t.begeleidersNamen="";
  t.busNodig=false; t.vervoerwijze=null; t.openbaarVervoerder=null; t.kostOpenbaar=null; t.kostOpenbaarPerLln=null;
  t.vertrekSchool=""; t.terug=""; t.terugSchool="";
  /* B21: bij het omzetten verdwijnt wat enkel bij een uitstap hoort, zoals de bevestiging belooft */
  t.busmaatschappij=""; t.prijsVervoer=null; t.busReferentie=""; t.busOfferteOp=null; t.busBevestigdOp=null; t.internBestelbonBus="";
  t.busStatus=null; t.factuurStatusBus=null; t.smartschool=null; delete t.opvangNodig;
  t.titel = t.titel==null ? "" : String(t.titel);
  t.plaats = ["locatie","online","school"].includes(t.plaats) ? t.plaats : "";
  if(t.plaats==="online"||t.plaats==="school"){ ["straat","nummer","postcode","stad"].forEach(f=>t[f]=""); t.locatieAnders=false; }
  t.deelnemersGroep = ["naam","kleuter","lager","school"].includes(t.deelnemersGroep) ? t.deelnemersGroep : "naam";
  const dn = t.deelnemersGroep==="naam" && Array.isArray(t.deelnemers) ? t.deelnemers : [];
  t.deelnemers = dn.map(d=>({naam:String((d&&d.naam)??"").trim(), klas:String((d&&d.klas)??"").trim(),
    vervoer: t.plaats==="locatie" && DN_VERV_KEYS.includes(d&&d.vervoer) ? d.vervoer : ""})).filter(d=>d.naam);
  t.aantalDeelnemers = Math.max(0, Math.round(toNum(t.aantalDeelnemers)||0), t.deelnemers.length);
  t.inschrijving = ["zelf","secretariaat","geen"].includes(t.inschrijving) ? t.inschrijving : "";
  t.inschrijfStatus = t.inschrijving==="secretariaat" ? (t.inschrijfStatus==="ingeschreven" ? "ingeschreven" : "teschrijven") : null;
  t.ingeschrevenOp = t.inschrijving==="secretariaat" && t.inschrijfStatus==="ingeschreven" && parseISO(t.ingeschrevenOp) ? t.ingeschrevenOp : null;
  t.inschrijvenVoor = t.inschrijving==="secretariaat" && parseISO(t.inschrijvenVoor) ? t.inschrijvenVoor : null;
  t.inschrijfLink = t.inschrijfLink==null ? "" : String(t.inschrijfLink).trim();
  /* Wie zelf inschrijft, zegt uitdrukkelijk of er een bestelbonnummer van de school nodig is: nee, zo snel mogelijk of later.
     Het secretariaat duidt aan wanneer het nummer aan de aanvrager is doorgegeven. */
  if(t.bestelbon==null && t.bestelbonNodig) t.bestelbon = t.bestelbonWanneer || "later";   /* vroegere voorbeeldgegevens (vinkje) */
  delete t.bestelbonNodig; delete t.bestelbonWanneer;
  t.bestelbon = t.inschrijving==="zelf" && ["nee","dringend","later"].includes(t.bestelbon) ? t.bestelbon : "";
  const bon = bonNodig(t);
  t.bestelbonStatus = bon ? (t.bestelbonStatus==="doorgegeven" ? "doorgegeven" : "doorgeven") : null;
  t.bestelbonDoorgegevenOp = t.bestelbonStatus==="doorgegeven" && parseISO(t.bestelbonDoorgegevenOp) ? t.bestelbonDoorgegevenOp : null;
}
function norm(src){
  const t=Object.assign({},src);
  t.type = t.type==="meerdaags" ? "meerdaags" : "dag";
  if(t.type==="dag") t.datumEind=null;
  t.klassen = Array.isArray(t.klassen) ? t.klassen.filter(Boolean) : [];
  t.aantalLln = Math.max(0,Math.round(toNum(t.aantalLln)||0));
  t.aantalBegeleiders = Math.max(0,Math.round(toNum(t.aantalBegeleiders)||0));
  t.categorie = t.categorie==="nascholing" ? "nascholing" : "uitstap";
  if(t.categorie==="nascholing") normNascholing(t); else NASCH_FIELDS.forEach(f=>{ delete t[f]; });
  ["kostprijs","kostprijsPerLln","prijsVervoer","kostOpenbaar","voorschotBedrag"].forEach(f=>t[f]=toNum(t[f]));
  ["leerkracht","activiteit","straat","nummer","postcode","stad","contactTel","contactEmail","vertrekSchool","terug","terugSchool",
   "busmaatschappij","busReferentie","internBestelbonUitstap","internBestelbonBus","betaalwijze","opmerking","adminNotitie","interneNotitie","begeleidersNamen",
   "locNaam","locStraat","locNummer","locPostcode","locStad"].forEach(f=>t[f]=t[f]==null?"":String(t[f]));
  t.locatieAnders=!!t.locatieAnders;
  if(!t.locatieAnders) ["locNaam","locStraat","locNummer","locPostcode","locStad"].forEach(f=>t[f]="");
  t.busNodig = !!t.busNodig;
  if(t.busNodig){ t.vervoerwijze=null; t.openbaarVervoerder=null; t.kostOpenbaar=null; }
  if(!t.prijsStatus) t.prijsStatus = t.kostprijs===0 ? "gratis" : (t.kostprijs==null ? "tebevestigen" : "bekend");
  if(t.prijsStatus==="gratis"){ t.kostprijs=0; t.kostprijsPerLln=null; }
  t.kostprijsBasis = t.kostprijsBasis==="perLln" ? "perLln" : "totaal";
  if(t.prijsStatus==="bekend" && t.kostprijsBasis==="perLln" && t.kostprijsPerLln!=null) t.kostprijs=r2(t.kostprijsPerLln*persAantal(t));
  t.kostOpenbaarPerLln=toNum(t.kostOpenbaarPerLln);
  t.kostOpenbaarBasis = t.kostOpenbaarBasis==="perLln" ? "perLln" : "totaal";
  if(t.vervoerwijze!=="openbaar"){ t.kostOpenbaarPerLln=null; }
  else if(t.kostOpenbaarBasis==="perLln" && t.kostOpenbaarPerLln!=null) t.kostOpenbaar=r2(t.kostOpenbaarPerLln*t.aantalLln);
  if(!["aangevraagd","bevestigd","geannuleerd"].includes(t.planStatus)) t.planStatus="aangevraagd";
  /* Busstatus: nog te regelen → offertes opgevraagd → geboekt.
     Uitstappen zonder status (vorige versie): met ingevulde busmaatschappij = geboekt. */
  if(t.busNodig){
    if(t.busStatus==="aangevraagd") t.busStatus = t.busmaatschappij ? "bevestigd" : "offertes";
    if(!["teregelen","offertes","bevestigd"].includes(t.busStatus)) t.busStatus = t.busmaatschappij ? "bevestigd" : "teregelen";
  } else t.busStatus=null;
  t.busKm=toNum(t.busKm); t.busOfferteOpm=t.busOfferteOpm==null?"":String(t.busOfferteOpm); t.busOfferteOp=t.busOfferteOp||null;
  /* Factuurregels: gratis = geen factuur; een bus heeft altijd een factuur; openbaar vervoer heeft geen factuur */
  if(!["teontvangen","ontvangen","nvt"].includes(t.factuurStatus)) t.factuurStatus = t.factuurUitstap ? "ontvangen" : "teontvangen";
  /* Annulering: met of zonder kosten, bij een uitstap met bus apart voor de bus. Zonder kosten vervalt de factuur;
     met kosten is ze te ontvangen, ook bij een gratis activiteit. Oudere annuleringen zonder keuze blijven zoals ze waren. */
  const ann = t.planStatus==="geannuleerd" && t.annulering ? t.annulering : null;
  if(ann){
    ann.kosten=toNum(ann.kosten); ann.busKosten=toNum(ann.busKosten);
    if(!["geen","wel"].includes(ann.metKosten)){ if(ann.kosten>0) ann.metKosten="wel"; else delete ann.metKosten; }
    if(!t.busNodig || !["geen","wel"].includes(ann.busMetKosten)) delete ann.busMetKosten;
    if(ann.metKosten!=="wel") ann.kosten=ann.metKosten==="geen"?null:ann.kosten;
    if(ann.busMetKosten!=="wel") ann.busKosten=null;
  }
  if(t.prijsStatus==="gratis" && !(ann && ann.metKosten==="wel")) t.factuurStatus="nvt";
  if(ann && ann.metKosten==="geen" && t.factuurStatus==="teontvangen") t.factuurStatus="nvt";
  if(ann && ann.metKosten==="wel" && t.factuurStatus==="nvt") t.factuurStatus="teontvangen";
  if(t.busNodig){
    const busNvt = !!(ann && ann.busMetKosten==="geen");
    if(!["teontvangen","ontvangen",...(busNvt?["nvt"]:[])].includes(t.factuurStatusBus)) t.factuurStatusBus = t.factuurBus ? "ontvangen" : "teontvangen";
    if(busNvt && t.factuurStatusBus==="teontvangen") t.factuurStatusBus="nvt";
  }
  else t.factuurStatusBus=null;
  /* Een bestelbon die door een annulering zonder kosten moet ingetrokken worden */
  t.bonIngetrokkenOp = ann && ann.metKosten==="geen" && t.internBestelbonUitstap && parseISO(t.bonIngetrokkenOp) ? t.bonIngetrokkenOp : null;
  t.bonBusIngetrokkenOp = ann && ann.busMetKosten==="geen" && t.internBestelbonBus && parseISO(t.bonBusIngetrokkenOp) ? t.bonBusIngetrokkenOp : null;
  t.factuurUitstap = t.factuurStatus==="ontvangen";
  t.factuurBus = t.factuurStatusBus==="ontvangen";
  t.voorschot = !!t.voorschot || (t.voorschotBedrag!=null && t.voorschotBedrag>0);
  if(!t.voorschot){ t.voorschotBedrag=null; t.voorschotInclusief=null; t.voorschotVervalt=null; t.voorschotBetaaldOp=null; }
  if(t.busStatus!=="bevestigd") t.busBevestigdOp=null;
  t.log = Array.isArray(t.log) ? t.log : [];
  t.v = SCHEMA;
  /* Een rij met een ongeldige datum (oud, geïmporteerd of rechtstreeks bewaard) mag de weergave niet laten vastlopen */
  t._datumFout = !parseISO(t.datumStart) || (t.type==="meerdaags" && (!parseISO(t.datumEind) || t.datumEind<t.datumStart));
  return t;
}
const isNasch = t => !!t && t.categorie==="nascholing";
const persAantal = t => isNasch(t) ? (t.aantalDeelnemers||0) : (t.aantalLln||0);
const bonNodig = t => !!t && (t.bestelbon==="dringend" || t.bestelbon==="later");
function kosten(t){
  const lln=persAantal(t);
  let act=null, per=null;
  if(t.prijsStatus==="gratis"){ act=0; per=0; }
  else if(t.prijsStatus==="bekend"){
    if(t.kostprijsBasis==="perLln" && t.kostprijsPerLln!=null){ per=t.kostprijsPerLln; act=r2(per*lln); }
    else { act=t.kostprijs; per=(act!=null&&lln>0)?r2(act/lln):null; }
  }
  const verv = t.busNodig ? t.prijsVervoer : (t.vervoerwijze==="openbaar" ? (t.kostOpenbaarBasis==="perLln"&&t.kostOpenbaarPerLln!=null ? r2(t.kostOpenbaarPerLln*lln) : t.kostOpenbaar) : null);
  const vs = t.voorschot ? t.voorschotBedrag : null;
  let actTot=act, saldo=null;
  if(act!=null && vs!=null){ if(t.voorschotInclusief==="excl") actTot=r2(act+vs); saldo = t.voorschotInclusief==="excl" ? act : r2(act-vs); }
  /* Een totaal enkel als alles gekend is: de activiteit (of gratis) én het vervoer als dat iets kost.
     Anders zou een onbekend deel als 0 meetellen en lijkt een gedeeltelijke prijs de volledige. */
  const vervNodig = t.busNodig || t.vervoerwijze==="openbaar";
  const volledig = act!=null && (!vervNodig || verv!=null);
  const tot = volledig ? r2((actTot||0)+(verv||0)) : null;
  const perAll = (tot!=null && lln>0) ? r2(tot/lln) : null;
  return {act,per,actTot,verv,vs,saldo,tot,perAll,volledig};
}
// ---- uitstappentool: einde ----

/** Wat woord voor woord overgenomen is, voor de tests en voor wie het wil nakijken. */
const overgenomen = Object.freeze({ SCHEMA, GROEPEN, r2, parseISO, schooljaarVan, toNum, norm, persAantal, kosten });

// ---------- T1, stap 2 en 3: de ruwe versie, en dan een eigen kopie normaliseren ----------

/**
 * Eén rij van de uitstappentool: { id, updated_at, trip }. Geeft
 *   id, gewijzigd   het id, en het tijdstip updated_at: de versie van de uitstap in de uitstappentool
 *   versie          de ruwe schemaversie zoals ze er staat; null zonder versie
 *   bekend          begrijpt de MT deze versie? Zo niet, dan leest ze de uitstap niet (T1)
 *   uitstap         de uitstap na norm(), of null bij een onbekende versie
 * norm() krijgt een eigen kopie: het wijzigt ook wat in de uitstap genest zit, zoals de annulering.
 */
function normaliseer(rij) {
  const trip = rij ? rij.trip : null;
  const ruw = trip !== null && typeof trip === "object" && !Array.isArray(trip) ? trip : null;
  const versie = ruw === null || ruw.v === undefined ? null : ruw.v;
  const bekend = ruw !== null && (versie === null || BEKENDE_VERSIES.includes(versie));
  return {
    id: rij ? rij.id : null,
    gewijzigd: rij ? rij.updated_at : null,
    versie,
    bekend,
    uitstap: bekend ? norm(JSON.parse(JSON.stringify(ruw))) : null,
  };
}

// ---------- T1, stap 4: wat de databank van de MT krijgt (64.3) ----------

/**
 * De melding van één uitstap aan mt_uitstappen_bijwerken. Een datum die de uitstappentool zelf
 * ongeldig noemt, gaat niet mee: de databank slaat de uitstap dan over als ongeldig, en wat de MT wist,
 * blijft staan.
 */
function melding(n) {
  const t = n.uitstap;
  return {
    id: n.id,
    gewijzigd: n.gewijzigd,
    categorie: t.categorie,
    verwijderd: Boolean(t.verwijderdOp),
    planStatus: t.planStatus,
    type: t.type,
    datumStart: t._datumFout ? null : t.datumStart,
    datumEind: t._datumFout ? null : t.datumEind,
    klassen: t.klassen.map((naam) => String(naam)),
  };
}

/**
 * Alles wat naar mt_uitstappen_bijwerken gaat: per uitstap de melding, en de volledige lijst van id's.
 * Een uitstap met een onbekende schemaversie gaat niet mee (T1). Haar id staat wel in de lijst: de MT
 * houdt wat ze wist, en de uitstap geldt niet als "niet gevonden".
 */
function bericht(rijen) {
  const uitstappen = [];
  const alleIds = [];
  const onbekendeVersie = [];
  for (const rij of rijen) {
    const n = normaliseer(rij);
    alleIds.push(n.id);
    if (n.bekend) uitstappen.push(melding(n));
    else onbekendeVersie.push(n.id);
  }
  return { uitstappen, alleIds, onbekendeVersie };
}

// ---------- T1, stap 5: kiezen ----------

/**
 * Wat een uitstap voor de MT is, na norm(). Eerst de categorie (V19), dan de prullenbak, dan de planning:
 *   "nascholing"   komt nooit in de MT (B64)
 *   "verwijderd"   in de prullenbak: telt niet mee (B14)
 *   "geannuleerd"  telt niet mee; annuleringskosten staan apart (1.7)
 *   "aangevraagd"  zichtbaar, maar telt enkel apart in de prognose (B15)
 *   "bevestigd"    telt
 */
function soortVan(t) {
  if (t.categorie === "nascholing") return "nascholing";
  if (t.verwijderdOp) return "verwijderd";
  return t.planStatus;
}

/**
 * De uitstappen geteld, per schooljaar: wat de pagina toont om na te kijken wat de MT leest.
 * Geeft { jaren: [{ schooljaar, bevestigd, aangevraagd, geannuleerd }], nascholingen, verwijderd,
 * zonderDatum, onbekendeVersie }. Het schooljaar volgt uit de startdatum, zoals in de uitstappentool.
 */
function overzicht(rijen) {
  const perJaar = new Map();
  const uit = { jaren: [], nascholingen: 0, verwijderd: 0, zonderDatum: 0, onbekendeVersie: 0 };
  for (const rij of rijen) {
    const n = normaliseer(rij);
    if (!n.bekend) {
      uit.onbekendeVersie++;
      continue;
    }
    const soort = soortVan(n.uitstap);
    if (soort === "nascholing") uit.nascholingen++;
    else if (soort === "verwijderd") uit.verwijderd++;
    else if (n.uitstap._datumFout) uit.zonderDatum++;
    else {
      const schooljaar = schooljaarVan(n.uitstap.datumStart);
      if (!perJaar.has(schooljaar)) perJaar.set(schooljaar, { schooljaar, bevestigd: 0, aangevraagd: 0, geannuleerd: 0 });
      perJaar.get(schooljaar)[soort]++;
    }
  }
  uit.jaren = [...perJaar.values()].sort((a, b) => (a.schooljaar < b.schooljaar ? -1 : 1));
  return uit;
}

// ---------- Wat een uitstap kost, voor het rekencontract (1.3) ----------

const ONBEKEND = Object.freeze({ onbekend: true });

/**
 * Een bedrag in euro uit de uitstappentool als hele centen; null als het geen bruikbaar bedrag is. De
 * uitstappentool kent enkel bedragen in hele centen, nooit onder nul: iets anders leest de MT niet.
 */
function centen(euro) {
  if (typeof euro !== "number" || !Number.isFinite(euro) || euro < 0) return null;
  const cent = Math.round(euro * 100);
  if (!Number.isSafeInteger(cent) || Math.abs(euro * 100 - cent) > 1e-6) return null;
  return cent;
}

/** Twee bedragen in centen samen; onbekend als een van de twee het is. */
function samen(a, b) {
  return a === null || b === null ? null : a + b;
}

/** Eén onderdeel: een gedeelde kost en een prijs per kind, in centen. Een onbruikbaar bedrag is onbekend, nooit € 0. */
function onderdeel(gedeeld, perKind) {
  if (gedeeld === null || perKind === null) return ONBEKEND;
  return { onbekend: false, gedeeld, perKind };
}

/**
 * Wat een uitstap kost, zoals het rekencontract het verdeelt (1.3). t is een uitstap na norm().
 * Geeft { activiteit, vervoer, volledig }. Een onderdeel is null (er is geen vervoer),
 * { onbekend: true }, of { onbekend: false, gedeeld, perKind } in centen: klaar voor verdeel() in
 * rekenen.js, met de aantallen van de MT erbij.
 *
 * De MT volgt kosten() van de uitstappentool (V22), met één afwijking: een prijs per leerling geldt
 * voor het werkelijke aantal, niet voor het geraamde aantal in de uitstappentool (V9, B22). Daarom
 * neemt de MT bij een prijs per leerling de prijs zelf, en niet het totaal dat kosten() ermee raamt:
 *   gratis                              activiteit € 0
 *   prijs gekend, totaal                gedeelde kost
 *   prijs gekend, per leerling          prijs per kind
 *   prijs nog te bevestigen             onbekend
 *   voorschot, exclusief                komt erbij, één keer, als gedeelde kost (B83)
 *   bus                                 gedeelde kost; zonder prijs onbekend
 *   openbaar vervoer, totaal            gedeelde kost
 *   openbaar vervoer, per leerling      prijs per kind (B90)
 *   te voet, met de fiets, op school    geen vervoer
 */
function kostenVoorMT(t) {
  const k = kosten(t);
  let activiteit = ONBEKEND;
  if (k.act != null) {
    const perLeerling = t.prijsStatus === "bekend" && t.kostprijsBasis === "perLln" && t.kostprijsPerLln != null;
    // Een exclusief voorschot komt erbij, één keer, zoals actTot in kosten().
    const voorschot = k.vs != null && t.voorschotInclusief === "excl" ? centen(k.vs) : 0;
    activiteit = perLeerling ? onderdeel(voorschot, centen(k.per)) : onderdeel(samen(centen(k.act), voorschot), 0);
  }
  let vervoer = null;
  if (t.busNodig || t.vervoerwijze === "openbaar") {
    const perLeerling = !t.busNodig && t.kostOpenbaarBasis === "perLln" && t.kostOpenbaarPerLln != null;
    if (k.verv == null) vervoer = ONBEKEND;
    else vervoer = perLeerling ? onderdeel(0, centen(t.kostOpenbaarPerLln)) : onderdeel(centen(k.verv), 0);
  }
  return { activiteit, vervoer, volledig: !activiteit.onbekend && !(vervoer !== null && vervoer.onbekend) };
}

/**
 * De annuleringskosten van een geannuleerde uitstap (1.7, V23), na norm(): kosten() rekent die niet.
 * Geeft { activiteit, vervoer }: null zonder kosten, { onbekend: true } als het bedrag nog moet volgen,
 * anders een gedeelde kost in centen. Standaard zijn ze voor de school; rekent de beheerder ze door,
 * dan verdeelt rekenen.js ze over wie hij aanduidt.
 */
function annuleringVoorMT(t) {
  const ann = t.planStatus === "geannuleerd" && t.annulering ? t.annulering : null;
  if (!ann) return { activiteit: null, vervoer: null };
  return {
    activiteit: ann.metKosten === "wel" ? (ann.kosten == null ? ONBEKEND : onderdeel(centen(ann.kosten), 0)) : null,
    vervoer: ann.busMetKosten === "wel" ? (ann.busKosten == null ? ONBEKEND : onderdeel(centen(ann.busKosten), 0)) : null,
  };
}

// ---------- De klassenlijst (hoofdstuk 4, B158) ----------

/**
 * De klassen uit de instellingen van de uitstappentool, in de volgorde van de lijst, zoals
 * mt_klassen_bijwerken ze verwacht: [{ id, naam, groep, actief }]. De groep en "actief" zoals de
 * uitstappentool ze zelf leest. Een klas zonder id krijgt hier geen verzonnen id: de databank weigert
 * de lijst dan, en er wijzigt niets.
 */
function klassenUit(instellingen) {
  const lijst = instellingen && Array.isArray(instellingen.klassen) ? instellingen.klassen : [];
  return lijst.map((k) => ({
    id: k && typeof k.id === "string" && k.id !== "" ? k.id : null,
    naam: k && typeof k.naam === "string" ? k.naam.trim() : "",
    groep: k && GROEPEN.includes(k.groep) ? k.groep : "Andere",
    actief: !(k && k.actief === false),
  }));
}

// ---------- T1, stap 1: volledig en gecontroleerd ophalen ----------

/** Het totaal uit de kop Content-Range: het getal na de schuine streep, zoals in "0-999/1503". */
function totaalUit(bereik) {
  const m = /\/(\d+)$/.exec(String(bereik === null || bereik === undefined ? "" : bereik));
  return m ? Number(m[1]) : null;
}

/** Eén lezing van alle bladzijden: { rijen }, of { reden } als ze mislukt of niet volledig is. */
async function leesEenKeer(haal, bron, vraag) {
  const rijen = [];
  let totaal = null;
  for (let blad = 0; blad < MAX_BLADZIJDEN; blad++) {
    let antwoord;
    let gegevens;
    try {
      antwoord = await haal(bron.url + "/rest/v1/" + vraag + "&limit=" + BLADZIJDE + "&offset=" + rijen.length, {
        method: "GET",
        // De publishable key gaat enkel mee als apikey, nooit als toegangsbewijs (design system 1.13).
        headers: { apikey: bron.sleutel, Accept: "application/json", Prefer: "count=exact" },
        redirect: "error",
      });
      gegevens = antwoord.ok ? JSON.parse(await antwoord.text()) : null;
    } catch {
      return { reden: "verbinding" };
    }
    // 416: de bladzijde begint voorbij het einde. De lijst werd dus korter terwijl de MT las.
    if (antwoord.status === 416) return { reden: "onvolledig" };
    if (!antwoord.ok) return { reden: antwoord.status === 401 || antwoord.status === 403 ? "geweigerd" : "fout", status: antwoord.status };
    if (!Array.isArray(gegevens)) return { reden: "fout", status: antwoord.status };
    // Elke bladzijde meldt het totaal. Wijzigt het onderweg, dan verschoven de bladzijden: geen lijst.
    const nu = totaalUit(antwoord.headers.get("content-range"));
    if (nu === null || (totaal !== null && nu !== totaal)) return { reden: "onvolledig" };
    totaal = nu;
    for (const rij of gegevens) {
      if (rij === null || typeof rij !== "object") return { reden: "fout", status: antwoord.status };
      rijen.push(rij);
    }
    if (rijen.length >= totaal) break;
    if (gegevens.length === 0) return { reden: "onvolledig" };
  }
  if (rijen.length !== totaal) return { reden: "onvolledig" };
  return { rijen };
}

/**
 * Alle rijen van één vraag aan de uitstappentool (T1, stap 1). haal is de functie waarmee de
 * oproeper het netwerk aanspreekt, met zijn eigen grens in de tijd; bron is { url, sleutel }.
 * Geeft { ok: true, rijen } of { ok: false, reden }:
 *   "verbinding"   geen antwoord
 *   "geweigerd"    de uitstappentool weigert de sleutel
 *   "fout"         een ander antwoord dan een lijst
 *   "onvolledig"   het aantal rijen klopt niet met het totaal, ook niet bij een tweede lezing
 * Een fout is nooit een lege lijst.
 */
async function leesAlles(haal, bron, vraag) {
  let uit = await leesEenKeer(haal, bron, vraag);
  // Wijzigde er iets terwijl de MT las, dan leest ze één keer opnieuw.
  if (uit.reden === "onvolledig") uit = await leesEenKeer(haal, bron, vraag);
  if (uit.reden) return { ok: false, reden: uit.reden, status: uit.status || 0 };
  return { ok: true, rijen: uit.rijen };
}

/** Elke rij heeft een eigen id, als tekst: anders is de lijst niet te vertrouwen. */
function metEigenId(rijen) {
  const gezien = new Set();
  for (const rij of rijen) {
    if (typeof rij.id !== "string" || rij.id === "" || gezien.has(rij.id)) return false;
    gezien.add(rij.id);
  }
  return true;
}

/**
 * Alle uitstappen, kort: van elke rij enkel wat de databank van de MT nodig heeft. Zo blijft een
 * lezing klein, ook met de uitstappen van vele schooljaren. Geeft de rijen als { id, updated_at, trip },
 * met in trip enkel die velden: normaliseer() en bericht() werken er gewoon mee.
 */
async function leesUitstappenKort(haal, bron) {
  const kolommen = ["id", "updated_at", ...VELDEN_KORT.map((veld) => veld + ":trip->" + veld)];
  const uit = await leesAlles(haal, bron, TABEL_UITSTAPPEN + "?select=" + kolommen.join(",") + "&order=id.asc");
  if (!uit.ok) return uit;
  if (!metEigenId(uit.rijen)) return { ok: false, reden: "onvolledig", status: 0 };
  return {
    ok: true,
    rijen: uit.rijen.map((rij) => {
      const trip = {};
      for (const veld of VELDEN_KORT) trip[veld] = rij[veld] === undefined ? null : rij[veld];
      return { id: rij.id, updated_at: rij.updated_at, trip };
    }),
  };
}

/**
 * De uitstappen van één schooljaar, volledig: voor de schermen, met de prijzen en de facturen erbij.
 * Geeft de rijen zoals ze in de uitstappentool staan: { id, nr, schooljaar, trip, updated_at }.
 */
async function leesUitstappen(haal, bron, schooljaar) {
  if (!/^\d{4}-\d{4}$/.test(String(schooljaar))) return { ok: false, reden: "fout", status: 0 };
  const uit = await leesAlles(haal, bron, TABEL_UITSTAPPEN + "?select=id,nr,schooljaar,trip,updated_at&schooljaar=eq." + schooljaar + "&order=nr.asc,id.asc");
  if (!uit.ok) return uit;
  if (!metEigenId(uit.rijen)) return { ok: false, reden: "onvolledig", status: 0 };
  return uit;
}

/**
 * De klassenlijst uit de instellingen van de uitstappentool. Geeft { ok: true, klassen }, of
 * { ok: false, reden }. Zonder de rij met de instellingen, of zonder klassen erin, is de reden "leeg":
 * een lege klassenlijst is een fout, geen resultaat.
 */
async function leesKlassen(haal, bron) {
  const uit = await leesAlles(haal, bron, TABEL_INSTELLINGEN + "?select=data&id=eq." + INSTELLINGEN_ID + "&order=id.asc");
  if (!uit.ok) return uit;
  const klassen = uit.rijen.length === 1 ? klassenUit(uit.rijen[0].data) : [];
  if (!klassen.length) return { ok: false, reden: "leeg", status: 0 };
  return { ok: true, klassen };
}
// ==== adapter: einde ====

/**
 * Mag dit verzoek naar de uitstappentool? Enkel lezen, enkel haar tabellen, en met niets anders in de
 * kop dan haar eigen publishable key: geen toegangsbewijs, geen sleutel van de MT.
 */
export function magNaarBron(adres, opties) {
  return typeof adres === "string" && adres.startsWith(UITSTAPPENTOOL.url + "/rest/v1/") && opties.method === "GET" && opties.body === undefined
    && Object.keys(opties.headers).sort().join(",") === "Accept,Prefer,apikey" && opties.headers.apikey === UITSTAPPENTOOL.sleutel;
}

/** Een fout die de pagina mag tonen: de tekst is voor de gebruiker geschreven. */
class Fout extends Error {
  constructor(status, code, tekst) {
    super(tekst);
    this.status = status;
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Eén oproep, naar Supabase of naar de uitstappentool, wacht hoogstens zo lang. */
const WACHTTIJD = 8_000;
/** Een heel verzoek blijft onder de dertig seconden die de pagina wacht (data.js). */
const TIJD_PER_VERZOEK = 24_000;
const MAX_INVOER = 1_000;
/**
 * Zoveel uitstappen gaan in één keer naar de databank. Gemeten op een lokale Postgres: 450 nieuwe
 * uitstappen met hun lijsten in 0,33 seconden, 450 ongewijzigde in 0,09 seconden. Via de API stopt een
 * vraag na 8 seconden: met 500 per keer blijft daar ruim marge onder, ook op een tragere databank.
 */
const PER_KEER = 500;
const LATER = "De databank van de MT antwoordt niet. Probeer het over enkele minuten opnieuw.";
const BRON_STIL = "De uitstappentool antwoordt niet. De MT toont de stand van de vorige keer; probeer het over enkele minuten opnieuw.";
const BRON_FOUT = "De MT kon de uitstappentool niet volledig lezen. Er is niets gewijzigd; probeer het over enkele minuten opnieuw.";
const TELLERS = ["nieuw", "gewijzigd", "weg", "ongewijzigd", "ongeldig", "buiten", "geen", "gesloten", "ouder"];

/**
 * o is alles wat de functie van buiten nodig heeft; in de tests is dat nagebootst:
 *   url      het adres van het project van Supabase van de MT
 *   publiek  de publishable key van dat project: openbaar, enkel als apikey
 *   geheim   de secret key: enkel in deze functie, en enkel naar het eigen project
 *   haal     het netwerk: (adres, opties) geeft een antwoord
 *   meld     het logboek van de functie: de uitkomst, nooit meer
 *   nu       de tijd van nu, in milliseconden
 */
export function maakBehandelaar(o) {
  const pagina = Object.prototype.hasOwnProperty.call(PAGINA, o.url) ? PAGINA[o.url] : null;

  // ---------- Antwoorden ----------

  function koppen(metCors) {
    const k = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    if (metCors && pagina) {
      k.set("Access-Control-Allow-Origin", pagina);
      k.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
      k.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      k.set("Access-Control-Max-Age", "600");
      k.set("Vary", "Origin");
    }
    return k;
  }

  function geef(status, lichaam, metCors = true) {
    return new Response(JSON.stringify(lichaam), { status, headers: koppen(metCors) });
  }

  /** Hoeveel tijd een oproep nog krijgt: hoogstens de wachttijd, en nooit voorbij het einde van het verzoek. */
  const tijdVoor = (beurt) => Math.min(WACHTTIJD, beurt.tot - o.nu());

  // ---------- Het eigen project ----------

  /**
   * Eén oproep naar het eigen project. Geeft de status en het antwoord; status 0 is geen antwoord.
   * Een omleiding wordt nooit gevolgd: de sleutel in de kop gaat enkel naar het eigen project.
   */
  async function roep(beurt, pad, methode, sleutel, drager, lichaam) {
    const tijd = tijdVoor(beurt);
    if (tijd < 250) return { status: 0, gegevens: null };
    const k = { apikey: sleutel, Accept: "application/json", Authorization: "Bearer " + drager };
    if (lichaam !== undefined) k["Content-Type"] = "application/json";
    try {
      const r = await o.haal(o.url + pad, {
        method: methode,
        headers: k,
        body: lichaam === undefined ? undefined : JSON.stringify(lichaam),
        redirect: "error",
        signal: AbortSignal.timeout(tijd),
      });
      const tekst = await r.text();
      let gegevens = null;
      if (tekst) {
        try {
          gegevens = JSON.parse(tekst);
        } catch {
          gegevens = null;
        }
      }
      return { status: r.status, gegevens };
    } catch {
      return { status: 0, gegevens: null };
    }
  }

  /**
   * Een databankfunctie. Met een toegangsbewijs: als die gebruiker, met de publishable key. Zonder: als
   * de serverfunctie, met de secret key als apikey en als Bearer, zoals supabase-js: Supabase wisselt
   * hem zelf om voor een kortlevend bewijs van de rol service_role.
   */
  async function databank(beurt, functie, args, token) {
    const r = token === null
      ? await roep(beurt, "/rest/v1/rpc/" + functie, "POST", o.geheim, o.geheim, args)
      : await roep(beurt, "/rest/v1/rpc/" + functie, "POST", o.publiek, token, args);
    if (r.status >= 200 && r.status < 300 && r.gegevens !== null && typeof r.gegevens === "object") return r.gegevens;
    const g = r.gegevens !== null && typeof r.gegevens === "object" ? r.gegevens : {};
    const code = typeof g.code === "string" ? g.code : "";
    const tekst = typeof g.message === "string" ? g.message.replace(/^MT: /, "") : "";
    if (code === "42501") throw new Fout(403, "rechten", tekst || "Je hebt geen rechten voor deze handeling.");
    if (code === "MT422") throw new Fout(422, "kan_niet", tekst);
    if (code === "22023" || code === "22P02") throw new Fout(500, "databank", "De databank weigert wat de serverfunctie doorgaf.");
    // De databank wachtte te lang op een slot of op een antwoord (de tijdslimieten van Supabase): later opnieuw.
    if (code === "55P03" || code === "57014") throw new Fout(503, "databank", LATER);
    if (r.status === 401) throw new Fout(401, "sessie", "Je sessie is verlopen. Meld opnieuw aan.");
    if (r.status === 404 || code === "PGRST202") throw new Fout(500, "databank", "De databank kent deze functie niet: voer sql/005_review1.sql uit.");
    throw new Fout(r.status === 0 ? 503 : 500, "databank", r.status === 0 ? LATER : "De databank gaf een fout.");
  }

  // ---------- Wie roept op ----------

  /** Het toegangsbewijs echt nakijken, bij Supabase zelf en voor dit project (17.4), zoals mt-accounts. */
  async function wieIsDit(beurt, verzoek) {
    const kop = verzoek.headers.get("Authorization") ?? "";
    const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(kop);
    if (!m) throw new Fout(401, "sessie", "Meld eerst aan.");
    const token = m[1];
    const r = await roep(beurt, "/auth/v1/user", "GET", o.publiek, token);
    if (r.status === 0 || r.status >= 500) throw new Fout(503, "supabase", "Supabase antwoordt niet. Probeer het over enkele minuten opnieuw.");
    const g = r.gegevens !== null && typeof r.gegevens === "object" ? r.gegevens : {};
    if (r.status !== 200 || typeof g.id !== "string" || !UUID.test(g.id)) throw new Fout(401, "sessie", "Je sessie is verlopen. Meld opnieuw aan.");
    return { id: g.id, token };
  }

  // ---------- De uitstappentool ----------

  /**
   * Het netwerk voor adapter.js: enkel naar de uitstappentool, enkel lezen, en met een grens in de tijd.
   * De adapter stuurt enkel de publishable key van de uitstappentool mee. Staat er toch iets anders in
   * de kop, of wijst het adres elders heen, dan vertrekt er niets.
   */
  function naarBron(beurt) {
    return (adres, opties) => {
      if (!magNaarBron(adres, opties)) return Promise.reject(new Error("de adapter vraagt iets wat deze functie niet toelaat"));
      const tijd = tijdVoor(beurt);
      if (tijd < 250) return Promise.reject(new Error("de tijd van het verzoek is om"));
      return o.haal(adres, { ...opties, redirect: "error", signal: AbortSignal.timeout(tijd) });
    };
  }

  function bronFout(reden) {
    return new Fout(reden === "verbinding" ? 503 : 502, "bron", reden === "verbinding" ? BRON_STIL : BRON_FOUT);
  }

  // ---------- Bijwerken ----------

  async function bijwerken(beurt, wie) {
    const begin = o.nu();
    // 2. Is de vrager een gebruiker van de MT? De databank beslist, met zijn eigen toegangsbewijs.
    const account = await databank(beurt, "mt_mijn_account", {}, wie.token);
    const beheerder = account.rol === "beheerder";

    // 3. De uitstappentool lezen. De uitstappen kort: enkel wat de databank nodig heeft.
    const bron = naarBron(beurt);
    const [gelezen, klassenlijst] = await Promise.all([
      leesUitstappenKort(bron, UITSTAPPENTOOL),
      beheerder ? leesKlassen(bron, UITSTAPPENTOOL) : Promise.resolve(null),
    ]);
    if (!gelezen.ok) throw bronFout(gelezen.reden);
    if (klassenlijst !== null && !klassenlijst.ok && klassenlijst.reden !== "leeg") throw bronFout(klassenlijst.reden);

    // 4. De klassen, enkel voor een beheerder en met zijn eigen toegangsbewijs: de groep van een klas
    //    bepaalt het plafond. Kan het niet, bv. omdat er nog geen lopend schooljaar is, dan zegt het
    //    antwoord waarom, en gaan de uitstappen gewoon door.
    let klassen = null;
    if (klassenlijst !== null) {
      if (!klassenlijst.ok) klassen = { ok: false, melding: "De uitstappentool heeft geen klassenlijst." };
      else {
        try {
          const r = await databank(beurt, "mt_klassen_bijwerken", { p_klassen: klassenlijst.klassen }, wie.token);
          klassen = { ok: true, schooljaar: r.schooljaar, nieuw: r.nieuw, gewijzigd: r.gewijzigd, uitgezet: r.uitgezet };
        } catch (fout) {
          if (!(fout instanceof Fout) || fout.code !== "kan_niet") throw fout;
          klassen = { ok: false, melding: fout.message };
        }
      }
    }

    // 5. De uitstappen, met de secret key, in delen. De volledige lijst van id's gaat mee met het
    //    laatste deel: pas als alles doorgegeven is, weet de databank wat er niet meer is.
    const b = bericht(gelezen.rijen);
    const uitstappen = Object.fromEntries(TELLERS.map((teller) => [teller, 0]));
    uitstappen.niet_gevonden = 0;
    const onbekendeKlassen = [];
    const wacht = [];
    const delen = Math.max(1, Math.ceil(b.uitstappen.length / PER_KEER));
    for (let deel = 0; deel < delen; deel++) {
      const r = await databank(beurt, "mt_uitstappen_bijwerken", {
        p_uitstappen: b.uitstappen.slice(deel * PER_KEER, (deel + 1) * PER_KEER),
        p_alle_ids: deel === delen - 1 ? b.alleIds : null,
      }, null);
      for (const teller of TELLERS) uitstappen[teller] += Number.isInteger(r[teller]) ? r[teller] : 0;
      if (Number.isInteger(r.niet_gevonden)) uitstappen.niet_gevonden += r.niet_gevonden;
      if (Array.isArray(r.onbekende_klassen)) onbekendeKlassen.push(...r.onbekende_klassen);
      if (Array.isArray(r.wacht)) wacht.push(...r.wacht);
    }

    return {
      versie: VERSIE,
      rekenversie: REKENVERSIE,
      gelezen: { uitstappen: gelezen.rijen.length, klassen: klassenlijst !== null && klassenlijst.ok ? klassenlijst.klassen.length : null },
      klassen,
      uitstappen,
      onbekende_klassen: onbekendeKlassen,
      wacht,
      onbekende_versie: b.onbekendeVersie,
      duur_ms: o.nu() - begin,
    };
  }

  // ---------- De oproep ----------

  return async function behandel(verzoek) {
    try {
      if (!pagina || !o.publiek || !o.geheim) {
        o.meld({ resultaat: "instelling" });
        return geef(500, { ok: false, code: "instelling", melding: "De serverfunctie is niet ingesteld voor dit project." }, false);
      }
      const oorsprong = verzoek.headers.get("Origin");
      if (oorsprong !== null && oorsprong !== pagina) {
        return geef(403, { ok: false, code: "oorsprong", melding: "Dit adres mag de serverfunctie niet oproepen." }, false);
      }
      if (verzoek.method === "OPTIONS") return new Response(null, { status: 204, headers: koppen(true) });
      if (verzoek.method !== "POST") throw new Fout(405, "oproep", "Deze oproep klopt niet.");

      const ruw = await verzoek.text();
      if (ruw.length > MAX_INVOER) throw new Fout(413, "oproep", "Deze oproep is te groot.");
      let invoer;
      try {
        invoer = JSON.parse(ruw);
      } catch {
        throw new Fout(400, "oproep", "Deze oproep klopt niet.");
      }
      if (invoer === null || typeof invoer !== "object" || Array.isArray(invoer) || invoer.actie !== "bijwerken") {
        throw new Fout(400, "oproep", "Deze oproep klopt niet.");
      }
      const beurt = { tot: o.nu() + TIJD_PER_VERZOEK };
      // 1. Het toegangsbewijs echt nakijken.
      const wie = await wieIsDit(beurt, verzoek);
      const uit = await bijwerken(beurt, wie);
      o.meld({ resultaat: "gelukt", gelezen: uit.gelezen.uitstappen, duur_ms: uit.duur_ms });
      return geef(200, { ok: true, ...uit });
    } catch (fout) {
      if (fout instanceof Fout) {
        o.meld({ resultaat: fout.code, status: fout.status });
        return geef(fout.status, { ok: false, code: fout.code, melding: fout.message });
      }
      o.meld({ resultaat: "onverwacht", soort: fout instanceof Error ? fout.name : "onbekend" });
      return geef(500, { ok: false, code: "onverwacht", melding: "De serverfunctie gaf een onverwachte fout." });
    }
  };
}

/** De sleutel met de naam "default" uit de lijst die Supabase aan de functie geeft. */
function sleutel(naam) {
  try {
    const lijst = JSON.parse(Deno.env.get(naam) ?? "{}");
    return typeof lijst.default === "string" ? lijst.default : "";
  } catch {
    return "";
  }
}

let behandelaar = null;

export default {
  fetch(verzoek) {
    // De sleutels komen van Supabase zelf, als omgevingsvariabelen van de functie. Nooit uit dit bestand.
    behandelaar ??= maakBehandelaar({
      url: (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, ""),
      publiek: sleutel("SUPABASE_PUBLISHABLE_KEYS"),
      geheim: sleutel("SUPABASE_SECRET_KEYS"),
      haal: (adres, opties) => fetch(adres, opties),
      meld: (regel) => console.log(JSON.stringify({ functie: "mt-uitstappen", versie: VERSIE, ...regel })),
      nu: () => Date.now(),
    });
    return behandelaar(verzoek);
  },
};
