#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { ArtanisStack } from "../lib/artanis-stack";

const app = new cdk.App();

const stackName = (app.node.tryGetContext("stackName") as string | undefined) ?? "artanis-selfhost";
const imageTag = app.node.tryGetContext("imageTag") as string | undefined;
const clerkCustomerOrgId = app.node.tryGetContext("clerkCustomerOrgId") as string | undefined;
const domainName = (app.node.tryGetContext("domainName") as string | undefined) || undefined;
const certificateArn = (app.node.tryGetContext("certificateArn") as string | undefined) || undefined;
const ghcrCredentialsSecretName = app.node.tryGetContext("ghcrCredentialsSecretName") as string | undefined;
const clerkSecretsSecretName = app.node.tryGetContext("clerkSecretsSecretName") as string | undefined;
const sentryDsnSecretName = app.node.tryGetContext("sentryDsnSecretName") as string | undefined;

if (!imageTag) throw new Error("Missing context: imageTag");
if (!clerkCustomerOrgId) throw new Error("Missing context: clerkCustomerOrgId");
if (!ghcrCredentialsSecretName) throw new Error("Missing context: ghcrCredentialsSecretName");
if (!clerkSecretsSecretName) throw new Error("Missing context: clerkSecretsSecretName");
if (!sentryDsnSecretName) throw new Error("Missing context: sentryDsnSecretName");

new ArtanisStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
  },
  imageTag,
  clerkCustomerOrgId,
  domainName,
  certificateArn,
  ghcrCredentialsSecretName,
  clerkSecretsSecretName,
  sentryDsnSecretName,
});
