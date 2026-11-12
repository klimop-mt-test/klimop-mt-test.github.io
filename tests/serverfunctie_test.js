// MT · tests/serverfunctie_test.js
// De serverfunctie voor de accounts (functies/mt-accounts), tegen een nagebootste Supabase: de
// aanmelding, de beheerroutes en de vier databankfuncties van 004. Er gaat niets over het netwerk.
// Wat de test bewaakt (17.4, T5):
//   - de secret key gaat enkel naar het eigen project, en staat nooit in een antwoord of in het logboek;
//   - of iemand beheerder is, beslist de databank, met het toegangsbewijs van de beheerder zelf;
//   - eerst de toegang blokkeren, dan pas iets wijzigen bij Supabase; mislukt dat, dan blijft de
//     blokkering;
//   - een gekozen wachtwoord staat nergens: niet in een antwoord, niet in het logboek.
// De databank zelf wordt nagekeken in tests/databank/proef.sql; hier staat een eenvoudige nabootsing.

import assert from "node:assert/strict";
import { ACCOUNTFUNCTIE_VERSIE, alleOmgevingen, omgeving } from "../code/config.js";
import { lees } from "./hulp.js";
import { maakBehandelaar, PAGINA, VERSIE } from "../functies/mt-accounts/index.ts";

const URL_MT = "https://ayszixqnuktogzjtreyy.supabase.co";
const OORSPRONG = PAGINA[URL_MT];
const PUBLIEK = "sb_publishable_voorbeeld";
const GEHEIM = ["sb", "secret", "enkelvoordetest"].join("_");
const ID = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const OP = (n) => "11111111-1111-4111-8111-" + String(n).padStart(12, "0");

// ---------- De nagebootste Supabase ----------

function b64(tekst) {
  return btoa(tekst).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function nep() {
  const s = {
    nu: Date.parse("2026-11-11T10:00:00Z"),
    oproepen: [],
    logboek: [],
    auth: new Map(), // id → { id, email, wachtwoord, ban, bevestigd, factoren }
    sessies: new Map(), // token → { gebruiker, aal, methodes }
    mt: new Map(), // id → { naam, email, rol, actief, tijdelijk, tot, eerste, app, open }
    ops: new Map(), // id → { soort, door, voor, plan, begonnen, afgerond, resultaat, melding }
    storing: null, // (oproep) → Response of niets: om een fout bij Supabase na te bootsen
    volgend: 500,
  };

  s.account = (n, email, wachtwoord, mt = null, factoren = []) => {
    s.auth.set(ID(n), { id: ID(n), email, wachtwoord, ban: null, bevestigd: true, factoren });
    if (mt) s.mt.set(ID(n), { naam: "Proef " + n, email, rol: "leerkracht", actief: true, tijdelijk: false, tot: null, eerste: true, app: false, open: null, ...mt });
    return ID(n);
  };
  s.sessie = (n, aal = "aal2", methodes = ["password", "totp"]) => {
    const claims = { sub: ID(n), aal, amr: methodes.map((method) => ({ method, timestamp: Math.floor(s.nu / 1000) })) };
    const token = b64('{"alg":"ES256"}') + "." + b64(JSON.stringify(claims)) + "." + b64("handtekening" + s.sessies.size);
    s.sessies.set(token, { gebruiker: ID(n), aal, methodes });
    return token;
  };

  const json = (status, lichaam) => new Response(JSON.stringify(lichaam), { status, headers: { "Content-Type": "application/json" } });
  const pg = (code, message, status = 400) => Object.assign(new Error(message), { antwoord: json(status, { code, message: "MT: " + message }) });
  const inOrde = (g) => !!g && g.actief && g.eerste && !g.tijdelijk && !g.app && !g.open;
  const eisServer = (ctx) => {
    if (ctx.rol !== "service_role") throw pg("42501", "enkel voor de serverfunctie van de accounts", 403);
  };
  const eisBeheerder = (ctx) => {
    const z = ctx.sessie;
    const g = z ? s.mt.get(z.gebruiker) : null;
    if (!z || z.aal !== "aal2" || !z.methodes.includes("totp") || !z.methodes.includes("password") || !inOrde(g) || g.rol !== "beheerder") {
      throw pg("42501", "geen rechten voor deze handeling", 403);
    }
    return z.gebruiker;
  };
  const instellingen = () => ({ afmelden_na_minuten: 30, code_geldig_dagen: 14, wachtwoord_min_lengte: 12, tijdelijk_wachtwoord_uren: 48, aangemeld_blijven: true });

  const functies = {
    mt_account_stand(a, ctx) {
      eisServer(ctx);
      const g = s.mt.get(a.p_gebruiker);
      if (!g) return { bekend: false, instellingen: instellingen() };
      return {
        bekend: true,
        account: { id: a.p_gebruiker, naam: g.naam, rol: g.rol, actief: g.actief, wachtwoord_tijdelijk: g.tijdelijk, tijdelijk_verlopen: g.tijdelijk && !(g.tot > s.nu), eerste_aanmelding_afgerond: g.eerste, app_koppelen: g.app, bezig: g.open !== null },
        instellingen: instellingen(),
      };
    },
    mt_account_eigen_start(a, ctx) {
      eisServer(ctx);
      const g = s.mt.get(a.p_gebruiker);
      if (!g) throw pg("42501", "dit account heeft geen toegang tot de MT", 403);
      if (!g.actief) throw pg("MT422", "dit account is uitgeschakeld");
      if (g.open) throw pg("MT409", "er loopt nog een wijziging aan dit account.");
      if (!g.tijdelijk) throw pg("MT422", "dit account heeft geen tijdelijk wachtwoord");
      if (!(g.tot > s.nu)) throw pg("MT422", "je tijdelijke wachtwoord is verlopen. Vraag een nieuw aan de beheerder of het secretariaat.");
      if (s.ops.has(a.p_operatie)) throw pg("MT409", "deze handeling is al gestart");
      s.ops.set(a.p_operatie, { soort: a.p_soort, door: a.p_gebruiker, voor: a.p_gebruiker, plan: {}, afgerond: false });
      g.open = a.p_operatie;
      return { operatie: a.p_operatie, gebruiker: a.p_gebruiker, email: g.email, wachtwoord_min_lengte: 12 };
    },
    mt_account_start(a, ctx) {
      const wie = eisBeheerder(ctx);
      if (s.ops.has(a.p_operatie)) throw pg("MT409", "deze handeling is al gestart");
      const plan = {};
      let uit;
      if (a.p_soort === "aanmaken") {
        const email = String(a.p_gegevens.email).trim().toLowerCase();
        if (![...s.mt.values()].every((g) => g.email !== email)) throw pg("MT422", "er bestaat al een gebruiker met dit e-mailadres");
        if (!["beheerder", "leerkracht", "lezer"].includes(a.p_gegevens.rol)) throw pg("MT422", "kies een rol: beheerder, leerkracht of lezer");
        Object.assign(plan, { naam: String(a.p_gegevens.naam).trim(), email, rol: a.p_gegevens.rol });
        uit = { email };
      } else {
        const g = s.mt.get(a.p_voor);
        if (!g) throw pg("MT422", "dit account bestaat niet in de MT");
        if (a.p_voor === wie) throw pg("MT422", "je eigen account wijzig je niet zelf. Vraag het aan de andere beheerder.");
        if (g.open && !s.ops.get(g.open).afgerond) throw pg("MT409", "er loopt al een wijziging aan dit account.");
        if (a.p_soort === "tijdelijk_wachtwoord" && !g.actief) throw pg("MT422", "dit account is uitgeschakeld. Schakel het eerst weer in.");
        if (a.p_soort === "inschakelen" && g.actief) throw pg("MT422", "dit account is al actief");
        if (a.p_soort === "tijdelijk_wachtwoord" || a.p_soort === "inschakelen") plan.app_wissen = a.p_gegevens.app_wissen === true;
        if (a.p_soort === "email_wijzigen") plan.email = String(a.p_gegevens.email).trim().toLowerCase();
        uit = { gebruiker: a.p_voor, email: g.email, actief: g.actief, ...plan };
        if (a.p_soort === "email_wijzigen") Object.assign(uit, { email: g.email, email_nieuw: plan.email });
        g.open = a.p_operatie;
        if (a.p_soort === "uitschakelen") g.actief = false;
      }
      s.ops.set(a.p_operatie, { soort: a.p_soort, door: wie, voor: a.p_voor, plan, afgerond: false });
      return { ...uit, operatie: a.p_operatie, soort: a.p_soort, uren: 48 };
    },
    mt_account_klaar(a, ctx) {
      eisServer(ctx);
      const op = s.ops.get(a.p_operatie);
      if (!op) throw pg("22023", "deze handeling bestaat niet");
      if (op.afgerond) throw pg("MT409", "deze handeling is al afgerond of vervangen");
      const g = op.voor ? s.mt.get(op.voor) : null;
      if (g && g.open !== a.p_operatie) throw pg("MT409", "deze handeling is vervangen door een nieuwe");
      if (!a.p_gelukt) {
        Object.assign(op, { afgerond: true, resultaat: "mislukt", melding: a.p_melding });
        const vrij = ["wachtwoord_kiezen", "email_wijzigen"].includes(op.soort);
        if (g && vrij) g.open = null;
        return { ok: false, gebruiker: op.voor, geblokkeerd: !!g && !vrij };
      }
      const tot = s.nu + 48 * 3600 * 1000;
      if (op.soort === "aanmaken") {
        const id = a.p_gegevens.gebruiker;
        const bij = s.auth.get(id);
        if (!bij || bij.email !== op.plan.email) throw pg("MT422", "het account bij Supabase klopt niet met de aanvraag");
        if (s.mt.has(id)) throw pg("MT422", "dit account of dit e-mailadres bestaat al in de MT");
        s.mt.set(id, { naam: op.plan.naam, email: op.plan.email, rol: op.plan.rol, actief: true, tijdelijk: true, tot, eerste: false, app: true, open: null });
        op.voor = id;
      } else if (op.soort === "tijdelijk_wachtwoord") Object.assign(g, { tijdelijk: true, tot, app: g.app || op.plan.app_wissen, open: null });
      else if (op.soort === "uitschakelen") Object.assign(g, { actief: false, tijdelijk: true, tot: s.nu, open: null });
      else if (op.soort === "inschakelen") Object.assign(g, { actief: true, tijdelijk: true, tot, app: g.app || op.plan.app_wissen, open: null });
      else if (op.soort === "email_wijzigen") Object.assign(g, { email: op.plan.email, open: null });
      else Object.assign(g, { tijdelijk: false, tot: null, open: null });
      Object.assign(op, { afgerond: true, resultaat: "gelukt" });
      return { ok: true, gebruiker: op.voor, tijdelijk_tot: new Date(tot).toISOString() };
    },
    mt_account_afgerond(a, ctx) {
      eisServer(ctx);
      const g = s.mt.get(a.p_gebruiker);
      if (!g) throw pg("42501", "dit account heeft geen toegang tot de MT", 403);
      if (g.tijdelijk) throw pg("MT422", "kies eerst je eigen wachtwoord");
      if (g.open) throw pg("MT409", "er loopt nog een wijziging aan dit account.");
      const al = g.eerste && !g.app;
      Object.assign(g, { eerste: true, app: false });
      return { ok: true, al_afgerond: al };
    },
  };

  s.haal = async (adres, opties) => {
    const u = new URL(adres);
    const koppen = opties.headers ?? {};
    const drager = typeof koppen.Authorization === "string" ? koppen.Authorization.replace(/^Bearer /, "") : null;
    const lichaam = opties.body ? JSON.parse(opties.body) : null;
    const oproep = { methode: opties.method, adres, pad: u.pathname + u.search, apikey: koppen.apikey ?? null, drager, lichaam };
    s.oproepen.push(oproep);
    if (s.storing) {
      const eerst = s.storing(oproep);
      if (eerst === "weg") throw new TypeError("geen netwerk");
      if (eerst) return eerst;
    }
    if (u.origin !== URL_MT) return json(404, {});
    const pad = u.pathname;
    const geheim = oproep.apikey === GEHEIM && drager === GEHEIM;

    if (pad === "/auth/v1/user" && opties.method === "GET") {
      const z = s.sessies.get(drager);
      if (oproep.apikey !== PUBLIEK || !z) return json(403, { error_code: "bad_jwt" });
      const a = s.auth.get(z.gebruiker);
      if (a.ban) return json(403, { error_code: "user_banned" });
      return json(200, { id: a.id, email: a.email });
    }
    if (pad === "/auth/v1/token" && u.searchParams.get("grant_type") === "password") {
      const a = [...s.auth.values()].find((x) => x.email === lichaam.email);
      if (oproep.apikey !== PUBLIEK || !a || a.ban || a.wachtwoord !== lichaam.password) return json(400, { error_code: "invalid_credentials" });
      const token = b64("{}") + "." + b64(JSON.stringify({ sub: a.id, aal: "aal1", amr: [{ method: "password", timestamp: 1 }] })) + "." + b64("nieuw" + s.sessies.size);
      s.sessies.set(token, { gebruiker: a.id, aal: "aal1", methodes: ["password"] });
      return json(200, { access_token: token });
    }
    if (pad === "/auth/v1/logout") {
      s.sessies.delete(drager);
      return new Response(null, { status: 204 });
    }
    if (pad.startsWith("/auth/v1/admin/")) {
      if (!geheim) return json(403, { error_code: "not_admin" });
      const delen = pad.slice("/auth/v1/admin/".length).split("/");
      if (delen[0] !== "users") return json(404, {});
      if (delen.length === 1 && opties.method === "POST") {
        if ([...s.auth.values()].some((x) => x.email === lichaam.email)) return json(422, { error_code: "email_exists" });
        if (lichaam.password.length < 12) return json(422, { error_code: "weak_password" });
        const id = ID(s.volgend++);
        s.auth.set(id, { id, email: lichaam.email, wachtwoord: lichaam.password, ban: null, bevestigd: lichaam.email_confirm === true, factoren: [] });
        return json(200, { id, email: lichaam.email });
      }
      if (delen.length === 1 && opties.method === "GET") {
        const filter = (u.searchParams.get("filter") ?? "").toLowerCase();
        return json(200, { users: [...s.auth.values()].filter((x) => x.email.includes(filter)).map((x) => ({ id: x.id, email: x.email })), aud: "authenticated" });
      }
      const a = s.auth.get(delen[1]);
      if (!a) return json(404, { error_code: "user_not_found" });
      if (delen.length === 2 && opties.method === "PUT") {
        if (lichaam.password !== undefined) {
          if (lichaam.password.length < 12) return json(422, { error_code: "weak_password" });
          a.wachtwoord = lichaam.password;
          for (const [token, z] of s.sessies) if (z.gebruiker === a.id) s.sessies.delete(token); // zoals Supabase: alle sessies weg
        }
        if (lichaam.email !== undefined) {
          if ([...s.auth.values()].some((x) => x.email === lichaam.email && x.id !== a.id)) return json(422, { error_code: "email_exists" });
          a.email = lichaam.email;
        }
        if (lichaam.email_confirm === true) a.bevestigd = true;
        if (lichaam.ban_duration !== undefined) a.ban = lichaam.ban_duration === "none" ? null : lichaam.ban_duration;
        return json(200, { id: a.id, email: a.email });
      }
      if (delen[2] === "factors" && delen.length === 3 && opties.method === "GET") return json(200, a.factoren);
      if (delen[2] === "factors" && delen.length === 4 && opties.method === "DELETE") {
        a.factoren = a.factoren.filter((f) => f.id !== delen[3]);
        return json(200, { id: delen[3] });
      }
      return json(404, {});
    }
    if (pad.startsWith("/rest/v1/rpc/") && opties.method === "POST") {
      const naam = pad.slice("/rest/v1/rpc/".length);
      const ctx = geheim ? { rol: "service_role" } : oproep.apikey === PUBLIEK && s.sessies.has(drager) ? { rol: "authenticated", sessie: s.sessies.get(drager) } : { rol: "anon" };
      if (!functies[naam]) return json(404, { code: "PGRST202" });
      try {
        return json(200, functies[naam](lichaam, ctx));
      } catch (fout) {
        if (fout.antwoord) return fout.antwoord;
        throw fout;
      }
    }
    return json(404, {});
  };

  s.behandel = maakBehandelaar({
    url: URL_MT,
    publiek: PUBLIEK,
    geheim: GEHEIM,
    haal: s.haal,
    meld: (regel) => s.logboek.push(JSON.stringify(regel)),
    wacht: () => Promise.resolve(),
    willekeurig: (aantal) => crypto.getRandomValues(new Uint8Array(aantal)),
  });

  /** Eén oproep van de pagina. Geeft { status, lichaam, koppen }. */
  s.vraag = async (token, lichaam, { oorsprong = OORSPRONG, methode = "POST" } = {}) => {
    const koppen = { "Content-Type": "application/json", apikey: PUBLIEK };
    if (token) koppen.Authorization = "Bearer " + token;
    if (oorsprong) koppen.Origin = oorsprong;
    const r = await s.behandel(new Request(URL_MT + "/functions/v1/mt-accounts", {
      method: methode,
      headers: koppen,
      body: methode === "POST" ? (typeof lichaam === "string" ? lichaam : JSON.stringify(lichaam)) : undefined,
    }));
    const tekst = await r.text();
    s.antwoorden = (s.antwoorden ?? "") + tekst;
    return { status: r.status, lichaam: tekst ? JSON.parse(tekst) : null, koppen: r.headers };
  };

  /** Nergens een geheim: niet in een antwoord, niet in het logboek, en de sleutel enkel naar het eigen project. */
  s.geenGeheimen = (...wachtwoorden) => {
    const alles = (s.antwoorden ?? "") + s.logboek.join("\n");
    assert.ok(!alles.includes(GEHEIM), "de secret key staat in een antwoord of in het logboek");
    for (const w of wachtwoorden) assert.ok(!alles.includes(w), "een gekozen wachtwoord staat in een antwoord of in het logboek");
    for (const token of s.sessies.keys()) assert.ok(!alles.includes(token), "een toegangsbewijs staat in een antwoord of in het logboek");
    for (const o of s.oproepen) {
      assert.ok(o.adres.startsWith(URL_MT + "/"), "een oproep ging naar een ander adres: " + o.adres);
      assert.ok(!o.adres.includes(GEHEIM), "de secret key staat in een adres");
      if (o.apikey === GEHEIM) assert.match(o.pad, /^\/(auth\/v1\/admin\/|rest\/v1\/rpc\/mt_account_(stand|eigen_start|klaar|afgerond)$)/, "de secret key ging mee naar " + o.pad);
    }
  };
  return s;
}

/** Een beheerder (1) en een leerkracht (2), allebei in orde, en hun sessies. */
function school() {
  const s = nep();
  s.account(1, "beheerder@voorbeeld.test", "wachtwoord-van-de-beheerder", { rol: "beheerder" }, [{ id: ID(901), factor_type: "totp", status: "verified" }]);
  s.account(2, "leerkracht@voorbeeld.test", "wachtwoord-van-de-leerkracht", {}, [{ id: ID(902), factor_type: "totp", status: "verified" }]);
  s.beheerder = s.sessie(1);
  s.leerkracht = s.sessie(2);
  return s;
}

const padenVan = (s, vanaf = 0) => s.oproepen.slice(vanaf).map((o) => o.methode + " " + o.pad.replace(/[0-9a-f-]{36}/g, ":id"));

// ---------- De instelling ----------

Deno.test("serverfunctie: elke MT in config.js heeft haar pagina, en omgekeerd", () => {
  assert.deepEqual(Object.keys(PAGINA).sort(), alleOmgevingen().map((o) => o.mt.url).sort());
  for (const [project, pagina] of Object.entries(PAGINA)) {
    assert.match(pagina, /^https:\/\/[a-z0-9.-]+$/, "de pagina is een https-adres zonder pad");
    const o = omgeving(pagina.replace(/^https:\/\//, ""));
    assert.ok(o, pagina + " is geen adres van de MT in config.js");
    assert.equal(o.mt.url, project, pagina + " hoort in config.js bij een ander project");
  }
});

Deno.test("serverfunctie: de versie die de pagina verwacht, en geen sleutel in het bestand", () => {
  const bron = lees("functies/mt-accounts/index.ts");
  // De serverfunctie houdt het nummer van de levering waarin ze laatst wijzigde: enkel dan plakt Pablo
  // ze opnieuw in Supabase. De pagina kijkt na dat in Supabase de versie staat die ze verwacht.
  assert.equal(VERSIE, ACCOUNTFUNCTIE_VERSIE, "config.js verwacht een andere versie van de serverfunctie dan in functies/ staat");
  assert.match(bron.split("\n")[0], new RegExp("versie " + VERSIE.replaceAll(".", "\\.") + "$"));
  const paginaVersie = lees("code/app.js").match(/export const VERSIE = "([0-9.]+)";/)[1];
  const cijfers = (v) => v.split(".").map(Number);
  const [a, b] = [cijfers(VERSIE), cijfers(paginaVersie)];
  assert.ok(a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] <= b[2]))), "de serverfunctie is nieuwer dan de pagina");
  assert.doesNotMatch(bron, /sb_(secret|publishable)_[A-Za-z0-9]/, "een sleutel staat in het bestand van de serverfunctie");
  assert.doesNotMatch(bron, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY/, "de serverfunctie gebruikt een oude sleutel");
  assert.doesNotMatch(bron, /\bfrom\s+["'](npm:|jsr:|https?:)/, "de serverfunctie laadt code van buitenaf");
});

Deno.test("serverfunctie: zonder sleutels of voor een onbekend project doet ze niets", async () => {
  for (const o of [{ url: URL_MT, publiek: PUBLIEK, geheim: "" }, { url: "https://anderprojectanderproj.supabase.co", publiek: PUBLIEK, geheim: GEHEIM }]) {
    let opgeroepen = 0;
    const behandel = maakBehandelaar({ ...o, haal: () => (opgeroepen++, Promise.reject(new Error("nee"))), meld: () => {}, wacht: () => Promise.resolve(), willekeurig: (n) => new Uint8Array(n) });
    const r = await behandel(new Request(URL_MT + "/functions/v1/mt-accounts", { method: "POST", body: '{"actie":"stand"}', headers: { Authorization: "Bearer a.b.c" } }));
    assert.equal(r.status, 500);
    assert.equal((await r.json()).code, "instelling");
    assert.equal(opgeroepen, 0);
  }
});

// ---------- Wie mag oproepen ----------

Deno.test("serverfunctie: enkel de pagina van de MT mag vanuit een browser oproepen", async () => {
  const s = school();
  const vooraf = await s.vraag(null, null, { methode: "OPTIONS" });
  assert.equal(vooraf.status, 204);
  assert.equal(vooraf.koppen.get("Access-Control-Allow-Origin"), OORSPRONG);
  assert.match(vooraf.koppen.get("Access-Control-Allow-Headers"), /authorization/);
  for (const methode of ["OPTIONS", "POST"]) {
    const r = await s.vraag(s.beheerder, { actie: "stand" }, { oorsprong: "https://klim-op.github.io", methode });
    assert.equal(r.status, 403, methode);
    assert.equal(r.koppen.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(s.oproepen.length, 0, "een vreemd adres bereikte Supabase");
  const zonder = await s.vraag(s.beheerder, { actie: "stand" }, { oorsprong: null });
  assert.equal(zonder.status, 200, "een oproep zonder Origin (geen browser) heeft enkel het toegangsbewijs nodig");
});

Deno.test("serverfunctie: zonder geldig toegangsbewijs gebeurt er niets", async () => {
  const s = school();
  assert.equal((await s.vraag(null, { actie: "stand" })).status, 401);
  assert.equal((await s.vraag(PUBLIEK, { actie: "stand" })).status, 401, "een sleutel is geen toegangsbewijs");
  assert.equal(s.oproepen.length, 0);
  const vals = b64("{}") + "." + b64(JSON.stringify({ sub: ID(1), aal: "aal2", amr: [{ method: "password" }, { method: "totp" }] })) + "." + b64("vals");
  const r = await s.vraag(vals, { actie: "aanmaken", operatie: OP(1), naam: "Nep", email: "nep@voorbeeld.test", rol: "beheerder" });
  assert.equal(r.status, 401);
  assert.equal(r.lichaam.code, "sessie");
  assert.deepEqual(padenVan(s), ["GET /auth/v1/user"], "na een geweigerd toegangsbewijs volgde nog een oproep");
  s.geenGeheimen();
});

Deno.test("serverfunctie: het toegangsbewijs van een ander account dan Supabase noemt, wordt geweigerd", async () => {
  const s = school();
  // Supabase zegt: dit is de leerkracht. Het bewijs zelf beweert de beheerder te zijn.
  const vals = b64("{}") + "." + b64(JSON.stringify({ sub: ID(1), aal: "aal2", amr: [{ method: "password" }, { method: "totp" }] })) + "." + b64("x");
  s.sessies.set(vals, { gebruiker: ID(2), aal: "aal2", methodes: ["password", "totp"] });
  assert.equal((await s.vraag(vals, { actie: "stand" })).status, 401);
});

Deno.test("serverfunctie: een oproep die niet klopt", async () => {
  const s = school();
  assert.equal((await s.vraag(s.beheerder, { actie: "alles_wissen" })).status, 400);
  assert.equal((await s.vraag(s.beheerder, "geen json")).status, 400);
  assert.equal((await s.vraag(s.beheerder, "[1]")).status, 400);
  assert.equal((await s.vraag(s.beheerder, { actie: "stand", vulling: "x".repeat(5000) })).status, 413);
  assert.equal((await s.vraag(s.beheerder, null, { methode: "GET" })).status, 405);
  assert.equal(s.oproepen.length, 0, "een foute oproep bereikte Supabase");
  assert.equal((await s.vraag(s.beheerder, { actie: "tijdelijk_wachtwoord", operatie: "geen-nummer", gebruiker: ID(2) })).status, 400);
  assert.equal((await s.vraag(s.beheerder, { actie: "uitschakelen", operatie: OP(1) })).status, 400);
});

Deno.test("serverfunctie: Supabase antwoordt niet", async () => {
  const s = school();
  s.storing = () => "weg";
  const r = await s.vraag(s.beheerder, { actie: "stand" });
  assert.equal(r.status, 503);
  assert.equal(r.lichaam.code, "supabase");
});

// ---------- Voor wie aanmeldt ----------

Deno.test("stand: het eigen account, met enkel een wachtwoord", async () => {
  const s = school();
  s.account(3, "nieuw@voorbeeld.test", "tijdelijk-wachtwoord", { tijdelijk: true, tot: s.nu + 3600e3, eerste: false, app: true });
  const r = await s.vraag(s.sessie(3, "aal1", ["password"]), { actie: "stand" });
  assert.equal(r.status, 200);
  assert.equal(r.lichaam.versie, VERSIE);
  assert.equal(r.lichaam.account.wachtwoord_tijdelijk, true);
  assert.equal(r.lichaam.account.tijdelijk_verlopen, false);
  assert.equal(r.lichaam.instellingen.wachtwoord_min_lengte, 12);
  assert.deepEqual(s.oproepen.at(-1).lichaam, { p_gebruiker: ID(3) }, "de stand van een ander account werd gevraagd");
  s.account(4, "enkelsupabase@voorbeeld.test", "een-wachtwoord-zonder-mt");
  const onbekend = await s.vraag(s.sessie(4, "aal1", ["password"]), { actie: "stand" });
  assert.equal(onbekend.lichaam.bekend, false);
  assert.equal(onbekend.lichaam.account, null);
  s.geenGeheimen();
});

Deno.test("eigen wachtwoord: gekozen, alle sessies weg, en nergens bewaard of gelogd", async () => {
  const s = school();
  s.account(3, "nieuw@voorbeeld.test", "tijdelijk-wachtwoord", { tijdelijk: true, tot: s.nu + 3600e3, eerste: false, app: true });
  const token = s.sessie(3, "aal1", ["password"]);
  const r = await s.vraag(token, { actie: "wachtwoord_kiezen", operatie: OP(1), wachtwoord: "mijn eigen lange zin 7" });
  assert.equal(r.status, 200, JSON.stringify(r.lichaam));
  assert.deepEqual(r.lichaam, { ok: true, opnieuw_aanmelden: true });
  assert.equal(s.auth.get(ID(3)).wachtwoord, "mijn eigen lange zin 7");
  assert.equal(s.sessies.has(token), false, "de oude sessie leeft nog");
  assert.deepEqual({ ...s.mt.get(ID(3)) }, { naam: "Proef 3", email: "nieuw@voorbeeld.test", rol: "leerkracht", actief: true, tijdelijk: false, tot: null, eerste: false, app: true, open: null });
  assert.deepEqual(padenVan(s), [
    "GET /auth/v1/user",
    "POST /rest/v1/rpc/mt_account_stand",
    "POST /rest/v1/rpc/mt_account_eigen_start",
    "POST /auth/v1/token?grant_type=password",
    "PUT /auth/v1/admin/users/:id",
    "POST /rest/v1/rpc/mt_account_klaar",
  ]);
  assert.equal(s.oproepen[3].drager, null, "de sleutel ging mee als Bearer");
  assert.equal(s.oproepen[4].pad, "/auth/v1/admin/users/" + ID(3), "het wachtwoord van een ander account werd gewijzigd");
  s.geenGeheimen("mijn eigen lange zin 7", "tijdelijk-wachtwoord");
});

Deno.test("eigen wachtwoord: niet het tijdelijke, niet te kort, niet te lang, niet uit een maillink", async () => {
  const s = school();
  s.account(3, "nieuw@voorbeeld.test", "tijdelijk-wachtwoord", { tijdelijk: true, tot: s.nu + 3600e3, eerste: false, app: true });
  const token = s.sessie(3, "aal1", ["password"]);
  const kort = await s.vraag(token, { actie: "wachtwoord_kiezen", operatie: OP(1), wachtwoord: "elfteken123" });
  assert.equal(kort.status, 422);
  assert.match(kort.lichaam.melding, /minstens 12 tekens/);
  const lang = await s.vraag(token, { actie: "wachtwoord_kiezen", operatie: OP(1), wachtwoord: "é".repeat(40) });
  assert.match(lang.lichaam.melding, /te lang/);
  const spatie = await s.vraag(token, { actie: "wachtwoord_kiezen", operatie: OP(1), wachtwoord: " een wachtwoord met spatie " });
  assert.match(spatie.lichaam.melding, /spatie/);
  assert.equal(s.ops.size, 0, "een wachtwoord dat niet kan, startte toch een handeling");

  const zelfde = await s.vraag(token, { actie: "wachtwoord_kiezen", operatie: OP(2), wachtwoord: "tijdelijk-wachtwoord" });
  assert.equal(zelfde.status, 422);
  assert.match(zelfde.lichaam.melding, /ander wachtwoord dan je tijdelijke/);
  assert.equal(s.ops.get(OP(2)).resultaat, "mislukt");
  assert.equal(s.mt.get(ID(3)).open, null, "het account bleef geblokkeerd");
  assert.equal(s.mt.get(ID(3)).tijdelijk, true);
  assert.equal(s.sessies.size, 3, "de sessie van de controle bleef bestaan");
  assert.ok(s.sessies.has(token), "de eigen sessie verdween");

  const link = await s.vraag(s.sessie(3, "aal1", ["recovery"]), { actie: "wachtwoord_kiezen", operatie: OP(3), wachtwoord: "een heel ander wachtwoord" });
  assert.equal(link.status, 403);
  assert.equal(s.auth.get(ID(3)).wachtwoord, "tijdelijk-wachtwoord");
  s.geenGeheimen("een heel ander wachtwoord", "é".repeat(40));
});

Deno.test("eigen wachtwoord: de termijn en de staat van het account beslist de databank", async () => {
  const s = school();
  s.account(3, "laat@voorbeeld.test", "tijdelijk-wachtwoord", { tijdelijk: true, tot: s.nu - 1000, eerste: false, app: true });
  const laat = await s.vraag(s.sessie(3, "aal1", ["password"]), { actie: "wachtwoord_kiezen", operatie: OP(1), wachtwoord: "een heel ander wachtwoord" });
  assert.equal(laat.status, 422);
  assert.match(laat.lichaam.melding, /verlopen/);
  const gewoon = await s.vraag(s.leerkracht, { actie: "wachtwoord_kiezen", operatie: OP(2), wachtwoord: "een heel ander wachtwoord" });
  assert.equal(gewoon.status, 422, "wie geen tijdelijk wachtwoord heeft, kiest hier geen nieuw");
  assert.equal(s.auth.get(ID(2)).wachtwoord, "wachtwoord-van-de-leerkracht");
  assert.equal(s.auth.get(ID(3)).wachtwoord, "tijdelijk-wachtwoord");
  assert.ok(!padenVan(s).some((p) => p.startsWith("PUT ")), "er werd toch een wachtwoord gewijzigd");
});

Deno.test("eigen wachtwoord: weigert Supabase, dan komt het account weer vrij", async () => {
  const s = school();
  s.account(3, "nieuw@voorbeeld.test", "tijdelijk-wachtwoord", { tijdelijk: true, tot: s.nu + 3600e3, eerste: false, app: true });
  s.storing = (o) => o.methode === "PUT" ? new Response('{"error_code":"weak_password"}', { status: 422 }) : null;
  const zwak = await s.vraag(s.sessie(3, "aal1", ["password"]), { actie: "wachtwoord_kiezen", operatie: OP(1), wachtwoord: "wachtwoord1234" });
  assert.equal(zwak.status, 422);
  assert.match(zwak.lichaam.melding, /te zwak/);
  assert.equal(zwak.lichaam.geblokkeerd, false);
  assert.equal(s.mt.get(ID(3)).open, null);
  assert.equal(s.ops.get(OP(1)).melding, "Supabase weigerde (422, weak_password).");
  s.geenGeheimen("wachtwoord1234");
});

Deno.test("afronden: enkel met de code, en enkel als de app bij Supabase echt gekoppeld is", async () => {
  const s = school();
  s.account(3, "nieuw@voorbeeld.test", "mijn eigen lange zin 7", { eerste: false, app: true }, [{ id: ID(903), factor_type: "totp", status: "unverified" }]);
  assert.equal((await s.vraag(s.sessie(3, "aal1", ["password"]), { actie: "afronden" })).status, 403);
  assert.equal((await s.vraag(s.sessie(3, "aal2", ["recovery", "totp"]), { actie: "afronden" })).status, 403, "een maillink met een code telt niet");
  const token = s.sessie(3);
  const nietGekoppeld = await s.vraag(token, { actie: "afronden" });
  assert.equal(nietGekoppeld.status, 422);
  assert.equal(s.mt.get(ID(3)).eerste, false);
  s.auth.get(ID(3)).factoren[0].status = "verified";
  const r = await s.vraag(token, { actie: "afronden" });
  assert.deepEqual(r.lichaam, { ok: true, al_afgerond: false });
  assert.deepEqual([s.mt.get(ID(3)).eerste, s.mt.get(ID(3)).app], [true, false]);
  assert.equal(s.oproepen.at(-2).pad, "/auth/v1/admin/users/" + ID(3) + "/factors", "de koppeling van een ander account werd nagekeken");
  assert.deepEqual((await s.vraag(token, { actie: "afronden" })).lichaam, { ok: true, al_afgerond: true });
  s.geenGeheimen();
});

// ---------- Voor een beheerder ----------

Deno.test("aanmaken: de databank beslist of het mag, met het toegangsbewijs van de beheerder zelf", async () => {
  const s = school();
  const nee = await s.vraag(s.leerkracht, { actie: "aanmaken", operatie: OP(1), naam: "Nep", email: "nep@voorbeeld.test", rol: "beheerder" });
  assert.equal(nee.status, 403);
  assert.equal(nee.lichaam.code, "rechten");
  assert.deepEqual(padenVan(s), ["GET /auth/v1/user", "POST /rest/v1/rpc/mt_account_start"], "na de weigering volgde nog een oproep");
  assert.equal(s.oproepen[1].apikey, PUBLIEK, "de start liep met de secret key");
  assert.equal(s.oproepen[1].drager, s.leerkracht, "de start liep niet met het toegangsbewijs van wie het vroeg");
  const zonderCode = await s.vraag(s.sessie(1, "aal1", ["password"]), { actie: "aanmaken", operatie: OP(2), naam: "Nep", email: "nep@voorbeeld.test", rol: "lezer" });
  assert.equal(zonderCode.status, 403, "een beheerder zonder code");
  assert.equal(s.auth.size, 2, "er kwam toch een account bij Supabase");
  s.geenGeheimen();
});

Deno.test("aanmaken: een account met een tijdelijk wachtwoord, dat één keer teruggegeven wordt", async () => {
  const s = school();
  const r = await s.vraag(s.beheerder, { actie: "aanmaken", operatie: OP(1), naam: " Lien Proef ", email: " Lien.Proef@Voorbeeld.test ", rol: "leerkracht" });
  assert.equal(r.status, 200, JSON.stringify(r.lichaam));
  assert.match(r.lichaam.wachtwoord, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
  assert.equal(r.lichaam.email, "lien.proef@voorbeeld.test");
  assert.equal(r.lichaam.uren, 48);
  const bij = s.auth.get(r.lichaam.gebruiker);
  assert.deepEqual([bij.email, bij.wachtwoord, bij.bevestigd], ["lien.proef@voorbeeld.test", r.lichaam.wachtwoord, true]);
  assert.deepEqual({ ...s.mt.get(r.lichaam.gebruiker) }, { naam: "Lien Proef", email: "lien.proef@voorbeeld.test", rol: "leerkracht", actief: true, tijdelijk: true, tot: s.nu + 48 * 3600e3, eerste: false, app: true, open: null });
  assert.deepEqual(padenVan(s), ["GET /auth/v1/user", "POST /rest/v1/rpc/mt_account_start", "POST /auth/v1/admin/users", "POST /rest/v1/rpc/mt_account_klaar"]);
  assert.ok(!s.logboek.join("").includes(r.lichaam.wachtwoord), "het tijdelijke wachtwoord staat in het logboek van de functie");
  const dubbel = await s.vraag(s.beheerder, { actie: "aanmaken", operatie: OP(2), naam: "Lien Twee", email: "lien.proef@voorbeeld.test", rol: "lezer" });
  assert.equal(dubbel.status, 422);
  assert.match(dubbel.lichaam.melding, /bestaat al/);
  assert.equal(s.auth.size, 3);
  const zelfdeNummer = await s.vraag(s.beheerder, { actie: "aanmaken", operatie: OP(1), naam: "Nog Eens", email: "nogeens@voorbeeld.test", rol: "lezer" });
  assert.equal(zelfdeNummer.status, 409, "hetzelfde operatienummer maakte een tweede account");
  s.geenGeheimen();
});

Deno.test("aanmaken: een account dat al bij Supabase bestond, krijgt een nieuw wachtwoord en verliest zijn koppelingen", async () => {
  const s = school();
  s.account(7, "strandde@voorbeeld.test", "oud-wachtwoord-van-toen", null, [{ id: ID(907), factor_type: "totp", status: "verified" }]);
  s.auth.get(ID(7)).ban = "876000h";
  const oud = s.sessie(7);
  const r = await s.vraag(s.beheerder, { actie: "aanmaken", operatie: OP(1), naam: "Proef Strandde", email: "strandde@voorbeeld.test", rol: "lezer" });
  assert.equal(r.status, 200, JSON.stringify(r.lichaam));
  assert.equal(r.lichaam.gebruiker, ID(7));
  const bij = s.auth.get(ID(7));
  assert.deepEqual([bij.wachtwoord, bij.ban, bij.factoren.length], [r.lichaam.wachtwoord, null, 0]);
  assert.equal(s.sessies.has(oud), false);
  assert.equal(s.mt.get(ID(7)).rol, "lezer");
  // Hoort het account al bij een gebruiker van de MT, dan weigert de databank bij de start.
  const bestaand = await s.vraag(s.beheerder, { actie: "aanmaken", operatie: OP(2), naam: "Kaper", email: "leerkracht@voorbeeld.test", rol: "beheerder" });
  assert.equal(bestaand.status, 422);
  assert.equal(s.auth.get(ID(2)).wachtwoord, "wachtwoord-van-de-leerkracht");
});

Deno.test("aanmaken: lukt het bij Supabase niet, dan is er geen gebruiker en staat de mislukking in het register", async () => {
  const s = school();
  s.storing = (o) => o.pad === "/auth/v1/admin/users" ? "weg" : null;
  const r = await s.vraag(s.beheerder, { actie: "aanmaken", operatie: OP(1), naam: "Proef Weg", email: "weg@voorbeeld.test", rol: "lezer" });
  assert.equal(r.status, 503);
  assert.equal(r.lichaam.geblokkeerd, false);
  assert.deepEqual([s.ops.get(OP(1)).resultaat, s.ops.get(OP(1)).melding], ["mislukt", "Supabase gaf geen antwoord."]);
  assert.equal(s.mt.size, 2);
});

Deno.test("tijdelijk wachtwoord: eerst blokkeren, dan het wachtwoord, dan pas vrijgeven", async () => {
  const s = school();
  const oud = s.leerkracht;
  let geblokkeerdTijdensSupabase = null;
  s.storing = (o) => {
    if (o.methode === "PUT") geblokkeerdTijdensSupabase = s.mt.get(ID(2)).open === OP(1);
    return null;
  };
  const r = await s.vraag(s.beheerder, { actie: "tijdelijk_wachtwoord", operatie: OP(1), gebruiker: ID(2) });
  assert.equal(r.status, 200, JSON.stringify(r.lichaam));
  assert.equal(geblokkeerdTijdensSupabase, true, "het account was niet geblokkeerd toen het wachtwoord wijzigde");
  assert.equal(s.auth.get(ID(2)).wachtwoord, r.lichaam.wachtwoord);
  assert.equal(s.sessies.has(oud), false, "de sessie van de leerkracht leeft nog");
  assert.deepEqual([s.mt.get(ID(2)).tijdelijk, s.mt.get(ID(2)).app, s.mt.get(ID(2)).open], [true, false, null]);
  assert.equal(s.auth.get(ID(2)).factoren.length, 1, "de app-koppeling verdween zonder dat het gevraagd was");
  assert.equal(r.lichaam.app_gewist, false);
  assert.deepEqual(padenVan(s), ["GET /auth/v1/user", "POST /rest/v1/rpc/mt_account_start", "PUT /auth/v1/admin/users/:id", "POST /rest/v1/rpc/mt_account_klaar"]);
  assert.deepEqual(Object.keys(s.oproepen[2].lichaam), ["password"]);
  s.geenGeheimen();
});

Deno.test("tijdelijk wachtwoord met de app opnieuw: de koppelingen zijn weg, en de MT weet het", async () => {
  const s = school();
  s.auth.get(ID(2)).factoren.push({ id: ID(912), factor_type: "totp", status: "unverified" });
  const r = await s.vraag(s.beheerder, { actie: "tijdelijk_wachtwoord", operatie: OP(1), gebruiker: ID(2), app_wissen: true });
  assert.equal(r.status, 200, JSON.stringify(r.lichaam));
  assert.equal(r.lichaam.app_gewist, true);
  assert.equal(s.auth.get(ID(2)).factoren.length, 0);
  assert.deepEqual([s.mt.get(ID(2)).tijdelijk, s.mt.get(ID(2)).app], [true, true]);
  const volgorde = padenVan(s);
  assert.ok(volgorde.indexOf("PUT /auth/v1/admin/users/:id") < volgorde.indexOf("GET /auth/v1/admin/users/:id/factors"), "eerst het wachtwoord (de sessies), dan de koppelingen");
});

Deno.test("tijdelijk wachtwoord: niet voor het eigen account, en enkel voor een beheerder", async () => {
  const s = school();
  const zelf = await s.vraag(s.beheerder, { actie: "tijdelijk_wachtwoord", operatie: OP(1), gebruiker: ID(1) });
  assert.equal(zelf.status, 422);
  assert.match(zelf.lichaam.melding, /eigen account/);
  const nee = await s.vraag(s.leerkracht, { actie: "tijdelijk_wachtwoord", operatie: OP(2), gebruiker: ID(1), app_wissen: true });
  assert.equal(nee.status, 403);
  assert.equal(s.auth.get(ID(1)).wachtwoord, "wachtwoord-van-de-beheerder");
  assert.equal(s.auth.get(ID(1)).factoren.length, 1);
  assert.ok(!padenVan(s).some((p) => p.includes("/admin/")), "een beheerroute van Supabase werd toch opgeroepen");
});

Deno.test("tijdelijk wachtwoord: mislukt het bij Supabase, dan blijft het account geblokkeerd tot de beheerder het herhaalt", async () => {
  const s = school();
  s.storing = (o) => o.methode === "PUT" ? new Response('{"error_code":"unexpected_failure"}', { status: 500 }) : null;
  const r = await s.vraag(s.beheerder, { actie: "tijdelijk_wachtwoord", operatie: OP(1), gebruiker: ID(2) });
  assert.equal(r.status, 502);
  assert.equal(r.lichaam.geblokkeerd, true);
  assert.equal(r.lichaam.wachtwoord, undefined);
  assert.equal(s.mt.get(ID(2)).open, OP(1));
  assert.equal(s.ops.get(OP(1)).resultaat, "mislukt");
  s.storing = null;
  const opnieuw = await s.vraag(s.beheerder, { actie: "tijdelijk_wachtwoord", operatie: OP(2), gebruiker: ID(2) });
  assert.equal(opnieuw.status, 200);
  assert.equal(s.mt.get(ID(2)).open, null);
});

Deno.test("tijdelijk wachtwoord: de koppeling niet volledig gewist is mislukt, en blokkeert", async () => {
  const s = school();
  s.storing = (o) => o.methode === "DELETE" ? new Response("{}", { status: 500 }) : null;
  const r = await s.vraag(s.beheerder, { actie: "tijdelijk_wachtwoord", operatie: OP(1), gebruiker: ID(2), app_wissen: true });
  assert.equal(r.status, 502);
  assert.equal(r.lichaam.geblokkeerd, true);
  assert.equal(s.mt.get(ID(2)).app, false, "de MT denkt dat de app opnieuw te koppelen is, maar de koppeling bestaat nog");
  assert.equal(s.mt.get(ID(2)).open, OP(1));
});

Deno.test("het einde van een handeling: bij een storing van de databank nog twee keer", async () => {
  const s = school();
  let keer = 0;
  s.storing = (o) => o.pad === "/rest/v1/rpc/mt_account_klaar" && ++keer < 3 ? new Response("{}", { status: 503 }) : null;
  const r = await s.vraag(s.beheerder, { actie: "tijdelijk_wachtwoord", operatie: OP(1), gebruiker: ID(2) });
  assert.equal(r.status, 200, JSON.stringify(r.lichaam));
  assert.equal(keer, 3);
  assert.equal(s.mt.get(ID(2)).open, null);
  // Blijft de databank weg, dan meldt de functie het, zonder het wachtwoord: het account blijft geblokkeerd.
  s.storing = (o) => o.pad === "/rest/v1/rpc/mt_account_klaar" ? "weg" : null;
  const weg = await s.vraag(s.beheerder, { actie: "tijdelijk_wachtwoord", operatie: OP(2), gebruiker: ID(2) });
  assert.equal(weg.status, 503);
  assert.equal(weg.lichaam.wachtwoord, undefined);
  assert.equal(s.mt.get(ID(2)).open, OP(2));
});

Deno.test("uitschakelen: meteen uit in de MT, dan de ban en een wachtwoord dat niemand kent", async () => {
  const s = school();
  const oud = s.leerkracht;
  let uitTijdensSupabase = null;
  s.storing = (o) => {
    if (o.methode === "PUT") uitTijdensSupabase = s.mt.get(ID(2)).actief === false;
    return null;
  };
  const r = await s.vraag(s.beheerder, { actie: "uitschakelen", operatie: OP(1), gebruiker: ID(2) });
  assert.equal(r.status, 200, JSON.stringify(r.lichaam));
  assert.equal(uitTijdensSupabase, true);
  assert.deepEqual(r.lichaam, { ok: true, gebruiker: ID(2) });
  const bij = s.auth.get(ID(2));
  assert.equal(bij.ban, "876000h");
  assert.ok(bij.wachtwoord.length >= 40 && bij.wachtwoord !== "wachtwoord-van-de-leerkracht");
  assert.equal(s.sessies.has(oud), false);
  assert.deepEqual([s.mt.get(ID(2)).actief, s.mt.get(ID(2)).open], [false, null]);
  s.geenGeheimen(bij.wachtwoord);

  const weerAan = await s.vraag(s.beheerder, { actie: "inschakelen", operatie: OP(2), gebruiker: ID(2) });
  assert.equal(weerAan.status, 200, JSON.stringify(weerAan.lichaam));
  assert.deepEqual([s.auth.get(ID(2)).ban, s.auth.get(ID(2)).wachtwoord], [null, weerAan.lichaam.wachtwoord]);
  assert.deepEqual([s.mt.get(ID(2)).actief, s.mt.get(ID(2)).tijdelijk], [true, true]);
  assert.equal((await s.vraag(s.beheerder, { actie: "inschakelen", operatie: OP(3), gebruiker: ID(2) })).status, 422, "een actief account inschakelen");
});

Deno.test("een ander e-mailadres: bij Supabase en in de MT, of geen van beide", async () => {
  const s = school();
  const r = await s.vraag(s.beheerder, { actie: "email_wijzigen", operatie: OP(1), gebruiker: ID(2), email: " Nieuw.Adres@voorbeeld.test " });
  assert.equal(r.status, 200, JSON.stringify(r.lichaam));
  assert.deepEqual([s.auth.get(ID(2)).email, s.mt.get(ID(2)).email], ["nieuw.adres@voorbeeld.test", "nieuw.adres@voorbeeld.test"]);
  s.account(8, "bezet@voorbeeld.test", "een-wachtwoord-zonder-mt");
  const bezet = await s.vraag(s.beheerder, { actie: "email_wijzigen", operatie: OP(2), gebruiker: ID(2), email: "bezet@voorbeeld.test" });
  assert.equal(bezet.status, 422);
  assert.equal(bezet.lichaam.geblokkeerd, false);
  assert.deepEqual([s.mt.get(ID(2)).email, s.mt.get(ID(2)).open], ["nieuw.adres@voorbeeld.test", null]);
  s.geenGeheimen();
});

Deno.test("een tijdelijk wachtwoord: zestien tekens in vier groepjes, zonder tekens die op elkaar lijken, elk teken even vaak", () => {
  let nr = 0;
  const behandel = maakBehandelaar({ url: URL_MT, publiek: PUBLIEK, geheim: GEHEIM, haal: () => Promise.reject(new Error("nee")), meld: () => {}, wacht: () => Promise.resolve(), willekeurig: (n) => Uint8Array.from({ length: n }, () => nr++ % 256) });
  assert.equal(typeof behandel, "function");
  const bron = lees("functies/mt-accounts/index.ts");
  const tekens = bron.match(/const TEKENS = "([^"]+)";/)[1];
  assert.equal(tekens.length, 31);
  assert.doesNotMatch(tekens, /[01ilo]/, "een teken dat op een ander lijkt");
  assert.equal(new Set(tekens).size, 31);
  assert.match(bron, /byte < 248/, "zonder deze grens komen de eerste tekens vaker voor");
});
