/**
 * WaterTemperatureStack
 *
 * AWS-deploy water-temperature-lambda-funktiolle:
 *   API Gateway HTTP API (kevyempi kuin REST API)
 *     GET /v1/water/temperature → Lambda → SYKE Hydrologiarajapinta → JSON
 *
 * Lambda on Node.js 22 ja riippuvuudeton (ks. ../index.mjs). Bundlaus tehdään
 * esbuildillä (NodejsFunction). Ei DynamoDB-, SSM- eikä Secrets Manager
 * -käyttöä (SYKE-rajapinta ei vaadi avainta).
 *
 * Kustannus- ja väärinkäyttösuojat (kolme kerrosta):
 *   1. **API Gateway -throttlaus** ($default-stage): rate + burst → 429 ennen
 *      kuin pyyntö saavuttaa Lambdan (ks. config.ts API_THROTTLE_*).
 *   2. **Lambda varattu concurrency** = 2: kattoaa samanaikaisten suoritusten
 *      määrän, joten kustannus per hetki on rajattu.
 *   3. **5 min muistivälimuisti** Lambdassa: N selainta → 1 SYKE-kutsu / TTL.
 * Lisäksi CloudWatch-hälytys pyyntöpiikistä (+ SNS-aihe, johon voi tilata
 * sähköpostin).
 *
 * CORS-esitarkistus (OPTIONS) hoidetaan HTTP API:n tasolla; Lambda vastaa
 * lisäksi OPTIONS-pyyntöön 204:lla (hyödyllinen esim. Function URL -käytössä).
 */

import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

import {
  API_REQUEST_SPIKE_PER_5MIN,
  API_THROTTLE_BURST_LIMIT,
  API_THROTTLE_RATE_LIMIT,
  WATER_CACHE_MS,
  WATER_LAKE_NAME,
  WATER_MUNICIPALITY,
  WATER_PAIKKA_ID,
  WATER_RESERVED_CONCURRENCY,
  WATER_STALE_MAX_MS,
  WATER_STATION_LAT,
  WATER_STATION_LON,
  WATER_STATION_NAME,
  WATER_UPSTREAM_TIMEOUT_MS,
  WATER_URL,
} from './config';

export interface WaterTemperatureStackProps extends cdk.StackProps {
  /** Ympäristön nimi (dev | test | prod) — nimeämiseen ja ENVIRONMENT-muuttujaan. */
  envName: string;
  /**
   * Sallitut CORS-originit. Oletus `['*']` (sopii dev/testiin). Prodissa
   * kannattaa rajata omaan frontend-domainiin, esim.
   * `-c allowedOrigins=https://oma-frontti.fi`.
   */
  allowedOrigins?: string[];
}

export class WaterTemperatureStack extends cdk.Stack {
  public readonly waterTemperatureFunction: nodejs.NodejsFunction;
  public readonly httpApi: apigwv2.HttpApi;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: WaterTemperatureStackProps) {
    super(scope, id, props);

    const envName = props.envName;

    this.waterTemperatureFunction = new nodejs.NodejsFunction(
      this,
      'WaterTemperatureFunction',
      {
        entry: path.join(__dirname, '../../index.mjs'),
        handler: 'handler',
        functionName: `water-temperature-${envName}`,
        description: 'Tampereen seudun pintaveden lämpötila (SYKE Hydrologiarajapinta)',
        runtime: lambda.Runtime.NODEJS_22_X,
        memorySize: 256,
        // Yksi pieni OData-kutsu ehtii hyvin 10 sekunnissa.
        timeout: cdk.Duration.seconds(10),
        // Kustannuskatto: ks. lib/config.ts.
        reservedConcurrentExecutions: WATER_RESERVED_CONCURRENCY,
        // NodejsFunction vaatii, etta entry on projectRootin alla, joten
        // projectRoot on repon juuri. Bundlaus ajetaan siella; esbuild on siksi
        // juuren devDependency (ks. ../package.json).
        projectRoot: path.join(__dirname, '../..'),
        depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
        bundling: {
          format: nodejs.OutputFormat.ESM,
          target: 'node22',
          mainFields: ['module', 'main'],
          minify: true,
          sourceMap: false,
        },
        environment: {
          ENVIRONMENT: envName,
          LOG_LEVEL: 'INFO',
          SYKE_HYDRO_URL: WATER_URL,
          WATER_PAIKKA_ID: String(WATER_PAIKKA_ID),
          WATER_STATION_NAME,
          WATER_LAKE_NAME,
          WATER_MUNICIPALITY,
          WATER_STATION_LAT: String(WATER_STATION_LAT),
          WATER_STATION_LON: String(WATER_STATION_LON),
          WATER_CACHE_MS: String(WATER_CACHE_MS),
          WATER_STALE_MAX_MS: String(WATER_STALE_MAX_MS),
          WATER_UPSTREAM_TIMEOUT_MS: String(WATER_UPSTREAM_TIMEOUT_MS),
        },
      },
    );

    // Oletus-stage luodaan erikseen, jotta siihen voi asettaa throttlauksen
    // (HttpApi:n oletusstagelle ei voi antaa throttle-asetuksia suoraan).
    this.httpApi = new apigwv2.HttpApi(this, 'WaterTemperatureHttpApi', {
      description: 'water-temperature-lambda: GET /v1/water/temperature',
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: props.allowedOrigins ?? ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.GET],
        allowHeaders: ['content-type'],
      },
    });

    this.httpApi.addRoutes({
      path: '/v1/water/temperature',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'WaterTemperatureIntegration',
        this.waterTemperatureFunction,
      ),
    });

    // Throttlaus: API Gateway vastaa 429:llä ennen kuin pyyntö menee Lambdalle.
    new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: {
        rateLimit: API_THROTTLE_RATE_LIMIT,
        burstLimit: API_THROTTLE_BURST_LIMIT,
      },
    });

    // --- Kustannusvalvonta: pyyntöpiikki → hälytys (SNS). -------------------
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `water-temperature-${envName}-alarms`,
      displayName: 'water-temperature-lambda hälytykset',
    });

    const requestSpike = new cloudwatch.Alarm(this, 'ApiRequestSpikeAlarm', {
      alarmName: `water-temperature-${envName}-request-spike`,
      alarmDescription:
        'API-pyyntöjen piikki: mahdollinen väärinkäyttö tai kustannusriski (ks. API_REQUEST_SPIKE_PER_5MIN)',
      metric: this.httpApi.metric('Count', {
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: API_REQUEST_SPIKE_PER_5MIN,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    requestSpike.addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'API:n julkinen osoite',
    });
    new cdk.CfnOutput(this, 'FunctionName', {
      value: this.waterTemperatureFunction.functionName,
    });
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'SNS-aihe hälytyksille (tilaa sähköposti tarvittaessa)',
    });
  }
}
