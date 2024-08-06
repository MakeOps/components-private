#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';
import { HttpApi, PayloadFormatVersion } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export class SimplePythonWebhookStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const webhookHandler = new DockerImageFunction(this, 'WebhookFunction', {
      code: DockerImageCode.fromImageAsset(join(__dirname, 'code'), {
        entrypoint: ["/usr/local/bin/python", "-m", "awslambdaric"],
        cmd: ["handler.webhook_handler"]
      }),
      logRetention: RetentionDays.TWO_WEEKS
    })

    const api = new HttpApi(this, 'API', {
      description: 'Basic Python Webhook Handler',
      defaultIntegration: new HttpLambdaIntegration('DefaultIntegration', webhookHandler, {
        payloadFormatVersion: PayloadFormatVersion.VERSION_2_0
      }),
    })

    new cdk.CfnOutput(this, 'APIEndpoint', { value: api.apiEndpoint })
    new cdk.CfnOutput(this, 'LoggingOutput', { value: webhookHandler.logGroup.logGroupName })

  }
}

const app = new cdk.App();
new SimplePythonWebhookStack(app, 'SimplePythonWebhookStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
