import { Context } from 'aws-lambda';
import { ConsumerWorkflowInput, WorkflowMetadata } from '../../shared/types';

const IDEMPOTENCY_TTL_SECONDS = 2 * 24 * 60 * 60;
const RESULTS_TTL_SECONDS = 90 * 24 * 60 * 60;

interface PipeWorkflowInput {
  readonly workItem: ConsumerWorkflowInput['workItem'];
  readonly workflow?: Partial<WorkflowMetadata>;
}

export const handler = async (
  event: PipeWorkflowInput,
  context: Context,
): Promise<ConsumerWorkflowInput> => {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const normalizedWorkItem: ConsumerWorkflowInput['workItem'] = {
    ...event.workItem,
    payload: event.workItem.payload ?? {},
    headers: event.workItem.headers ?? {},
  };
  const workflow: WorkflowMetadata = {
    idempotencyTtl: event.workflow?.idempotencyTtl ?? String(nowEpochSeconds + IDEMPOTENCY_TTL_SECONDS),
    resultsTtl: event.workflow?.resultsTtl ?? String(nowEpochSeconds + RESULTS_TTL_SECONDS),
    sourceMessageId: event.workflow?.sourceMessageId,
    sourceIngestedAt: event.workflow?.sourceIngestedAt,
  };

  console.info(JSON.stringify({
    level: 'INFO',
    message: 'Workflow bootstrap complete',
    recordId: normalizedWorkItem.recordId,
    providerId: normalizedWorkItem.providerId,
    requestId: context.awsRequestId,
  }));

  return {
    workItem: normalizedWorkItem,
    workflow,
  };
};
