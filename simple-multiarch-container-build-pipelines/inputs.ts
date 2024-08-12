import { CDKHelperConfig } from "./cdk-helper";

/**
 * Defines an interface for input and configuration of the stack.
 */

export interface SourceGitHub {
  type: string
  owner: string
  repo: string
  branch: string
  connectionArn: string
  triggerOnPush: boolean
}

export interface SourceType {
  github: SourceGitHub
}

export interface DestinationECR {
  repoName: string
  exists: boolean
  tagRules: string[]
}

export interface DestinationType {
  ecr: DestinationECR
}

export interface SimpleMultiArchContainerBuildPipelinesInput extends CDKHelperConfig {

  pipelineName: string

  source: SourceType

  destination: DestinationType

  workDir: string

}
