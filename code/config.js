// MT · config.js · versie 0.9.0
// De adressen en sleutels per omgeving (17.1). De omgeving, test of productie, volgt uit het adres
// van de pagina; een onbekend adres start niet.
//
// Enkel publishable keys: die zijn openbaar, want ze staan in de paginabron, en gaan enkel als
// apikey mee (design system 1.13). Nooit een secret key (sb_secret_…) of een oude sleutel (eyJ…)
// in dit bestand of elders in de repository: een test bewaakt dat.

export const VERSIE = "0.9.0";

/** De MT per adres van de pagina. De productie komt erbij bij de livegang. */
const OMGEVINGEN = Object.freeze({
  "klimop-mt-test.github.io": Object.freeze({
    naam: "test",
    label: "Testversie",
    /** Zo heet de MT in de authenticator-app. Per omgeving anders: test en productie staan er naast elkaar. */
    app: "Klim-Op MT test",
    mt: Object.freeze({
      url: "https://ayszixqnuktogzjtreyy.supabase.co",
      sleutel: "sb_publishable_7Qn6D-ZAtf4AuVg3TOGLbQ_-lC0jKkB",
    }),
  }),
});

/**
 * De uitstappentool (project klimop-software): enkel lezen, via adapter.js (B14, T1). Sinds 0.8.0 leest
 * enkel de serverfunctie mt-uitstappen ze (B212): de pagina toont wat die functie las, en maakt zelf geen
 * verbinding met dat project (review 2). Dit adres staat hier als de ene plaats waar het vastligt: een
 * test gaat na dat de serverfunctie precies dit project leest, met deze sleutel.
 */
export const UITSTAPPENTOOL = Object.freeze({
  url: "https://vmvxawjfryaijkhhnnyr.supabase.co",
  sleutel: "sb_publishable_Xg0ezCxtbHfReSOcigRXvw_j5fwRjqg",
});

/** De serverfunctie voor de accounts (functies/mt-accounts): de naam waaronder ze in Supabase staat (17.4). */
export const ACCOUNTFUNCTIE = "mt-accounts";

/**
 * De versie van de serverfunctie die deze versie van de MT verwacht. De serverfunctie houdt het nummer
 * van de levering waarin ze laatst wijzigde: enkel dan plakt Pablo ze opnieuw in Supabase. Staat er in
 * Supabase een andere versie, dan zegt de MT dat.
 */
export const ACCOUNTFUNCTIE_VERSIE = "0.8.0";

/** De serverfunctie voor de uitstappen (functies/mt-uitstappen): ze leest de uitstappentool en werkt de MT bij (17.4, B212). */
export const UITSTAPFUNCTIE = "mt-uitstappen";

/** De versie van die serverfunctie die deze versie van de MT verwacht, zoals bij de accounts. */
export const UITSTAPFUNCTIE_VERSIE = "0.8.0";

/** Het domein van de e-mailadressen van de school. Een ander adres mag, maar de MT vraagt het eerst na. */
export const SCHOOLDOMEIN = "klimopvilvoorde.be";

/** Het voorbeeld in het veld E-mailadres van het aanmeldscherm. */
export const MAILVOORBEELD = "voornaam.familienaam@" + SCHOOLDOMEIN;

/** De omgeving voor een adres (location.hostname), of null als het adres onbekend is. */
export function omgeving(host) {
  return Object.prototype.hasOwnProperty.call(OMGEVINGEN, host) ? OMGEVINGEN[host] : null;
}

/** Alle omgevingen: voor de keep-alive en de tests. */
export function alleOmgevingen() {
  return Object.values(OMGEVINGEN);
}
