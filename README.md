# klimop-mt-test.github.io

Testversie van de MT, de maximumfactuur-tool van GO! basisschool Klim-Op. Enkel code: nooit leerlinggegevens, nooit echte namen, en geen geheime sleutels. Test en productie krijgen dezelfde bestanden.

## Opbouw

| Map of bestand | Inhoud |
|---|---|
| `index.html` | de pagina |
| `code/` | de werking, één bestand per taak: `app.js` de start, `config.js` de adressen, `ui.js` alles op het scherm, `data.js` de databank |
| `opmaak/` | de huisstijl (`mt.css`), het logo, en het lettertype Outfit met zijn licentie |
| `sql/` | de scripts voor Supabase, op volgorde |
| `tests/` | de automatische tests |
| `.github/` | de tests en de keep-alive in GitHub Actions |
