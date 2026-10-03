/**
 * Savutesti (mockattu fetch) — ei verkkoyhteyttä, deterministinen.
 *
 * Aja: `npm test`
 *
 * Testataan portatun logiikan olennainen käyttäytyminen:
 *   1. buildLatestTemperatureUrl rakentaa OData-kyselyn oikein (ei $format)
 *   2. parseDdmmss muuntaa DDMMSS-koordinaatit
 *   3. parseLatestTemperature poimii arvon/aian/paikan ja varapaikan
 *   4. createKeyedCache: TTL, stale-fallback ja in-flight-dedupe
 *   5. handler: 503 (ei välimuistia), 200 (onnistunut haku), stale 200, 404, OPTIONS
 */

import assert from 'node:assert/strict';

// Pieni TTL (1 ms) + pitkä stale-ikkuna tekevät välimuistin tiloista deterministisiä.
// Huom: envNumber hylkää nollan, joten pienin sallittu arvo on 1.
process.env.WATER_CACHE_MS = '1';
process.env.WATER_STALE_MAX_MS = '604800000';
process.env.LOG_LEVEL = 'ERROR';

const {
  createKeyedCache,
  buildLatestTemperatureUrl,
  parseDdmmss,
  parseLatestTemperature,
  handler,
} = await import('../index.mjs');

const BASE = 'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.2/odata';

const FALLBACK = {
  id: 1694,
  name: 'Näsijärvi, Kyrönlahti',
  lake: 'Näsijärvi',
  municipality: 'Ylöjärvi',
  latitude: null,
  longitude: null,
};

const LATEST_ROW = {
  Paikka_Id: 1694,
  Aika: '2026-10-02T00:00:00',
  Arvo: '12.5',
  Paikka: {
    Paikka_Id: 1694,
    KuntaNimi: 'Ylöjärvi',
    Nimi: 'Näsijärvi, Kyrönlahti',
    JarviNimi: 'Näsijärvi (N60 95.40)x1',
    KoordLat: '614242',
    KoordLong: '233317',
  },
};

const odata = (value) => ({ 'odata.metadata': `${BASE}/$metadata#LampoPintavesi`, value });

const getEvent = (path = '/v1/water/temperature', method = 'GET') => ({
  rawPath: path,
  requestContext: { http: { method } },
});

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  \u2713 ${name}`);
    })
    .catch((error) => {
      console.error(`  \u2717 ${name}\n    ${error.message}`);
      process.exitCode = 1;
      throw error;
    });
}

console.log('water-temperature-lambda — savutesti');

await test('buildLatestTemperatureUrl: uusin ensin, yksi rivi, paikka mukaan, ei $format', () => {
  const url = buildLatestTemperatureUrl(BASE, 1694);
  assert.ok(url.startsWith(`${BASE}/LampoPintavesi?`));
  assert.ok(url.includes('$filter=Paikka_Id%20eq%201694'));
  assert.ok(url.includes('$orderby=Aika%20desc'));
  assert.ok(url.includes('$top=1'));
  assert.ok(url.includes('$expand=Paikka'));
  assert.ok(!url.includes('$format'));
});

await test('parseDdmmss: DDMMSS -> desimaaliasteet, virheellinen -> null', () => {
  assert.ok(Math.abs(parseDdmmss('614242') - 61.7117) < 0.001);
  assert.ok(Math.abs(parseDdmmss('233317') - 23.5547) < 0.001);
  assert.equal(parseDdmmss(''), null);
  assert.equal(parseDdmmss('abc'), null);
  assert.equal(parseDdmmss(null), null);
});

await test('parseLatestTemperature: poimii arvon, ajan ja paikkatiedot', () => {
  const reading = parseLatestTemperature(odata([LATEST_ROW]), FALLBACK);
  assert.equal(reading.temperatureC, 12.5);
  assert.equal(reading.measuredAt, '2026-10-02T00:00:00');
  assert.equal(reading.station.name, 'Näsijärvi, Kyrönlahti');
  assert.equal(reading.station.municipality, 'Ylöjärvi');
  assert.ok(Math.abs(reading.station.latitude - 61.7117) < 0.001);
});

await test('parseLatestTemperature: tyhjä/kelvoton vastaus -> varapaikka, arvo null', () => {
  const empty = parseLatestTemperature(odata([]), FALLBACK);
  assert.equal(empty.temperatureC, null);
  assert.deepEqual(empty.station, FALLBACK);
  const junk = parseLatestTemperature(null, FALLBACK);
  assert.equal(junk.temperatureC, null);
  assert.deepEqual(junk.station, FALLBACK);
});

await test('createKeyedCache: TTL, stale-fallback ja in-flight-dedupe', async () => {
  let clock = 1_000_000;
  const cache = createKeyedCache({ ttlMs: 300_000, staleMaxMs: 86_400_000, maxEntries: 1, now: () => clock });

  let loads = 0;
  const load = async () => { loads += 1; return `arvo-${loads}`; };
  assert.equal((await cache.get('latest', load)).value, 'arvo-1');
  clock += 299_999;
  assert.equal((await cache.get('latest', load)).value, 'arvo-1');
  assert.equal(loads, 1);
  clock += 2;
  assert.equal((await cache.get('latest', load)).value, 'arvo-2');

  // Stale-fallback: TTL on umpeutunut ja haku epaonnistuu -> vanha arvo stale:true.
  clock += 300_000;
  const stale = await cache.get('latest', async () => { throw new Error('SYKE vastasi 500'); });
  assert.equal(stale.value, 'arvo-2');
  assert.equal(stale.stale, true);

  // In-flight-dedupe: kolme samanaikaista hakua samalla avaimella -> yksi lataus.
  let concurrent = 0;
  const slow = () => new Promise((resolve) => { concurrent += 1; setTimeout(() => resolve('valmis'), 5); });
  const results = await Promise.all([
    cache.get('x', slow),
    cache.get('x', slow),
    cache.get('x', slow),
  ]);
  assert.deepEqual(results.map((e) => e.value), ['valmis', 'valmis', 'valmis']);
  assert.equal(concurrent, 1);
});

await test('handler: 503 kun upstream epäonnistuu eikä välimuistissa ole arvoa', async () => {
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const res = await handler(getEvent());
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['retry-after'], '300');
  assert.deepEqual(JSON.parse(res.body), { error: 'UPSTREAM_UNAVAILABLE' });
});

await test('handler: 200 ja normalisoitu vastaus onnistuneella haulla', async () => {
  let calls = 0;
  const seen = {};
  globalThis.fetch = async (url, init) => {
    calls += 1;
    seen.url = url;
    seen.accept = init.headers.accept;
    return Response.json(odata([LATEST_ROW]));
  };
  const res = await handler(getEvent());
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 1);
  assert.equal(seen.accept, 'application/json');
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  const body = JSON.parse(res.body);
  assert.equal(body.temperatureC, 12.5);
  assert.equal(body.measuredAt, '2026-10-02T00:00:00');
  assert.equal(body.stale, false);
  assert.equal(body.station.name, 'Näsijärvi, Kyrönlahti');
  assert.equal(body.source.system, 'SYKE');
  assert.equal(body.source.license, 'CC BY 4.0');
  assert.ok(typeof body.fetchedAt === 'string' && body.fetchedAt.endsWith('Z'));
});

await test('handler: 200 + stale=true kun haku epäonnistuu mutta välimuistissa on arvo', async () => {
  // Odotetaan, että 1 ms TTL ehtii umpeutua, jolloin haku yritetään uudelleen.
  await new Promise((resolve) => setTimeout(resolve, 5));
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const res = await handler(getEvent());
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.temperatureC, 12.5);
  assert.equal(body.stale, true);
});

await test('handler: 404 tuntemattomalle polulle', async () => {
  const res = await handler(getEvent('/v1/nope'));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'NOT_FOUND' });
});

await test('handler: OPTIONS -> 204 CORS-esitarkistus', async () => {
  const res = await handler(getEvent('/v1/water/temperature', 'OPTIONS'));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-methods'], 'GET,OPTIONS');
});

console.log(`\n${passed} testiä läpi.`);
