// MT · tests/nabootsing.js
// De nagebootste Supabase en de nagebootste uitstappentool voor de serverfunctie mt-uitstappen. Er gaat
// niets over het netwerk. Twee tests gebruiken ze: tests/uitstapfunctie_test.js, en de controle in een
// echte browser (tests/browser/naspelen.js).
// De databankfuncties van de nabootsing volgen sql/006_review2.sql: de lezingen met hun volgnummer, de
// rust van dertig seconden, de rem (B225) en de uitkomst die de databank bewaart. Wat ze niet nabootst:
// de lijsten per klas, een verhuis naar een ander schooljaar en de taken per uitstap. Een datum die
// wacht, bootst ze na met s.vast. De echte databankfuncties worden nagekeken in tests/databank/proef.sql,
// en de echte serverfunctie tegen de echte databank in tests/databank_test.js.

import { UITSTAPFUNCTIE } from "../code/config.js";
import { maakBehandelaar, PAGINA, UITSTAPPENTOOL } from "../functies/mt-uitstappen/index.ts";

export const URL_MT = "https://ayszixqnuktogzjtreyy.supabase.co";
export const OORSPRONG = PAGINA[URL_MT];
export const PUBLIEK = "sb_publishable_voorbeeld";
export const GEHEIM = ["sb", "secret", "enkelvoordetest"].join("_");
export const ID = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");

export function b64(tekst) {
  return btoa(tekst).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const schooljaarVan = (datum) => {
  const jaar = Number(datum.slice(0, 4));
  return Number(datum.slice(5, 7)) >= 9 ? jaar + "-" + (jaar + 1) : jaar - 1 + "-" + jaar;
};

export function nep() {
  const s = {
    nu: Date.parse("2026-11-16T08:00:00Z"),
    /** Elke oproep duurt zo lang: om een traag netwerk na te bootsen. */
    duur: 5,
    oproepen: [],
    logboek: [],
    sessies: new Map(), // token → id van de gebruiker
    gebruikers: new Map(), // id → { rol }
    jaren: new Map(), // schooljaar → stand
    klassen: new Map(), // schooljaar → Set van namen
    activiteiten: new Map(), // uitstap → { gewijzigd, stand, schooljaar, plan, start }
    lezingen: [], // { nummer, stand, begonnen, klaar, door, tellingen, uitkomst, verouderd }
    vast: new Set(), // uitstappen waarvan de datum vastligt, bv. door een bevestigde klas: een andere datum wacht
    taken: [], // de taken van de rem
    maxRijen: null, // de grootste bladzijde die de uitstappentool geeft; null: wat gevraagd wordt
    bron: { uitstappen: [], instellingen: [] },
    storing: null, // (oproep) → Response, "gooi" of niets
  };

  s.gebruiker = (n, rol) => {
    s.gebruikers.set(ID(n), { rol });
    const token = b64('{"alg":"ES256"}') + "." + b64(JSON.stringify({ sub: ID(n) })) + "." + b64("handtekening" + n);
    s.sessies.set(token, ID(n));
    return token;
  };
  s.uitstap = (id, trip, gewijzigd = "2026-11-10T08:00:00+00:00") => {
    s.bron.uitstappen.push({ id, nr: s.bron.uitstappen.length + 1, schooljaar: "", updated_at: gewijzigd, trip });
  };
  s.klassenlijst = (...namen) => {
    s.bron.instellingen = [{ id: "klimop", data: { klassen: namen.map((naam, i) => ({ id: "k" + i, naam, groep: /K/.test(naam) ? "Kleuter" : "Lager" })) } }];
  };
  /** Dertig seconden later: voorbij de rust tussen twee lezingen. */
  s.later = (ms = 31000) => {
    s.nu += ms;
  };
  s.schooljaar = (jaar, stand, namen = []) => {
    s.jaren.set(jaar, stand);
    s.klassen.set(jaar, new Set(namen));
  };

  const json = (status, lichaam, koppen = {}) => new Response(JSON.stringify(lichaam), { status, headers: { "Content-Type": "application/json", ...koppen } });
  const pg = (code, message, status = 400) => Object.assign(new Error(message), { antwoord: json(status, { code, message: "MT: " + message }) });

  /** Eén uitstap, zoals mt_intern.uitstap_bijwerken in 006. */
  function uitstapBijwerken(p) {
    // Klassen die geen lijst zijn, zijn voor de databank geen klassen; lege namen en dubbels vallen weg.
    const klassen = Array.isArray(p.klassen) ? [...new Set(p.klassen.map((k) => String(k).trim()).filter((k) => k !== ""))] : [];
    const dag = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const eind = p.type === "meerdaags" ? (p.datumEind ?? p.datumStart) : p.datumStart;
    const geldig = typeof p.id === "string" && p.id.length >= 1 && p.id.length <= 60 && typeof p.gewijzigd === "string" && !Number.isNaN(Date.parse(p.gewijzigd))
      && dag(p.datumStart) && dag(eind) && eind >= p.datumStart && ["aangevraagd", "bevestigd", "geannuleerd"].includes(p.planStatus)
      && Date.parse(p.gewijzigd) <= s.nu + 5 * 60000 && klassen.length <= 50;
    if (!geldig) return { wat: "ongeldig", uitstap: p.id };
    const weg = p.categorie === "nascholing" ? "nascholing" : p.verwijderd === true ? "verwijderd" : null;
    const jaar = schooljaarVan(p.datumStart);
    const onbekend = () => klassen.filter((naam) => !(s.klassen.get(jaar) ?? new Set()).has(naam));
    const act = s.activiteiten.get(p.id);
    if (!act) {
      if (weg) return { wat: "geen", uitstap: p.id };
      if (!["lopend", "voorbij"].includes(s.jaren.get(jaar))) return { wat: "buiten", uitstap: p.id };
      s.activiteiten.set(p.id, { gewijzigd: p.gewijzigd, stand: "actief", schooljaar: jaar, plan: p.planStatus, start: p.datumStart });
      return { wat: "nieuw", uitstap: p.id, onbekend: onbekend(), schooljaar: jaar };
    }
    // Geen vergelijking "ouder" meer: de volgorde hangt aan de lezing (006).
    if (s.jaren.get(act.schooljaar) === "afgesloten") return { wat: "gesloten", uitstap: p.id };
    if (weg) {
      // Dezelfde stand, misschien in een nieuwere versie: de versie volgt wel.
      if (act.stand === weg) {
        act.gewijzigd = p.gewijzigd;
        return { wat: "ongewijzigd", uitstap: p.id };
      }
      Object.assign(act, { stand: weg, gewijzigd: p.gewijzigd });
      return { wat: "weg", uitstap: p.id };
    }
    let wijzigt = act.stand !== "actief" || act.plan !== p.planStatus;
    Object.assign(act, { stand: "actief", plan: p.planStatus });
    if (act.start !== p.datumStart) {
      // Ligt de datum vast, dan wacht de nieuwe: de datum en de versie blijven die van toen.
      if (s.vast.has(p.id)) return { wat: wijzigt ? "gewijzigd" : "ongewijzigd", uitstap: p.id, wacht: true };
      act.start = p.datumStart;
      wijzigt = true;
    }
    if (act.gewijzigd !== p.gewijzigd) wijzigt = true;
    act.gewijzigd = p.gewijzigd;
    return { wat: wijzigt ? "gewijzigd" : "ongewijzigd", uitstap: p.id, onbekend: onbekend(), schooljaar: act.schooljaar };
  }

  const TELLERS = ["nieuw", "gewijzigd", "weg", "ongewijzigd", "ongeldig", "buiten", "geen", "gesloten"];
  const dienst = (ctx) => {
    if (ctx.rol !== "service_role") throw pg("42501", "enkel voor een serverfunctie van de MT", 403);
  };

  const functies = {
    mt_mijn_account(_a, ctx) {
      const g = ctx.gebruiker ? s.gebruikers.get(ctx.gebruiker) : null;
      if (!g) throw pg("42501", "dit account heeft geen toegang tot de MT", 403);
      const lopend = [...s.jaren].find(([, stand]) => stand === "lopend");
      return { id: ctx.gebruiker, naam: "Proef", rol: g.rol, schooljaar: lopend ? lopend[0] : null, klassen: [], instellingen: {} };
    },
    mt_klassen_bijwerken(a, ctx) {
      const g = ctx.gebruiker ? s.gebruikers.get(ctx.gebruiker) : null;
      if (!g || g.rol !== "beheerder") throw pg("42501", "geen rechten voor deze handeling", 403);
      const lopend = [...s.jaren].find(([, stand]) => stand === "lopend");
      if (!lopend) throw pg("MT422", "er is nog geen lopend schooljaar");
      if (!Array.isArray(a.p_klassen) || a.p_klassen.length < 1) throw pg("MT422", "de klassenlijst is leeg of klopt niet. Er is niets gewijzigd.");
      a.p_klassen.forEach((k, i) => {
        if (typeof k.id !== "string" || !k.naam || !["Kleuter", "Lager", "Andere"].includes(k.groep)) throw pg("MT422", "klas " + (i + 1) + " in de klassenlijst klopt niet. Er is niets gewijzigd.");
      });
      const set = s.klassen.get(lopend[0]);
      let nieuw = 0;
      for (const k of a.p_klassen) {
        if (!set.has(k.naam)) nieuw++;
        set.add(k.naam);
      }
      return { schooljaar: lopend[0], nieuw, gewijzigd: 0, uitgezet: 0 };
    },
    mt_lezing_start(a, ctx) {
      dienst(ctx);
      const klaar = [...s.lezingen].reverse().find((l) => l.stand === "klaar") ?? null;
      const bezig = s.lezingen.find((l) => l.stand === "bezig") ?? null;
      if (bezig && bezig.begonnen > s.nu - 60000) return { wat: "bezig", sinds: new Date(bezig.begonnen).toISOString(), uitkomst: klaar ? klaar.uitkomst : null };
      for (const l of s.lezingen) if (l.stand === "bezig") Object.assign(l, { stand: "afgebroken", reden: "geen einde binnen de tijd" });
      if (klaar && !klaar.verouderd && klaar.klaar > s.nu - 30000) return { wat: "recent", uitkomst: klaar.uitkomst };
      const l = { nummer: s.lezingen.length + 1, stand: "bezig", begonnen: s.nu, klaar: null, door: a.p_door ?? null, tellingen: null, uitkomst: null, verouderd: false };
      s.lezingen.push(l);
      return { wat: "nieuw", lezing: l.nummer };
    },
    mt_lezing_stop(a, ctx) {
      dienst(ctx);
      const l = s.lezingen.find((x) => x.nummer === a.p_lezing && x.stand === "bezig");
      if (l) Object.assign(l, { stand: "afgebroken", reden: String(a.p_reden ?? "").slice(0, 200) });
      return { afgebroken: Boolean(l) };
    },
    mt_uitstappen_bijwerken(a, ctx) {
      dienst(ctx);
      const metUitkomst = a.p_uitkomst !== null && a.p_uitkomst !== undefined;
      const metIds = a.p_alle_ids !== null && a.p_alle_ids !== undefined;
      if (!Number.isInteger(a.p_lezing) || !Array.isArray(a.p_uitstappen) || a.p_uitstappen.length > 5000
        || (metUitkomst && (typeof a.p_uitkomst !== "object" || Array.isArray(a.p_uitkomst) || !metIds))) throw pg("22023", "de lijst van uitstappen klopt niet");
      const lezing = s.lezingen.find((l) => l.nummer === a.p_lezing);
      if (!lezing || lezing.stand !== "bezig") throw pg("MT409", "deze lezing is ingehaald door een nieuwere, of al afgesloten. Er is niets gewijzigd.");
      // Eén oproep is één transactie: mislukt ze, dan is er niets gewijzigd.
      const vooraf = structuredClone({ activiteiten: [...s.activiteiten], taken: s.taken });
      try {
        const tel = Object.fromEntries(TELLERS.map((naam) => [naam, 0]));
        const onbekend = [];
        const wacht = [];
        for (const p of a.p_uitstappen) {
          const r = uitstapBijwerken(p);
          tel[r.wat]++;
          if (r.onbekend && r.onbekend.length) onbekend.push({ uitstap: r.uitstap, schooljaar: r.schooljaar, klassen: r.onbekend });
          if (r.wacht) wacht.push(r.uitstap);
        }
        const eerder = lezing.tellingen ?? { uitstappen: Object.fromEntries(TELLERS.map((naam) => [naam, 0])), onbekende_klassen: [], wacht: [] };
        const samen = {
          uitstappen: Object.fromEntries(TELLERS.map((naam) => [naam, eerder.uitstappen[naam] + tel[naam]])),
          onbekende_klassen: [...eerder.onbekende_klassen, ...onbekend],
          wacht: [...eerder.wacht, ...wacht],
        };
        if (!metIds) {
          lezing.tellingen = samen;
          return { ...tel, niet_gevonden: 0, tegengehouden: 0, onbekende_klassen: onbekend, wacht };
        }
        const open = [...s.activiteiten].filter(([, act]) => ["lopend", "voorbij"].includes(s.jaren.get(act.schooljaar)));
        if (a.p_alle_ids.length === 0 && open.some(([, act]) => act.stand === "actief")) {
          throw pg("MT422", "de uitstappentool gaf geen enkele uitstap terug. Dat is een fout, geen resultaat; er is niets gewijzigd.");
        }
        // De rem (B225): meer dan vijf uitstappen die nog meetelden, verdwijnen niet zonder vraag.
        const verdwenen = open.filter(([id, act]) => act.stand === "actief" && !a.p_alle_ids.includes(id)).map(([id]) => id).sort();
        let weg = 0;
        let tegengehouden = 0;
        let taak = null;
        let lijst = [];
        if (verdwenen.length > 5) {
          tegengehouden = verdwenen.length;
          // Welke het zijn: op datum en dan op id, hoogstens vijftig. De nabootsing kent geen klaslijsten.
          lijst = verdwenen.map((id) => ({ uitstap: id, van: s.activiteiten.get(id).start, tot: s.activiteiten.get(id).start, klassen: [] }))
            .sort((x, y) => (x.van < y.van ? -1 : x.van > y.van ? 1 : x.uitstap < y.uitstap ? -1 : 1)).slice(0, 50);
          taak = s.taken.find((t) => t.stand === "open") ?? null;
          if (taak) taak.uitstappen = verdwenen;
          else s.taken.push((taak = { id: ID(7000 + s.taken.length), stand: "open", uitstappen: verdwenen }));
        } else {
          for (const t of s.taken) if (t.stand === "open") t.stand = "hersteld";
          for (const [id, act] of open) {
            if (act.stand !== "niet_gevonden" && !a.p_alle_ids.includes(id)) {
              act.stand = "niet_gevonden";
              weg++;
            }
          }
        }
        const uitkomst = {
          ...(a.p_uitkomst ?? {}),
          lezing: lezing.nummer,
          klaar_op: new Date(s.nu).toISOString(),
          duur_ms: s.nu - lezing.begonnen,
          uitstappen: { ...samen.uitstappen, niet_gevonden: weg, tegengehouden },
          verdwenen_taak: taak ? taak.id : null,
          verdwenen: lijst,
          onbekende_klassen: samen.onbekende_klassen,
          wacht: samen.wacht,
        };
        Object.assign(lezing, { stand: "klaar", klaar: s.nu, tellingen: samen, uitkomst });
        return { ...tel, niet_gevonden: weg, tegengehouden, onbekende_klassen: onbekend, wacht, uitkomst };
      } catch (fout) {
        s.activiteiten = new Map(vooraf.activiteiten);
        s.taken = vooraf.taken;
        throw fout;
      }
    },
  };

  /**
   * De Data API van de uitstappentool: lezen op id ("verder vanaf de laatste id"), een totaal dat zegt
   * hoeveel rijen er vanaf daar nog zijn, en korte kolommen. Een vraag met een verschuiving (offset)
   * weigert ze: zo valt op als de adapter weer op een aantal rijen zou bladeren.
   */
  function bron(url) {
    const tabel = url.pathname.replace("/rest/v1/", "");
    if (!Object.prototype.hasOwnProperty.call(s.bron, tabel)) return json(404, { message: "bestaat niet" });
    if (url.searchParams.get("order") !== "id.asc" || url.searchParams.has("offset")) return json(400, { message: "de nabootsing leest enkel op id, zonder verschuiving" });
    let rijen = [...s.bron[tabel]].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const filter of url.searchParams.getAll("id")) {
      if (filter.startsWith("eq.")) rijen = rijen.filter((r) => r.id === filter.slice(3));
      else if (filter.startsWith("gt.")) rijen = rijen.filter((r) => r.id > filter.slice(3));
      else return json(400, { message: "onbekende filter" });
    }
    const stuk = rijen.slice(0, Math.min(Number(url.searchParams.get("limit")), s.maxRijen ?? Infinity)).map((r) => {
      const uit = {};
      for (const kolom of url.searchParams.get("select").split(",")) {
        const m = /^(\w+):trip->(\w+)$/.exec(kolom);
        if (m) uit[m[1]] = r.trip !== null && typeof r.trip === "object" && !Array.isArray(r.trip) && r.trip[m[2]] !== undefined ? r.trip[m[2]] : null;
        else uit[kolom] = r[kolom] === undefined ? null : r[kolom];
      }
      return uit;
    });
    return json(stuk.length < rijen.length ? 206 : 200, stuk, { "content-range": (stuk.length ? "0-" + (stuk.length - 1) : "*") + "/" + rijen.length });
  }

  s.haal = (adres, opties) => {
    const url = new URL(adres);
    const koppen = new Headers(opties.headers);
    const lichaam = opties.body ? JSON.parse(opties.body) : null;
    const oproep = { adres, host: url.origin, pad: url.pathname, methode: opties.method, sleutel: koppen.get("apikey"), drager: koppen.get("Authorization"), lichaam, opties };
    s.oproepen.push(oproep);
    s.nu += s.duur;
    if (s.storing) {
      const eigen = s.storing(oproep);
      if (eigen === "gooi") return Promise.reject(new TypeError("geen netwerk"));
      if (eigen) return Promise.resolve(eigen);
    }
    if (url.origin === UITSTAPPENTOOL.url) {
      if (oproep.sleutel !== UITSTAPPENTOOL.sleutel) return Promise.resolve(json(401, { message: "Invalid API key" }));
      return Promise.resolve(bron(url));
    }
    if (url.origin !== URL_MT) return Promise.reject(new TypeError("onbekend adres: " + adres));
    if (oproep.sleutel !== PUBLIEK && oproep.sleutel !== GEHEIM) return Promise.resolve(json(401, { message: "Invalid API key" }));
    const drager = (oproep.drager ?? "").replace(/^Bearer /, "");
    if (url.pathname === "/auth/v1/user") {
      const id = s.sessies.get(drager);
      return Promise.resolve(id ? json(200, { id, email: "proef@school.voorbeeld" }) : json(403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" }));
    }
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);
    if (!m || !Object.prototype.hasOwnProperty.call(functies, m[1]) || opties.method !== "POST") return Promise.resolve(json(404, { code: "PGRST202", message: "bestaat niet" }));
    const ctx = drager === GEHEIM && oproep.sleutel === GEHEIM ? { rol: "service_role", gebruiker: null } : { rol: "authenticated", gebruiker: s.sessies.get(drager) ?? null };
    if (ctx.rol === "authenticated" && !ctx.gebruiker) return Promise.resolve(json(401, { code: "PGRST301", message: "JWT expired" }));
    try {
      return Promise.resolve(json(200, functies[m[1]](lichaam ?? {}, ctx)));
    } catch (fout) {
      if (fout.antwoord) return Promise.resolve(fout.antwoord);
      throw fout;
    }
  };

  s.behandel = maakBehandelaar({ url: URL_MT, publiek: PUBLIEK, geheim: GEHEIM, haal: s.haal, meld: (regel) => s.logboek.push(regel), nu: () => s.nu });
  s.vraag = async (token, { lichaam = { actie: "bijwerken" }, methode = "POST", oorsprong = OORSPRONG } = {}) => {
    const koppen = { "Content-Type": "application/json" };
    if (oorsprong) koppen.Origin = oorsprong;
    if (token) koppen.Authorization = "Bearer " + token;
    const antwoord = await s.behandel(new Request(URL_MT + "/functions/v1/" + UITSTAPFUNCTIE, { method: methode, headers: koppen, body: methode === "POST" ? (typeof lichaam === "string" ? lichaam : JSON.stringify(lichaam)) : undefined }));
    const tekst = await antwoord.text();
    return { status: antwoord.status, koppen: antwoord.headers, tekst, g: tekst ? JSON.parse(tekst) : null };
  };
  s.naarDatabank = () => s.oproepen.filter((o) => o.pad === "/rest/v1/rpc/mt_uitstappen_bijwerken");
  s.naarBron = () => s.oproepen.filter((o) => o.host === UITSTAPPENTOOL.url);
  return s;
}
