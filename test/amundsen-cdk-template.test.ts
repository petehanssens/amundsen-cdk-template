import { expect as expectCDK, haveResource } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as AmundsenCdkTemplate from '../src/main';

test('Empty Stack', () => {
  const app = new cdk.App();
  // WHEN
  const stack = new AmundsenCdkTemplate.AmundsenStack(app, 'MyTestStack');
  // THEN
  expectCDK(stack).to(haveResource('AWS::ECS::Cluster'));
});
