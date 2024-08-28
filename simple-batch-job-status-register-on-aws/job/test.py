import os
import boto3
import uuid

os.environ['AWS_PROFILE'] = 'jason'

region = 'eu-west-1'
batch = boto3.client('batch', region)

job_queue = 'Queue4A7E3555-Q94fb9W7hQSarqKO'
job_def = 'ECSJobDefACAEF3CA-8391e4346710d2a'

def submit_job(job_queue, job_def):
    response = batch.submit_job(
        jobName=f'{uuid.uuid4().hex}',
        jobQueue=job_queue,
        jobDefinition=job_def,
    )
    return response


def test_submit_job():
    submit_job(job_queue, job_def)
