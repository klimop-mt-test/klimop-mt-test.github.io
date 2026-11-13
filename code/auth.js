// MT · auth.js · versie 0.6.2
// Aanmelden, de tweestapsverificatie en de sessie (17.2, T5). Het enige bestand dat supabase-js
// gebruikt, en naast app.js het enige dat de opslag van de browser aanraakt. De bibliotheek staat in
// de eigen repository (code/lib), op één vaste versie (B158); een test bewaakt haar controlesom.
//
// Wat hier beslist wordt, is gemak, geen beveiliging: de databank kijkt bij elke vraag zelf na of de
// sessie een verse code uit de app heeft (sql/004_accounts.sql). Dit bestand schrijft geen HTML.
//
// De sessie staat op één van twee plaatsen (B26):
//   - "Aangemeld blijven": in localStorage, op een eigen toestel. De databank vraagt dan om de twee
//     weken opnieuw de code;
//   - anders in sessionStorage: enkel dit tabblad, weg bij het sluiten, en de MT meldt af na een tijd
//     zonder activiteit.

export const VERSIE = "0.6.2";

/** De sleutel van de sessie in de opslag. De MT heeft een eigen adres, dus geen andere tool leest ze (B72). */
const SLEUTEL = "mt_auth";
/** "1" in localStorage: aangemeld blijven op dit toestel. */
const BLIJVEN = "mt_auth_blijven";
/** Het tijdstip van de laatste activiteit, in sessionStorage. */
const ACTIEF = "mt_auth_actief";
/** Eén keer te tonen op het aanmeldscherm, na een herlading: waarom je afgemeld werd. */
const BERICHT = "mt_auth_bericht";

/**
 * De opslag van de sessie, zoals supabase-js ze verwacht, met de keuze "Aangemeld blijven".
 * Elke toegang kan mislukken (opslag uitgeschakeld in de browser): dan is er gewoon geen sessie.
 */
export function maakOpslag(lokaal, tab) {
  const veilig = (werk, anders) => {
    try {
      return werk();
    } catch {
      return anders;
    }
  };
  const blijft = () => veilig(() => lokaal.getItem(BLIJVEN) === "1", false);
  // Na het afmelden komt er niets van een aanmelding meer bij, ook niet van een oproep die nog onderweg was (I4).
  let dicht = false;
  return {
    blijft,
    /** Vóór het aanmelden: waar komt de sessie? */
    kies(blijven) {
      veilig(() => (blijven ? lokaal.setItem(BLIJVEN, "1") : lokaal.removeItem(BLIJVEN)));
    },
    /** "Aangemeld blijven" mag niet voor deze rol (B148): de sessie verhuist naar dit tabblad. */
    naarTab() {
      veilig(() => {
        const sessie = lokaal.getItem(SLEUTEL);
        lokaal.removeItem(BLIJVEN);
        if (sessie !== null) {
          tab.setItem(SLEUTEL, sessie);
          lokaal.removeItem(SLEUTEL);
        }
      });
    },
    getItem: (sleutel) => veilig(() => lokaal.getItem(sleutel) ?? tab.getItem(sleutel), null),
    setItem(sleutel, waarde) {
      if (dicht) return;
      veilig(() => {
        if (blijft()) {
          lokaal.setItem(sleutel, waarde);
          tab.removeItem(sleutel);
        } else {
          tab.setItem(sleutel, waarde);
          lokaal.removeItem(sleutel);
        }
      });
    },
    removeItem(sleutel) {
      veilig(() => lokaal.removeItem(sleutel));
      veilig(() => tab.removeItem(sleutel));
    },
    /** Alles van de aanmelding weg, op beide plaatsen. */
    wis() {
      for (const sleutel of [SLEUTEL, SLEUTEL + "-code-verifier", SLEUTEL + "-user", BLIJVEN, ACTIEF]) this.removeItem(sleutel);
    },
    /** Bij het afmelden: alles weg, en daarna bewaart deze opslag geen sessie meer (review 1, I4). */
    sluit() {
      dicht = true;
      this.wis();
    },
    /** Staat er een sessie in deze browser? Zonder netwerk, en zonder ze te vernieuwen. */
    heeftSessie: () => veilig(() => (lokaal.getItem(SLEUTEL) ?? tab.getItem(SLEUTEL)) !== null, false),
    /** Het toegangsbewijs zoals het in de opslag staat, of niets. */
    token() {
      try {
        const sessie = JSON.parse(this.getItem(SLEUTEL) ?? "null");
        return sessie && typeof sessie.access_token === "string" ? sessie.access_token : null;
      } catch {
        return null;
      }
    },
    /** De laatste activiteit, in dit tabblad. */
    raak: (nu) => (dicht ? undefined : veilig(() => tab.setItem(ACTIEF, String(nu)))),
    laatste: () => veilig(() => Number(tab.getItem(ACTIEF)) || 0, 0),
    bericht: (tekst) => veilig(() => (tekst ? tab.setItem(BERICHT, tekst) : tab.removeItem(BERICHT))),
    leesBericht: () => veilig(() => tab.getItem(BERICHT), null),
  };
}

/** Is er te lang niets gebeurd? Zonder gekend tijdstip telt het als te lang: liever een keer te veel afmelden. */
export function teLangStil(laatste, nu, minuten) {
  return !(laatste > 0) || nu - laatste >= minuten * 60000 || nu < laatste - 60000;
}

/** De code uit de app: zes cijfers. Spaties ertussen mogen, zoals sommige apps ze tonen. */
export function zesCijfers(invoer) {
  const cijfers = String(invoer ?? "").replace(/\s+/g, "");
  return /^[0-9]{6}$/.test(cijfers) ? cijfers : null;
}

/** De sleutel van de app in groepjes van vier, om over te typen. */
export function inGroepjes(sleutel) {
  return String(sleutel ?? "").replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/** Een fout van Supabase bij het aanmelden, in een zin voor wie aanmeldt. Nooit de tekst van Supabase zelf. */
export function uitleg(fout, waar) {
  const code = fout && typeof fout.code === "string" ? fout.code : "";
  const status = fout && typeof fout.status === "number" ? fout.status : 0;
  if (code === "invalid_credentials") return "Het e-mailadres of het wachtwoord klopt niet.";
  if (code === "user_banned") return "Dit account is uitgeschakeld. Vraag het na bij de beheerder of het secretariaat.";
  if (code === "mfa_verification_failed") return "Deze code klopt niet. Wacht tot je app een nieuwe code toont en probeer het opnieuw.";
  if (code === "mfa_challenge_expired") return "Dat duurde te lang. Typ de code die je app nu toont.";
  if (code === "insufficient_aal") return "Je app is al gekoppeld. Typ de code uit je app.";
  if (code === "email_not_confirmed") return "Dit account is bij Supabase nog niet bevestigd. Vraag het na bij de beheerder.";
  // Supabase beperkt het aantal codes per minuut en per netwerk: op school delen alle toestellen er één.
  if ((status === 429 || code.startsWith("over_")) && waar === "code") {
    return "Er wordt nu veel aangemeld vanop dit netwerk. Wacht een minuut, en typ dan de code die je app op dat moment toont.";
  }
  if (status === 429 || code.startsWith("over_")) return "Te veel pogingen na elkaar. Wacht enkele minuten en probeer het opnieuw.";
  if (status === 0 || status >= 500) return "Geen verbinding met Supabase. Controleer je internetverbinding en probeer het opnieuw.";
  return waar === "code" ? "De code werd niet aanvaard. Probeer het opnieuw." : "Aanmelden lukte niet. Probeer het opnieuw.";
}

// ---------- De aanmelding zelf ----------

let client = null;
let opslag = null;
let appNaam = "Klim-Op MT";

/** Start de aanmelding voor de omgeving. Geeft false als de bibliotheek niet geladen is. */
export function stel(omgeving, { lib = globalThis.supabase, lokaal, tab } = {}) {
  if (!lib || typeof lib.createClient !== "function") return false;
  const eigen = (naam) => {
    try {
      return globalThis[naam];
    } catch {
      return null;
    }
  };
  opslag = maakOpslag(lokaal ?? eigen("localStorage"), tab ?? eigen("sessionStorage"));
  appNaam = omgeving.app;
  client = lib.createClient(omgeving.mt.url, omgeving.mt.sleutel, {
    // detectSessionInUrl uit: een link uit een mail meldt in de MT nooit aan.
    auth: { storageKey: SLEUTEL, storage: opslag, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return true;
}

/** Het toegangsbewijs van wie aangemeld is, telkens vers; anders niets. */
export async function token() {
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data && data.session ? data.session.access_token : null;
  } catch {
    return null;
  }
}

/**
 * Hoe ver de aanmelding staat, volgens het toegangsbewijs:
 * { aangemeld, email, aal, methodes, codeOp }. codeOp is het tijdstip van de laatste code, in ms.
 */
export async function niveau() {
  const niets = { aangemeld: false, email: null, aal: null, methodes: [], codeOp: null };
  if (!client) return niets;
  try {
    const { data } = await client.auth.getSession();
    if (!data || !data.session) return niets;
    const { data: n, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !n) return niets;
    const stappen = Array.isArray(n.currentAuthenticationMethods) ? n.currentAuthenticationMethods : [];
    const codes = stappen.filter((s) => s && s.method === "totp" && typeof s.timestamp === "number").map((s) => s.timestamp * 1000);
    return {
      aangemeld: true,
      email: data.session.user && data.session.user.email ? data.session.user.email : null,
      aal: n.currentLevel,
      methodes: stappen.map((s) => (s && typeof s.method === "string" ? s.method : "")),
      codeOp: codes.length ? Math.max(...codes) : null,
    };
  } catch {
    return niets;
  }
}

/** Stap 1: e-mailadres en wachtwoord. Geeft { ok } of { ok: false, tekst }. */
export async function aanmelden(email, wachtwoord, blijven) {
  if (!client) return { ok: false, tekst: "De aanmeldmodule is niet geladen. Vernieuw de pagina met Ctrl+F5." };
  opslag.kies(blijven === true);
  try {
    const { error } = await client.auth.signInWithPassword({ email, password: wachtwoord });
    if (error) return { ok: false, tekst: uitleg(error, "wachtwoord") };
    opslag.raak(Date.now());
    return { ok: true };
  } catch (fout) {
    return { ok: false, tekst: uitleg(fout, "wachtwoord") };
  }
}

/** De app-koppelingen van dit account: { ok, gekoppeld: [id], open: [id] }. */
export async function koppelingen() {
  try {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error || !data) return { ok: false, tekst: uitleg(error, "code"), gekoppeld: [], open: [] };
    const totp = (data.all ?? []).filter((f) => f && f.factor_type === "totp");
    return {
      ok: true,
      gekoppeld: totp.filter((f) => f.status === "verified").map((f) => f.id),
      open: totp.filter((f) => f.status !== "verified").map((f) => f.id),
    };
  } catch (fout) {
    return { ok: false, tekst: uitleg(fout, "code"), gekoppeld: [], open: [] };
  }
}

/**
 * Een nieuwe koppeling beginnen: geeft { ok, id, qr, sleutel }. Wat van een vorige poging bleef
 * liggen, gaat eerst weg: Supabase weigert anders een tweede koppeling met dezelfde naam.
 */
export async function koppel() {
  try {
    const eerst = await koppelingen();
    if (!eerst.ok) return { ok: false, tekst: eerst.tekst };
    for (const id of eerst.open) await client.auth.mfa.unenroll({ factorId: id });
    const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", issuer: appNaam, friendlyName: appNaam + " " + Date.now() });
    if (error || !data || !data.totp) return { ok: false, tekst: uitleg(error, "code") };
    return { ok: true, id: data.id, qr: data.totp.qr_code, sleutel: data.totp.secret };
  } catch (fout) {
    return { ok: false, tekst: uitleg(fout, "code") };
  }
}

/** De code uit de app nakijken voor een koppeling. Lukt het, dan heeft de sessie haar tweede stap. */
export async function geefCode(koppeling, code) {
  try {
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId: koppeling, code });
    if (error) return { ok: false, tekst: uitleg(error, "code") };
    opslag.raak(Date.now());
    return { ok: true };
  } catch (fout) {
    return { ok: false, tekst: uitleg(fout, "code") };
  }
}

/**
 * Afmelden, eerst in deze browser: alles van de aanmelding is meteen weg, ook zonder netwerk, en niets
 * schrijft het nog terug (review 1, I4). Geeft het toegangsbewijs terug waarmee de pagina de sessie
 * daarna ook bij Supabase beëindigt (data.js). Dat laatste mag mislukken: deze browser kent ze niet meer.
 */
export function afmeldenLokaal(bericht = null) {
  if (!opslag) return null;
  const token = opslag.token();
  opslag.sluit();
  opslag.bericht(bericht);
  return token;
}

/** Meldt het als een ander tabblad afmeldt: via supabase-js, of doordat de gedeelde sessie uit de opslag verdween. */
export function opAfgemeld(actie) {
  if (client) client.auth.onAuthStateChange((gebeurtenis) => (gebeurtenis === "SIGNED_OUT" ? setTimeout(actie, 0) : undefined));
  globalThis.addEventListener("storage", (gebeurtenis) => {
    if (gebeurtenis.key === SLEUTEL && gebeurtenis.newValue === null) actie();
  });
}

/** Staat er een sessie in deze browser? Zonder netwerk. */
export const heeftSessie = () => (opslag ? opslag.heeftSessie() : false);
export const blijft = () => (opslag ? opslag.blijft() : false);
export const naarTab = () => (opslag ? opslag.naarTab() : undefined);
export const raak = (nu = Date.now()) => (opslag ? opslag.raak(nu) : undefined);
export const laatste = () => (opslag ? opslag.laatste() : 0);

/** Het bericht voor het aanmeldscherm, één keer. */
export function haalBericht() {
  if (!opslag) return null;
  const tekst = opslag.leesBericht();
  opslag.bericht(null);
  return tekst;
}
