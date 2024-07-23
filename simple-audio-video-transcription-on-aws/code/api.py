import re
import os
import logging
import boto3
import simplejson as json

from boto3.dynamodb.conditions import Attr, Key


DDB_TABLE = os.environ.get('DDB_TABLE')
AUTH_METHOD = os.environ.get('AUTH_METHOD', 'none')
RESULTS_BUCKET = os.environ.get('RESULTS_BUCKET')
LOG_LEVEL = os.environ.get('LOG_LEVEL', 'info')

RESULT_BASE_PATH = 'transcriptions'


logger = logging.getLogger('workflow')
logger.setLevel(LOG_LEVEL.upper())


ddb = boto3.resource('dynamodb')
s3 = boto3.client('s3')
uploadTable = ddb.Table(DDB_TABLE)


jobs_pattern = r'^/jobs/[0-9a-f]{10}$'
jobs_pattern_result = r'^/jobs/[0-9a-f]{10}/result$'


def get_user_from_event(event):
    '''Using the given AUTH_METHOD, retrieve the user for this request.'''

    # if using the cognito auth_method then retrieve the jwt sub as the user

    if AUTH_METHOD == 'cognito':
        return event['requestContext']['authorizer']['jwt']['claims']['sub']
    elif AUTH_METHOD == 'none':
        return event['queryStringParameters']['user']

    raise Exception('no user provided')


def handle_get_job_id(event):
    '''Retrieve the status of the job from the DynamoDB table'''

    path_params = event['pathParameters']['proxy']
    job_id = path_params.split('/')[1]
    user = get_user_from_event(event)

    response = uploadTable.query(
        KeyConditionExpression=Key('pk').eq(user),
        FilterExpression=Attr('job_id').eq(job_id),
        ScanIndexForward=False,
        ProjectionExpression='job_id, event_time, job_status',
        Limit=1
    )

    if 'Items' in response and len(response['Items']) > 0:
        return response['Items'][0], 200

    return {'error': 'not_found', 'message': 'not item found'}, 404


def handle_get_job_list(event):
    '''Get a list of jobs'''

    user = get_user_from_event(event)

    response = uploadTable.query(
        KeyConditionExpression=Key('pk').eq(user),
        ScanIndexForward=False,
        ProjectionExpression='job_id, event_time, job_status',
        Limit=5
    )

    if 'Items' in response and len(response['Items']) > 0:
        return { 'jobs': response['Items'] }, 200

    return { 'jobs': [] }, 200


def handle_get_job_result(event):
    '''Return the parsed info'''

    user = get_user_from_event(event)
    job_id = event['pathParameters']['proxy'].split('/')[1]

    key = f'{RESULT_BASE_PATH}/{user}/{job_id}.json'

    logger.debug(f'Getting Job Result bucket={RESULTS_BUCKET} obj={key} job_id={job_id} user={user}')

    res = s3.get_object(
        Bucket=RESULTS_BUCKET,
        Key=key
    )

    # only return the results data
    output = json.loads(res['Body'].read())

    return output['results'], 200


def route_request(event):
    '''Route the request based on the key to the correct function'''

    if event['rawPath'] == '/jobs':
        return handle_get_job_list(event)
    elif re.match(jobs_pattern, event['rawPath']):
        return handle_get_job_id(event)
    elif re.match(jobs_pattern_result, event['rawPath']):
        return handle_get_job_result(event)

    return {'error': 'unknown', 'message': f'no handler for rawPath={event["rawPath"]}'}, 500


def handle_event(event, context):
    '''Provides an API to interact with the file upload objects in DynamoDB'''

    logger.debug(json.dumps(event))

    response = {}
    status_code = 200

    try:
        response, status_code = route_request(event)
    except Exception as err:
        logger.error(err)
        response, status_code = { 'error': 'internal_error', 'message': 'check server logs' }, 500

    return {
        'statusCode': status_code,
        'body': json.dumps(response),
        'headers': {
            'Content-Type': 'application/json',
        },
    }
