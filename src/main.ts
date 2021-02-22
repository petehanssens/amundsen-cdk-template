import { App } from '@aws-cdk/core';
import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as iam from '@aws-cdk/aws-iam';
import * as neptune from '@aws-cdk/aws-neptune';
import * as ecs from '@aws-cdk/aws-ecs';
import * as es from '@aws-cdk/aws-elasticsearch';

export class SLRStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new iam.CfnServiceLinkedRole(this, 'ESSLR', {
      awsServiceName: 'es.amazonaws.com',
      description: 'es service linked role',
    })

  }
}

export class AmundsenStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // CFN Vars
    const application = new cdk.CfnParameter(this, "Application", {
      type: "String",
      description: "The name of the Application.",
      default: 'amundsen'
    }).valueAsString;
    
    const environment = new cdk.CfnParameter(this, "Environment", {
        type: "String",
        description: "The name of the Environment where the app is run.",
        default: 'dev'
    }).valueAsString;

    const sg1 = ec2.SecurityGroup.fromSecurityGroupId(this, 'linux-mgmt',
      cdk.Fn.importValue('cloudshuttle-dev-linux-mgmt-sg')
    )

    const vpc = ec2.Vpc.fromLookup(this, 'vpc', {
      tags: {
        'Name': `cloudshuttle-dev-vpc`
      }
    })

    const subnets = vpc.privateSubnets.map((a) => {
      console.log('subnets: ',a.subnetId)
      return a.subnetId
    })

    console.log('all subnets: ', subnets)

    const snaId = cdk.Fn.importValue('cloudshuttle-dev-private-sn-a')
    const snbId = cdk.Fn.importValue('cloudshuttle-dev-private-sn-b')
    const sncId = cdk.Fn.importValue('cloudshuttle-dev-private-sn-c')

    const privateSNA = ec2.Subnet.fromSubnetId(this, 
      'PrivateSNA', 
      snaId
    )
    const privateSNB = ec2.Subnet.fromSubnetId(this, 
      'PrivateSNB', 
      snbId
    )
    const privateSNC = ec2.Subnet.fromSubnetId(this, 
      'PrivateSNC', 
      sncId
    )

    console.log('all subnets: ', subnets)

    // Elasticsearch Cluster
    const iamPolicy = new iam.PolicyStatement({
      resources: [
        // `arn:aws:es:${this.region}:${this.account}:domain/*`
        "*"
      ],
      actions: [
        "es:ESHttpGet",
        "es:ESHttpPut",
        "es:ESHttpPost",
        "es:ESHttpHead"
      ],
      effect: iam.Effect.ALLOW,
      principals: [
        new iam.AnyPrincipal()
      ]
    })

    const iamPolicyDoc = new iam.PolicyDocument({statements: [iamPolicy]})

    const esDomain = new es.CfnDomain(this, 'AmundsenESDomain', {
      domainName: `${application}-${environment}-es-domain`,
      elasticsearchClusterConfig: {
        // dedicatedMasterEnabled: true,
        // dedicatedMasterCount: 3,
        // dedicatedMasterType: 'm3.medium.elasticsearch',
        instanceCount: 1,
        instanceType: 't3.small.elasticsearch',
      },
      ebsOptions: {
        ebsEnabled: true,
        volumeSize: 10,
      },
      elasticsearchVersion: '6.7',
      vpcOptions: {
        securityGroupIds: [sg1.securityGroupId],
        subnetIds: [snaId]
      },
      accessPolicies: iamPolicyDoc
    })

    const NeptuneCloudWatchPolicyStatement = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:PutRetentionPolicy',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescriptLogStreams',
          'logs:GetLogEvents'
        ],
        resources: [
          `arn:${this.partition}:logs:${this.account}:${this.region}:log-group:/aws/neptune/*`,
          `arn:${this.partition}:logs:${this.account}:${this.region}:log-group:/aws/neptune/*:log-stream:*`
        ]
      }
    )
    const NeptuneCloudWatchPolicyDocument = new iam.PolicyDocument()
    NeptuneCloudWatchPolicyDocument.addStatements(NeptuneCloudWatchPolicyStatement)

    const NeptuneCloudWatchPolicy = new iam.ManagedPolicy(this, 'NeptuneS3Policy', {
      description: 'An IAM Policy that allows Neptune cluster log events to be sent to CloudWatch',
      managedPolicyName: `${application}-${environment}-neptune-cloudwatch-policy`,
      document: NeptuneCloudWatchPolicyDocument
    })

    const NeptuneS3PolicyStatement = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:Get*',
          's3:List*',
          "es:ESHttpGet",
          "es:ESHttpPut",
          "es:ESHttpPost",
          "es:ESHttpHead"
        ],
        resources: [
          `arn:aws:s3:::*`,
          `arn:aws:es:${this.region}:${this.account}:domain/*`,
        ]
      }
    )
    const NeptuneS3PolicyDocument = new iam.PolicyDocument()
    NeptuneS3PolicyDocument.addStatements(NeptuneS3PolicyStatement)
    const NeptuneS3Policy = new iam.ManagedPolicy(this, 'NeptuneS3PolicyDocument', {
      description: 'An IAM Policy that allows s3 and elasticsearch access',
      managedPolicyName: `${application}-${environment}-neptune-s3-policy`,
      document: NeptuneS3PolicyDocument
    })

    const neptuneRole = new iam.Role(this, 'NeptuneRole', {
      roleName: `${application}-${environment}-neptune-role`,
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
      managedPolicies: [
        NeptuneS3Policy,
        NeptuneCloudWatchPolicy
      ]
    })

    const neptuneSubnetGroup = new neptune.CfnDBSubnetGroup(this, 'NeptuneSubnetGroup', {
      dbSubnetGroupDescription: 'private subnets',
      // removalPolicy: cdk.RemovalPolicy.DESTROY,
      dbSubnetGroupName: `${application}-${environment}-neptune-subnet-group`,
      subnetIds: [
        snaId,
        snbId,
        sncId
      ],
    })

    const neptuneClusterParameterGroup = new neptune.CfnDBClusterParameterGroup(this, 
      'NeptuneClusterParameterGroup', {
      name: `${application}-${environment}-neptune-cluster-pg`,
      description: 'Neptune cluster parameter group',
      family: 'neptune1',
      parameters: {
        neptune_enable_audit_log: 1
      },
    })

    new neptune.CfnDBClusterParameterGroup(this, 
      'NeptuneDBParameterGroup', {
      name: `${application}-${environment}-neptune-db-pg`,
      description: 'Neptune db parameter group',
      family: 'neptune1',
      parameters: {
        neptune_query_timeout: 120000
      },
    })

    const neptuneCluster = new neptune.CfnDBCluster(this, 'NeptuneCluster', {
      dbClusterParameterGroupName: neptuneClusterParameterGroup.name,
      backupRetentionPeriod: 7,
      associatedRoles: [
        {
          roleArn: neptuneRole.roleArn,
          featureName: 'neptune-role'
        }
      ],
      dbClusterIdentifier: `${application}-${environment}-neptune-cluster`,
      dbSubnetGroupName: neptuneSubnetGroup.dbSubnetGroupName,
      iamAuthEnabled: true,
      port: 8182,
      preferredBackupWindow: '02:00-03:00',
      preferredMaintenanceWindow: 'mon:03:00-mon:04:00',
      storageEncrypted: true,
      vpcSecurityGroupIds: [
        sg1.securityGroupId
      ],
      tags: [
        {
          key: 'hello',
          value: 'world'
        }
      ]
    })

    new neptune.CfnDBInstance(this, 'NeptuneInstance', {
      dbInstanceClass: 'db.t3.medium',
      allowMajorVersionUpgrade: true,
      autoMinorVersionUpgrade: true,
      availabilityZone: vpc.availabilityZones[0],
      dbClusterIdentifier: `${application}-${environment}-neptune-cluster`,
      dbInstanceIdentifier: `${application}-${environment}-neptune-instance`,
      // dbParameterGroupName: `${application}-${environment}-neptune-db-pg`,
      dbSubnetGroupName: neptuneSubnetGroup.dbSubnetGroupName,
      preferredMaintenanceWindow: 'mon:03:00-mon:04:00',
      tags: [
        {
          key: 'blah',
          value: 'world'
        }
      ]
    }).addDependsOn(neptuneCluster)

    // Fargate Cluster
    const fargateCluster = new ecs.Cluster(this, 'FargateCluster', {
      clusterName: `${application}-${environment}-amundsen-cluster`,
      vpc: vpc,
      containerInsights: true,
    })

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: `${application}-${environment}-amundsen-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    })

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${application}-${environment}-amundsen-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    })

    const taskPolicy = new iam.Policy(this, 'TaskPolicy', {
      policyName: `${application}-${environment}-amundsen-container-policy`,
      roles: [
        taskRole
      ],
    })

    taskPolicy.addStatements(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:*:log-stream:*`,
        `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
      ],
    }))

    // Add a ES policy to a Role
    taskPolicy.addStatements(
      new iam.PolicyStatement({
        resources: [
          `arn:aws:es:${this.region}:${this.account}:domain/*`,
          `arn:aws:rds:${this.region}:${this.account}:cluster/*`,
        ],
        actions: [
          "es:ESHttpGet",
          "es:ESHttpPut",
          "es:ESHttpPost",
          "es:ESHttpHead",
          "neptune:*"
        ],
        effect: iam.Effect.ALLOW,
    }))

    const amundsenFrontend = new ecs.FargateTaskDefinition(this, 'AmundsenFrontend', {
      cpu: 1024,
      executionRole: executionRole,
      memoryLimitMiB: 4096,
      taskRole: taskRole,
    })

    amundsenFrontend.addContainer('AmundsenFrontendContainer', {
      image: ecs.ContainerImage.fromRegistry('amundsendev/amundsen-frontend:latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'amundsen-frontend' }),
      environment: {
        SEARCHSERVICE_BASE: 'http://localhost:5001',
        METADATASERVICE_BASE: 'http://localhost:5002',
        FRONTEND_SVC_CONFIG_MODULE_CLASS: 'amundsen_application.config.TestConfig',
      },
      cpu: 256,
      memoryLimitMiB: 512,
    })

    amundsenFrontend.addContainer('AmundsenMetadataContainer1', {
      image: ecs.ContainerImage.fromRegistry('amundsendev/amundsen-metadata:latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'amundsen-metadata' }),
      environment: {
        PROXY_CLIENT: 'NEPTUNE',
        PROXY_PORT: '8182',
        PROXY_HOST: `${neptuneCluster.attrEndpoint}`
      },
      cpu: 256,
      memoryLimitMiB: 512
    })

    amundsenFrontend.addContainer('AmundsenSearchContainer1', {
      image: ecs.ContainerImage.fromRegistry('amundsendev/amundsen-search:latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'amundsen-search' }),
      environment: {
        PROXY_CLIENT: 'ELASTICSEARCH',
        PROXY_PORT: '443',
        PROXY_HOST: `https://${esDomain.attrDomainEndpoint}`,
      },
      cpu: 256,
      memoryLimitMiB: 512
    })

    new ecs.FargateService(this, 'FargateFrontendService', {
      cluster: fargateCluster,
      serviceName: `${application}-${environment}-amundsen-frontend-service`,
      securityGroups: [
        sg1
      ],
      vpcSubnets: {
        subnets: [
          privateSNA,
          privateSNB,
          privateSNC
        ]
      },
      taskDefinition: amundsenFrontend,
      assignPublicIp: false,
      desiredCount: 1,
    })
  }
}


// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

// Deploy this stack first (comment out the second stack until you've deployed this :D)
new SLRStack(app, 'amudsen-dev-es-slr', { env: devEnv });

new AmundsenStack(app, 'amudsen-dev-stack', { env: devEnv });

app.synth();