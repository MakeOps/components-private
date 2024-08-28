#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { InstanceClass, Vpc } from 'aws-cdk-lib/aws-ec2';
import { EcsEc2ContainerDefinition, EcsJobDefinition, JobQueue, ManagedEc2EcsComputeEnvironment } from 'aws-cdk-lib/aws-batch';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { join } from 'path';
import { Rule } from 'aws-cdk-lib/aws-events';
import { Choice, Condition, DefinitionBody, JsonPath, Pass, StateMachine, StateMachineType, Succeed } from 'aws-cdk-lib/aws-stepfunctions';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CallAwsService, DynamoAttributeValue, DynamoPutItem } from 'aws-cdk-lib/aws-stepfunctions-tasks';

export class SampleTestCase extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = Vpc.fromLookup(this, 'VPC', { isDefault: true })

    const computeEnvironment = new ManagedEc2EcsComputeEnvironment(this, 'MyECSComputeEnvironment', {
      vpc,
      minvCpus: 0,
      maxvCpus: 8,
      instanceClasses: [InstanceClass.M6G],
      useOptimalInstanceClasses: false,
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

    // Instance Management State Machine
    const instanceManagementRule = new Rule(this, 'InstanceManagementEvent', {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['ecs.amazonaws.com'],
          eventName: [
            'RegisterContainerInstance',
            'DeregisterContainerInstance'
          ],
        }
      }
    })

    // Instance Management Definition

    const stepChoiceIsError = new Choice(this, 'ChoiceIsError')

    const succeed = new Succeed(this, 'Success')

    const stepGetFieldsDDB = new Pass(this, 'StepGetFieldsDDB', {
      comment: 'Filter the elements using jsonpath',
      parameters: {
        'detail': JsonPath.objectAt('$.detail'),
        'availability_zone': JsonPath.stringAt("$.detail.responseElements.containerInstance.attributes[?(@.name=='ecs.availability-zone')].value"),
        'instance_type': JsonPath.stringAt("$.detail.responseElements.containerInstance.attributes[?(@.name=='ecs.instance-type')].value"),
        'ami_id': JsonPath.stringAt("$.detail.responseElements.containerInstance.attributes[?(@.name=='ecs.ami-id')].value"),
        'cpu': JsonPath.stringAt("$.detail.responseElements.containerInstance.registeredResources[?(@.name=='CPU')].integerValue"),
        'memory': JsonPath.stringAt("$.detail.responseElements.containerInstance.registeredResources[?(@.name=='MEMORY')].integerValue"),
        'monitoring_enabled': JsonPath.stringAt("$.describeInstances.Reservations[0].Instances[0].Tags[?(@.Key=='RuntimeMonitoring')].Value")
      }
    })

    const stepPutItem = new DynamoPutItem(this, 'StepPutItem', {
      table: metadataTable,
      item: {
        'pk': DynamoAttributeValue.fromString(JsonPath.stringAt('$.detail.responseElements.containerInstance.containerInstanceArn')),
        'sk': DynamoAttributeValue.fromString('instance'),
        'availability_zone': DynamoAttributeValue.fromString(JsonPath.arrayGetItem(JsonPath.stringAt('$.availability_zone'), 0)),
        'instance_type': DynamoAttributeValue.fromString(JsonPath.arrayGetItem(JsonPath.stringAt('$.instance_type'), 0)),
        'ami_id': DynamoAttributeValue.fromString(JsonPath.arrayGetItem(JsonPath.stringAt('$.ami_id'), 0)),
        'cpu': DynamoAttributeValue.numberFromString(JsonPath.format('{}', JsonPath.arrayGetItem(JsonPath.stringAt('$.cpu'), 0))),
        'memory': DynamoAttributeValue.numberFromString(JsonPath.format('{}', JsonPath.arrayGetItem(JsonPath.stringAt('$.memory'), 0))),
        'instance_id': DynamoAttributeValue.fromString(JsonPath.stringAt('$.detail.responseElements.containerInstance.ec2InstanceId')),
        'last_event_time': DynamoAttributeValue.fromString(JsonPath.stringAt('$.detail.eventTime')),
        'last_event_type': DynamoAttributeValue.fromString(JsonPath.stringAt('$.detail.eventName')),
        'ecs_cluster': DynamoAttributeValue.fromString(JsonPath.stringAt('$.detail.requestParameters.cluster')),
        '#tagetEventType': DynamoAttributeValue.fromString(JsonPath.stringAt('$.detail.eventTime'))
      },
      expressionAttributeNames: {
        '#targetEventType': JsonPath.stringAt('$.detail.eventName')
      }
    }).next(succeed)

    const describeTags = new CallAwsService(this, 'StepDescribeInstance', {
      service: 'ec2',
      action: 'describeInstances',
      parameters: {
        'InstanceIds': JsonPath.array(JsonPath.stringAt('$.detail.responseElements.containerInstance.ec2InstanceId')),
      },
      resultPath: '$.describeInstances',
      iamResources: ['*']
    })

    const stepIsMonitored = new Choice(this, 'ChoiceIsMonitored')

    stepIsMonitored.when(
      Condition.stringEquals("$.monitoring_enabled[0]", 'enabled'),
      stepPutItem
    )
    stepIsMonitored.otherwise(succeed)

    describeTags.next(stepGetFieldsDDB).next(stepIsMonitored)

    stepChoiceIsError.when(
      Condition.isNotPresent('$.detail.errorCode'),
      describeTags
    )
    stepChoiceIsError.otherwise(succeed)

    // Define the workflow

    const sfn = new StateMachine(this, 'InstanceManagementStateMachine', {
      definitionBody: DefinitionBody.fromChainable(stepChoiceIsError),
      stateMachineType: StateMachineType.STANDARD,
      logs: {
        destination: new LogGroup(this, 'InstanceManagementStateMachineLogs', { retention: RetentionDays.ONE_WEEK })
      }
    })

    instanceManagementRule.addTarget(new SfnStateMachine(sfn))

  }
}

const app = new cdk.App();

new SampleTestCase(app, 'SimpleBatchRuntimeMonitoringStackTestCase', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

new SimpleBatchRuntimeMonitoringOnAwsStack(app, 'SimpleBatchRuntimeMonitoringStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
