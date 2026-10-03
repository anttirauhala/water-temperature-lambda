/**
 * water-temperature-lambda
 *
 * Tampereen seudun pintaveden lämpötila (SYKE Hydrologiarajapinta).
 *
 * Toteutus on tarkoituksella **riippuvuudeton** (ei npm-paketteja): Node.js 22
 * sisältää `fetch`in ja `AbortSignal.timeout`in, ja jäsennelty lokitus sekä
 * korrelaatio-ID on toteutettu inline (ei ulkoisia kirjastoja).
 *
 * Reitti: `GET /v1/water/temperature`
 * Putki: API Gateway HTTP API (payload 2.0) → tämä Lambda → JSON.
 *
 * Datalähde: SYKE Hydrologiarajapinta (OData 3.0), CC BY 4.0, ei API-avainta.
 * Oletusasema: Näsijärvi, Kyrönlahti (Paikka_Id 1694) — Tampereen seudun
 * edustava pintaveden lämpötila-asema (Ylöjärvi). Havainto on päivittäinen,
 * joten 5 minuutin muistivälimuisti ei hävitä tuoreutta mutta pitää
 * upstream-kutsut kurissa (N selainta → 1 SYKE-kutsu / TTL / lämmin kontti).
 *
 * Konfigurointi (kaikilla on käyttökelpoinen oletus):
 *   ENVIRONMENT, LOG_LEVEL, SYKE_HYDRO_URL, WATER_PAIKKA_ID,
 *   WATER_STATION_NAME, WATER_LAKE_NAME, WATER_MUNICIPALITY,
 *   WATER_STATION_LAT, WATER_STATION_LON, WATER_CACHE_MS,
 *   WATER_STALE_MAX_MS, WATER_UPSTREAM_TIMEOUT_MS
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Logitus (jäsennelty JSON-lokitus ja korrelaatio-ID; ei ulkoisia riippuvuuksia)
// ---------------------------------------------------------------------------

const LEVEL_WEIGHT = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

const logContext = new AsyncLocalStorage();

/** Suorita funktio korrelaatio-ID:n kontekstissa. */
export function withCorrelationId(correlationId, fn) {
  return logContext.run({ correlationId }, fn);
}

/** Nykyinen korrelaatio-ID (jos konteksti on aktiivinen). */
export function getCorrelationId() {
  return logContext.getStore()?.correlationId;
}

/** Generoi uuden korrelaatio-ID:n (UUID v4). */
export function newCorrelationId() {
  return randomUUID();
}

/** Serialisoi virhe lokiriville. */
export function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}

/** Luo jäsennellyn JSON-loggerin (CloudWatch Logs -yhteensopiva). */
export function createLogger({ service, environment }) {
  const configured = String(process.env.LOG_LEVEL ?? 'INFO').toUpperCase();
  const minLevel = Object.prototype.hasOwnProperty.call(LEVEL_WEIGHT, configured)
    ? configured
    : 'INFO';

  function write(level, message, fields) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;
    const entry = { timestamp: new Date().toISOString(), level, service, message };
    if (environment) entry.environment = environment;
    const correlationId = getCorrelationId();
    if (correlationId) entry.correlationId = correlationId;
    Object.assign(entry, fields ?? {});
    const line = JSON.stringify(entry);
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (message, fields) => write('DEBUG', message, fields),
    info: (message, fields) => write('INFO', message, fields),
    warn: (message, fields) => write('WARN', message, fields),
    error: (message, fields) => write('ERROR', message, fields),
  };
}

// ---------------------------------------------------------------------------
// Välimuisti (portattu cache.ts:stä)
// ---------------------------------------------------------------------------

/**
 * Avainkohtainen muistivälimuisti: N selainta aiheuttaa enintään yhden
 * upstream-kutsun per TTL per lämmin kontti. Virhetilanteessa palautetaan
 * viimeisin onnistunut arvo `stale: true`na, kunnes se on `staleMaxMs`ia
 * vanhempi.
 */
export function createKeyedCache(options) {
  const entries = new Map();
  const inflight = new Map();

  function store(key, value, fetchedAt) {
    // Map säilyttää lisäysjärjestyksen → ensimmäinen avain on vanhin.
    entries.delete(key);
    entries.set(key, { value, fetchedAt });
    while (entries.size > options.maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  function refresh(key, load) {
    const existing = inflight.get(key);
    if (existing) return existing;
    const pending = load().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, pending);
    return pending;
  }

  return {
    async get(key, load) {
      const now = options.now();
      const entry = entries.get(key);
      if (entry && now - entry.fetchedAt < options.ttlMs) {
        return { value: entry.value, stale: false, fetchedAt: entry.fetchedAt };
      }
      try {
        const value = await refresh(key, load);
        const fetchedAt = options.now();
        store(key, value, fetchedAt);
        return { value, stale: false, fetchedAt };
      } catch (error) {
        if (entry && options.now() - entry.fetchedAt <= options.staleMaxMs) {
          return { value: entry.value, stale: true, fetchedAt: entry.fetchedAt };
        }
        throw error;
      }
    },
    peek(key) {
      return entries.get(key)?.value ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// SYKE Hydrologiarajapinta (OData 3.0) — portattu syke.ts:stä
// ---------------------------------------------------------------------------

/** Rajapinnan juuri (OData); ympäristömuuttujalla voi vaihtaa. */
export const SYKE_HYDRO_BASE_URL =
  process.env.SYKE_HYDRO_URL ??
  'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata';

/** Lähteetön HTTP-virhe tilakoodin kanssa. */
export class SykeError extends Error {
  constructor(status, resource, message) {
    super(message ?? `SYKE vastasi ${status} (${resource})`);
    this.name = 'SykeError';
    this.status = status;
    this.resource = resource;
  }
}

/**
 * URL uusimmalle pintaveden lämpötilahavainnolle: uusin ensin, yksi rivi,
 * paikkatiedot mukaan (`$expand=Paikka`). Muoto valitaan `Accept`-otsikolla,
 * koska rajapinta hylkää `$format`-kyselyparametrin.
 */
export function buildLatestTemperatureUrl(baseUrl, paikkaId) {
  const filter = encodeURIComponent(`Paikka_Id eq ${paikkaId}`);
  return `${baseUrl}/LampoPintavesi?$filter=${filter}&$orderby=Aika%20desc&$top=1&$expand=Paikka`;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * SYKE antaa koordinaatit muodossa DDMMSS (esim. `614242` = 61°42′42″).
 * Palauttaa desimaaliasteet tai `null`, jos muoto ei täsmää (ei arvausta).
 */
export function parseDdmmss(value) {
  const raw = String(value ?? '').trim();
  const match = /^(\d{2})(\d{2})(\d{2})/.exec(raw);
  if (!match) return null;
  const deg = Number(match[1]);
  const min = Number(match[2]);
  const sec = Number(match[3]);
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return deg + min / 60 + sec / 3600;
}

function toStation(raw, fallback) {
  if (raw === null || typeof raw !== 'object') return fallback;
  return {
    id: toNumber(raw.Paikka_Id) ?? fallback.id,
    name: toString(raw.Nimi) || fallback.name,
    lake: toString(raw.JarviNimi) || fallback.lake,
    municipality: toString(raw.KuntaNimi) || fallback.municipality,
    latitude: parseDdmmss(raw.KoordLat) ?? fallback.latitude,
    longitude: parseDdmmss(raw.KoordLong) ?? fallback.longitude,
  };
}

/**
 * Poimii uusimman havainnon OData-vastauksesta. Puuttuva arvo on `null`, ei
 * nolla. Tyhjä vastaus (ei havaintoja) palauttaa varapaikan `null`-arvolla.
 */
export function parseLatestTemperature(raw, fallback) {
  const root = raw !== null && typeof raw === 'object' ? raw : {};
  const rows = Array.isArray(root.value) ? root.value : [];
  const row = rows[0];
  if (row === null || row === undefined || typeof row !== 'object') {
    return { temperatureC: null, measuredAt: null, station: fallback };
  }
  return {
    temperatureC: toNumber(row.Arvo),
    measuredAt: typeof row.Aika === 'string' ? row.Aika : null,
    station: toStation(row.Paikka, fallback),
  };
}

/** Hakee uusimman pintaveden lämpötilan ja paikkatiedot. */
export async function fetchSurfaceWaterTemperature(baseUrl, paikkaId, fallback, timeoutMs) {
  const response = await fetch(buildLatestTemperatureUrl(baseUrl, paikkaId), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new SykeError(response.status, 'LampoPintavesi');
  const raw = await response.json();
  return parseLatestTemperature(raw, fallback);
}

// ---------------------------------------------------------------------------
// Konfiguraatio
// ---------------------------------------------------------------------------

/** Positiivinen luku ympäristömuuttujasta tai oletus. */
function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Valinnainen luku ympäristömuuttujasta tai `null` (esim. koordinaatit). */
function envOptionalNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const logger = createLogger({
  service: 'water-temperature',
  environment: process.env.ENVIRONMENT ?? 'dev',
});

const baseUrl = process.env.SYKE_HYDRO_URL ?? SYKE_HYDRO_BASE_URL;
const paikkaId = envNumber('WATER_PAIKKA_ID', 1694);
const upstreamTimeoutMs = envNumber('WATER_UPSTREAM_TIMEOUT_MS', 5_000);

/** Varapaikan tiedot, jos lähde ei palauta havaintoja (`$expand` ei tuo Paikkaa). */
const fallbackStation = {
  id: paikkaId,
  name: process.env.WATER_STATION_NAME ?? 'Näsijärvi, Kyrönlahti',
  lake: process.env.WATER_LAKE_NAME ?? 'Näsijärvi',
  municipality: process.env.WATER_MUNICIPALITY ?? 'Ylöjärvi',
  latitude: envOptionalNumber('WATER_STATION_LAT') ?? 61.7117,
  longitude: envOptionalNumber('WATER_STATION_LON') ?? 23.5547,
};

/** Yksi välimuistiava. 5 min TTL; varafallback viikko (havainto on päivittäinen). */
const cache = createKeyedCache({
  ttlMs: envNumber('WATER_CACHE_MS', 5 * 60_000),
  staleMaxMs: envNumber('WATER_STALE_MAX_MS', 7 * 86_400_000),
  maxEntries: 1,
  now: () => Date.now(),
});

// ---------------------------------------------------------------------------
// HTTP-handler (API Gateway HTTP API, payload 2.0)
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

async function loadReading() {
  const started = Date.now();
  const reading = await fetchSurfaceWaterTemperature(
    baseUrl,
    paikkaId,
    fallbackStation,
    upstreamTimeoutMs,
  );
  logger.info('Pintaveden lämpötila haettu', {
    station: reading.station.name,
    temperatureC: reading.temperatureC,
    measuredAt: reading.measuredAt,
    durationMs: Date.now() - started,
  });
  return reading;
}

/** `GET /v1/water/temperature`. */
async function handleTemperature() {
  let entry;
  try {
    entry = await cache.get('latest', loadReading);
  } catch (error) {
    logger.error('Pintaveden lämpötilan haku epäonnistui', { error: serializeError(error) });
    return jsonResponse(503, { error: 'UPSTREAM_UNAVAILABLE' }, { 'retry-after': '300' });
  }

  const response = {
    ...entry.value,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    stale: entry.stale,
    source: {
      system: 'SYKE',
      name: 'SYKE Hydrologiarajapinta',
      url: baseUrl,
      license: 'CC BY 4.0',
    },
  };
  return jsonResponse(200, response, { 'cache-control': 'public, max-age=300' });
}

export async function handler(event = {}) {
  return withCorrelationId(newCorrelationId(), async () => {
    const method = String(
      event.requestContext?.http?.method ?? event.httpMethod ?? 'GET',
    ).toUpperCase();
    const path = event.rawPath ?? event.path ?? '';

    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: { ...CORS_HEADERS }, body: '' };
    }

    const isTemperaturePath =
      path === '' ||
      path === '/' ||
      path.endsWith('/v1/water/temperature') ||
      path.endsWith('/water/temperature');

    if (!isTemperaturePath) return jsonResponse(404, { error: 'NOT_FOUND' });
    return handleTemperature();
  });
}
