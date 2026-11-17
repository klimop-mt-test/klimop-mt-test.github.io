# klimop-mt-test.github.io

Testversie van de MT, de maximumfactuur-tool van GO! basisschool Klim-Op. Enkel code: nooit leerlinggegevens, nooit echte namen, en geen geheime sleutels. Test en productie krijgen dezelfde bestanden.

## Opbouw

| Map of bestand | Inhoud |
|---|---|
| `index.html` | de pagina |
| `code/` | de werking, één bestand per taak: `app.js` de start, `config.js` de adressen, `ui.js` alles op het scherm, `data.js` de databank, `auth.js` de aanmelding, `aanmelden.js` het aanmeldscherm, `gebruikers.js` het scherm Gebruikers, `rekenen.js` het rekencontract, `adapter.js` het lezen van de uitstappentool, `rekentest.js` de testgevallen van het rekencontract en `uitstappentool.js` wat de startpagina daarvan toont. In `code/lib/` staat supabase-js 2.116.0, het officiële bestand uit het npm-pakket, ongewijzigd, met zijn licentie |
| `functies/` | de twee serverfuncties, elk één bestand dat je in Supabase plakt bij Edge Functions: `mt-accounts` voor de accounts, en `mt-uitstappen`, die de uitstappentool leest en de MT bijwerkt. De sleutel die ze gebruiken, geeft Supabase hun zelf: hij staat nergens in deze repository. In `mt-uitstappen` staat de tekst van `code/adapter.js` woord voor woord; een test bewaakt dat |
| `opmaak/` | de huisstijl (`mt.css`), het logo, en het lettertype Outfit met zijn licentie |
| `sql/` | de scripts voor Supabase, op volgorde: elk script voer je één keer uit in de SQL Editor, het volgende pas na het vorige |
| `tests/` | de automatische tests; `tests/databank/` bootst Supabase na en bevat de proef op de databank en de lijst van bewust ingebouwde fouten, met enkel verzonnen gegevens. De databanktest speelt ook een wedloop na, twee verbindingen tegelijk, stuurt wat de echte `adapter.js` klaarzet door de echte databankfunctie, en laat hele verzoeken door de echte serverfunctie `mt-uitstappen` lopen, met de echte databank erachter. Zie verder "De tests" hieronder |
| `.github/` | de tests, de keep-alive en de wekelijkse vergelijking met de uitstappentool, in GitHub Actions. Namen met een punt gaan niet mee met een upload: je maakt of wijzigt ze met de hand |

## De tests

Bij elke upload draait GitHub de gewone tests, in de tijd van UTC en in die van Brussel, en de databanktest. De uitkomst staat als vinkje of kruisje bij de upload. Wie de tests zelf wil draaien, heeft [Deno](https://deno.com) nodig, en voor de databanktest ook PostgreSQL; alles vertrekt vanuit de hoofdmap van de repository.

| Wat | Opdracht |
|---|---|
| de gewone tests | `deno test --allow-read --no-prompt tests/` |
| de databanktest: de SQL-scripts op een nagebootste Supabase, de proef per rol, de wedloop, de serverfunctie tegen de echte databank, en elke bewust ingebouwde fout in de scripts | `MT_DATABANK=1 deno test --allow-read --allow-write --allow-env --allow-run --no-prompt tests/databank_test.js` |
| de bewust ingebouwde fouten in de code (`tests/codefouten.js`): vindt een test over het gedrag ze? | `MT_CODEFOUTEN=1 deno test --allow-read --allow-write --allow-env --allow-run --no-prompt tests/codefouten_test.js` |
| de pagina in een echte Chromium, op 1366, 768 en 390 pixels breed, met schermafbeeldingen | `deno run --allow-all tests/browser/naspelen.js <map voor de schermafbeeldingen>` |

De laatste twee draaien niet bij een upload: ze duren enkele minuten, en de laatste haalt een browser op van npm. Ze horen bij elke levering, en een reviewer kan ze zo herhalen. De gewone tests gaan bij elke upload wel na dat de lijst van ingebouwde fouten nog bij de code past. `tests/nabootsing.js` is de nagebootste Supabase en uitstappentool die de tests van de serverfunctie en de browsercontrole delen.

## Eén vaste regel voor deze organisatie

In de organisatie van de MT staat **nooit een tweede repository met GitHub Pages**, niet in die van de testversie en niet in die van de echte MT. Een tweede repository met Pages komt op hetzelfde adres te staan, in een submap. De browser ziet dat als dezelfde website: zo'n pagina kan de aanmelding van de MT lezen, en haar scripts mogen volgens de beveiliging van de MT (de CSP) gewoon draaien. De scheiding van de MT met de andere tools (B72) houdt dus enkel stand zolang hier niets anders met Pages staat.
