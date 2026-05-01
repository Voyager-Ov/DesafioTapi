import * as cdk from 'aws-cdk-lib';
import { TapiStack } from '../../../cdk/lib/stacks/tapi-stack';

describe('TapiStack state machine refactor', () => {
  it('synthesizes a state machine that owns final persistence and jittered retries', () => {
    const app = new cdk.App();
    const stack = new TapiStack(app, 'TestTapiStack', {
      env: {
        account: '123456789012',
        region: 'us-east-1',
      },
    });

    const assembly = app.synth();
    const template = assembly.getStackArtifact(stack.artifactId).template as {
      Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
    };

    const stateMachine = Object.values(template.Resources).find(
      (resource) => resource.Type === 'AWS::StepFunctions::StateMachine',
    );
    expect(stateMachine).toBeDefined();

    const definitionParts = (stateMachine?.Properties?.DefinitionString as {
      'Fn::Join': [string, unknown[]];
    })['Fn::Join'][1];
    const definition = definitionParts
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join('');

    expect(definition).toContain('"PersistSuccessResult"');
    expect(definition).toContain('"ResultPath":"$.consumerResult"');
    expect(definition).toContain('"JitterStrategy":"FULL"');
    expect(definition).toContain('"Parameters":{"recordId.$":"$.workItem.recordId"');
    expect(definition).toContain('"DuplicateWorkItem"');
    expect(definition).toContain('"RollbackIdempotencyLock"');
    expect(definition).toContain('"TerminalApiError"');
    expect(definition).toContain('"$.workItem.recordId"');
    expect(definition).toContain('"Next":"RollbackIdempotencyLock"');
    expect(definition).toContain('"responseBody":{"S.$":"$.consumerResult.responseBody"}');
    expect(definition).not.toContain('States.JsonToString');
    expect(definition).not.toContain('ObjectAt($.consumerResult.responseBody)');
    expect(definition).not.toContain('"Payload.$":"$"');

    const consumerFunction = Object.values(template.Resources).find(
      (resource) =>
        resource.Type === 'AWS::Lambda::Function'
        && resource.Properties?.FunctionName === 'tapi-consumer',
    );

    expect(consumerFunction).toBeDefined();
    expect(
      (consumerFunction?.Properties?.Environment as { Variables: Record<string, string> }).Variables.RESULTS_TABLE_NAME,
    ).toBeUndefined();
  });
});
