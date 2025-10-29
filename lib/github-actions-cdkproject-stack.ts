import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class GithubActionsCdkprojectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'myVPC', {
      vpcId: 'vpc-053b9ebca1c4699e6',
      availabilityZones: ['ca-central-1a', 'ca-central-1b'],
      publicSubnetIds: ['subnet-00c87def2b5adf2e8', 'subnet-0c74e4a72c1c8a995'],
      privateSubnetIds: ['subnet-06f2aaf01e87f3a08', 'subnet-0a4e64872d8211fef'],
    });

    const albSG = new ec2.SecurityGroup(this, 'ALBSG', { vpc, allowAllOutbound: true });
    albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');
    albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS');

    const ec2SG = new ec2.SecurityGroup(this, 'EC2SG', { vpc, allowAllOutbound: true });
    ec2SG.addIngressRule(albSG, ec2.Port.tcp(80), 'Allow from ALB');
    ec2SG.addIngressRule(albSG, ec2.Port.tcp(443), 'Allow from ALB');

    const dbSG = new ec2.SecurityGroup(this, 'DBSG', { vpc, allowAllOutbound: true });
    dbSG.addIngressRule(ec2SG, ec2.Port.tcp(5432), 'Allow PostgreSQL from EC2');

    const dbSecret = new secretsmanager.Secret(this, 'DBSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'dbadmin' }),
        excludeCharacters: '/@" ',
        generateStringKey: 'password',
      },
    });

    const db = new rds.DatabaseInstance(this, 'PostgresRDS', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_15 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSG],
      credentials: rds.Credentials.fromSecret(dbSecret),
      allocatedStorage: 20,
      multiAz: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    const lt = new ec2.LaunchTemplate(this, 'EC2LaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2SG,
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minCapacity: 1,
      maxCapacity: 4,
      desiredCapacity: 2,
      launchTemplate: lt,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSG,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener('Listener', { port: 80, open: true });
    listener.addTargets('Target', { port: 80, targets: [asg] });

    new cdk.CfnOutput(this, 'DBSecretArn', { value: dbSecret.secretArn });
    new cdk.CfnOutput(this, 'DBEndpoint', { value: db.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'ALBEndpoint', { value: alb.loadBalancerDnsName });
  }
}