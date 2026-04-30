# JSON Contracts

Use these minimal shapes as a starting point.

## functional-spec.json
```json
{
  "meta": {
    "feature_id": "string",
    "document_type": "functional_specification",
    "status": "draft|pending_approval|approved"
  },
  "scope": {
    "in_scope": [],
    "out_of_scope": []
  },
  "use_cases": [],
  "acceptance_criteria": [],
  "business_rules": []
}
```

## technical-spec.json
```json
{
  "meta": {
    "feature_id": "string",
    "document_type": "technical_specification",
    "status": "draft|pending_approval|approved"
  },
  "architecture": {},
  "interfaces": {},
  "libraries": [],
  "test_strategy": {},
  "implementation_phases": []
}
```

## todos.json
```json
{
  "feature_id": "string",
  "document_type": "execution_todos",
  "tasks": [
    {
      "id": "T01",
      "title": "string",
      "owner_role": "string",
      "status": "todo|in_progress|blocked|done",
      "parallelizable": false,
      "depends_on": [],
      "outputs": [],
      "exit_criteria": []
    }
  ],
  "parallel_execution_batches": []
}
```

## Parallelization Heuristic
Mark task as `parallelizable: true` only if both are true:
1. No shared-write conflict with other running tasks.
2. All prerequisites in `depends_on` are already `done`.
