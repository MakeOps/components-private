#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { AmazonLinuxCpuType, InstanceClass, InstanceSize, InstanceType, MachineImage, Vpc } from 'aws-cdk-lib/aws-ec2';
import { EcsEc2ContainerDefinition, EcsJobDefinition, EcsMachineImageType, JobQueue, ManagedEc2EcsComputeEnvironment } from 'aws-cdk-lib/aws-batch';
import { AmiHardwareType, ContainerImage, EcsOptimizedImage } from 'aws-cdk-lib/aws-ecs';
import { join } from 'path';

export class SampleTestCase extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = Vpc.fromLookup(this, 'VPC', { isDefault: true })

    const computeEnvironment = new ManagedEc2EcsComputeEnvironment(this, 'MyECSComputeEnvironment', {
      vpc,
      minvCpus: 0,
      maxvCpus: 8,
      instanceClasses: [InstanceClass.M6G],
      useOptimalInstanceClasses: false
    })

    cdk.Tags.of(computeEnvironment).add('RuntimeMonitoring', 'enabled')

    const jobQueue = new JobQueue(this, 'Queue', {})
    jobQueue.addComputeEnvironment(computeEnvironment, 1)

    const jobDef = new EcsJobDefinition(this, 'ECSJobDef', {
      container: new EcsEc2ContainerDefinition(this, 'defaultContainer', {
        image: ContainerImage.fromAsset(join(__dirname, 'job')),
        memory: cdk.Size.mebibytes(2048),
        cpu: 1,
      }),
    })


  }
}

export class SimpleBatchRuntimeMonitoringOnAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const metadataTable = new TableV2(this, 'JobMetadataTable', {
      partitionKey: {
        type: AttributeType.STRING,
        name: 'pk'
      },
      sortKey: {
        type: AttributeType.STRING,
        name: 'sk'
      }
    })

  }
}

const app = new cdk.App();

new SampleTestCase(app, 'SimpleBatchRuntimeMonitoringStackTestCase', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

new SimpleBatchRuntimeMonitoringOnAwsStack(app, 'SimpleBatchRuntimeMonitoringStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
