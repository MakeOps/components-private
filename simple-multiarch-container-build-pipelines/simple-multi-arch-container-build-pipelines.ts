#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { loadConfig } from './cdk-helper';
import { SimpleMultiArchContainerBuildPipelinesInput } from './inputs';
import { CodeBuildAction, CodeStarConnectionsSourceAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Artifact, Pipeline, PipelineType } from 'aws-cdk-lib/aws-codepipeline';
import { BuildEnvironmentVariableType, BuildSpec, LinuxArmBuildImage, LinuxBuildImage, PipelineProject } from 'aws-cdk-lib/aws-codebuild';
import { IRepository, Repository } from 'aws-cdk-lib/aws-ecr';
import { IRole, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { version } from 'os';

const config = loadConfig() as SimpleMultiArchContainerBuildPipelinesInput


interface CreateBuildSpecOptions {
  tagRules: string[]
  arch: string
}

function repoTagFromTagRule(tagRule: string): any {
  switch (tagRule) {
    case 'latest':
      return `$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO:latest`
    case 'commit-short':
      return `$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO:$CODEBUILD_RESOLVED_SOURCE_VERSION_SHORT`
    case 'commit':
    default:
      return `$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO:$CODEBUILD_RESOLVED_SOURCE_VERSION`
  }
}

function createBuildSpec(opts: CreateBuildSpecOptions) {

  const preBuildCommands = [
    'export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query=Account --output text)',
    'export CODEBUILD_RESOLVED_SOURCE_VERSION_SHORT=${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}',
    '$(aws ecr get-login --no-include-email --region $AWS_DEFAULT_REGION)'
  ]

  if (config.workDir != '') {
    preBuildCommands.unshift(`cd ${config.workDir}`)
  }

  const repoDestLabels = opts.tagRules.map(repoTagFromTagRule)
  const imageTagLines = repoDestLabels.map(repo => `docker tag $IMAGE_REPO:$IMAGE_TAG ${repo}-${opts.arch}`)
  const imagePushLines = repoDestLabels.map(repo => `docker push ${repo}-${opts.arch}`)

  return {
    version: 0.2,
    phases: {
      install: {
        commands: [
          'yum install -y awscli jq',
          'nohup /usr/local/bin/dockerd --host=unix:///var/run/docker.sock --host=tcp://127.0.0.1:2375 &',
          'timeout 15 sh -c "until docker info; do echo .; sleep 1; done"'
        ]
      },
      pre_build: {
        commands: preBuildCommands
      },
      build: {
        commands: [
          `docker build --build-arg ARCH=${opts.arch} -t $IMAGE_REPO:$IMAGE_TAG .`,
          ...imageTagLines
        ]
      },
      post_build: {
        commands: [
          ...imagePushLines
        ]
      }
    }
  }
}

function pushManifestBuildSpec(tagRules: string[]) {

  const repoDestLabels = tagRules.map(repoTagFromTagRule)
  const createManifests = repoDestLabels.map(repo => `docker manifest create ${repo} ${repo}-amd64 ${repo}-arm64`)
  const pushManifests = repoDestLabels.map(repo => `docker manifest push ${repo}`)

  return {
    version: 0.2,
    phases: {
      install: {
        commands: [
          'yum install -y awscli jq',
          'nohup /usr/local/bin/dockerd --host=unix:///var/run/docker.sock --host=tcp://127.0.0.1:2375 &',
          'timeout 15 sh -c "until docker info; do echo .; sleep 1; done"'
        ]
      },
      pre_build: {
        commands: [
          'export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query=Account --output text)',
          'export CODEBUILD_RESOLVED_SOURCE_VERSION_SHORT=${CODEBUILD_RESOLVED_SOURCE_VERSION:0:8}',
          '$(aws ecr get-login --no-include-email --region $AWS_DEFAULT_REGION)',
        ]
      },
      build: {
        commands: createManifests
      },
      post_build: {
        commands: pushManifests
      }
    }
  }
}

interface ImageBuildPipelineProjectProps {

  arch: string

  imageRepo: IRepository

  buildRole: IRole

}

function ImageBuildPipelineProject(scope: Construct, id: string, props: ImageBuildPipelineProjectProps) {

  const project = new PipelineProject(scope, `PipelineProject${id}`, {
    buildSpec: BuildSpec.fromObjectToYaml(createBuildSpec({
      arch: props.arch,
      tagRules: config.destination.ecr.tagRules
    })),
    environment: {
      buildImage: (props.arch == 'arm64') ? LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_2_0 : LinuxBuildImage.AMAZON_LINUX_2_4,
      privileged: true
    },
    environmentVariables: {
      IMAGE_REPO: {
        type: BuildEnvironmentVariableType.PLAINTEXT,
        value: props.imageRepo.repositoryName
      },
      IMAGE_TAG: {
        type: BuildEnvironmentVariableType.PLAINTEXT,
        value: 'latest'
      },
      ARCH: {
        type: BuildEnvironmentVariableType.PLAINTEXT,
        value: props.arch.toLowerCase()
      }
    },
    role: props.buildRole
  })

  return project

}

interface ManifestPushPipelineProjectProps {

  imageRepo: IRepository

  buildRole: IRole

  tagRules: string[]

}


function ManifestPushPipelineProject(scope: Construct, id: string, props: ManifestPushPipelineProjectProps) {

  const project = new PipelineProject(scope, id, {
    buildSpec: BuildSpec.fromObjectToYaml(pushManifestBuildSpec(props.tagRules)),
    environment: {
      buildImage: LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_2_0,
      privileged: true
    },
    environmentVariables: {
      IMAGE_REPO: {
        type: BuildEnvironmentVariableType.PLAINTEXT,
        value: props.imageRepo.repositoryName
      },
      IMAGE_TAG: {
        type: BuildEnvironmentVariableType.PLAINTEXT,
        value: 'latest'
      },
    },
    role: props.buildRole
  })

  return project
}


function destinationFromConfig(scope: Construct): IRepository {

  return (config.destination.ecr.exists) ?
    Repository.fromRepositoryName(scope, 'DestinationRepoMulti', `${config.destination.ecr.repoName}`)
    : new Repository(scope, 'DestinationRepoMulti', { repositoryName: `${config.destination.ecr.repoName}` })

  // const repoArm = (config.destination.ecr.exists) ?
  //   Repository.fromRepositoryName(scope, 'DestinationRepoArm', `${config.destination.ecr.repoName}-arm64`)
  //   : new Repository(scope, 'DestinationRepoArm', { repositoryName: `${config.destination.ecr.repoName}-arm64` })

  // const repoX64 = (config.destination.ecr.exists) ?
  //   Repository.fromRepositoryName(scope, 'DestinationRepoX64', `${config.destination.ecr.repoName}-amd64`)
  //   : new Repository(scope, 'DestinationRepoX64', { repositoryName: `${config.destination.ecr.repoName}-amd64` })

}


export class SimpleMultiArchContainerBuildPipelinesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const sourceArtifact = new Artifact()

    const destinationRepo = destinationFromConfig(this)

    const sourceAction = new CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      owner: config.source.github.owner,
      repo: config.source.github.repo,
      branch: config.source.github.branch,
      connectionArn: config.source.github.connectionArn,
      output: sourceArtifact,
      triggerOnPush: config.source.github.triggerOnPush
    })

    const buildRole = new Role(this, 'PipelineBuildRole', {
      assumedBy: new ServicePrincipal('codebuild.amazonaws.com')
    })

    buildRole.addManagedPolicy({
      managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser'
    })

    const projectArm = ImageBuildPipelineProject(this, 'Arm64', {
      arch: 'arm64',
      imageRepo: destinationRepo,
      buildRole,
    })

    const projectAmd = ImageBuildPipelineProject(this, 'Amd64', {
      arch: 'amd64',
      imageRepo: destinationRepo,
      buildRole,
    })

    const pushManifest = ManifestPushPipelineProject(this, 'ManifestProject', {
      buildRole: buildRole,
      imageRepo: destinationRepo,
      tagRules: config.destination.ecr.tagRules
    })

    new Pipeline(this, 'Pipeline', {
      pipelineName: config.pipelineName,
      pipelineType: PipelineType.V2,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction]
        },
        {
          stageName: 'Build',
          actions: [
            new CodeBuildAction({
              actionName: 'Build-Arm64',
              project: projectArm,
              input: sourceArtifact,
            }),
            new CodeBuildAction({
              actionName: 'Build-Amd64',
              project: projectAmd,
              input: sourceArtifact,
            }),
          ]
        },
        {
          stageName: 'Finalize',
          actions: [
            new CodeBuildAction({
              actionName: 'Push-Manifest',
              project: pushManifest,
              input: sourceArtifact
            })
          ]
        }
      ]
    })


  }
}

const app = new cdk.App();

new SimpleMultiArchContainerBuildPipelinesStack(app, 'SimpleMultiArchContainerBuildPipelinesStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
