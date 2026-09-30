# waitzi.

**No pager. Your phone becomes the pager.**

Waitzi er en webapp til madboder og caféer: kunden scanner en QR-kode, taster sit ordrenummer og lægger telefonen fra sig. Når køkkenet trykker *Mark ready*, bipper, vibrerer og lyser telefonen — præcis som en gammeldags pager. Ingen app, ingen login, intet at downloade.

## Sider

| Adresse   | Hvem          | Hvad                                                                 |
|-----------|---------------|----------------------------------------------------------------------|
| `/`       | Kunden        | Tast ordrenummer → vent → fuldskærms-alarm når maden er klar          |
| `/staff`  | Personalet    | Dashboard: *New order*, *Mark ready*, *Page again*, *Collected*, *Undo* |
| `/card`   | Til disken    | Printbart kort med QR-kode til kundesiden                             |

Kundesiden kan også åbnes med nummeret udfyldt: `/?n=42` (fx som QR på kvitteringen).

## Kom i gang

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Åbn `/staff` på en tablet ved disken og `/` på en telefon.

### Indstillinger (miljøvariabler)

| Variabel      | Standard            | Beskrivelse                                                        |
|---------------|---------------------|--------------------------------------------------------------------|
| `PORT`        | `3000`              | Port                                                               |
| `VENUE_NAME`  | `Hallen · Stand 4`  | Navnet der vises øverst                                            |
| `STAFF_KEY`   | *(tom)*             | Kode til personale-dashboardet. **Sæt den i produktion.**          |
| `SIGNAL`      | `amber`             | Signalfarve: `amber`, `green` eller `coral`                        |
| `PUBLIC_URL`  | *(fra request)*     | Offentlig adresse brugt i QR-koden, fx `https://waitzi.to`         |
| `DATA_FILE`   | `data/state.json`   | Hvor køen gemmes, så en genstart ikke mister ordrer                |

## Sådan virker det

- **Server** (`server.js`): Node uden framework. Holder køen i hukommelsen, gemmer den i en JSON-fil og sender ændringer live til alle skærme via Server-Sent Events. Nummereringen og "collected today" nulstilles automatisk ved midnat.
- **Alarmen**: bip · pause · bip (to 140 ms toner på C7 gennem et low-pass-filter), vibration kort · kort · lang (70/70/260 ms), hvid flash og derefter en langsom "ånding" i signalfarven. Tappet på *Start waiting* låser lyden op, så den kan spille senere.
- **Telefonen holdes vågen** med Screen Wake Lock, mens kunden venter. Mister telefonen forbindelsen, vises "Reconnecting… your place is saved." og den forbinder selv igen. Ordrenummeret huskes, hvis siden genindlæses.
- **I baggrunden** viser siden en systemnotifikation (hvis kunden har tilladt det), og fanens titel blinker.
- **iOS Safari** har ingen web-vibration, så lys og lyd bærer alarmen. Tilføjes Waitzi til hjemmeskærmen (PWA), kan den også vise notifikationer.
- **Reduced motion** respekteres: ingen flash, ringe eller fjedre — farveskiftet på hele skærmen bærer stadig alarmen.

## Drift

Appen kører som én proces (køen ligger i den proces), så kør én instans. Fx:

```bash
docker build -t waitzi .
docker run -p 3000:3000 -e STAFF_KEY=hemmelig -e PUBLIC_URL=https://din-adresse -v waitzi-data:/app/data waitzi
```

Den kan også køre direkte på Render, Railway, Fly.io o.l. med `npm start`. Brug HTTPS i produktion — wake lock, service worker og notifikationer kræver det.

## Design

Det oprindelige Claude Design-prototype ligger i `design/Waitzi.dc.html` (farver, typografi, bevægelse og alarm-signatur er taget derfra).
