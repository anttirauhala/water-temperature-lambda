# water-temperature-lambda

AWS Lambda -funktio, joka hakee **Tampereen seudun pintaveden lämpötilan**
[SYKE:n Hydrologiarajapinnasta](https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata)
(OData 3.0) ja palauttaa sen normalisoituna JSONina.

Toteutus on tarkoituksella **riippuvuudeton**: ei npm-ajonaikaisia paketteja,
joten zip-paketti on pieni ja kylmäkäynnistys nopea.

## Arkkitehtuuri

```
Selain / asiakas
   │  GET /v1/water/temperature
   ▼
API Gateway HTTP API
   │
   ▼
Lambda (Node.js 22, riippuvuudeton)  ── muistivälimuisti 5 min ──┐
   │                                                            │
   ▼  (välimuistin ohittaen ~1 kutsu / 5 min / lämmin kontti)   │
SYKE Hydrologiarajapinta (OData 3.0, CC BY 4.0, ei API-avainta) ┘
```

- **Yksi asema**: `Näsijärvi, Kyrönlahti` (`Paikka_Id` 1694, Ylöjärvi). Tampereen
  kaupungin kunnassa ei ole säännöllisesti raportoivaa pintaveden
  lämpötila-asemaa; Näsijärvi on Tampereen järvi ja Kyrönlahti sen pohjoispää.
  Havainto on **päivittäinen**.
- **5 min muistivälimuisti**: N selainta aiheuttaa enintään yhden SYKE-kutsun per
  TTL per lämmin Lambda-kontti.
- **Stale-fallback**: jos upstream-haku epäonnistuu, palautetaan viimeisin
  onnistunut arvo `stale: true`na enintään 7 vrk ajan → lämpötilatieto ei katoa
  yhden epäonnistuneen haun takia.
- **In-flight-dedupe**: samanaikaiset pyynnöt jakavat yhden upstream-kutsun.

## Tiedostot

```
.
├── .nvmrc             # kehityksen Node-versio (`nvm use`)
├── index.mjs          # Lambda-handler (koko logiikka; ei riippuvuuksia)
├── package.json       # paikallinen ajo, testit ja CDK-komennot (devDep: esbuild)
├── test/
│   ├── smoke.mjs      # savutesti (mockattu fetch; `npm test`)
│   └── live.mjs       # oikea SYKE-kutsu (`npm run live`)
└── infra/             # AWS CDK (TypeScript): HTTP API + Lambda
    ├── bin/app.ts
    ├── lib/water-temperature-stack.ts
    ├── lib/config.ts
    ├── cdk.json
    └── package.json   # aws-cdk-lib, aws-cdk, ts-node, typescript
```

## API

### `GET /v1/water/temperature`

**200 OK**

```json
{
  "temperatureC": 12.5,
  "measuredAt": "2026-10-02T00:00:00",
  "station": {
    "id": 1694,
    "name": "Näsijärvi, Kyrönlahti",
    "lake": "Näsijärvi (N60 95.40)x1",
    "municipality": "Ylöjärvi",
    "latitude": 61.711666666666666,
    "longitude": 23.554722222222225
  },
  "fetchedAt": "2026-10-03T13:56:13.097Z",
  "stale": false,
  "source": {
    "system": "SYKE",
    "name": "SYKE Hydrologiarajapinta",
    "url": "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata",
    "license": "CC BY 4.0"
  }
}
```

- `temperatureC` — pintaveden lämpötila °C tai `null`, jos havaintoa ei ole
  (puuttuvaa arvoa **ei** korvata nollalla).
- `measuredAt` — havainnon aika lähteestä, tai `null`.
- `stale` — `true`, jos upstream-haku epäonnistui ja arvo on välimuistista.
- Otsikot: `cache-control: public, max-age=300`, CORS `access-control-allow-origin: *`.

**404** `{"error":"NOT_FOUND"}` — tuntematon polku.

**503** `{"error":"UPSTREAM_UNAVAILABLE"}` + `retry-after: 300` — upstream
epäonnistui eikä kelvollista välimuistiarvoa ole.

## Konfiguraatio (ympäristömuuttujat)

Kaikilla on käyttökelpoinen oletus, joten funktio toimii ilman konfigurointia.

| Muuttuja | Oletus | Kuvaus |
| --- | --- | --- |
| `ENVIRONMENT` | `dev` | `dev` \| `test` \| `prod` (lokitus) |
| `LOG_LEVEL` | `INFO` | `DEBUG` \| `INFO` \| `WARN` \| `ERROR` |
| `SYKE_HYDRO_URL` | `…/Hydrologiarajapinta/1.2/odata` | Rajapinnan juuri |
| `WATER_PAIKKA_ID` | `1694` | SYKE `Paikka_Id` |
| `WATER_STATION_NAME` | `Näsijärvi, Kyrönlahti` | Varapaikan nimi |
| `WATER_LAKE_NAME` | `Näsijärvi` | Varapaikan järvi |
| `WATER_MUNICIPALITY` | `Ylöjärvi` | Varapaikan kunta |
| `WATER_STATION_LAT` / `WATER_STATION_LON` | `61.7117` / `23.5547` | Varapaikan koordinaatit |
| `WATER_CACHE_MS` | `300000` | Välimuistin TTL (ms) |
| `WATER_STALE_MAX_MS` | `604800000` | Vanhan arvon enimmäisikä virhetilanteessa (ms) |
| `WATER_UPSTREAM_TIMEOUT_MS` | `5000` | Upstream-timeout (ms) |

## Paikallinen ajo ja testit

Vaatii **Node.js ≥ 22.23.4** (funktio käyttää natiivia `fetch`iä). Versio on
lukittu `.nvmrc`:hen → `nvm use`. Alaraja johtuu Node.js:n Brotli-dekooderin
haavoittuvuudesta (CVE-2026-111497, "Node2Shell"), joka on korjattu versiossa
22.23.4: `fetch` purkaa `content-encoding: br` -vastaukset automaattisesti,
joten vanhempi Node on altis. Lambdan ajoaikana on `nodejs22.x`, jonka AWS
päivittää automaattisesti (runtime update -tila `Auto`).

```bash
npm test     # savutesti: mockattu fetch, ei verkkoyhteyttä
npm run live # oikea SYKE-kutsu ja tulostus
```

Funktiota voi kutsua myös suoraan:

```bash
node -e "import('./index.mjs').then(m => m.handler({ rawPath: '/v1/water/temperature' })).then(r => console.log(r.statusCode, r.body))"
```

## Deploy (AWS CDK)

```bash
npm install                # juuressa: esbuild (Lambda bundlaus)
npm run infra:install      # infra/: aws-cdk-lib, aws-cdk, ts-node

cd infra
npx cdk bootstrap          # tarvitaan kerran per tili/alue
npx cdk diff               # muutokset
npx cdk deploy             # deploy (oletus: dev)
npx cdk deploy -c env=prod # prod-ympäristö
```

Juuresta käsin samat komennot onnistuvat skripteillä
(`npm run synth`, `npm run diff`, `npm run deploy`).

### Ympäristöt: dev ja prod

Ympäristö valitaan CDK-kontekstilla `-c env=<nimi>` (oletus `dev`). Kumpikin
ympäristö on **oma CloudFormation-stackinsa** samassa tilissä/alueessa
(`WaterTemperatureStack-dev` / `WaterTemperatureStack-prod`), ja resurssit
nimetään ympäristön mukaan (`water-temperature-prod`,
`water-temperature-prod-alarms`).

```bash
# Juuresta (skriptit välittävät -c env=prod perille)
npm run synth:prod
npm run diff:prod
npm run deploy:prod

# ...tai infra/-hakemistosta suoraan
cd infra
npx cdk deploy -c env=prod
```

`cdk deploy` ilman kontekstia koskee **vain** dev-stackia, joten prod-deploy ei
muuta deviä.

#### Rajaa CORS prodissa

Oletus `allowOrigins: ['*']` sopii dev/testiin. Prodissa rajaa omaan
frontend-domainiin (pilkkueroteltuna):

```bash
cd infra
npx cdk deploy -c env=prod -c allowedOrigins=https://oma-frontti.fi,https://www.oma-frontti.fi
```

`-c`-arvot ovat komentokohtaisia — toistuvan prod-deployn voi helpottaa
lisäämällä ne `infra/cdk.json`:n `context`-lohkoon:

```json
{ "context": { "env": "prod", "allowedOrigins": "https://oma-frontti.fi" } }
```

#### Tilaa hälytykset (prod)

```bash
aws sns subscribe --topic-arn <AlarmTopicArn> --protocol email \
  --notification-endpoint sina@example.com
```

#### Tuhoa

```bash
npm run destroy:prod     # tai: cd infra && npx cdk destroy -c env=prod
```

Stack luo seuraavat resurssit:

- **Lambda** `water-temperature-<env>` — Node.js 22, 256 Mt, timeout 10 s,
  varattu concurrency 2.
- **API Gateway HTTP API** — reitti `GET /v1/water/temperature`,
  CORS-esitarkistus sallittu (GET), stagen throttlaus (rate 20/s, burst 40).
- **CloudWatch-hälytys** pyyntöpiikistä (> 1000 pyyntöä / 5 min) ja
  **SNS-aihe** hälytyksille.
- CloudFormation-outputit `ApiUrl`, `FunctionName` ja `AlarmTopicArn`.

## Kustannusten ja väärinkäytön rajoittaminen

Julkinen reitti on suojattu kolmella kerroksella, jotta sitä ei voi
"tykittää" kustannusten kasvattamiseksi:

1. **API Gateway -throttlaus** (`$default`-stage): rate 20 req/s ja burst 40.
   Kun raja ylittyy, API Gateway vastaa **429 Too Many Requests** eikä Lambdaa
   kutsuta lainkaan. Tämä on ensisijainen kustannussuoja.
   - Säädä arvot `infra/lib/config.ts`:ssä (`API_THROTTLE_RATE_LIMIT`,
     `API_THROTTLE_BURST_LIMIT`).
   - HTTP API tukee stagen oletus-throttlausta, **ei** käyttösuunnitelmia
     (usage plans) eikä API-avaimia — ne ovat REST API:n ominaisuus.
     Asiakaskohtainen kiintiöinti vaatisi REST API:n.
2. **Lambda varattu concurrency = 2**: samanaikaisten suoritusten katto, joten
   kustannus per hetki on rajattu.
3. **5 min muistivälimuisti**: N selainta aiheuttaa enintään yhden SYKE-kutsun
   per TTL — upstream-kuorma ei skaalaa liikenteen mukana.

Pyyntöpiikistä hälytetään CloudWatch-hälytyksellä (`API_REQUEST_SPIKE_PER_5MIN`,
infra/lib/config.ts, oletus 1000 pyyntöä / 5 min). Tilaa hälytykset
sähköpostiin:

```bash
aws sns subscribe --topic-arn <AlarmTopicArn> --protocol email --notification-endpoint sina@example.com
```

Kovempaan suojaukseen (IP-pohjainen rate limit, botit) seuraava askel olisi
**AWS WAF** rate-based -säännöllä API:n eteen.

## Datalähde ja attribuutio

- **Lähde**: Suomen ympäristökeskus (SYKE), Hydrologiarajapinta, suure
  `LampoPintavesi` ("Pintaveden lämpötila", °C).
- **Lisenssi**: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Mainitse lähde: *Suomen ympäristökeskus (SYKE), Hydrologiarajapinta.*
- **Ei API-avainta.** Pyydä datasta vastuullisesti — palvelinpuolen välimuisti
  (5 min) pitää upstream-kutsut kurissa.
