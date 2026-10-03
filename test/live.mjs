/**
 * Live-testi: kutsuu handleria ja tekee oikean SYKE-kutsun (vaatii verkkoyhteyden).
 *
 * Aja: `npm run live`
 */

import { handler } from '../index.mjs';

const res = await handler({
  rawPath: '/v1/water/temperature',
  requestContext: { http: { method: 'GET' } },
});

console.log(`HTTP ${res.statusCode}`);
console.log(JSON.stringify(JSON.parse(res.body), null, 2));

if (res.statusCode !== 200) process.exitCode = 1;
