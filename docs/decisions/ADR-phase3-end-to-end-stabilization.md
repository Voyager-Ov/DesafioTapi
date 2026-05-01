# ADR: End-to-End Stabilization for Phase 3

## Status
Accepted

## Context
Phase 3 replaced the old `orchestrator` path with `EventBridge Scheduler -> Lambda Producer -> SQS FIFO -> EventBridge Pipe -> Step Functions Express -> Consumer -> DynamoDB`.

The first validation scripts and runbooks were partially inherited from Phase 2 and produced false confidence. The stabilization work below records each concrete mistake, its root cause, its impact, and the rule we will keep from now on.

## Decision
The official end-to-end validation path for Phase 3 will:
- use CloudWatch logs as the source of truth for `Step Functions Express`
- validate provider serialization through Lambda consumer logs, not through Step Functions execution APIs
- seed a single `dispatchSlot` with concentrated `providerId` distribution and mixed `200/400/503` outcomes
- use file-backed JSON arguments for AWS CLI DynamoDB operations in PowerShell
- retire Phase 2 validation automation from the active repo surface

## Error Log

### 1. Using `list-executions` and `get-execution-history` for `EXPRESS`
- Error detected:
  The first smoke validator tried to inspect the workflow with `aws stepfunctions list-executions` and `aws stepfunctions get-execution-history`.
- Root cause:
  The validation logic was carried over from the `STANDARD` workflow model used earlier.
- Impact:
  The script was built around an API path that is not the operational source of truth for `Step Functions Express`, so even a healthy runtime would be validated the wrong way.
- Correction applied:
  The validator now audits `EXPRESS` through CloudWatch Logs Insights on `/aws/vendedlogs/states/tapi-consumer-state-machine`.
- Operational rule:
  For `EXPRESS` workflows, validate behavior from CloudWatch logs, never from the execution listing APIs.

### 2. Assuming Step Functions logs were enough to prove provider ordering
- Error detected:
  The first validation plan expected to infer `providerId` directly from state machine logs.
- Root cause:
  We ignored that the current state machine logging configuration uses `includeExecutionData = false`.
- Impact:
  The workflow logs can prove state transitions, but not the provider-level sequencing requirement that comes from SQS FIFO `MessageGroupId`.
- Correction applied:
  Provider ordering is now audited from `/aws/lambda/tapi-consumer` by reconstructing request spans per `providerId` and checking for overlap.
- Operational rule:
  Use the narrowest log source that still contains the business key being validated. For provider ordering, that source is the consumer Lambda logs.

### 3. Seed without strong provider concentration
- Error detected:
  The first 100-record smoke test distributed providers too evenly and did not force repeated requests against the same provider groups.
- Root cause:
  We optimized for volume, but not for the hardest architectural invariant: one-at-a-time processing per provider.
- Impact:
  The test could show throughput and general success, while still failing to certify FIFO serialization under contention.
- Correction applied:
  The seed now concentrates records across fixed provider buckets and mixes `200/400/503` inside those same buckets.
- Operational rule:
  Any concurrency-validation seed must intentionally create repeated work for the same `providerId`.

### 4. Inline JSON for DynamoDB in PowerShell
- Error detected:
  The smoke validator tried to pass `--expression-attribute-values` and `--key` as inline JSON strings.
- Root cause:
  PowerShell string interpolation and quoting semantics were treated as if they were shell-safe for AWS CLI JSON arguments.
- Impact:
  `query`, `scan`, and `delete-item` calls became brittle and failed before the end-to-end test could even start.
- Correction applied:
  The validator now writes JSON to temporary files and passes them through `file://...`.
- Operational rule:
  In PowerShell, AWS CLI JSON arguments for DynamoDB must be file-backed unless there is a trivial one-field case already proven safe.

### 5. Keeping the old Phase 2 validator active
- Error detected:
  `scripts/phase2-validate.ps1` still lived in the active repo path and pointed to the old runtime model.
- Root cause:
  We preserved a previously useful tool without reclassifying it after the architecture changed.
- Impact:
  Operators had two competing scripts, one of which encoded outdated assumptions about Step Functions and the old orchestrator path.
- Correction applied:
  The obsolete script is removed from the active repo workflow.
- Operational rule:
  When the execution architecture changes, validation tooling must be migrated or retired in the same change window.

### 6. Forgetting the `BatchWriteItem` 25-item limit
- Error detected:
  The first 100-record smoke design assumed one batch write could carry all records.
- Root cause:
  We modeled the desired dataset size before rechecking the DynamoDB `BatchWriteItem` hard limit.
- Impact:
  The smoke test could not write the seed deterministically in one pass.
- Correction applied:
  The validator now chunks the seed into four deterministic batches of `25`.
- Operational rule:
  Every bulk test harness must encode AWS service hard limits explicitly instead of relying on memory.

### 7. Assuming the Pipe input root was an object instead of a batch array
- Error detected:
  The workflow expected `$.workItem` and `$.workflow`, but the actual `SQS -> Pipe -> Step Functions` input arrived as an array with one transformed element.
- Root cause:
  We treated `batchSize = 1` as “single object at the root”, but Pipes still preserve the batch envelope.
- Impact:
  The runtime failed immediately in `BootstrapWorkflowInput` with `States.Runtime`, the queue kept recycling messages, `pending` stayed in `PENDING`, and no `idempotency` or `results` rows were created.
- Correction applied:
  The first workflow state now reads `$[0].workItem` and `$[0].workflow` before returning the normalized object for the rest of the state machine.
- Operational rule:
  For `SQS` sources in EventBridge Pipes, validate the actual root shape in CloudWatch before assuming object-level JSONPaths, even when `batchSize = 1`.

### 8. Treating optional `payload` and `headers` as always-present in Step Functions JSONPath
- Error detected:
  After fixing the batch root, the workflow still failed in `InvokeConsumerLambda` because `payload.$` and `headers.$` were resolved against work items that legitimately did not contain those fields.
- Root cause:
  The queue contract allowed optional fields, but the state machine parameters were written as if the paths always existed.
- Impact:
  The workflow acquired idempotency and moved `pending` to `IN_PROGRESS`, then crashed with `States.Runtime`, leaving partially advanced rows and forcing retries against inconsistent state.
- Correction applied:
  `workflow-bootstrap` now normalizes the work item so `payload` and `headers` always exist before `InvokeConsumerLambda`.
- Operational rule:
  Any field referenced through `.$` in Step Functions must be guaranteed present by the preceding normalization step.

### 9. Reading `93/100` as a routing failure instead of stale state carry-over
- Error detected:
  The first full-slot smoke conclusion could be read as an end-to-end routing or delivery defect because only `93` of `100` items reached final persistence.
- Root cause:
  Several rows used in the slot validation were already left in `IN_PROGRESS` by earlier broken runs, so the new runtime inherited stale operational state.
- Impact:
  The smoke result could be misdiagnosed as a current Pipe, Scheduler, or Step Functions issue even though the queue drained and `93` items completed the full path correctly.
- Correction applied:
  The Phase 3 runbook now records the exact interpretation of the `93/100` result: end-to-end is validated, but stale recovery remains an explicit follow-up concern.
- Operational rule:
  When validating a repaired workflow, distinguish current execution failures from stale state inherited from previous broken executions before drawing architecture-level conclusions.

## Current Status Update
After a clean rerun of the `100`-record smoke test with a fresh isolated seed on May 1, 2026:
- `tapi-pending-records` closed `60 COMPLETED / 40 FAILED / 0 IN_PROGRESS`
- `tapi-idempotency` closed `60 COMPLETED / 40 FAILED / 0 IN_PROGRESS`
- `tapi-results` persisted `100` final rows (`60` with `200`, `20` with `400`, `20` with `503`)
- the FIFO queue drained to zero

This confirms the previous `93/100` finding was inherited stale operational state, not a reproducible defect of the current runtime.

## Consequences
- The end-to-end validator is now aligned with the actual runtime architecture.
- The operational proof path is slower than a naive CLI smoke test, but materially more trustworthy.
- Future regressions in provider ordering, workflow routing, or terminal/transient closure should now be observable from one script and one summary artifact.
