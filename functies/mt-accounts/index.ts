// MT · functies/mt-accounts/index.ts · versie 0.4.0
// De serverfunctie voor de accounts (17.4, B25, T5): een Edge Function in het Supabase-project van de MT.
//
// Waarom ze bestaat. Supabase bewaart de wachtwoorden en de app-koppelingen. Een wachtwoord instellen
// voor iemand anders, of een koppeling wissen, kan enkel met de secret key. Die sleutel mag nooit in
// de browser, de repository of een chat (design system 1.14): Supabase geeft hem zelf aan deze
// functie, en enkel hier wordt hij gebruikt.
//
// Wat ze doet, en niets anders:
//   voor wie aanmeldt     stand               welke stap volgt: een eigen wachtwoord, de app, de code
//                         wachtwoord_kiezen   een eigen wachtwoord bij een tijdelijk wachtwoord
//                         afronden            de eerste aanmelding of een nieuwe koppeling afronden
//   voor een beheerder    aanmaken            een nieuw account, met een tijdelijk wachtwoord
//                         tijdelijk_wachtwoord  een nieuw tijdelijk wachtwoord, eventueel met de app opnieuw
//                         uitschakelen, inschakelen, email_wijzigen
//
// Wie mag wat:
//   - elk toegangsbewijs wordt eerst echt nagekeken bij Supabase zelf, voor dit project;
//   - of iemand beheerder is, beslist de databank en niet deze functie: de start van een handeling
//     loopt met het toegangsbewijs van de beheerder zelf (sql/004_accounts.sql);
//   - met de secret key doet de functie enkel wat de handeling vraagt bij Supabase, en roept ze de
//     vier databankfuncties op die enkel voor haar bestaan. Op tabellen heeft ze geen enkel recht.
//
// Nooit in een antwoord of in het logboek van de functie: een wachtwoord dat iemand koos, een
// toegangsbewijs, een sleutel. Een tijdelijk wachtwoord maakt de functie zelf, en ze geeft het één
// keer terug aan de beheerder die het vroeg.
//
// Zo plaats je ze: Supabase → project → Edge Functions → Deploy a new function → Via Editor → de
// naam mt-accounts → dit hele bestand plakken → Deploy function. "Verify JWT" blijft aan staan.
// Wijzigt dit bestand, dan plak je het opnieuw. Test en productie krijgen hetzelfde bestand.

export const VERSIE = "0.4.0";

/**
 * De pagina van de MT per project van Supabase. Enkel dat adres mag deze functie vanuit een browser
 * oproepen. Een test vergelijkt deze lijst met code/config.js. De productie komt erbij bij de livegang.
 */
export const PAGINA: Readonly<Record<string, string>> = Object.freeze({
  "https://ayszixqnuktogzjtreyy.supabase.co": "https://klimop-mt-test.github.io",
});

type Json = Record<string, unknown>;

/** Alles wat de functie van buiten nodig heeft. In de tests is dat nagebootst. */
export interface Omgeving {
  /** Het adres van het project van Supabase. */
  url: string;
  /** De publishable key: openbaar, enkel als apikey. */
  publiek: string;
  /** De secret key: enkel in deze functie, en enkel naar het eigen project. */
  geheim: string;
  haal: (adres: string, opties: RequestInit) => Promise<Response>;
  /** Het logboek van de functie: de handeling en de uitkomst, nooit meer. */
  meld: (regel: Json) => void;
  wacht: (ms: number) => Promise<void>;
  /** Willekeurige bytes, voor een tijdelijk wachtwoord. */
  willekeurig: (aantal: number) => Uint8Array;
}

interface Wie {
  id: string;
  email: string;
  token: string;
  aal: string;
  methodes: string[];
}

/** Een fout die de pagina mag tonen: de tekst is voor de gebruiker geschreven. */
class Fout extends Error {
  constructor(readonly status: number, readonly code: string, melding: string, readonly extra: Json = {}) {
    super(melding);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WACHTTIJD = 10_000;
const MAX_INVOER = 4_000;
/** Een wachtwoord langer dan 72 bytes kapt Supabase af. */
const MAX_WACHTWOORD_BYTES = 72;
/** Zonder tekens die op elkaar lijken: geen 0 en o, geen 1, i en l. */
const TEKENS = "abcdefghjkmnpqrstuvwxyz23456789";
/** Een ban van honderd jaar: Supabase kent geen ban zonder einde. */
const VOORGOED = "876000h";
const LATER = "Supabase antwoordt niet. Probeer het over enkele minuten opnieuw.";

const BEHEER = new Set(["aanmaken", "tijdelijk_wachtwoord", "uitschakelen", "inschakelen", "email_wijzigen"]);
const EIGEN = new Set(["stand", "wachtwoord_kiezen", "afronden"]);

export function maakBehandelaar(o: Omgeving): (verzoek: Request) => Promise<Response> {
  const pagina = Object.prototype.hasOwnProperty.call(PAGINA, o.url) ? PAGINA[o.url] : null;

  // ---------- Antwoorden ----------

  function koppen(metCors: boolean): Headers {
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

  function antwoord(status: number, lichaam: Json, metCors = true): Response {
    return new Response(JSON.stringify(lichaam), { status, headers: koppen(metCors) });
  }

  // ---------- Supabase oproepen ----------

  /** Eén oproep naar het eigen project. Geeft de status en het antwoord; status 0 is geen antwoord. */
  async function roep(pad: string, methode: string, sleutel: string, drager: string | null, lichaam?: Json): Promise<{ status: number; gegevens: unknown }> {
    const k: Record<string, string> = { apikey: sleutel, Accept: "application/json" };
    if (drager !== null) k.Authorization = "Bearer " + drager;
    if (lichaam !== undefined) k["Content-Type"] = "application/json";
    try {
      const r = await o.haal(o.url + pad, {
        method: methode,
        headers: k,
        body: lichaam === undefined ? undefined : JSON.stringify(lichaam),
        signal: AbortSignal.timeout(WACHTTIJD),
      });
      const tekst = await r.text();
      let gegevens: unknown = null;
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
   * De beheerroutes van Supabase Auth, met de secret key. Zoals supabase-js gaat de sleutel mee als
   * apikey en als Bearer: Supabase wisselt hem zelf om voor een kortlevend bewijs van de rol service_role.
   */
  const beheer = (pad: string, methode: string, lichaam?: Json) => roep("/auth/v1" + pad, methode, o.geheim, o.geheim, lichaam);

  /** Een databankfunctie. Met een toegangsbewijs: als die gebruiker. Zonder: als de serverfunctie. */
  async function databank(functie: string, args: Json, token: string | null): Promise<Json> {
    const r = token === null
      ? await roep("/rest/v1/rpc/" + functie, "POST", o.geheim, o.geheim, args)
      : await roep("/rest/v1/rpc/" + functie, "POST", o.publiek, token, args);
    if (r.status >= 200 && r.status < 300) return (r.gegevens ?? {}) as Json;
    const g = (r.gegevens ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof g.code === "string" ? g.code : "";
    const tekst = typeof g.message === "string" ? g.message.replace(/^MT: /, "") : "";
    if (code === "42501") throw new Fout(403, "rechten", tekst || "Je hebt geen rechten voor deze handeling.");
    if (code === "MT409") throw new Fout(409, "gewijzigd", tekst);
    if (code === "MT422") throw new Fout(422, "kan_niet", tekst);
    if (code === "MT429") throw new Fout(429, "te_veel", tekst);
    if (code === "22023" || code === "22P02") throw new Fout(400, "oproep", "Deze oproep klopt niet.");
    if (r.status === 404) throw new Fout(500, "databank", "De databank kent deze functie niet: voer sql/004_accounts.sql uit.");
    throw new Fout(r.status === 0 ? 503 : 500, "databank", r.status === 0 ? LATER : "De databank gaf een fout.");
  }

  /**
   * Het einde van een handeling in de databank. Lukt het bij een storing niet meteen, dan nog twee
   * keer: de handeling bij Supabase is dan al gebeurd, en zonder dit einde blijft het account geblokkeerd.
   */
  async function rondAf(operatie: string, gelukt: boolean, gegevens: Json = {}, melding: string | null = null): Promise<Json> {
    let laatste: unknown = null;
    for (let poging = 0; poging < 3; poging++) {
      if (poging > 0) await o.wacht(400 * poging);
      try {
        return await databank("mt_account_klaar", { p_operatie: operatie, p_gelukt: gelukt, p_gegevens: gegevens, p_melding: melding }, null);
      } catch (fout) {
        laatste = fout;
        if (!(fout instanceof Fout) || fout.code !== "databank") break;
      }
    }
    throw laatste;
  }

  /** De handeling mislukte bij Supabase: dat komt in het register. Daarna gaat de fout naar de pagina. */
  async function mislukt(operatie: string, melding: string, fout: Fout): Promise<never> {
    let geblokkeerd = false;
    try {
      const r = await rondAf(operatie, false, {}, melding);
      geblokkeerd = r.geblokkeerd === true;
    } catch {
      geblokkeerd = true;
    }
    throw new Fout(fout.status, fout.code, fout.message, { ...fout.extra, geblokkeerd });
  }

  // ---------- Wie roept op ----------

  /** Het toegangsbewijs echt nakijken, bij Supabase zelf en voor dit project (17.4). */
  async function wieIsDit(verzoek: Request): Promise<Wie> {
    const kop = verzoek.headers.get("Authorization") ?? "";
    const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(kop);
    if (!m) throw new Fout(401, "sessie", "Meld eerst aan.");
    const token = m[1];
    const r = await roep("/auth/v1/user", "GET", o.publiek, token);
    if (r.status === 0 || r.status >= 500) throw new Fout(503, "supabase", LATER);
    const g = (r.gegevens ?? {}) as { id?: unknown; email?: unknown };
    if (r.status !== 200 || typeof g.id !== "string" || !UUID.test(g.id) || typeof g.email !== "string") {
      throw new Fout(401, "sessie", "Je sessie is verlopen. Meld opnieuw aan.");
    }
    // Supabase keek de handtekening na: wat in het toegangsbewijs staat, klopt dus.
    let claims: { sub?: unknown; aal?: unknown; amr?: unknown } = {};
    try {
      const deel = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(deel), (c) => c.charCodeAt(0))));
    } catch {
      throw new Fout(401, "sessie", "Je sessie is verlopen. Meld opnieuw aan.");
    }
    if (claims.sub !== g.id) throw new Fout(401, "sessie", "Je sessie is verlopen. Meld opnieuw aan.");
    const methodes: string[] = [];
    if (Array.isArray(claims.amr)) {
      for (const stap of claims.amr) {
        if (stap && typeof stap === "object" && typeof (stap as { method?: unknown }).method === "string") {
          methodes.push((stap as { method: string }).method);
        }
      }
    }
    return { id: g.id, email: g.email.toLowerCase(), token, aal: typeof claims.aal === "string" ? claims.aal : "", methodes };
  }

  // ---------- Hulp ----------

  function uuid(waarde: unknown, wat: string): string {
    if (typeof waarde !== "string" || !UUID.test(waarde)) throw new Fout(400, "oproep", "Deze oproep klopt niet: " + wat + " ontbreekt.");
    return waarde.toLowerCase();
  }

  function tekst(waarde: unknown, wat: string, max: number): string {
    if (typeof waarde !== "string" || waarde.length > max) throw new Fout(400, "oproep", "Deze oproep klopt niet: " + wat + " ontbreekt.");
    return waarde;
  }

  /** Vier groepjes van vier tekens: ruim 79 bits, en te lezen en te typen zonder twijfel. */
  function tijdelijkWachtwoord(): string {
    for (;;) {
      let uit = "";
      while (uit.length < 16) {
        for (const byte of o.willekeurig(32)) {
          // Enkel bytes onder 248 (8 × 31), zodat elk teken even vaak voorkomt.
          if (byte < 248 && uit.length < 16) uit += TEKENS[byte % TEKENS.length];
        }
      }
      if (/[a-z]/.test(uit) && /[0-9]/.test(uit)) return uit.replace(/(.{4})(?=.)/g, "$1-");
    }
  }

  /** Een wachtwoord dat niemand kent, voor een uitgeschakeld account. */
  function onbekendWachtwoord(): string {
    let uit = "";
    for (const byte of o.willekeurig(48)) uit += TEKENS[byte % TEKENS.length];
    return uit;
  }

  /** Waarom Supabase weigerde, in een zin voor het register: de code van Supabase, nooit de invoer. */
  function reden(r: { status: number; gegevens: unknown }): string {
    const g = (r.gegevens ?? {}) as { error_code?: unknown; code?: unknown };
    const code = typeof g.error_code === "string" ? g.error_code : typeof g.code === "string" ? g.code : "";
    return r.status === 0 ? "Supabase gaf geen antwoord." : "Supabase weigerde (" + r.status + (code ? ", " + code.slice(0, 60) : "") + ").";
  }

  function foutcode(r: { gegevens: unknown }): string {
    const g = (r.gegevens ?? {}) as { error_code?: unknown };
    return typeof g.error_code === "string" ? g.error_code : "";
  }

  /** De app-koppelingen van een account wissen. Geeft false als het niet volledig lukte. */
  async function wisKoppelingen(gebruiker: string): Promise<boolean> {
    const lijst = await beheer("/admin/users/" + gebruiker + "/factors", "GET");
    if (lijst.status !== 200 || !Array.isArray(lijst.gegevens)) return false;
    for (const factor of lijst.gegevens as { id?: unknown }[]) {
      if (typeof factor.id !== "string" || !UUID.test(factor.id)) return false;
      const weg = await beheer("/admin/users/" + gebruiker + "/factors/" + factor.id, "DELETE");
      if (weg.status !== 200) return false;
    }
    return true;
  }

  // ---------- Voor wie aanmeldt ----------

  async function stand(wie: Wie): Promise<Json> {
    const s = await databank("mt_account_stand", { p_gebruiker: wie.id }, null);
    return { versie: VERSIE, bekend: s.bekend === true, account: s.account ?? null, instellingen: s.instellingen ?? null };
  }

  async function wachtwoordKiezen(wie: Wie, invoer: Json): Promise<Json> {
    const operatie = uuid(invoer.operatie, "het operatienummer");
    const nieuw = tekst(invoer.wachtwoord, "het wachtwoord", 400);
    // Enkel een sessie die met het wachtwoord begon: een link in een mail telt niet (B5).
    if (!wie.methodes.includes("password")) throw new Fout(403, "rechten", "Meld aan met je e-mailadres en je tijdelijke wachtwoord.");
    const s = await databank("mt_account_stand", { p_gebruiker: wie.id }, null);
    const minimum = Number((s.instellingen as Json | undefined)?.wachtwoord_min_lengte ?? 12);
    if ([...nieuw].length < minimum) throw new Fout(422, "kan_niet", "Kies een wachtwoord van minstens " + minimum + " tekens.");
    if (new TextEncoder().encode(nieuw).length > MAX_WACHTWOORD_BYTES) throw new Fout(422, "kan_niet", "Dit wachtwoord is te lang: kies er een van hoogstens 72 tekens.");
    if (nieuw !== nieuw.trim()) throw new Fout(422, "kan_niet", "Een wachtwoord begint of eindigt niet met een spatie.");

    // De start in de databank: zij kijkt na dat het wachtwoord tijdelijk is en dat de termijn nog loopt,
    // met haar eigen tijd, en beperkt herhaalde pogingen.
    await databank("mt_account_eigen_start", { p_operatie: operatie, p_soort: "wachtwoord_kiezen", p_gebruiker: wie.id }, null);

    // Het nieuwe wachtwoord mag niet het tijdelijke zijn: anders kent de beheerder het (17.2). Lukt
    // aanmelden met het nieuwe wachtwoord nu al, dan is het hetzelfde.
    const zelfde = await roep("/auth/v1/token?grant_type=password", "POST", o.publiek, null, { email: wie.email, password: nieuw });
    if (zelfde.status === 200) {
      const sessie = (zelfde.gegevens ?? {}) as { access_token?: unknown };
      if (typeof sessie.access_token === "string") await roep("/auth/v1/logout?scope=local", "POST", o.publiek, sessie.access_token);
      await mislukt(operatie, "Het gekozen wachtwoord was het tijdelijke.", new Fout(422, "kan_niet", "Kies een ander wachtwoord dan je tijdelijke wachtwoord."));
    }
    if (zelfde.status !== 400 || foutcode(zelfde) !== "invalid_credentials") {
      await mislukt(operatie, reden(zelfde), new Fout(503, "supabase", LATER));
    }

    const r = await beheer("/admin/users/" + wie.id, "PUT", { password: nieuw });
    if (r.status !== 200) {
      const zwak = foutcode(r) === "weak_password";
      await mislukt(operatie, reden(r), zwak
        ? new Fout(422, "kan_niet", "Supabase vindt dit wachtwoord te zwak. Kies een langer wachtwoord, of een dat minder voor de hand ligt.")
        : new Fout(r.status === 0 ? 503 : 502, "supabase", LATER));
    }
    await rondAf(operatie, true);
    // Supabase beëindigde alle sessies van dit account: de pagina meldt opnieuw aan, met het nieuwe wachtwoord.
    return { opnieuw_aanmelden: true };
  }

  async function afronden(wie: Wie): Promise<Json> {
    if (wie.aal !== "aal2" || !wie.methodes.includes("totp") || !wie.methodes.includes("password")) {
      throw new Fout(403, "rechten", "Geef eerst de code uit je app in.");
    }
    const lijst = await beheer("/admin/users/" + wie.id + "/factors", "GET");
    if (lijst.status !== 200 || !Array.isArray(lijst.gegevens)) throw new Fout(503, "supabase", LATER);
    const gekoppeld = (lijst.gegevens as { factor_type?: unknown; status?: unknown }[])
      .some((f) => f.factor_type === "totp" && f.status === "verified");
    if (!gekoppeld) throw new Fout(422, "kan_niet", "Je authenticator-app is nog niet gekoppeld.");
    const r = await databank("mt_account_afgerond", { p_gebruiker: wie.id }, null);
    return { al_afgerond: r.al_afgerond === true };
  }

  // ---------- Voor een beheerder ----------
  // Elke handeling begint in de databank, met het toegangsbewijs van de beheerder: zij kijkt na dat hij
  // beheerder is, met een verse code, en blokkeert het account. Pas dan wijzigt er iets bij Supabase.

  async function aanmaken(wie: Wie, invoer: Json): Promise<Json> {
    const operatie = uuid(invoer.operatie, "het operatienummer");
    const start = await databank("mt_account_start", {
      p_operatie: operatie,
      p_soort: "aanmaken",
      p_voor: null,
      p_gegevens: { naam: tekst(invoer.naam, "de naam", 200), email: tekst(invoer.email, "het e-mailadres", 300), rol: tekst(invoer.rol, "de rol", 20) },
    }, wie.token);
    const email = String(start.email);
    const wachtwoord = tijdelijkWachtwoord();
    let gebruiker: string | null = null;
    let r = await beheer("/admin/users", "POST", { email, password: wachtwoord, email_confirm: true });
    if (r.status === 200 && typeof (r.gegevens as { id?: unknown } | null)?.id === "string") {
      gebruiker = (r.gegevens as { id: string }).id;
    } else if (r.status === 422 && foutcode(r) === "email_exists") {
      // Het account bestaat al bij Supabase, bv. na een poging die halverwege strandde: het krijgt een
      // nieuw tijdelijk wachtwoord en verliest zijn koppelingen. Hoort het al bij een gebruiker van de
      // MT, dan weigert de databank het hieronder.
      const zoek = await beheer("/admin/users?filter=" + encodeURIComponent(email) + "&per_page=200", "GET");
      const gevonden = zoek.status === 200
        ? ((zoek.gegevens as { users?: { id?: unknown; email?: unknown }[] } | null)?.users ?? [])
          .filter((u) => typeof u.email === "string" && u.email.toLowerCase() === email && typeof u.id === "string")
        : [];
      if (gevonden.length === 1) {
        gebruiker = gevonden[0].id as string;
        r = await beheer("/admin/users/" + gebruiker, "PUT", { password: wachtwoord, ban_duration: "none", email_confirm: true });
        if (r.status !== 200 || !(await wisKoppelingen(gebruiker))) gebruiker = null;
      }
    }
    if (gebruiker === null || !UUID.test(gebruiker)) {
      await mislukt(operatie, reden(r), new Fout(r.status === 0 ? 503 : 502, "supabase", "Supabase maakte het account niet aan. Probeer het opnieuw."));
    }
    let klaar: Json;
    try {
      klaar = await rondAf(operatie, true, { gebruiker });
    } catch (fout) {
      if (fout instanceof Fout && fout.code === "kan_niet") await mislukt(operatie, fout.message, fout);
      throw fout;
    }
    return { gebruiker: klaar.gebruiker, email, wachtwoord, geldig_tot: klaar.tijdelijk_tot ?? null, uren: start.uren ?? null };
  }

  async function nieuwWachtwoord(wie: Wie, invoer: Json, soort: "tijdelijk_wachtwoord" | "inschakelen"): Promise<Json> {
    const operatie = uuid(invoer.operatie, "het operatienummer");
    const gebruiker = uuid(invoer.gebruiker, "de gebruiker");
    const start = await databank("mt_account_start", {
      p_operatie: operatie, p_soort: soort, p_voor: gebruiker, p_gegevens: { app_wissen: invoer.app_wissen === true },
    }, wie.token);
    const wachtwoord = tijdelijkWachtwoord();
    // Eerst het wachtwoord: Supabase beëindigt daarmee alle sessies van het account (T5). Dan de koppelingen.
    const r = await beheer("/admin/users/" + gebruiker, "PUT", soort === "inschakelen" ? { password: wachtwoord, ban_duration: "none" } : { password: wachtwoord });
    if (r.status !== 200) await mislukt(operatie, reden(r), new Fout(r.status === 0 ? 503 : 502, "supabase", "Supabase stelde het wachtwoord niet in."));
    if (start.app_wissen === true && !(await wisKoppelingen(gebruiker))) {
      await mislukt(operatie, "De app-koppeling werd niet volledig gewist.", new Fout(502, "supabase", "Supabase wiste de app-koppeling niet."));
    }
    const klaar = await rondAf(operatie, true);
    return { gebruiker, wachtwoord, app_gewist: start.app_wissen === true, geldig_tot: klaar.tijdelijk_tot ?? null, uren: start.uren ?? null };
  }

  async function uitschakelen(wie: Wie, invoer: Json): Promise<Json> {
    const operatie = uuid(invoer.operatie, "het operatienummer");
    const gebruiker = uuid(invoer.gebruiker, "de gebruiker");
    // De start zet het account in de MT meteen uit. Daarna de ban, en een wachtwoord dat niemand kent:
    // daarmee beëindigt Supabase alle sessies.
    await databank("mt_account_start", { p_operatie: operatie, p_soort: "uitschakelen", p_voor: gebruiker, p_gegevens: {} }, wie.token);
    const r = await beheer("/admin/users/" + gebruiker, "PUT", { ban_duration: VOORGOED, password: onbekendWachtwoord() });
    if (r.status !== 200) await mislukt(operatie, reden(r), new Fout(r.status === 0 ? 503 : 502, "supabase", "Supabase trok de sessies niet in."));
    await rondAf(operatie, true);
    return { gebruiker };
  }

  async function emailWijzigen(wie: Wie, invoer: Json): Promise<Json> {
    const operatie = uuid(invoer.operatie, "het operatienummer");
    const gebruiker = uuid(invoer.gebruiker, "de gebruiker");
    const start = await databank("mt_account_start", {
      p_operatie: operatie, p_soort: "email_wijzigen", p_voor: gebruiker, p_gegevens: { email: tekst(invoer.email, "het e-mailadres", 300) },
    }, wie.token);
    const email = String(start.email_nieuw);
    const r = await beheer("/admin/users/" + gebruiker, "PUT", { email, email_confirm: true });
    if (r.status !== 200) {
      const bestaat = foutcode(r) === "email_exists";
      await mislukt(operatie, reden(r), bestaat
        ? new Fout(422, "kan_niet", "Bij Supabase bestaat al een account met dit e-mailadres.")
        : new Fout(r.status === 0 ? 503 : 502, "supabase", "Supabase wijzigde het e-mailadres niet."));
    }
    await rondAf(operatie, true);
    return { gebruiker, email };
  }

  // ---------- De oproep ----------

  return async function behandel(verzoek: Request): Promise<Response> {
    let actie = "";
    try {
      if (!pagina || !o.publiek || !o.geheim) {
        o.meld({ resultaat: "instelling" });
        return antwoord(500, { ok: false, code: "instelling", melding: "De serverfunctie is niet ingesteld voor dit project." }, false);
      }
      const oorsprong = verzoek.headers.get("Origin");
      if (oorsprong !== null && oorsprong !== pagina) {
        return antwoord(403, { ok: false, code: "oorsprong", melding: "Dit adres mag de serverfunctie niet oproepen." }, false);
      }
      if (verzoek.method === "OPTIONS") return new Response(null, { status: 204, headers: koppen(true) });
      if (verzoek.method !== "POST") throw new Fout(405, "oproep", "Deze oproep klopt niet.");

      const ruw = await verzoek.text();
      if (ruw.length > MAX_INVOER) throw new Fout(413, "oproep", "Deze oproep is te groot.");
      let invoer: Json;
      try {
        invoer = JSON.parse(ruw) as Json;
      } catch {
        throw new Fout(400, "oproep", "Deze oproep klopt niet.");
      }
      if (invoer === null || typeof invoer !== "object" || Array.isArray(invoer) || typeof invoer.actie !== "string"
          || !(BEHEER.has(invoer.actie) || EIGEN.has(invoer.actie))) {
        throw new Fout(400, "oproep", "Deze oproep klopt niet.");
      }
      actie = invoer.actie;
      const wie = await wieIsDit(verzoek);

      let uit: Json;
      if (actie === "stand") uit = await stand(wie);
      else if (actie === "wachtwoord_kiezen") uit = await wachtwoordKiezen(wie, invoer);
      else if (actie === "afronden") uit = await afronden(wie);
      else if (actie === "aanmaken") uit = await aanmaken(wie, invoer);
      else if (actie === "tijdelijk_wachtwoord" || actie === "inschakelen") uit = await nieuwWachtwoord(wie, invoer, actie);
      else if (actie === "uitschakelen") uit = await uitschakelen(wie, invoer);
      else uit = await emailWijzigen(wie, invoer);

      o.meld({ actie, resultaat: "gelukt" });
      return antwoord(200, { ok: true, ...uit });
    } catch (fout) {
      if (fout instanceof Fout) {
        o.meld({ actie, resultaat: fout.code, status: fout.status });
        return antwoord(fout.status, { ok: false, code: fout.code, melding: fout.message, ...fout.extra });
      }
      o.meld({ actie, resultaat: "onverwacht", soort: fout instanceof Error ? fout.name : "onbekend" });
      return antwoord(500, { ok: false, code: "onverwacht", melding: "De serverfunctie gaf een onverwachte fout." });
    }
  };
}

/** De sleutel met de naam "default" uit de lijst die Supabase aan de functie geeft. */
function sleutel(naam: string): string {
  try {
    const lijst = JSON.parse(Deno.env.get(naam) ?? "{}") as Record<string, unknown>;
    return typeof lijst.default === "string" ? lijst.default : "";
  } catch {
    return "";
  }
}

let behandelaar: ((verzoek: Request) => Promise<Response>) | null = null;

export default {
  fetch(verzoek: Request): Promise<Response> {
    // De sleutels komen van Supabase zelf, als omgevingsvariabelen van de functie. Nooit uit dit bestand.
    behandelaar ??= maakBehandelaar({
      url: (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, ""),
      publiek: sleutel("SUPABASE_PUBLISHABLE_KEYS"),
      geheim: sleutel("SUPABASE_SECRET_KEYS"),
      haal: (adres, opties) => fetch(adres, opties),
      meld: (regel) => console.log(JSON.stringify({ functie: "mt-accounts", versie: VERSIE, ...regel })),
      wacht: (ms) => new Promise((klaar) => setTimeout(klaar, ms)),
      willekeurig: (aantal) => crypto.getRandomValues(new Uint8Array(aantal)),
    });
    return behandelaar(verzoek);
  },
};
