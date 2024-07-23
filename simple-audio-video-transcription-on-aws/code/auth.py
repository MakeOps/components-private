import jwt
import requests

from jwt.exceptions import PyJWTError


def validate_cognito_token(token):
    '''Validates a provided cognito JWT'''

    # Decode the token without verification to extract the headers
    unverified_headers = jwt.get_unverified_header(token)

    # Extract the key ID (kid) from the headers
    kid = unverified_headers['kid']

    # Decode the token without verification to extract the 'iss' claim
    unverified_claims = jwt.decode(token, options={"verify_signature": False})
    iss = unverified_claims['iss']

    # Construct the JWKs URL
    jwks_url = f"{iss}/.well-known/jwks.json"

    # Fetch the JWKs
    jwks_response = requests.get(jwks_url)
    jwks = jwks_response.json()

    # Find the key that matches the kid from the token
    public_key = None
    for key in jwks['keys']:
        if key['kid'] == kid:
            public_key = jwt.algorithms.RSAAlgorithm.from_jwk(key)
            break

    if not public_key:
        raise ValueError("Public key not found")

    try:
        # Verify and decode the token
        payload = jwt.decode(
            token,
            public_key,
            algorithms=['RS256'],
            options={"verify_aud": False}  # You might want to verify the audience as well
        )
        return payload
    except PyJWTError as e:
        print(f"Token validation failed: {str(e)}")
        return None


def get_unverified_claims(token):
    '''Return the claims of the token without checking validity'''
    return jwt.decode(token, options={'verify_signature': False})
