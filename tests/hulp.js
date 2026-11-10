// MT · tests/hulp.js
// Bestanden van de repository lezen, voor de automatische tests (17.1, 17.12).

export const MAP = new URL("../", import.meta.url);

/** De inhoud van een bestand, als tekst. */
export function lees(pad) {
  return Deno.readTextFileSync(new URL(pad, MAP));
}

/** Bestaat het bestand? */
export function bestaat(pad) {
  try {
    return Deno.statSync(new URL(pad, MAP)).isFile;
  } catch {
    return false;
  }
}

/** De map met de modules van de pagina, en de map met de opmaak (B206). */
export const CODE = "code/";
export const OPMAAK = "opmaak/";

/** De modules van de pagina: alle .js-bestanden in code/, met hun pad. */
export function paginaModules() {
  const paden = [];
  for (const item of Deno.readDirSync(new URL(CODE, MAP))) {
    if (item.isFile && item.name.endsWith(".js")) paden.push(CODE + item.name);
  }
  return paden.sort();
}

/** De naam zonder map: code/app.js wordt app.js. */
export function naamVan(pad) {
  return pad.slice(pad.lastIndexOf("/") + 1);
}

/** Alle tekstbestanden van de repository, met hun pad, zonder .git en zonder beelden of lettertypes. */
export function alleTekstbestanden() {
  const uit = [];
  const binair = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|zip|pdf)$/i;
  const loop = (map, pad) => {
    for (const item of Deno.readDirSync(map)) {
      if (item.name === ".git") continue;
      const hier = pad + item.name;
      if (item.isDirectory) loop(new URL(item.name + "/", map), hier + "/");
      else if (item.isFile && !binair.test(item.name)) uit.push(hier);
    }
  };
  loop(MAP, "");
  return uit.sort();
}

/** De SQL-scripts, op volgorde. */
export function sqlScripts() {
  const namen = [];
  try {
    for (const item of Deno.readDirSync(new URL("sql/", MAP))) {
      if (item.isFile && item.name.endsWith(".sql")) namen.push("sql/" + item.name);
    }
  } catch {
    // nog geen map sql
  }
  return namen.sort();
}

/** SQL zonder commentaar en zonder do-blokken, om de definities te ontleden. */
export function sqlZonderCommentaar(tekst) {
  return tekst
    .replace(/--[^\n]*/g, "")
    .replace(/\bdo\s+\$\$[\s\S]*?\$\$\s*;/gi, "");
}
