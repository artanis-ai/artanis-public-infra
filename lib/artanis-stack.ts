import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface ArtanisStackProps extends cdk.StackProps {
  imageTag: string;
  clerkCustomerOrgId: string;
  domainName?: string;
  certificateArn?: string;
  ghcrCredentialsSecretName: string;
  clerkSecretsSecretName: string;
  sentryDsnSecretName: string;
}

export class ArtanisStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ArtanisStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    const dbSecret = new rds.DatabaseSecret(this, "DbSecret", {
      username: "artanis",
    });

    const db = new rds.DatabaseInstance(this, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of("16.13", "16"),
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      credentials: rds.Credentials.fromSecret(dbSecret),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      multiAz: false,
      databaseName: "artanis",
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: false,
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    const bucket = new s3.Bucket(this, "UploadsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.HEAD],
          allowedOrigins: props.domainName ? [`https://${props.domainName}`] : ["*"],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const ghcrCredentials = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GhcrCredentials",
      props.ghcrCredentialsSecretName,
    );
    const clerkSecrets = secretsmanager.Secret.fromSecretNameV2(
      this,
      "ClerkSecrets",
      props.clerkSecretsSecretName,
    );
    const sentryDsn = secretsmanager.Secret.fromSecretNameV2(this, "SentryDsn", props.sentryDsnSecretName);

    const internalApiSecret = new secretsmanager.Secret(this, "InternalApiSecret", {
      description: "INTERNAL_API_SECRET — Next.js ↔ FastAPI shared bearer",
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 48,
      },
    });

    const cluster = new ecs.Cluster(this, "Cluster", { vpc, containerInsights: true });

    const logGroup = new logs.LogGroup(this, "LogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const image = ecs.ContainerImage.fromRegistry(`ghcr.io/artanis-ai/artanis:${props.imageTag}`, {
      credentials: ghcrCredentials,
    });

    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn)
      : undefined;

    const environment: Record<string, string> = {
      NODE_ENV: "production",
      PORT: "3000",
      HOSTNAME: "0.0.0.0",
      STORAGE_DRIVER: "s3",
      LLM_BACKEND: "bedrock",
      AWS_REGION: this.region,
      S3_BUCKET: bucket.bucketName,
      CLERK_CUSTOMER_ORG_ID: props.clerkCustomerOrgId,
      PGHOST: db.instanceEndpoint.hostname,
      PGPORT: cdk.Token.asString(db.instanceEndpoint.port),
      PGDATABASE: "artanis",
    };

    const secretsMapping: Record<string, ecs.Secret> = {
      PGUSER: ecs.Secret.fromSecretsManager(dbSecret, "username"),
      PGPASSWORD: ecs.Secret.fromSecretsManager(dbSecret, "password"),
      CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(clerkSecrets, "CLERK_SECRET_KEY"),
      CLERK_PUBLISHABLE_KEY: ecs.Secret.fromSecretsManager(clerkSecrets, "CLERK_PUBLISHABLE_KEY"),
      CLERK_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(clerkSecrets, "CLERK_WEBHOOK_SECRET"),
      SENTRY_DSN: ecs.Secret.fromSecretsManager(sentryDsn),
      INTERNAL_API_SECRET: ecs.Secret.fromSecretsManager(internalApiSecret),
    };

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Service", {
      cluster,
      cpu: 1024,
      memoryLimitMiB: 2048,
      desiredCount: 1,
      publicLoadBalancer: true,
      assignPublicIp: false,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      taskImageOptions: {
        image,
        containerPort: 3000,
        environment,
        secrets: secretsMapping,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "artanis", logGroup }),
      },
      certificate,
      redirectHTTP: certificate !== undefined,
      healthCheckGracePeriod: cdk.Duration.seconds(300),
      circuitBreaker: { rollback: false },
    });

    service.targetGroup.configureHealthCheck({
      path: "/api/py/health",
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 5,
    });

    db.connections.allowDefaultPortFrom(service.service, "Fargate service to Postgres");

    bucket.grantReadWrite(service.taskDefinition.taskRole);

    service.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*anthropic.claude-*`,
        ],
      }),
    );

    new cdk.CfnOutput(this, "AlbDns", { value: service.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, "HealthUrl", {
      value: `${certificate ? "https" : "http"}://${
        props.domainName ?? service.loadBalancer.loadBalancerDnsName
      }/api/py/health`,
    });
    new cdk.CfnOutput(this, "ClerkWebhookUrl", {
      value: `${certificate ? "https" : "http"}://${
        props.domainName ?? service.loadBalancer.loadBalancerDnsName
      }/api/webhooks/clerk`,
    });
    new cdk.CfnOutput(this, "S3BucketName", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "RdsEndpoint", { value: db.instanceEndpoint.hostname });
  }
}
