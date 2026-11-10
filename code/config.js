// MT · config.js · versie 0.2.0
// De adressen en sleutels per omgeving (17.1). De omgeving, test of productie, volgt uit het adres
// van de pagina; een onbekend adres start niet.
//
// Enkel publishable keys: die zijn openbaar, want ze staan in de paginabron, en gaan enkel als
// apikey mee (design system 1.13). Nooit een secret key (sb_secret_…) of een oude sleutel (eyJ…)
// in dit bestand of elders in de repository: een test bewaakt dat.

export const VERSIE = "0.2.0";

/** De MT per adres van de pagina. De productie komt erbij bij de livegang. */
const OMGEVINGEN = Object.freeze({
  "klimop-mt-test.github.io": Object.freeze({
    naam: "test",
    label: "Testversie",
    mt: Object.freeze({
      url: "https://ayszixqnuktogzjtreyy.supabase.co",
      sleutel: "sb_publishable_7Qn6D-ZAtf4AuVg3TOGLbQ_-lC0jKkB",
    }),
  }),
});

/** De uitstappentool (project klimop-software): enkel lezen, via adapter.js, vanaf stap 3 (B14, T1). */
export const UITSTAPPENTOOL = Object.freeze({
  url: "https://vmvxawjfryaijkhhnnyr.supabase.co",
  sleutel: "sb_publishable_Xg0ezCxtbHfReSOcigRXvw_j5fwRjqg",
});

/** De omgeving voor een adres (location.hostname), of null als het adres onbekend is. */
export function omgeving(host) {
  return Object.prototype.hasOwnProperty.call(OMGEVINGEN, host) ? OMGEVINGEN[host] : null;
}

/** Alle omgevingen: voor de keep-alive en de tests. */
export function alleOmgevingen() {
  return Object.values(OMGEVINGEN);
}
