#!/usr/bin/env node
/**
 * CDK-sovelluksen juuri: `npx ts-node bin/app.ts` (ks. cdk.json).
 *
 * Ympäristöt ja konfigurointi valitaan kontekstilla:
 *   cdk deploy                          # dev (oletus)
 *   cdk deploy -c env=prod              # prod
 *   cdk deploy -c env=prod -c allowedOrigins=https://oma-frontti.fi
 *
 * `-c`-arvot ovat komentokohtaisia; vakioarvot kannattaa lisätä
 * infra/cdk.json:n `context`-lohkoon.
 */
import * as cdk from 'aws-cdk-lib';

import { WaterTemperatureStack } from '../lib/water-temperature-stack';

const app = new cdk.App();

const envName = (app.node.tryGetContext('env') as string | undefined) ?? 'dev';

// Sallitut CORS-originit (pilkkueroteltuna). Oletus: kaikki ('*'), joka sopii
// dev/testiin; prodissa kannattaa rajata omaan frontend-domainiin.
const allowedOrigins = (app.node.tryGetContext('allowedOrigins') as string | undefined)
  ?.split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

new WaterTemperatureStack(app, `WaterTemperatureStack-${envName}`, {
  envName,
  allowedOrigins,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-north-1',
  },
  description:
    'water-temperature-lambda: Tampereen seudun pintaveden lämpötila (SYKE Hydrologiarajapinta)',
});
