// import * as ecr from '@aws-cdk/aws-ecr';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecsp from '@aws-cdk/aws-ecs-patterns';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as es from '@aws-cdk/aws-elasticsearch';
import * as iam from '@aws-cdk/aws-iam';
import * as logs from '@aws-cdk/aws-logs';
import * as neptune from '@aws-cdk/aws-neptune';
import * as s3 from '@aws-cdk/aws-s3';

import * as cdk from '@aws-cdk/core';

export class SLRStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new iam.CfnServiceLinkedRole(this, 'ESSLR', {
      awsServiceName: 'es.amazonaws.com',
      description: 'es service linked role',
    });
  }
}

export interface AmundsenStackProps extends cdk.StackProps {
  /**
   * The vpc to deploy into, this will accept an IVpc or lookup a
   * vpc based on a vpc Name tag
   * @default one will be created for you
   */
  readonly vpc?: ec2.IVpc | string;
}

export class AmundsenStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: AmundsenStackProps) {
    super(scope, id, props);

    const amundsenBasePort = 5000;
    const amundsenSearchPort = 5001;
    const amundsenMetadataPort = 5002;

    props?.vpc || console.warn('A vpc will be created for you');

    const vpc =
      typeof props?.vpc === 'string'
        ? ec2.Vpc.fromLookup(this, 'vpc', {
          tags: {
            Name: props.vpc,
          },
        })
        : props?.vpc ??
          new ec2.Vpc(this, 'ExampleVpc', {
            cidr: '10.0.0.0/16',
            subnetConfiguration: [
              { subnetType: ec2.SubnetType.PRIVATE, name: 'Private', cidrMask: 24 },
              { subnetType: ec2.SubnetType.ISOLATED, name: 'Isolated', cidrMask: 24 },
              { subnetType: ec2.SubnetType.PUBLIC, name: 'Public', cidrMask: 24 },
            ],
            maxAzs: 3,
          });

    const accessPolicies: iam.PolicyStatement[] = [
      new iam.PolicyStatement({
        resources: [`arn:aws:es:${this.region}:${this.account}:domain/*`],
        actions: ['es:*'],
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
      }),
    ];

    const elasticSearch = new es.Domain(this, 'elasticsearch', {
      // this seems to be the newest compatible
      version: es.ElasticsearchVersion.V6_8,
      enableVersionUpgrade: true,
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      accessPolicies,
    });
    //
    new cdk.CfnOutput(this, 'es-endpoint', { value: elasticSearch.domainEndpoint });

    const neptuneRole = new iam.Role(this, 'neptune-role', {
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
    });
    new cdk.CfnOutput(this, 'neptune-role-output', { value: neptuneRole.roleName });

    const bucket = new s3.Bucket(this, 'amundsen-bucket', {
      bucketName: `amundsenexample-${this.region}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
    bucket.grantReadWrite(neptuneRole);
    new cdk.CfnOutput(this, 'bucket-name', { value: bucket.bucketName });

    const neptuneCluster = new neptune.DatabaseCluster(this, 'neptune', {
      vpc,
      instanceType: neptune.InstanceType.R5_LARGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      associatedRoles: [neptuneRole],
      iamAuthentication: true,
    });
    new cdk.CfnOutput(this, 'neptune-endpoint', {
      value: `${neptuneCluster.clusterEndpoint.socketAddress}`,
    });
    neptuneCluster.connections.allowDefaultPortFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock));

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'amundsen-task-def', {
      cpu: 1024,
      memoryLimitMiB: 4096,
    });

    const logGroup = new logs.LogGroup(this, this.stackName);
    taskDefinition.addContainer('amundsenfrontend', {
      image: ecs.ContainerImage.fromRegistry('amundsendev/amundsen-frontend:3.7.0'),
      containerName: 'frontend',
      memoryLimitMiB: 1024,
      portMappings: [
        {
          containerPort: amundsenBasePort,
        },
      ],
      environment: {
        LOG_LEVEL: 'DEBUG',
        SEARCHSERVICE_BASE: `http://localhost:${amundsenSearchPort}`,
        METADATASERVICE_BASE: `http://localhost:${amundsenMetadataPort}`,
        FRONTEND_SVC_CONFIG_MODULE_CLASS: 'amundsen_application.config.TestConfig',
      },
      logging: new ecs.AwsLogDriver({
        logGroup,
        streamPrefix: 'amundsenfrontend',
      }),
    });

    taskDefinition.addContainer('amundsen-search', {
      image: ecs.ContainerImage.fromRegistry('amundsendev/amundsen-search:2.5.1'),
      containerName: 'search',
      memoryLimitMiB: 1024,
      portMappings: [
        {
          containerPort: amundsenSearchPort,
        },
      ],
      environment: {
        LOG_LEVEL: 'DEBUG',
        PROXY_ENDPOINT: `https://${elasticSearch.domainEndpoint}`,
        PROXY_CLIENT: 'ELASTICSEARCH',
        PORT: `${amundsenSearchPort}`,
        PROXY_PORT: '443',
        // these are required, else you'll have a bad day
        CREDENTIALS_PROXY_USER: '',
        CREDENTIALS_PROXY_PASSWORD: '',
      },
      logging: new ecs.AwsLogDriver({
        logGroup,
        streamPrefix: 'amundsensearch',
      }),
    });

    const cfnNeptune = neptuneCluster.node.defaultChild as neptune.CfnDBCluster;

    taskDefinition.addContainer('amundsen-metadata', {
      image: ecs.ContainerImage.fromRegistry('amundsendev/amundsen-metadata:3.5.0'),
      containerName: 'metadata',
      memoryLimitMiB: 1024,
      portMappings: [
        {
          containerPort: amundsenMetadataPort,
        },
      ],
      environment: {
        LOG_LEVEL: 'DEBUG',
        METADATA_SVC_CONFIG_MODULE_CLASS: 'metadata_service.config.NeptuneConfig',
        AWS_REGION: this.region,
        S3_BUCKET_NAME: bucket.bucketName,
        IGNORE_NEPTUNE_SHARD: 'True',
        PROXY_CLIENT: 'NEPTUNE',
        PROXY_HOST: `wss://${neptuneCluster.clusterEndpoint.socketAddress}/gremlin`,
        PROXY_PORT: cfnNeptune.attrPort,
        PROXY_ENCRYPTED: 'True',
        PROXY_VALIDATE_SSL: 'False',
      },
      logging: new ecs.AwsLogDriver({
        logGroup,
        streamPrefix: 'amundsenmetadata',
      }),
    });

    const sg = new ec2.SecurityGroup(this, 'clusterSG', {
      vpc,
    });
    sg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTcp());

    const service = new ecsp.ApplicationLoadBalancedFargateService(this, 'service', {
      taskDefinition,
      cpu: 512,
      memoryLimitMiB: 2048,
      publicLoadBalancer: true,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    neptuneCluster.connections.allowFrom(service.cluster, ec2.Port.allTcp());
    elasticSearch.connections.allowFrom(service.cluster, ec2.Port.allTcp());

    elasticSearch.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTcp());

    neptuneCluster.grantConnect(taskDefinition.taskRole);
    elasticSearch.grantReadWrite(taskDefinition.taskRole);
  }
}

export class VPCStack extends cdk.Stack {
  public vpc: ec2.Vpc;
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'CustomVPC', {
      cidr: '10.0.0.0/16',
      subnetConfiguration: [
        { subnetType: ec2.SubnetType.PRIVATE, name: 'Private', cidrMask: 24 },
        { subnetType: ec2.SubnetType.ISOLATED, name: 'Isolated', cidrMask: 24 },
        { subnetType: ec2.SubnetType.PUBLIC, name: 'Public', cidrMask: 24 },
      ],
      maxAzs: 3,
    });
    cdk.Tags.of(this.vpc).add('Name', 'AmundsenExample');
  }
}

// for development, use account/region from cdk cli
const devEnv: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new cdk.App();

const roleStack = new SLRStack(app, 'amudsen-dev-es-slr', { env: devEnv });

const vpcStack = new VPCStack(app, 'amudsen-dev-vpc', { env: devEnv });

const serviceStack = new AmundsenStack(app, 'amudsen-dev-stack', { env: devEnv, vpc: vpcStack.vpc });
serviceStack.addDependency(roleStack);

app.synth();
