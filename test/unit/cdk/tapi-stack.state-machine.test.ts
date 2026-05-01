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
    expect(definition).toContain('"BootstrapWorkflowInput"');
    expect(definition).toContain('"ResultPath":"$.consumerResult"');
    expect(definition).toContain('"JitterStrategy":"FULL"');
    expect(definition).toContain('"workItem.$":"$[0].workItem"');
    expect(definition).toContain('"workflow.$":"$[0].workflow"');
    expect(definition).toContain('"Parameters":{"recordId.$":"$.workItem.recordId"');
    expect(definition).toContain('"DuplicateWorkItem"');
    expect(definition).toContain('"RollbackIdempotencyLock"');
    expect(definition).toContain('"TerminalApiError"');
    expect(definition).toContain('"ParseWorkflowErrorEnvelope"');
    expect(definition).toContain('"ParseWorkflowErrorPayload"');
    expect(definition).toContain('"RouteClassifiedFailure"');
    expect(definition).toContain('"NormalizeTerminalFailure"');
    expect(definition).toContain('"NormalizeTransientExhaustedFailure"');
    expect(definition).toContain('"PrepareSuccessPersistence"');
    expect(definition).toContain('"PrepareFailurePersistence"');
    expect(definition).toContain('"$.workItem.recordId"');
    expect(definition).toContain('"Next":"RollbackIdempotencyLock"');
    expect(definition).toContain('"responseBodyText.$":"$.consumerResult.responseBody"');
    expect(definition).toContain('"responseBody":{"S.$":"$.persistence.responseBodyText"}');
    expect(definition).toContain('"statusCode":{"N.$":"$.persistence.statusCodeText"}');
    expect(definition).toContain('"durationMs":{"N.$":"$.persistence.durationMsText"}');
    expect(definition).toContain('States.StringToJson');
    expect(definition).toContain('States.JsonToString');
    expect(definition).toContain('States.Format');
    expect(definition).toContain('States.TaskFailed');
    expect(definition).not.toContain('"PersistTerminalFailureResult"');
    expect(definition).not.toContain('"PersistExhaustedTransientFailure"');
    expect(definition).not.toContain('"PersistTimeoutFailure"');
    expect(definition).not.toContain('"PersistUnexpectedFailure"');
    expect(definition).not.toContain('"ParseTerminalErrorEnvelope"');
    expect(definition).not.toContain('"ParseTransientErrorEnvelope"');
    expect(definition).not.toContain('"Payload.$":"$"');

    const consumerFunction = Object.values(template.Resources).find(
      (resource) =>
        resource.Type === 'AWS::Lambda::Function'
        && resource.Properties?.FunctionName === 'tapi-consumer',
    );
    const bootstrapFunction = Object.values(template.Resources).find(
      (resource) =>
        resource.Type === 'AWS::Lambda::Function'
        && resource.Properties?.FunctionName === 'tapi-workflow-bootstrap',
    );

    expect(consumerFunction).toBeDefined();
    expect(bootstrapFunction).toBeDefined();
    expect(
      (consumerFunction?.Properties?.Environment as { Variables: Record<string, string> }).Variables.RESULTS_TABLE_NAME,
    ).toBeUndefined();
    expect(stateMachine?.Properties).toMatchObject({
      StateMachineType: 'EXPRESS',
    });
  });
});
