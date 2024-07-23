import { CDKHelperConfig } from "./cdk-helper";

/**
 * Defines an interface for input and configuration of the stack.
 */
export interface SimpleAudioVideoTranscriptionInput extends CDKHelperConfig {

  transcribeLocale: string

  s3CorsEnabled: boolean

  s3CorsOrigins: string[]

  s3UserInfo: string

  apiEnabled: boolean

  apiAuthMethod: string

  apiCorsEnabled: boolean

  apiCorsOrigins: string[]

  apiCognitoUserPoolId: string

  apiCognitoAppClientId: string

}
