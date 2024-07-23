import * as cdk from 'aws-cdk-lib';
import { AttributeType, Table, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { Bucket, EventType, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { DefinitionBody, IntegrationPattern, JsonPath, StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { CallAwsService, DynamoAttributeValue, DynamoUpdateItem } from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { join } from 'path';
import { loadConfig } from './cdk-helper';
import { AddRoutesOptions, CorsHttpMethod, HttpApi, HttpApiProps, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { SimpleAudioVideoTranscriptionInput } from './inputs';


// Load the configuration for the local values.yaml file.
const config = loadConfig('./values.yaml') as SimpleAudioVideoTranscriptionInput


/**
 * The outputs of the transcription stack
 */
type TranscriptionStackOutputs = {
  fileUploadsTable: string
  transcribeResultBucket: string
}


class SimpleAudioVideoTranscriptionOnAwsStack extends cdk.Stack {

  public outputs: TranscriptionStackOutputs

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ===========================================================
    // Create the S3 Buckets and the DynamoDB table for this stack
    // ===========================================================


    // Declare the input Amazon S3 bucket
    const uploadBucket = new Bucket(this, 'UploadBucket')


    // Declare the transcript output Amazon S3 bucket
    const transcribeResultBucket = new Bucket(this, 'TranscribeResultBucket')


    // If set in the cdk.json, update the cors for S3 - useful when uploading directly from browser.
    if (config.s3CorsEnabled) {
      uploadBucket.addCorsRule({
        allowedMethods: [HttpMethods.POST, HttpMethods.PUT, HttpMethods.DELETE],
        allowedOrigins: config.s3CorsOrigins,
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 0
      })
    }


    // Create a DynamoDB table for storing the uploaded file metadata
    const fileUploadsTable = new Table(this, 'FileUploadTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING }
    })


    // =========================================================
    // Construct the AWS Step Function for processing the files.
    // =========================================================


    // Create a new IAM role to provide permissions to our step function file process
    const transcribeProcessorRole = new Role(this, 'TranscribeProcessorRole', {
      assumedBy: new ServicePrincipal('states.amazonaws.com')
    })


    // Allow the transcribe processor to tag resources
    transcribeProcessorRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['transcribe:TagResource'],
      resources: ['*']
    }))


    // Grant permissions to the Step Function IAM Role
    transcribeResultBucket.grantWrite(transcribeProcessorRole)
    uploadBucket.grantRead(transcribeProcessorRole)
    fileUploadsTable.grantWriteData(transcribeProcessorRole)


    // STEP 1 - Update DynamoDB Record to SET job_status = 'IN_PROGRESS'
    const stepStatusInProgress = new DynamoUpdateItem(this, 'StepStatusInProgress', {
      stateName: 'Set In Progress',
      key: {
        pk: DynamoAttributeValue.fromString(JsonPath.stringAt('$.user')),
        sk: DynamoAttributeValue.fromString(JsonPath.stringAt('$.event_time'))
      },
      table: fileUploadsTable,
      expressionAttributeValues: {
        ':vstatus': DynamoAttributeValue.fromString('IN_PROGRESS')
      },
      updateExpression: 'SET job_status = :vstatus',
      resultPath: '$.updateProgress',
    })


    // STEP 2 - Call the StartTranscriptionJob API to start processing our uploaded file.
    const stepStartTranscriptionJob = new CallAwsService(this, 'StepStartTranscriptionJob', {
      stateName: 'Trigger Transcription Job',
      service: 'transcribe',
      action: 'startTranscriptionJob',
      parameters: {
        TranscriptionJobName: JsonPath.stringAt('$.job_id'),
        Media: { MediaFileUri: JsonPath.stringAt('$.media_file_uri') },
        LanguageCode: config.transcribeLocale,
        OutputBucketName: transcribeResultBucket.bucketName,
        OutputKey: JsonPath.stringAt('$.output_key'),
      },
      iamResources: ['*'],
      resultPath: '$.startTranscriptionJob',
    })


    // STEP 3 - Use a AWS SDK service integration with waitForTaskToken to store the Task.Token for later
    const stepWaitForTranscribe = new CallAwsService(this, 'WaitForTranscribe', {
      stateName: 'Wait for Transcribe',
      service: 'dynamodb',
      integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      action: 'updateItem',
      parameters: {
        Key: {
          pk: { S: JsonPath.stringAt('$.user') },
          sk: { S: JsonPath.stringAt('$.event_time') }
        },
        TableName: fileUploadsTable.tableName,
        ExpressionAttributeValues: {
          ':vtoken': { S: JsonPath.base64Encode(JsonPath.stringAt('$$.Task.Token')) }
        },
        UpdateExpression: 'SET task_token = :vtoken'
      },
      iamResources: ["*"],
      resultPath: '$.waitForTranscribe'
    })


    // STEP 4 - Update the record to SET job_status = 'COMPLETE'
    const stepStatusComplete = new DynamoUpdateItem(this, 'StepUpdateItemComplete', {
      stateName: 'Update Transcribe Complete',
      key: {
        pk: DynamoAttributeValue.fromString(JsonPath.stringAt('$.user')),
        sk: DynamoAttributeValue.fromString(JsonPath.stringAt('$.event_time'))
      },
      table: fileUploadsTable,
      expressionAttributeValues: {
        ':vstatus': DynamoAttributeValue.fromString('COMPLETE')
      },
      updateExpression: 'SET job_status = :vstatus',
      resultPath: '$.updateProgressComplete',
    })


    // Define the flow of our transcription processing pipeline.
    const stepFunctionDefinition = stepStatusInProgress
      .next(stepStartTranscriptionJob)
      .next(stepWaitForTranscribe)
      .next(stepStatusComplete)



    // Define the AWS Step Function and provide role with permissions.
    const uploadProcessorSfn = new StateMachine(this, 'UploadProcessorSfn', {
      definitionBody: DefinitionBody.fromChainable(stepFunctionDefinition),
      comment: 'Workflow to process audio / video files',
      role: transcribeProcessorRole
    })


    // =================================================================================================
    // Create a Lambda functions that handle s3:PutObject on new files and the Amazon Transcribe Results
    // =================================================================================================


    // Create a trigger function to react to new uploaded objects
    const newFileHandlerFunc = new DockerImageFunction(this, 'NewFileHandlerFunc', {
      code: DockerImageCode.fromImageAsset(join(__dirname, 'code'), { cmd: ['workflow.handle_new_media_files'] }),
      memorySize: 1024,
      environment: {
        'STATE_MACHINE_ARN': uploadProcessorSfn.stateMachineArn,
        'DDB_TABLE': fileUploadsTable.tableName,
        'USER_INFO': config.s3UserInfo,
      }
    })


    // Grant appropriate permissions to the upload
    fileUploadsTable.grantWriteData(newFileHandlerFunc)
    uploadProcessorSfn.grantStartExecution(newFileHandlerFunc)
    uploadBucket.grantRead(newFileHandlerFunc, 'uploads/*')


    // Connect the Amazon S3 notification to trigger the lambda function
    uploadBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(newFileHandlerFunc), {
        prefix: 'uploads/'
      }
    )


    // Create AWS Lambda Function to handle Transcription Results
    const transcribeResultHandlerFunc = new DockerImageFunction(this, 'TranscribeResultHandlerFunc', {
      code: DockerImageCode.fromImageAsset(join(__dirname, 'code'), { cmd: ['workflow.handle_transcribe_complete_event'] }),
      memorySize: 1024,
      environment: {
        'DDB_TABLE': fileUploadsTable.tableName
      },
    })


    // Connect the Amazon S3 notification to trigger the lambda function
    transcribeResultBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(transcribeResultHandlerFunc), {
        prefix: 'transcriptions/',
        suffix: '.json'
      }
    )


    // Grant appropriate permissions to the function to update the StateMachine and get details of the transcription.
    transcribeResultHandlerFunc.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['transcribe:GetTranscriptionJob'],
      resources: ['*']
    }))
    transcribeResultHandlerFunc.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['states:SendTaskSuccess'],
      resources: [uploadProcessorSfn.stateMachineArn]
    }))
    fileUploadsTable.grantReadData(transcribeResultHandlerFunc)


    // Provide outputs for the API
    this.outputs = {
      fileUploadsTable: fileUploadsTable.tableName,
      transcribeResultBucket: transcribeResultBucket.bucketName
    }

  }
}

interface TranscriptionAPIConfig extends cdk.StackProps {
  dynamoDbTableName: string
  resultsBucketName: string
}

class SimpleAudioVideoTranscriptionOnAwsAPIStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TranscriptionAPIConfig) {
    super(scope, id, props);

    // ======================================================
    // Create our API to handle basic requests for job status
    // ======================================================


    // Fetch resources from the provided input props.
    const table = TableV2.fromTableName(this, 'FileUploadTable', props.dynamoDbTableName)
    const resultsBucket = Bucket.fromBucketName(this, 'ResultsBucket', props.resultsBucketName)


    // Define a Docker Image function with the code for our API.
    const apiFunc = new DockerImageFunction(this, 'APIFunction', {
      code: DockerImageCode.fromImageAsset(join(__dirname, 'code'), { cmd: ['api.handle_event'] }),
      memorySize: 1024,
      environment: {
        'DDB_TABLE': table.tableName,
        'RESULTS_BUCKET': props.resultsBucketName,
        'AUTH_METHOD': config.apiAuthMethod
      },
    })


    // Grant appropriate permissions to the Lambda function
    table.grantReadData(apiFunc)
    resultsBucket.grantRead(apiFunc)


    // Defining the API
    let apiProps: HttpApiProps = {}


    // If CORS needs to be enabled on the API Gateway endpoint - useful for calling from browser.
    if (config.apiCorsEnabled) {
      apiProps = {
        ...apiProps,
        corsPreflight: {
          allowHeaders: ['Authorization'],
          allowMethods: [
            CorsHttpMethod.GET,
            CorsHttpMethod.HEAD,
            CorsHttpMethod.OPTIONS,
          ],
          allowOrigins: config.apiCorsOrigins
        },
        defaultAuthorizationScopes: ['openid']
      }
    }


    // Define the HTTP API
    const api = new HttpApi(this, 'TranscriptionStatusAPI', apiProps)


    // Define a catch-all proxy route.
    let addRouteOptions: AddRoutesOptions = {
      path: '/{proxy+}',
      methods: [ HttpMethod.GET ],
      integration: new HttpLambdaIntegration('JobStatusIntegration', apiFunc),
    }


    // If cognito auth is enabled for the API Gateway endpoint apply to the integration.
    if (config.apiAuthMethod == 'cognito') {

      const userPool = UserPool.fromUserPoolId(this, 'UserPoolId', config.apiCognitoUserPoolId)
      const userPoolClient = UserPoolClient.fromUserPoolClientId(this, 'UserPoolClient', config.apiCognitoAppClientId)
      const authorizer = new HttpUserPoolAuthorizer('TranscriptJobAuthorizer', userPool, {
        userPoolClients: [userPoolClient],
      })

      addRouteOptions = {...addRouteOptions, authorizer: authorizer}

    }

    // Add the route to the API
    api.addRoutes(addRouteOptions)

  }
}

// =====================================================
// Creating the app and attaching the stacks to the app.
// =====================================================


const app = new cdk.App();


const transcriptionStack = new SimpleAudioVideoTranscriptionOnAwsStack(app, 'SimpleAudioVideoTranscriptionOnAwsStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});


// If API should be deployed.
if (config.apiEnabled) {
  new SimpleAudioVideoTranscriptionOnAwsAPIStack(app, 'SimpleAudioVideoTranscriptionOnAwsAPIStack', {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    dynamoDbTableName: transcriptionStack.outputs.fileUploadsTable,
    resultsBucketName: transcriptionStack.outputs.transcribeResultBucket
  })
}
