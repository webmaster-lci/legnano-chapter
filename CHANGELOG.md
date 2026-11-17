# Cronologia modifiche – Legnano Chapter

Ogni modifica è salvata come commit su GitHub: si può tornare a qualsiasi versione precedente.
Le tappe principali hanno anche un'etichetta (tag) per ritrovarle al volo.

| Data | Versione | Commit | Modifica |
|---|---|---|---|
| 17/11/2026 23:18 | v0.1 | `2b7b6e9` | Prima pubblicazione del sito di prova |
| 17/11/2026 23:31 |  | `b3857d9` | Avvio GitHub Pages |
| 17/11/2026 23:49 | v0.2 | `f39b890` | Area riservata collegata a Supabase: login email/password, database, regole di accesso |
| 18/11/2026 00:03 | v0.3 | `ed5f37d` | Script con i dati di prova copiati dall'app su Claude |
| 18/11/2026 00:09 |  | `9087923` | Esci riporta al sito |
| 18/11/2026 00:10 | v0.4 | `d3e9832` | Pulsanti separati "‹ Sito" (resti collegato) ed "Esci" |
| 18/11/2026 00:14 | v0.5 | `fae9dbc` | Layout largo per PC e tablet; telefono invariato; intestazione su una riga |

## Come tornare indietro

Basta chiederlo in chat indicando la versione (es. "torna alla v0.4"): viene creato un nuovo commit
che ripristina quello stato, senza cancellare la cronologia.

Da GitHub: scheda **Code ▸ Commits** per vedere ogni versione; **Tags** per le tappe principali.

## Nota sul database (Supabase)

La cronologia qui copre il codice e gli script SQL (`supabase/`), non i dati inseriti nell'app.
Prima di modifiche al database viene preparato uno script di ripristino.
