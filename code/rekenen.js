// MT · rekenen.js · versie 0.9.0
// Het rekencontract (mt-rekencontract.md, versie 20): hoe de MT rekent, tot op de cent. De nummers in
// dit bestand, zoals 1.16 of G5e, verwijzen naar dat contract.
//
// Regel 1 (17.1): dit bestand importeert niets, en kent geen scherm, netwerk, browseropslag of klok.
// Alles komt mee als gegeven, ook een datum (als kalenderdatum jjjj-mm-dd). Zo geeft het in de
// browser, in een serverfunctie en in de tests exact dezelfde uitkomst, in elke tijdzone (B69).
//
// Hoe het rekent (1.1, 1.16):
//   - alle bedragen zijn hele centen;
//   - onderweg rekent het exact, met breuken van gehele getallen: geen kommagetallen en geen
//     tussentijdse afronding;
//   - afronden gebeurt één keer per leerling en per activiteit (B98), naar de dichtstbijzijnde cent,
//     tot en met de halve cent naar beneden (B97). Ook wat de tussenkomsten dragen, wordt voor de twee
//     onderdelen samen één keer afgerond (review 2).
//
// Wat hier staat, is fase 1: verdelen (1.4), tussenkomsten (1.5), wat de school draagt (1.6, 1.15),
// wie meetelt (1.2), het plafond per leerling (1.11), een correctie verdelen (1.10) en de stand van
// een bedrag (1.8). De facturatie, de voorschotten en het rapport volgen in fase 2; minder scherp en
// de credits van een meerdaagse in fase 3.

export const VERSIE = "0.9.0";

/**
 * De rekenversie (17.1): gaat omhoog bij elke wijziging aan dit bestand of aan adapter.js die een
 * uitkomst kan wijzigen, en staat later in elke momentopname. Een test weigert een wijziging zonder
 * nieuwe rekenversie (tests/rekenversie_test.js).
 */
export const REKENVERSIE = 3;

// ---------- Exact rekenen met breuken ----------

function fout(tekst) {
  return new RangeError("rekenen: " + tekst);
}

function ggd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Een breuk t/n, vereenvoudigd, met een noemer boven nul. */
function breuk(t, n = 1n) {
  if (n === 0n) throw fout("een deling door nul");
  if (n < 0n) {
    t = -t;
    n = -n;
  }
  const g = ggd(t, n) || 1n;
  return { t: t / g, n: n / g };
}

const NUL = breuk(0n);
const plus = (a, b) => breuk(a.t * b.n + b.t * a.n, a.n * b.n);
const min = (a, b) => breuk(a.t * b.n - b.t * a.n, a.n * b.n);
const maal = (a, b) => breuk(a.t * b.t, a.n * b.n);
const gedeeldDoor = (a, b) => breuk(a.t * b.n, a.n * b.t);
const kleiner = (a, b) => a.t * b.n < b.t * a.n;
const kleinste = (a, b) => (kleiner(b, a) ? b : a);
/** Nooit onder nul. */
const vanafNul = (a) => (a.t < 0n ? NUL : a);
const isNul = (a) => a.t === 0n;

/** Een geheel getal als BigInt; al de rest is een fout in de oproep. */
function geheel(waarde, wat) {
  if (typeof waarde === "bigint") return waarde;
  if (typeof waarde !== "number" || !Number.isSafeInteger(waarde)) throw fout(wat + " is geen geheel getal");
  return BigInt(waarde);
}

function nietNegatief(waarde, wat) {
  const g = geheel(waarde, wat);
  if (g < 0n) throw fout(wat + " is negatief");
  return g;
}

function alsGetal(g) {
  const getal = Number(g);
  if (!Number.isSafeInteger(getal)) throw fout("een bedrag is te groot");
  return getal;
}

/**
 * Afronden naar de dichtstbijzijnde cent (B97): tot en met de halve cent naar beneden, daarboven naar
 * boven. Bij een credit geldt hetzelfde op het bedrag: -0,335 wordt -0,33.
 * teller en noemer zijn gehele getallen, in centen: afronden(67, 2) is 33, afronden(6701, 200) is 34.
 */
export function afronden(teller, noemer = 1) {
  let t = geheel(teller, "de teller");
  let n = geheel(noemer, "de noemer");
  if (n === 0n) throw fout("een deling door nul");
  if (n < 0n) {
    t = -t;
    n = -n;
  }
  const negatief = t < 0n;
  if (negatief) t = -t;
  const q = t / n;
  const r = t % n;
  const uit = 2n * r > n ? q + 1n : q;
  return alsGetal(negatief ? -uit : uit);
}

const rond = (b) => afronden(b.t, b.n);

// ---------- Verdelen (1.3 tot 1.7, 1.16) ----------
//
// Een activiteit heeft twee onderdelen: de activiteit zelf en het vervoer. Elk onderdeel heeft:
//   gedeeld             de gedeelde kost G, in centen: gelijk verdeeld over de aangerekende leerlingen
//   perKind             de prijs per kind p, in centen
//   onbekend            true: de prijs ontbreekt of is nog te bevestigen. Nooit stil € 0 (B80)
//   tussenkomstTotaal   de tussenkomsten als totaal, samen (B81, B91)
//   tussenkomstPerKind  de tussenkomsten als bedrag per kind, samen (B104)
//   aangerekend         A: het aantal aangerekende leerlingen, van alle klassen samen
//   betalers            B: het aantal dat de prijs per kind betaalt
// Geen vervoer, of een gratis activiteit: laat het onderdeel weg, of geef null.
//
// Een leerling heeft per onderdeel een profiel:
//   aangerekend   hij telt mee in A, en betaalt zijn deel van de gedeelde kost
//   perKind       hij telt mee in B, en betaalt de prijs per kind
//   school        de school draagt zijn deel: gratis zwemjaar (B66), meerdaags in de kleuterschool (B142)

/** Het profiel van een leerling voor één onderdeel. Wie niet aangerekend is, betaalt ook de prijs per kind niet. */
function leesDeel(deel) {
  const aangerekend = Boolean(deel && deel.aangerekend);
  return { aangerekend, perKind: aangerekend && Boolean(deel.perKind), school: Boolean(deel && deel.school) };
}

/**
 * Een profiel dat voor beide onderdelen hetzelfde is.
 *   profiel(true, true)   aanwezig
 *   profiel(true, false)  aangerekend, maar zonder de prijs per kind (briefje ouders, ongewettigd afwezig, nog te bepalen)
 *   profiel(false)        niet aangerekend: een attest, of wie niet deelneemt
 */
export function profiel(aangerekend, perKind = aangerekend, school = false) {
  const deel = Object.freeze(leesDeel({ aangerekend, perKind, school }));
  return Object.freeze({ activiteit: deel, vervoer: deel });
}

export const AANWEZIG = profiel(true, true);
export const ENKEL_GEDEELD = profiel(true, false);
export const NIET_AANGEREKEND = profiel(false, false);

function leesOnderdeel(o, naam) {
  if (o === null || o === undefined) return null;
  if (o.onbekend) return { onbekend: true };
  const uit = {
    onbekend: false,
    G: nietNegatief(o.gedeeld ?? 0, "de gedeelde kost van " + naam),
    p: nietNegatief(o.perKind ?? 0, "de prijs per kind van " + naam),
    T: nietNegatief(o.tussenkomstTotaal ?? 0, "de tussenkomst van " + naam),
    t: nietNegatief(o.tussenkomstPerKind ?? 0, "de tussenkomst per kind van " + naam),
    A: nietNegatief(o.aangerekend, "het aantal aangerekende leerlingen van " + naam),
    B: 0n,
  };
  // Zonder prijs per kind betaalt niemand er een. Mét een prijs per kind moet het aantal betalers
  // meekomen: een aantal dat ontbreekt, is nooit stil nul.
  if (uit.p > 0n) uit.B = nietNegatief(o.betalers, "het aantal betalers van " + naam);
  if (uit.B > uit.A) throw fout("bij " + naam + " betalen meer leerlingen de prijs per kind dan er aangerekend zijn");
  return uit;
}

/**
 * Eén onderdeel, vóór de tussenkomsten als totaal (1.16):
 *   e = p (als hij die betaalt) + G / A (als hij aangerekend is)
 * Een tussenkomst per kind t maakt daarvan max(0, e − t): voor wie de prijs per kind betaalt, of
 * zonder prijs per kind voor elke aangerekende leerling (B104). Wat daarbij per leerling wegvalt,
 * max(0, t − e), telt samen als overschot (B141).
 */
function voorTotaal(o) {
  const kost = breuk(o.G + o.p * o.B);
  if (o.A === 0n) {
    // Niemand aangerekend: de kost is voor de school. Geen deling door nul (1.4, G4). Een tussenkomst als
    // totaal verlaagt dan wat de school draagt (1.5, B223, G4b); een tussenkomst per kind heeft niemand
    // om naartoe te gaan.
    return { betaler: NUL, enkelGedeeld: NUL, ruimte: kost, overschotPerKind: NUL, perKindGebruikt: NUL, kost };
  }
  const deel = breuk(o.G, o.A);
  let betaler = plus(breuk(o.p), deel);
  let enkelGedeeld = deel;
  let overschotPerKind = NUL;
  let perKindGebruikt = NUL;
  if (o.t > 0n) {
    const t = breuk(o.t);
    if (o.p > 0n) {
      overschotPerKind = maal(breuk(o.B), vanafNul(min(t, betaler)));
      perKindGebruikt = maal(breuk(o.B), kleinste(t, betaler));
      betaler = vanafNul(min(betaler, t));
    } else {
      overschotPerKind = maal(breuk(o.A), vanafNul(min(t, deel)));
      perKindGebruikt = maal(breuk(o.A), kleinste(t, deel));
      betaler = enkelGedeeld = vanafNul(min(deel, t));
    }
  }
  // Wat de leerlingen samen nog betalen: daar gaat een tussenkomst als totaal van af.
  const ruimte = plus(maal(breuk(o.B), betaler), maal(breuk(o.A - o.B), enkelGedeeld));
  return { betaler, enkelGedeeld, ruimte, overschotPerKind, perKindGebruikt, kost };
}

const binnen = new WeakMap();

/**
 * Verdeelt de kost van een activiteit (1.4, 1.5, 1.16). Geeft de verdeling terug: wat elk onderdeel
 * kost, wat de tussenkomsten dragen, en wat er van een tussenkomst overschiet. Het bedrag van een
 * leerling volgt met bedrag(verdeling, profiel), de sommen met totalen(verdeling, groepen).
 *
 * Een tussenkomst verlaagt eerst haar eigen onderdeel, en maakt nooit een negatieve kost. Wat ze meer
 * is dan haar onderdeel, gaat als totaal naar het andere onderdeel (B102, B141). Wat dat niet kan
 * opnemen, keert terug naar het eigen onderdeel: een tussenkomst blijft nooit ongebruikt zolang er
 * nog iets te betalen is (B219, B221). Wat dan nog overblijft, is de rest: dat lost de beheerder op.
 */
export function verdeel({ activiteit = null, vervoer = null } = {}) {
  const invoer = { activiteit: leesOnderdeel(activiteit, "de activiteit"), vervoer: leesOnderdeel(vervoer, "het vervoer") };
  const stap = {};
  for (const naam of ["activiteit", "vervoer"]) {
    const o = invoer[naam];
    if (o === null || o.onbekend) {
      stap[naam] = null;
      continue;
    }
    const v = voorTotaal(o);
    // De eigen tussenkomst als totaal: zoveel als het onderdeel nog kost; de rest gaat naar het andere onderdeel.
    const eigen = kleinste(breuk(o.T), v.ruimte);
    stap[naam] = { ...v, o, eigen, naarAnder: plus(min(breuk(o.T), eigen), v.overschotPerKind) };
  }
  const ander = { activiteit: "vervoer", vervoer: "activiteit" };
  // Wat elk onderdeel van het overschot van het andere opneemt: zoveel als het zelf nog kost (B102).
  const neemt = {};
  for (const naam of ["activiteit", "vervoer"]) {
    const s = stap[naam];
    const van = stap[ander[naam]];
    neemt[naam] = s && van ? kleinste(van.naarAnder, min(s.ruimte, s.eigen)) : NUL;
  }
  // Wat het andere onderdeel niet kon opnemen, keert terug naar het eigen onderdeel en verlaagt wat de
  // leerlingen daar nog betalen (B219, B221). Pas wat dan nog overblijft, is de rest. Is de prijs van
  // het andere onderdeel onbekend, dan wacht het overschot: het is geen rest, en er keert niets terug.
  let rest = NUL;
  const terug = {};
  for (const naam of ["activiteit", "vervoer"]) {
    const s = stap[naam];
    terug[naam] = NUL;
    if (!s) continue;
    const doel = invoer[ander[naam]];
    if (doel !== null && doel.onbekend) continue;
    const over = min(s.naarAnder, neemt[ander[naam]]);
    terug[naam] = kleinste(over, min(min(s.ruimte, s.eigen), neemt[naam]));
    rest = plus(rest, min(over, terug[naam]));
  }
  const intern = {};
  const zichtbaar = {};
  // Wat de tussenkomsten van elk onderdeel dragen, exact: de eigen, wat van het andere onderdeel overkwam, en wat terugkeerde.
  const gedragen = { activiteit: null, vervoer: null };
  for (const naam of ["activiteit", "vervoer"]) {
    const o = invoer[naam];
    if (o === null) {
      intern[naam] = { bestaat: false, onbekend: false, betaler: NUL, enkelGedeeld: NUL };
      zichtbaar[naam] = { bestaat: false, bekend: true, kost: 0, tussenkomst: 0, aangerekend: 0, betalers: 0 };
      continue;
    }
    if (o.onbekend) {
      // Onbekend: geen bedrag, en wat hierheen zou komen, wacht tot de prijs gekend is.
      intern[naam] = { bestaat: true, onbekend: true, betaler: NUL, enkelGedeeld: NUL };
      zichtbaar[naam] = { bestaat: true, bekend: false, kost: null, tussenkomst: null, aangerekend: null, betalers: null };
      continue;
    }
    const s = stap[naam];
    const blijft = min(min(min(s.ruimte, s.eigen), neemt[naam]), terug[naam]);
    // Elk bedrag van het onderdeel daalt in dezelfde verhouding (B91).
    const factor = isNul(s.ruimte) ? NUL : gedeeldDoor(blijft, s.ruimte);
    intern[naam] = { bestaat: true, onbekend: false, betaler: maal(s.betaler, factor), enkelGedeeld: maal(s.enkelGedeeld, factor), A: s.o.A, B: s.o.B, metPrijsPerKind: s.o.p > 0n };
    gedragen[naam] = plus(plus(plus(s.perKindGebruikt, s.eigen), neemt[naam]), terug[naam]);
    zichtbaar[naam] = { bestaat: true, bekend: true, kost: rond(s.kost), tussenkomst: 0, aangerekend: alsGetal(s.o.A), betalers: alsGetal(s.o.B) };
  }
  // Wat de tussenkomsten dragen, in hele centen (1.5; review 2: R01). De twee onderdelen worden exact opgeteld
  // en samen één keer afgerond, zoals het bedrag van een leerling (B98): de activiteit staat er afgerond, en het
  // vervoer is het verschil met het afgeronde geheel. Zo tellen de twee altijd op tot wat de tussenkomsten
  // samen dragen, en verdwijnt er nooit een cent in twee halve centen.
  if (gedragen.activiteit) zichtbaar.activiteit.tussenkomst = rond(gedragen.activiteit);
  if (gedragen.vervoer) {
    zichtbaar.vervoer.tussenkomst = gedragen.activiteit ? rond(plus(gedragen.activiteit, gedragen.vervoer)) - zichtbaar.activiteit.tussenkomst : rond(gedragen.vervoer);
  }
  Object.freeze(zichtbaar.activiteit);
  Object.freeze(zichtbaar.vervoer);
  const onbekend = intern.activiteit.onbekend || intern.vervoer.onbekend;
  const uit = Object.freeze({
    activiteit: zichtbaar.activiteit,
    vervoer: zichtbaar.vervoer,
    /** Beide onderdelen zijn gekend: er is een totaal per leerling. */
    volledig: !onbekend,
    /**
     * Wat een tussenkomst meer was dan haar onderdeel (B102, B141): hoeveel er van elk onderdeel naar het
     * andere vertrok, hoeveel daarvan terugkeerde omdat het andere het niet kon opnemen (B221), en wat er
     * dan nog overblijft.
     */
    overschot: Object.freeze({
      vanActiviteit: stap.activiteit ? rond(stap.activiteit.naarAnder) : 0,
      vanVervoer: stap.vervoer ? rond(stap.vervoer.naarAnder) : 0,
      terugActiviteit: rond(terug.activiteit),
      terugVervoer: rond(terug.vervoer),
      // Zolang een onderdeel onbekend is, staat niet vast wat er overblijft.
      rest: onbekend ? null : rond(rest),
    }),
  });
  binnen.set(uit, intern);
  return uit;
}

function exactDeel(o, deel) {
  if (!o.bestaat || !deel.aangerekend) return NUL;
  return deel.perKind ? o.betaler : o.enkelGedeeld;
}

function vanVerdeling(verdeling) {
  const intern = binnen.get(verdeling);
  if (!intern) throw fout("dit is geen verdeling van verdeel()");
  return intern;
}

/**
 * Het bedrag van één leerling voor een activiteit: { activiteit, vervoer, totaal }, in centen.
 * Activiteit en vervoer worden exact opgeteld en samen één keer afgerond (B98). Op de fiche staat de
 * activiteit afgerond, en het vervoer als het verschil met het afgeronde totaal: zo tellen de lijnen
 * altijd exact op, en is het vervoer nooit negatief.
 * Is een onderdeel onbekend, dan is dat onderdeel en het totaal null: het andere onderdeel is nooit
 * het volledige bedrag (B80, G6c, G8). Dat geldt enkel voor wie er iets van betaalt: wie voor dat
 * onderdeel niet aangerekend wordt (een attest), of wiens deel de school draagt, betaalt er € 0 voor,
 * wat het ook kost.
 * Wat de school draagt, wordt eerst gewoon berekend en staat dan voor de ouders op € 0 (1.6).
 */
export function bedrag(verdeling, wie) {
  const intern = vanVerdeling(verdeling);
  const mijn = { activiteit: leesDeel(wie && wie.activiteit), vervoer: leesDeel(wie && wie.vervoer) };
  const betaalt = (naam) => mijn[naam].aangerekend && !mijn[naam].school;
  const ouders = (naam) => (betaalt(naam) ? exactDeel(intern[naam], mijn[naam]) : NUL);
  const onbekend = (naam) => intern[naam].onbekend && betaalt(naam);
  const a = ouders("activiteit");
  const v = ouders("vervoer");
  if (onbekend("activiteit") && onbekend("vervoer")) return { activiteit: null, vervoer: null, totaal: null };
  if (onbekend("activiteit")) return { activiteit: null, vervoer: rond(v), totaal: null };
  if (onbekend("vervoer")) return { activiteit: rond(a), vervoer: null, totaal: null };
  const totaal = rond(plus(a, v));
  const activiteit = rond(a);
  return { activiteit, vervoer: totaal - activiteit, totaal };
}

/**
 * De sommen van een activiteit, voor alle leerlingen samen. groepen is de volledige lijst
 * [{ profiel, aantal }]: samen precies de aangerekende leerlingen en de betalers van de verdeling.
 * Geeft, in centen:
 *   ouders       wat de ouders samen betalen, na de afronding per leerling
 *   kost         wat de activiteit kost: de gedeelde kosten en de prijs per kind voor wie die betaalt
 *   tussenkomst  wat de tussenkomsten dragen, voor de twee onderdelen samen één keer afgerond
 *   school       wat de school draagt: kost − tussenkomst − ouders. Positief of negatief: het
 *                afrondingsverschil is voor of van de school (1.1), en ook wat niemand betaalt
 * Is een onderdeel onbekend, dan zijn de kost, de tussenkomst en het deel van de school null: nooit
 * een som waarin een onbekende prijs als € 0 meetelt. Wat de ouders samen betalen, is dan enkel gekend
 * als niemand iets van dat onderdeel betaalt.
 */
export function totalen(verdeling, groepen) {
  const intern = vanVerdeling(verdeling);
  if (!Array.isArray(groepen)) throw fout("de groepen ontbreken");
  const tel = { activiteit: { A: 0n, B: 0n }, vervoer: { A: 0n, B: 0n } };
  let ouders = 0n;
  let onbekend = false;
  for (const groep of groepen) {
    const aantal = nietNegatief(groep.aantal, "het aantal van een groep");
    // Een lege groep betaalt niets, en maakt dus ook niets onbekend (review 2: R02).
    if (aantal === 0n) continue;
    for (const naam of ["activiteit", "vervoer"]) {
      const deel = leesDeel(groep.profiel && groep.profiel[naam]);
      if (deel.aangerekend) tel[naam].A += aantal;
      if (deel.perKind) tel[naam].B += aantal;
    }
    const b = bedrag(verdeling, groep.profiel);
    if (b.totaal === null) onbekend = true;
    else ouders += aantal * BigInt(b.totaal);
  }
  for (const naam of ["activiteit", "vervoer"]) {
    const o = intern[naam];
    if (!o.bestaat || o.onbekend) continue;
    // Zonder prijs per kind is er geen aantal betalers om mee te vergelijken.
    if (tel[naam].A !== o.A || (o.metPrijsPerKind && tel[naam].B !== o.B)) throw fout("de groepen kloppen niet met de aantallen van de verdeling");
  }
  if (!verdeling.volledig) return { ouders: onbekend ? null : alsGetal(ouders), kost: null, tussenkomst: null, school: null };
  const kost = verdeling.activiteit.kost + verdeling.vervoer.kost;
  const tussenkomst = verdeling.activiteit.tussenkomst + verdeling.vervoer.tussenkomst;
  return { ouders: alsGetal(ouders), kost, tussenkomst, school: kost - tussenkomst - alsGetal(ouders) };
}

// ---------- Van de lijsten naar de aantallen en de profielen (1.2, 1.2b, 1.4) ----------

/**
 * De aantallen van een activiteit, uit de totalen per lijst van de databank (mt_lijst_totalen, T6):
 * voor elke rol dezelfde cijfers, ook voor een leerkracht die enkel haar eigen klas leest.
 *   lijsten           de lijsten van alle klassen van de activiteit, zoals mt_lijst_totalen ze geeft:
 *                     [{ aangerekend, aanwezig, deelnemers, annulering_betalers }]
 *   iedereenBetaalt   betalen aangerekende afwezigen ook de prijs per kind (B22, B119)?
 *   meerdaags         bij een meerdaagse betaalt elke deelnemer zijn deel, ongeacht attesten (B112)
 *   annulering        de annuleringskosten worden doorgerekend: aan wie de beheerder bevestigde (1.7).
 *                     Annuleringskosten zijn gedeelde kosten: niemand betaalt een prijs per kind
 * Geeft { aangerekend, betalers }: A en B van 1.16.
 */
export function aantallen(lijsten, { iedereenBetaalt = false, meerdaags = false, annulering = false } = {}) {
  let aangerekend = 0;
  let aanwezig = 0;
  for (const lijst of lijsten) {
    const telt = annulering ? lijst.annulering_betalers : meerdaags ? lijst.deelnemers : lijst.aangerekend;
    aangerekend += alsGetal(nietNegatief(telt, "een aantal van een lijst"));
    if (!annulering) aanwezig += alsGetal(nietNegatief(lijst.aanwezig, "een aantal van een lijst"));
  }
  if (annulering) return { aangerekend, betalers: 0 };
  return { aangerekend, betalers: meerdaags || iedereenBetaalt ? aangerekend : aanwezig };
}

/**
 * Het profiel van één leerling op een lijst (1.2, 1.2b):
 *   neemtDeel     staat hij aangevinkt (B109)? Wie niet deelneemt, betaalt niets en telt nergens mee
 *   aangerekend   heeft hij een status die aangerekend wordt (B19)? Aanwezig is dat altijd
 *   aanwezig      heeft hij geen afwezigheid?
 * met dezelfde keuzes als aantallen(). school: de school draagt zijn deel (B66, B142).
 */
export function profielVan({ neemtDeel = true, aangerekend = true, aanwezig = true, school = false }, { iedereenBetaalt = false, meerdaags = false } = {}) {
  if (!neemtDeel) return NIET_AANGEREKEND;
  if (meerdaags) return profiel(true, true, school);
  if (!aangerekend) return NIET_AANGEREKEND;
  return profiel(true, aanwezig || iedereenBetaalt, school);
}

// ---------- Een correctie verdelen (1.10, B97) ----------

/**
 * Een totaal dat over leerlingen verdeeld wordt, per leerling afgerond: bijfactureren (positief) of
 * crediteren (negatief). Geeft { perLeerling, samen, verschil }: het verschil is voor of van de school.
 * verdeelCorrectie(-100, 3) geeft -33 per leerling, samen -99 (G11a).
 */
export function verdeelCorrectie(totaal, aantal) {
  const n = geheel(aantal, "het aantal leerlingen");
  if (n <= 0n) throw fout("een correctie verdelen over niemand");
  const perLeerling = afronden(geheel(totaal, "het bedrag"), n);
  const samen = alsGetal(BigInt(perLeerling) * n);
  return { perLeerling, samen, verschil: alsGetal(geheel(totaal, "het bedrag")) - samen };
}

// ---------- Per leerling en per schooljaar (1.11, B100, B128) ----------

/**
 * De drie getallen per leerling (B128), tegenover het plafond (B100):
 *   werkelijk     de werkelijke kost
 *   aanrekenbaar  de werkelijke kost, hoogstens het plafond
 *   school        wat boven het plafond uitkomt: ten laste van de school
 *   ruimte        wat er tot het plafond nog overblijft
 *   label         "boven" vanaf één cent boven het plafond, "op" bij precies het plafond, anders "onder"
 * De marge speelt hier niet mee: ze dient enkel voor de terugbetaling aan schoolverlaters (1.13).
 */
export function plafondStand(werkelijk, plafond) {
  const w = alsGetal(geheel(werkelijk, "de werkelijke kost"));
  const p = alsGetal(nietNegatief(plafond, "het plafond"));
  return {
    werkelijk: w,
    aanrekenbaar: Math.min(w, p),
    school: Math.max(0, w - p),
    ruimte: Math.max(0, p - w),
    label: w > p ? "boven" : w === p ? "op" : "onder",
  };
}

/**
 * Het jaartotaal van een leerling (1.11). bedragen: [{ cent, soort }], met als soort:
 *   "definitief"   alles in orde
 *   "voorlopig"    aanwezigheden of facturen nog niet in orde: telt mee, met die stand
 *   "raming"       een bevestigde uitstap die nog komt: telt mee in de prognose (B30)
 *   "aangevraagd"  nog niet bevestigd in de uitstappentool: enkel apart (B15)
 * Een correctie telt mee zoals elke kost, met haar eigen soort. Een bedrag dat onbekend is (null),
 * telt nergens: "onbekend" zegt hoeveel er zo zijn.
 */
export function jaarStand(bedragen, plafond) {
  const som = { definitief: 0, voorlopig: 0, raming: 0, aangevraagd: 0 };
  let onbekend = 0;
  for (const b of bedragen) {
    if (!Object.prototype.hasOwnProperty.call(som, b.soort)) throw fout("een bedrag heeft een onbekende soort");
    if (b.cent === null || b.cent === undefined) onbekend++;
    else som[b.soort] += alsGetal(geheel(b.cent, "een bedrag"));
  }
  return {
    ...som,
    onbekend,
    nu: plafondStand(som.definitief + som.voorlopig, plafond),
    prognose: plafondStand(som.definitief + som.voorlopig + som.raming, plafond),
  };
}

// ---------- De stand van een bedrag (1.8, B46, F1, F10) ----------

/**
 * Vanzelf, zonder klik van de beheerder: "gefactureerd", "definitief" of "voorlopig", met de redenen.
 *   alleKlassenBevestigd  de aanwezigheden van alle klassen zijn bevestigd
 *   openAanvraag          er staat nog een wijzigingsaanvraag open
 *   prijzenGekend         alle prijzen zijn gekend: geen prijs te bevestigen, geen bedrag dat ontbreekt (B80)
 *   factuurActiviteit, factuurVervoer   "ontvangen", "nvt" of "teontvangen"; null bij een beurt van
 *                         een lopende activiteit: die is definitief zodra haar aanwezigheden bevestigd zijn (F10)
 *   gefactureerd          na het markeren in een facturatie (fase 2)
 */
export function standBedrag({ alleKlassenBevestigd, openAanvraag = false, prijzenGekend = true, factuurActiviteit = null, factuurVervoer = null, gefactureerd = false }) {
  const redenen = [];
  if (!alleKlassenBevestigd) redenen.push("aanwezigheden");
  if (openAanvraag) redenen.push("aanvraag");
  if (!prijzenGekend) redenen.push("prijs");
  if (factuurActiviteit === "teontvangen") redenen.push("factuur_activiteit");
  if (factuurVervoer === "teontvangen") redenen.push("factuur_vervoer");
  for (const factuur of [factuurActiviteit, factuurVervoer]) {
    if (factuur !== null && !["ontvangen", "nvt", "teontvangen"].includes(factuur)) throw fout("een factuur heeft een onbekende stand");
  }
  if (redenen.length) return { stand: "voorlopig", redenen };
  return { stand: gefactureerd ? "gefactureerd" : "definitief", redenen };
}

// ---------- Wie meetelt: kalenderdatums en klasperioden (1.2, B67, B89, B157) ----------

const DATUM = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAGEN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const schrikkel = (jaar) => (jaar % 4 === 0 && jaar % 100 !== 0) || jaar % 400 === 0;
const dagenIn = (jaar, maand) => (maand === 2 && schrikkel(jaar) ? 29 : DAGEN[maand - 1]);

/** Is dit een bestaande kalenderdatum, geschreven als jjjj-mm-dd? */
export function isDatum(tekst) {
  const m = typeof tekst === "string" ? DATUM.exec(tekst) : null;
  if (!m) return false;
  const jaar = Number(m[1]), maand = Number(m[2]), dag = Number(m[3]);
  return maand >= 1 && maand <= 12 && dag >= 1 && dag <= dagenIn(jaar, maand);
}

function eisDatum(tekst) {
  if (!isDatum(tekst)) throw fout("geen geldige datum: " + String(tekst));
  return tekst;
}

/**
 * De dag na een datum, zonder klok en zonder tijdzone. De einddatum van Informat is de laatste dag van
 * de inschrijving: die dag telt nog mee. Een periode in de MT loopt "tot vóór" de dag erna (B89).
 */
export function dagNa(datum) {
  const m = DATUM.exec(eisDatum(datum));
  let jaar = Number(m[1]), maand = Number(m[2]), dag = Number(m[3]) + 1;
  if (dag > dagenIn(jaar, maand)) {
    dag = 1;
    maand++;
    if (maand > 12) {
      maand = 1;
      jaar++;
    }
  }
  return String(jaar).padStart(4, "0") + "-" + String(maand).padStart(2, "0") + "-" + String(dag).padStart(2, "0");
}

/** Het schooljaar van een dag: van 1 september tot 31 augustus, zoals in de uitstappentool. */
export function schooljaarVan(datum) {
  const m = DATUM.exec(eisDatum(datum));
  const jaar = Number(m[1]);
  return Number(m[2]) >= 9 ? jaar + "-" + (jaar + 1) : jaar - 1 + "-" + jaar;
}

/**
 * De klasperiode van een leerling op een dag: van een dag tot vóór een dag (T7). Een activiteit telt
 * iedereen die op die dag in de klas zat: de begindatum telt mee, de dag "tot vóór" niet meer (B67).
 * perioden: [{ van, einde, … }], zoals de tabel klasindelingen ze geeft. Geeft de periode, of null.
 */
export function periodeOp(perioden, dag) {
  eisDatum(dag);
  for (const periode of perioden) {
    if (eisDatum(periode.van) <= dag && dag < eisDatum(periode.einde)) return periode;
  }
  return null;
}

/**
 * Is deze leerling schoolverlater (B99, B101, B157)? Dat volgt uit zijn laatste periode in het
 * schooljaar: een einddatum van inschrijving, of het 6de leerjaar op het einde van het schooljaar.
 *   perioden   [{ van, tot, leerjaar }]: tot is null zonder einddatum; leerjaar is dat van de klas
 *   afwijking  wat de beheerder voor deze leerling zelf koos: true, false, of null (B101)
 */
export function isSchoolverlater(perioden, afwijking = null) {
  if (afwijking === true || afwijking === false) return afwijking;
  let laatste = null;
  for (const periode of perioden) {
    if (laatste === null || eisDatum(periode.van) > laatste.van) laatste = periode;
  }
  if (laatste === null) return false;
  return (laatste.tot !== null && laatste.tot !== undefined) || laatste.leerjaar === 6;
}

// ---------- Niveau en leerjaar (1.2, B157, B208, G20) ----------

/**
 * Kleuter of lager komt uit de groep in de klassenlijst, nooit uit de klascode: 1KA en 1instA zijn
 * kleuterklassen. Een klas uit de groep Andere heeft geen niveau.
 */
export function niveauVan(groep) {
  return groep === "Kleuter" ? "kleuter" : groep === "Lager" ? "lager" : null;
}

/**
 * Het leerjaar, enkel bij een klas van de groep Lager: het eerste cijfer van de naam, dus 4A is het
 * 4de leerjaar (B208). Een kleuterklas heeft geen leerjaar. Begint de naam van een lagere klas niet
 * met 1 tot 6, dan is het leerjaar niet af te leiden (null): de MT vraagt het één keer.
 */
export function leerjaarVan(naam, groep) {
  if (groep !== "Lager") return null;
  const m = /^[1-6]/.exec(String(naam ?? ""));
  return m ? Number(m[0]) : null;
}

/** Het scherpe plafond van een schooljaar voor een niveau, in centen (B77); null voor een klas zonder niveau. */
export function plafondVoor(schooljaar, niveau) {
  if (niveau === "kleuter") return schooljaar.plafond_kleuter_cent ?? null;
  if (niveau === "lager") return schooljaar.plafond_lager_cent ?? null;
  return null;
}

/** Zit deze klas in het gratis zwemjaar van dit schooljaar (B66, B103)? Enkel een lagere klas kan dat. */
export function inGratisZwemjaar(klas, schooljaar) {
  const leerjaar = klas.leerjaar ?? leerjaarVan(klas.naam, klas.groep);
  return klas.groep === "Lager" && leerjaar !== null && leerjaar === (schooljaar.gratis_zwemjaar_leerjaar ?? null);
}
