#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TapiStack } from '../lib/stacks/tapi-stack';

const app = new cdk.App();

new TapiStack(app, 'TapiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Tapi Challenge — Serverless batch processing with SQS FIFO + Step Functions',
  tags: {
    Project: 'TapiChallenge',
    Environment: process.env.ENVIRONMENT ?? 'dev',
    ManagedBy: 'CDK',
  },
});

app.synth();
