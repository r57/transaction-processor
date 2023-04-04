#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "@aws-cdk/core";

import { TransactionProcessorStack } from "../lib/transaction-processor-stack";

const awsAccount = process.env.AWS_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT;
const awsRegion = process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION;

const app = new cdk.App();

new TransactionProcessorStack(app, "TransactionProcessorStack", {
  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
  env: { account: awsAccount, region: awsRegion },
});
