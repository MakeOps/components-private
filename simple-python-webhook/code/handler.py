import os
import logging
import simplejson as json

LOG_LEVEL = os.environ.get('LOG_LEVEL', 'info')

logging.basicConfig(
    level=logging.INFO,
    format='%(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)
logger.setLevel(LOG_LEVEL.upper())


def webhook_handler(event, _context):
    '''Webhook Event Handler Function'''

    # For an example event see example.json
    print(json.dumps(event))

    ## ======= YOUR CODE ========

    response_payload = {'version': '0.1.0'}

    ## ==== END OF YOUR CODE ====

    return {
        'statusCode': 200,
        'body': json.dumps(response_payload),
        'headers': {
            'Content-Type': 'application/json'
        }
    }
