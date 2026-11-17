// MT · adapter.js · versie 0.9.0
// De uitstappentool lezen (hoofdstuk 4 en 17.1 van de huidige stand; T1, V20, V22, B212).
//
// Regel 2 (17.1): dit bestand leest de uitstappentool enkel over het netwerk, met de functie die het
// meekrijgt (haal), en schrijft er nooit in. Het importeert niets, en kent geen scherm, geen
// browseropslag en geen klok. Zo draait precies dezelfde tekst op twee plaatsen (B212):
//   - in de pagina, om te tonen wat de uitstappentool zegt;
//   - in de serverfunctie functies/mt-uitstappen, die de MT bijwerkt. Alles onder de streep hieronder
//     staat daar woord voor woord in; een test bewaakt dat.
//
// De vaste volgorde van T1:
//   1. alles ophalen, in bladzijden: telkens verder vanaf de laatste id, met het totaal van de databank
//      erbij. Mislukt een bladzijde of ontbreekt het totaal, dan is er geen lijst: nooit een lege of halve;
//   2. de ruwe schemaversie nakijken, vóór norm(): norm() zet de versie zelf altijd op 2;
//   3. een eigen kopie normaliseren, met norm() woord voor woord uit de uitstappentool;
//   4. vergelijken met wat de MT al kent: dat doet de databank zelf (mt_uitstappen_bijwerken), met
//      wat melding() hier per uitstap klaarzet;
//   5. kiezen: een nascholing komt nooit in de MT, een verwijderde of geannuleerde uitstap telt niet
//      mee, een aangevraagde enkel apart, een bevestigde telt.
//
// Wat een uitstap kost, vertaalt kostenVoorMT() naar het rekencontract (1.3): een gedeelde kost, een
// prijs per kind, of onbekend. Een prijs die ontbreekt, is nooit € 0 (B80).

export const VERSIE = "0.9.0";

// ==== adapter: gedeeld met de serverfunctie ====

/**
 * De rekenversie (17.1): dezelfde als in rekenen.js; een test bewaakt dat. Ze gaat omhoog bij elke
 * wijziging aan rekenen.js of aan dit bestand die een uitkomst kan wijzigen. De serverfunctie meldt
 * haar rekenversie aan de pagina: verschilt ze, dan staat in Supabase een oudere serverfunctie.
 */
export const REKENVERSIE = 3;

/** De ruwe schemaversies van de uitstappentool die de MT begrijpt (T1). Zonder versie: van vóór de versies. */
export const BEKENDE_VERSIES = Object.freeze([1, 2]);

/** De twee tabellen van de uitstappentool die de MT leest, en de ene rij met de instellingen (hoofdstuk 4). */
const TABEL_UITSTAPPEN = "uitstappen";
const TABEL_INSTELLINGEN = "instellingen";
const INSTELLINGEN_ID = "klimop";

/** De Data API geeft hoogstens 1000 rijen per vraag terug. */
const BLADZIJDE = 1000;
/** Na zoveel bladzijden stopt het lezen: zoveel uitstappen telt de uitstappentool nooit. */
const MAX_BLADZIJDEN = 50;
/** Meer klassen dan dit heeft geen uitstap: de MT neemt zo'n rij niet over (review 2: R2-09). */
const MAX_KLASSEN = 50;

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
export const overgenomen = Object.freeze({ SCHEMA, GROEPEN, r2, parseISO, schooljaarVan, toNum, norm, persAantal, kosten });

// ---------- T1, stap 2 en 3: de ruwe versie, en dan een eigen kopie normaliseren ----------

/**
 * Eén rij van de uitstappentool: { id, updated_at, trip }. Geeft
 *   id, gewijzigd   het id, en het tijdstip updated_at: de versie van de uitstap in de uitstappentool
 *   versie          de ruwe schemaversie zoals ze er staat; null zonder versie
 *   bekend          begrijpt de MT deze versie? Zo niet, dan leest ze de uitstap niet (T1)
 *   bruikbaar       kan de MT met de rij rekenen? Een rij waarover de overgenomen code struikelt, of met
 *                   meer dan vijftig klassen, neemt de MT niet over: iedereen kan in de uitstappentool
 *                   een aanvraag toevoegen, ook buiten het scherm om, en zo'n rij mag het lezen van de
 *                   andere nooit doen stoppen (review 2: R13)
 *   uitstap         de uitstap na norm(); null bij een onbekende versie of een onbruikbare rij
 * norm() krijgt een eigen kopie: het wijzigt ook wat in de uitstap genest zit, zoals de annulering.
 * Een rij zonder gegevens leest de MT als een uitstap zonder velden, dus zonder datum: dat is ook wat
 * de korte lezing van zo'n rij geeft (review 2: R2-06).
 */
export function normaliseer(rij) {
  const trip = rij ? rij.trip : null;
  const ruw = trip !== null && typeof trip === "object" && !Array.isArray(trip) ? trip : {};
  const versie = ruw.v === undefined ? null : ruw.v;
  const bekend = versie === null || BEKENDE_VERSIES.includes(versie);
  let uitstap = null;
  if (bekend) {
    try {
      uitstap = norm(JSON.parse(JSON.stringify(ruw)));
      if (!Array.isArray(uitstap.klassen) || uitstap.klassen.length > MAX_KLASSEN) uitstap = null;
    } catch {
      // De overgenomen code struikelt over deze rij: de MT slaat ze over, en leest de andere gewoon.
      uitstap = null;
    }
  }
  return {
    id: rij ? rij.id : null,
    gewijzigd: rij ? rij.updated_at : null,
    versie,
    bekend,
    bruikbaar: uitstap !== null,
    uitstap,
  };
}

// ---------- T1, stap 4: wat de databank van de MT krijgt (64.3) ----------

/**
 * De melding van één uitstap aan mt_uitstappen_bijwerken. Een datum die de uitstappentool zelf
 * ongeldig noemt, gaat niet mee: de databank slaat de uitstap dan over als ongeldig, en wat de MT wist,
 * blijft staan.
 */
export function melding(n) {
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
 * Een uitstap met een onbekende schemaversie gaat niet mee (T1), en een onbruikbare rij ook niet. Hun id
 * staat wel in de lijst: de MT houdt wat ze wist, en de uitstap geldt niet als "niet gevonden".
 */
export function bericht(rijen) {
  const uitstappen = [];
  const alleIds = [];
  const onbekendeVersie = [];
  const onbruikbaar = [];
  for (const rij of rijen) {
    const n = normaliseer(rij);
    alleIds.push(n.id);
    if (!n.bekend) onbekendeVersie.push(n.id);
    else if (!n.bruikbaar) onbruikbaar.push(n.id);
    else uitstappen.push(melding(n));
  }
  return { uitstappen, alleIds, onbekendeVersie, onbruikbaar };
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
export function soortVan(t) {
  if (t.categorie === "nascholing") return "nascholing";
  if (t.verwijderdOp) return "verwijderd";
  return t.planStatus;
}

/**
 * De uitstappen geteld, per schooljaar: wat de pagina toont om na te kijken wat de MT leest.
 * Geeft { jaren: [{ schooljaar, bevestigd, aangevraagd, geannuleerd }], nascholingen, verwijderd,
 * zonderDatum, onbekendeVersie, onbruikbaar }. Het schooljaar volgt uit de startdatum, zoals in de
 * uitstappentool.
 */
export function overzicht(rijen) {
  const perJaar = new Map();
  const uit = { jaren: [], nascholingen: 0, verwijderd: 0, zonderDatum: 0, onbekendeVersie: 0, onbruikbaar: 0 };
  for (const rij of rijen) {
    const n = normaliseer(rij);
    if (!n.bekend) {
      uit.onbekendeVersie++;
      continue;
    }
    if (!n.bruikbaar) {
      uit.onbruikbaar++;
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
export function kostenVoorMT(t) {
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
export function annuleringVoorMT(t) {
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
export function klassenUit(instellingen) {
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

/**
 * Eén lezing van alle bladzijden: { rijen }, of { reden } als ze mislukt of niet volledig is.
 * Elke bladzijde gaat verder vanaf de laatste id van de vorige ("id groter dan"), niet vanaf een aantal
 * rijen: verdwijnt er intussen een rij en komt er een bij, dan verschuift er niets, en een rij die er
 * heel de tijd stond, valt nooit weg (review 2: R05, R2-04). Het totaal bij elke bladzijde zegt hoeveel
 * rijen er vanaf daar nog zijn: zo weet de MT of er nog een bladzijde volgt, wat de databank ook als
 * grootste bladzijde toelaat.
 */
async function leesEenKeer(haal, bron, vraag) {
  const rijen = [];
  let laatste = null;
  for (let blad = 0; blad < MAX_BLADZIJDEN; blad++) {
    let antwoord;
    let gegevens;
    try {
      antwoord = await haal(bron.url + "/rest/v1/" + vraag + "&order=id.asc&limit=" + BLADZIJDE + (laatste === null ? "" : "&id=gt." + encodeURIComponent(laatste)), {
        method: "GET",
        // De publishable key gaat enkel mee als apikey, nooit als toegangsbewijs (design system 1.13).
        headers: { apikey: bron.sleutel, Accept: "application/json", Prefer: "count=exact" },
        redirect: "error",
      });
      gegevens = antwoord.ok ? JSON.parse(await antwoord.text()) : null;
    } catch {
      return { reden: "verbinding" };
    }
    if (!antwoord.ok) return { reden: antwoord.status === 401 || antwoord.status === 403 ? "geweigerd" : "fout", status: antwoord.status };
    if (!Array.isArray(gegevens)) return { reden: "fout", status: antwoord.status };
    // Hoeveel rijen er vanaf hier nog zijn, deze bladzijde inbegrepen. Zonder dat getal is er geen lijst.
    const over = totaalUit(antwoord.headers.get("content-range"));
    if (over === null || gegevens.length > over) return { reden: "onvolledig" };
    for (const rij of gegevens) {
      if (rij === null || typeof rij !== "object") return { reden: "fout", status: antwoord.status };
      rijen.push(rij);
    }
    if (gegevens.length === over) return { rijen };
    // Er volgt nog een bladzijde: verder vanaf de laatste id. Zonder een nieuwe id komt de MT niet vooruit.
    const id = gegevens.length ? gegevens[gegevens.length - 1].id : null;
    if (typeof id !== "string" || id === "" || id === laatste) return { reden: "onvolledig" };
    laatste = id;
  }
  return { reden: "onvolledig" };
}

/**
 * Alle rijen van één vraag aan de uitstappentool (T1, stap 1). haal is de functie waarmee de
 * oproeper het netwerk aanspreekt, met zijn eigen grens in de tijd; bron is { url, sleutel }.
 * Geeft { ok: true, rijen } of { ok: false, reden }:
 *   "verbinding"   geen antwoord
 *   "geweigerd"    de uitstappentool weigert de sleutel
 *   "fout"         een ander antwoord dan een lijst
 *   "onvolledig"   het totaal ontbreekt of een bladzijde klopt niet, ook niet bij een tweede lezing
 * Een fout is nooit een lege lijst.
 */
async function leesAlles(haal, bron, vraag) {
  let uit = await leesEenKeer(haal, bron, vraag);
  // Klopte een bladzijde niet, dan leest de MT één keer opnieuw.
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
export async function leesUitstappenKort(haal, bron) {
  const kolommen = ["id", "updated_at", ...VELDEN_KORT.map((veld) => veld + ":trip->" + veld)];
  const uit = await leesAlles(haal, bron, TABEL_UITSTAPPEN + "?select=" + kolommen.join(","));
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
export async function leesUitstappen(haal, bron, schooljaar) {
  if (!/^\d{4}-\d{4}$/.test(String(schooljaar))) return { ok: false, reden: "fout", status: 0 };
  const uit = await leesAlles(haal, bron, TABEL_UITSTAPPEN + "?select=id,nr,schooljaar,trip,updated_at&schooljaar=eq." + schooljaar);
  if (!uit.ok) return uit;
  if (!metEigenId(uit.rijen)) return { ok: false, reden: "onvolledig", status: 0 };
  // Gelezen op id; getoond op nummer, zoals in de uitstappentool.
  uit.rijen.sort((a, b) => (Number(a.nr) || 0) - (Number(b.nr) || 0) || (a.id < b.id ? -1 : 1));
  return uit;
}

/**
 * De klassenlijst uit de instellingen van de uitstappentool. Geeft { ok: true, klassen }, of
 * { ok: false, reden }. Zonder de rij met de instellingen, of zonder klassen erin, is de reden "leeg":
 * een lege klassenlijst is een fout, geen resultaat.
 */
export async function leesKlassen(haal, bron) {
  const uit = await leesAlles(haal, bron, TABEL_INSTELLINGEN + "?select=data&id=eq." + INSTELLINGEN_ID);
  if (!uit.ok) return uit;
  const klassen = uit.rijen.length === 1 ? klassenUit(uit.rijen[0].data) : [];
  if (!klassen.length) return { ok: false, reden: "leeg", status: 0 };
  return { ok: true, klassen };
}
