/**
 * water-temperature-lambda — konfiguraatio (CDK).
 *
 * Oletusarvoilla (ei ympäristömuuttujia) funktio hakee Tampereen seudun
 * edustavan aseman havainnon; arvot voi ohittaa ympäristömuuttujilla.
 *
 * Lähde: SYKE Hydrologiarajapinta (OData 3.0), CC BY 4.0, ei API-avainta.
 * Suure `LampoPintavesi` = "Pintaveden lämpötila" (T, °C).
 *
 * Asema on **Näsijärvi, Kyrönlahti** (`Paikka_Id` 1694): Tampereen kaupungin
 * kunnassa ei ole yhtään säännöllisesti raportoivaa pintaveden lämpötila-asemaa,
 * mutta Näsijärvi on Tampereen järvi ja Kyrönlahti sen pohjoispää (Ylöjärvi).
 * Havainto on päivittäinen.
 */

/** SYKE Hydrologiarajapinnan juuri (OData 3.0). */
export const WATER_URL =
  'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata';

export const WATER_PAIKKA_ID = 1694;
export const WATER_STATION_NAME = 'Näsijärvi, Kyrönlahti';
export const WATER_LAKE_NAME = 'Näsijärvi';
export const WATER_MUNICIPALITY = 'Ylöjärvi';
export const WATER_STATION_LAT = 61.7117;
export const WATER_STATION_LON = 23.5547;

/** 5 min välimuisti (vaatimus): N selainta → 1 SYKE-kutsu / TTL / lämmin kontti. */
export const WATER_CACHE_MS = 5 * 60_000;
/** Varafallback viikko, jotta hetkellinen lähdekatkos ei tyhjennä lukemaa. */
export const WATER_STALE_MAX_MS = 7 * 86_400_000;
/** Upstream-timeout; selvästi Lambdan 10 s timeoutia lyhyempi. */
export const WATER_UPSTREAM_TIMEOUT_MS = 5_000;
/** Kustannuskatto: pieni varattu concurrency erillään muista reiteistä. */
export const WATER_RESERVED_CONCURRENCY = 2;

/**
 * API Gateway -throttlaus (HTTP API -stagen oletusraja-arvot).
 *
 * Suojaa väärinkäytöltä ja kustannuspiikiltä: kun raja ylittyy, API Gateway
 * vastaa **429 Too Many Requests** eikä Lambdaa kutsuta lainkaan. Tämä on
 * ensisijainen kustannussuoja — Lambda ei ehdi skaalautua pyyntövyöryn takia.
 *
 * Mitoitus: Lambda kestää ~150 ms/havainto ja varattu concurrency on 2, joten
 * todellinen läpäisykyky on ~13 req/s. Rate 20/s jättää marginaalia normaalille
 * liikenteelle (selain pollaa 30–60 s välein) mutta katkaisee vyöryn selvästi
 * ennen kuin Lambda ruuhkautuu.
 *
 * Huom: HTTP API tukee **stagen oletus-throttlausta**, ei käyttösuunnitelmia
 * (usage plans) eikä API-avaimia — ne ovat REST API:n ominaisuus. Riittävän
 * vahva lisäsuoja olisi AWS WAF (esim. rate-based rule).
 */
export const API_THROTTLE_RATE_LIMIT = 20;
export const API_THROTTLE_BURST_LIMIT = 40;

/**
 * CloudWatch-hälytysraja API-pyyntöjen määrälle 5 minuutissa.
 * Normaali liikenne on murto-osa tästä — hälytys tarkoittaa väärinkäyttöä,
 * ei ruuhkaa.
 */
export const API_REQUEST_SPIKE_PER_5MIN = 1000;
