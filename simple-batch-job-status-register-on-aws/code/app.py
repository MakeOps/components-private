import boto3
import logging
import simplejson as json

logger = logging.getLogger()

logger.setLevel(logging.INFO)


def handle_event(event, context):
    logger.info(event)
    return
