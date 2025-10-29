import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class GithubActionsCdkprojectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Load config dynamically
    const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

    // ✅ VPC
    const vpc = new ec2.Vpc(this, 'DevVpc', {
      cidr: config.vpcCidr,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 }
      ]
    });

    // ✅ Security Groups
    const albSG = new ec2.SecurityGroup(this, 'ALBSG', { vpc, allowAllOutbound: true });
    albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');
    albSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS');

    const ec2SG = new ec2.SecurityGroup(this, 'EC2SG', { vpc, allowAllOutbound: true });
    ec2SG.addIngressRule(albSG, ec2.Port.tcp(80), 'Allow from ALB');
    ec2SG.addIngressRule(albSG, ec2.Port.tcp(443), 'Allow from ALB');

    const dbSG = new ec2.SecurityGroup(this, 'DBSG', { vpc, allowAllOutbound: true });
    dbSG.addIngressRule(ec2SG, ec2.Port.tcp(5432), 'Allow PostgreSQL from EC2');

    // ✅ RDS
    const dbSecret = new secretsmanager.Secret(this, 'DBSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'dbadmin' }),
        excludeCharacters: '/@" ',
        generateStringKey: 'password',
      },
    });

    const db = new rds.DatabaseInstance(this, 'PostgresRDS', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_15 }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2, ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSG],
      credentials: rds.Credentials.fromSecret(dbSecret),
      allocatedStorage: config.dbStorage,
      multiAz: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
    });

    // ✅ EC2 + AutoScaling
    const lt = new ec2.LaunchTemplate(this, 'EC2LaunchTemplate', {
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: ec2SG,
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minCapacity: config.minCapacity,
      maxCapacity: config.maxCapacity,
      desiredCapacity: config.desiredCapacity,
      launchTemplate: lt,
    });

    // ✅ ALB
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSG,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener('Listener', { port: 80, open: true });
    listener.addTargets('Target', { port: 80, targets: [asg] });

    // ✅ Outputs
    new cdk.CfnOutput(this, 'DBSecretArn', { value: dbSecret.secretArn });
    new cdk.CfnOutput(this, 'DBEndpoint', { value: db.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'ALBEndpoint', { value: alb.loadBalancerDnsName });
  }
}
