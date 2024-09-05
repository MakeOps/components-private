#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, ITableV2, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { InstanceClass, Vpc } from 'aws-cdk-lib/aws-ec2';
import { EcsEc2ContainerDefinition, EcsJobDefinition, JobQueue, ManagedEc2EcsComputeEnvironment } from 'aws-cdk-lib/aws-batch';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { join } from 'path';
import { Rule } from 'aws-cdk-lib/aws-events';
import { Choice, Condition, DefinitionBody, JsonPath, Pass, StateMachine, StateMachineType, Succeed } from 'aws-cdk-lib/aws-stepfunctions';
import { SfnStateMachine } from 'aws-cdk-lib/aws-events-targets';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CallAwsService, DynamoAttributeValue, DynamoGetItem, DynamoPutItem } from 'aws-cdk-lib/aws-stepfunctions-tasks';

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

    this.createInstanceMonitors(metadataTable)
    this.createJobMonitors(metadataTable)

  }

  createInstanceMonitors(metadataTable: ITableV2) {

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
        'monitoring_enabled': JsonPath.stringAt("$.describeInstances.Reservations[0].Instances[0].Tags[?(@.Key=='RuntimeMonitoring')].Value"),
        'launch_time': JsonPath.stringAt("$.describeInstances.Reservations[0].Instances[0].LaunchTime")
      }
    })

    const stepPutItem = new DynamoPutItem(this, 'StepPutItem', {
      table: metadataTable,
      item: {
        'pk': DynamoAttributeValue.fromString(JsonPath.format('{}:{}', JsonPath.stringAt('$.detail.responseElements.containerInstance.containerInstanceArn'), JsonPath.stringAt('$.detail.eventName'))),
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
        'launch_time': DynamoAttributeValue.fromString(JsonPath.stringAt('$.launch_time'))
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

  createJobMonitors(metadataTable: ITableV2) {

    const jobManagementRule = new Rule(this, 'JobManagementEvent', {
      eventPattern: {
        source: ['aws.batch'],
        detailType: ['Batch Job State Change'],
      }
    })

    const succeed = new Succeed(this, 'JobStateChangeSuccess')

    const stepPass = new Pass(this, 'JobStateChangeStepPass', {
      parameters: {
        'job_name': JsonPath.stringAt('$.detail.jobName'),
        'job_id': JsonPath.stringAt('$.detail.jobId'),
        'job_queue': JsonPath.stringAt('$.detail.jobQueue'),
        'region': JsonPath.stringAt('$.region'),
        'job_definition': JsonPath.stringAt('$.detail.jobDefinition'),
        'job_status': JsonPath.stringAt('$.detail.status'),
        'last_event_type': JsonPath.stringAt('$.detail.status'),
        'last_event_time': JsonPath.stringAt('$.time'),
        'cpu': JsonPath.stringAt("$.detail.container.resourceRequirements[?(@.type=='VCPU')].value"),
        'memory': JsonPath.stringAt("$.detail.container.resourceRequirements[?(@.type=='MEMORY')].value"),
        'detail': JsonPath.objectAt('$.detail'),
        'is_fargate': JsonPath.arrayContains(JsonPath.listAt('$.detail.platformCapabilities'), 'FARGATE'),
        'is_ec2': JsonPath.arrayContains(JsonPath.listAt('$.detail.platformCapabilities'), 'EC2'),
      },
      resultPath: '$.subset'
    })

    const stepUpdateFinishedJob = new Pass(this, 'UpdateFinishedJob')

    const pathPlatformEC2 = new DynamoGetItem(this, 'StepPlatformEC2', {
      table: metadataTable,
      key: {
        'pk': DynamoAttributeValue.fromString(JsonPath.format('{}:{}', JsonPath.stringAt('$.subset.detail.container.containerInstanceArn'), 'RegisterContainerInstance')),
        'sk': DynamoAttributeValue.fromString('instance'),
      },
      resultPath: '$.instance'
    })

    pathPlatformEC2
      .next(new DynamoPutItem(this, 'StepPutItemEC2', {
        table: metadataTable,
        item: {
          'pk': DynamoAttributeValue.fromString(JsonPath.stringAt('$.subset.job_id')),
          'sk': DynamoAttributeValue.fromString('job'),
          'task_arn': DynamoAttributeValue.fromString(JsonPath.stringAt('$.subset.detail.container.taskArn')),
          'job_name': DynamoAttributeValue.fromString(JsonPath.stringAt('$.subset.job_name')),
          'started_at': DynamoAttributeValue.fromString(JsonPath.stringAt('$.subset.last_event_time')),
          'job_status': DynamoAttributeValue.fromString(JsonPath.stringAt('$.subset.job_status')),
          'job_queue': DynamoAttributeValue.fromString(JsonPath.stringAt('$.subset.job_queue')),
          'vcpu': DynamoAttributeValue.numberFromString(JsonPath.format('{}', JsonPath.arrayGetItem(JsonPath.stringAt('$.subset.cpu'), 0))),
          'memory': DynamoAttributeValue.numberFromString(JsonPath.format('{}', JsonPath.arrayGetItem(JsonPath.stringAt('$.subset.memory'), 0))),
          'container_instance_arn': DynamoAttributeValue.fromString(JsonPath.stringAt('$.subset.detail.container.containerInstanceArn')),
          // 'purchase_option': DynamoAttributeValue.fromString(JsonPath.stringAt('$.instance.Item.purchase_option.S')),
          'instance_type': DynamoAttributeValue.fromString(JsonPath.stringAt('$.instance.Item.instance_type.S')),
          'availability_zone': DynamoAttributeValue.fromString(JsonPath.stringAt('$.instance.Item.availability_zone.S')),
          'instance_id': DynamoAttributeValue.fromString(JsonPath.stringAt('$.instance.Item.instance_id.S')),
          'log_stream': DynamoAttributeValue.fromString(JsonPath.stringAt('$.subset.detail.container.logStreamName'))
        },
        comment: 'Add the details of the job and the instance to the table',
      }))
      .next(succeed)

    const pathPlatformFargate = new Pass(this, 'StepPlatformFargate', {}).next(succeed)

    const stepPlatform = new Choice(this, 'StepPlatform', { comment: 'Check the platform of the job' })
    stepPlatform
    .when(
      Condition.booleanEquals('$.subset.is_fargate', true),
      pathPlatformFargate
    ).otherwise(pathPlatformEC2)

    const stepStatusDefault = new Choice(this, 'ChoiceStatusDefault')

    stepStatusDefault
      .when(
        Condition.or(
          Condition.stringEquals('$.subset.last_event_type', 'SUCCEEDED'),
          Condition.or(Condition.and(
            Condition.stringEquals('$.subset.last_event_type', 'FAILED'),
            Condition.isPresent('$.subset.detail.container.taskArn')
          ))
        ),
        stepUpdateFinishedJob,
        { comment: 'Check if the job status is completed states (SUCCEEDED or FAILED)' }
      )
      .when(
        Condition.stringEquals('$.subset.last_event_type', 'RUNNING'),
        stepPlatform,
      )
      .otherwise(succeed)

    stepPass.next(stepStatusDefault)

    const jobStateStateMachine = new StateMachine(this, 'JobStateChangeFn', {
      definitionBody: DefinitionBody.fromChainable(stepPass),
      stateMachineType: StateMachineType.STANDARD,
      logs: {
        destination: new LogGroup(this, 'JobStateChangeFnLogs', { retention: RetentionDays.ONE_WEEK })
      }
    })

    jobManagementRule.addTarget(new SfnStateMachine(jobStateStateMachine))

  }

}

const app = new cdk.App();

new SampleTestCase(app, 'SimpleBatchRuntimeMonitoringStackTestCase', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

new SimpleBatchRuntimeMonitoringOnAwsStack(app, 'SimpleBatchRuntimeMonitoringStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
