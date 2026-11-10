// MT · .github/keepalive.js
// Roept de pingfunctie op van elk project in config.js (17.9). Drie pogingen per project.
// Enkel de publishable key, enkel als apikey: nooit een secret key in een workflow.

import { alleOmgevingen } from "../code/config.js";

const POGINGEN = 3;
const PAUZE = 30_000;

async function ping(project) {
  const antwoord = await fetch(project.url + "/rest/v1/rpc/mt_ping", {
    headers: { apikey: project.sleutel, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const tekst = await antwoord.text();
  if (!antwoord.ok || tekst.trim() !== "true") throw new Error("antwoord " + antwoord.status + ": " + tekst.slice(0, 120));
}

let mislukt = 0;
for (const omgeving of alleOmgevingen()) {
  for (let poging = 1; poging <= POGINGEN; poging++) {
    try {
      await ping(omgeving.mt);
      console.log(omgeving.label + ": OK");
      break;
    } catch (fout) {
      console.log(omgeving.label + ", poging " + poging + ": " + fout.message);
      if (poging === POGINGEN) mislukt++;
      else await new Promise((klaar) => setTimeout(klaar, PAUZE));
    }
  }
}
if (mislukt) Deno.exit(1);
