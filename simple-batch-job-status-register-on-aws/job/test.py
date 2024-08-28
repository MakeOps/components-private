import os
import boto3
import uuid
import json

os.environ['AWS_PROFILE'] = 'jason'

region = 'eu-west-1'
batch = boto3.client('batch', region)
sfn = boto3.client('stepfunctions', region)

job_queue = 'Queue4A7E3555-wcfVDPHGNvj2uTRD'
job_def = 'ECSJobDefACAEF3CA-4cea2815a0368b1'

def submit_job(job_queue, job_def):
    response = batch.submit_job(
        jobName=f'{uuid.uuid4().hex}',
        jobQueue=job_queue,
        jobDefinition=job_def,
    )
    return response


def test_submit_job():
    submit_job(job_queue, job_def)


def test_start_execution():

    with open('sample-input.json') as fp:
        payload = json.load(fp)

    sfn.start_execution(
        stateMachineArn='arn:aws:states:eu-west-1:375479154925:stateMachine:InstanceManagementStateMachineBAEE2EAE-d3ziSnKf2H93',
        input=json.dumps(payload)
    )
