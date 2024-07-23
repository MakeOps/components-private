import os
import sys
import base64
import uuid
import logging

from urllib.parse import unquote

import boto3
import simplejson as json

from boto3.dynamodb.conditions import Key, Attr
from auth import validate_cognito_token


STATE_MACHINE_ARN = os.environ.get('STATE_MACHINE_ARN')
DDB_TABLE = os.environ.get('DDB_TABLE')
USER_INFO = os.environ.get('USER_INFO', 'none')
LOG_LEVEL = os.environ.get('LOG_LEVEL', 'debug')


logger = logging.getLogger('workflow')
logger.setLevel(LOG_LEVEL.upper())


sfn = boto3.client('stepfunctions')
ddb = boto3.resource('dynamodb')
s3 = boto3.client('s3')
transcribe = boto3.client('transcribe')


uploadTable = ddb.Table(DDB_TABLE)


def save_job_status_record(user: str, metadata: dict):
    '''Store the uploaded file info'''

    res = uploadTable.put_item(
      Item={
        'pk': user,
        'sk': metadata['event_time'],
        'job_status': 'SUBMITTED',
        **metadata
      }
    )

    logger.debug(f'DynamoDB Save Record pk={user} sk={metadata["event_time"]} result={res}')


def get_object_details_from_record(record):
    '''Retrieve the bucket_name and the object key from a S3 event record'''

    object_key = unquote(record['s3']['object']['key'])
    bucket_name = record['s3']['bucket']['name']

    return bucket_name, object_key


def get_user_from_object_metadata(bucket_name, object_key):
    '''Retrieve the user from the given input event

    if USER_INFO == 'user' then use the 'User' value in the object metadata
    if USER_INFO == 'token' then use the 'sub' value from the validated jwt stored in 'Token' metadata
    if USER_INFO == 'none' then use default
    else return default user 'unknown'

    '''

    # Get the S3 object metadata
    metadata = s3.head_object(
        Bucket=bucket_name,
        Key=object_key
    )['Metadata']

    logger.debug(f'Evaluating head Details for bucket={bucket_name} obj={object_key} res={json.dumps(metadata)}')

    default_user = 'unknown'

    if USER_INFO == 'user' and 'user' in metadata:
        return metadata['user']

    # If not auth method check for 'User' in the metadata
    elif USER_INFO == 'token' and 'token' in metadata:
        token = metadata['token']

        decoded_token = validate_cognito_token(token)

        if decoded_token:
            return decoded_token['sub']

    return default_user



def handle_file_record(record: dict):
    '''Handle a single new file event'''

    bucket_name, object_key = get_object_details_from_record(record)

    user = get_user_from_object_metadata(bucket_name, object_key)

    # Generate a job ID
    job_id = f'{uuid.uuid4().hex[:10]}'

    payload = {
        'user': user,
        'job_id': job_id,
        'event_time': record['eventTime'],
        'media_file_uri': f's3://{bucket_name}/{object_key}',
        'output_key': f'transcriptions/{user}/{job_id}.json',
        'size': record['s3']['object']['size']
    }

    logger.info(f'Handling Object Event user={user} job_id={job_id} media_file_uri={payload["media_file_uri"]}')
    logger.debug(json.dumps(payload))

    save_job_status_record(user, payload)

    res = sfn.start_execution(
        stateMachineArn=STATE_MACHINE_ARN,
        input=json.dumps(payload)
    )

    return {
        'execution_arn': res['executionArn'],
        **payload
    }


def handle_new_media_files(event, _context):
    '''Handle new file uploaded to S3'''

    logger.debug(json.dumps(event))

    output_objects = []

    for record in event['Records']:

        if record['eventName'] not in ['ObjectCreated:CompleteMultipartUpload', 'ObjectCreated:Put']:
            continue

        output_objects.append(handle_file_record(record))

    return output_objects


def query_for_task_details(user, job_id):
    '''Return the job record based on user and job_id'''

    res = uploadTable.query(
        KeyConditionExpression=Key('pk').eq(user),
        FilterExpression=Attr('job_id').eq(job_id),
        ScanIndexForward=False,
        ProjectionExpression='pk, sk, task_token, event_time',
        Limit=1
    )

    if len(res['Items']) == 0:
        return {}

    return res['Items'][0]


def handle_transcribe_complete_record(record):
    '''Handle each file that was outputted from the transcribe job.'''

    # Key is in format transcriptions/<user>/<job_id>.json
    bucket_name, object_key = get_object_details_from_record(record)

    pathname, _ext = os.path.splitext(object_key)
    _, user, job_id = pathname.split('/')

    logger.info(f'handling new file bucket_name={bucket_name} object_key={object_key} user={user} job_id={job_id}')

    # transcribe_job_details = transcribe.get_transcription_job(
    #     TranscriptionJobName=job_id
    # )

    # print(transcribe_job_details)
    # print(transcribe_job_details['TranscriptionJob']['Tags'])

    task_record_details = query_for_task_details(user, job_id)

    logger.debug('task record details' + str(task_record_details))

    sfn.send_task_success(
        taskToken=base64.b64decode(task_record_details['task_token']).decode(),
        output=json.dumps({'sk': task_record_details['sk'], 'pk': task_record_details['pk']})
    )

    return True


def handle_transcribe_complete_event(event, context):
    '''Handler for the transcription complete event.'''

    logger.debug(json.dumps(event))

    output_objects = []

    for record in event['Records']:
        if record['eventName'] not in ['ObjectCreated:CompleteMultipartUpload', 'ObjectCreated:Put']:
            continue

        output_objects.append(handle_transcribe_complete_record(record))

    return output_objects
