---
name: spec-json-iteration-flow
description: "Create features using a gated spec-first workflow: (1) read app context, (2) produce and iterate functional JSON, (3) produce and iterate technical JSON, (4) produce todos JSON with parallelization and dependencies, then implement only after specs are approved. Use when users ask for structured planning and controlled execution before coding for frontend/backend/fullstack features."
---

# Spec JSON Iteration Flow

## Overview
Use a strict, implementation-gated workflow: functional JSON -> technical JSON -> todos JSON -> code.
Treat each JSON as an approval gate and do not skip gates.

## Mandatory Sequence
1. Scan repository context before asking questions.
2. Create `functional-spec.json` from user description.
3. Iterate functional JSON until approved.
4. STOP and ask the user explicitly if the functional spec is approved before continuing.
4. Create `technical-spec.json` from approved functional JSON.
5. Iterate technical JSON until approved.
6. STOP and ask the user explicitly if the technical spec is approved before continuing.
6. Create `todos.json` with dependencies and parallelization.
7. Implement code only after all three JSONs are approved.

## Step 0: Context Scan (Before Spec)
Inspect the app to avoid assumptions.

Minimum scan:
- `package.json` and scripts
- routing/entrypoints (`app/`, `src/`, `pages/`)
- current domain/data layer (`lib/`, `services/`, `api/`, `db/`)
- existing `specs/` and design tokens (`styles.json`, theme files)

Summarize:
- stack and runtime constraints
- current architecture shape
- touched modules likely affected
- test setup available

## Skill Routing by Feature Type
After scanning context, classify the request:

- Frontend-heavy: prioritize UI/UX skills first.
- Backend-heavy: prioritize API/domain/data skills first.
- Fullstack: split work in frontend/backend tracks and sync through shared contracts.

Routing rules:
1. Prefer already-available local skills in session.
2. If a required skill is missing and discoverable, use `find-skills`.
3. If no suitable skill exists, continue with explicit assumptions and standard engineering practices.

## JSON Contracts
Use JSON files in this exact order and keep them independent.

### 1) functional-spec.json
Include:
- product scope and in/out boundaries
- user journeys and use cases
- acceptance criteria (Given/When/Then)
- UX behavior and interaction expectations
- business rules (domain language, no implementation details)

Do not include:
- library picks
- folder-level code architecture
- implementation sequence

### 2) technical-spec.json
Include:
- architecture and module boundaries
- interfaces/contracts (data, APIs, state shape)
- dependency/library decisions with rationale
- failure modes and edge handling
- testing strategy and quality gates
- phased implementation plan (goal, tasks, dependencies, DoD)

### 3) todos.json
Include short executable tasks with:
- `id`, `title`, `owner_role`, `status`
- `parallelizable` boolean
- `depends_on` list
- `outputs` and `exit_criteria`
- execution batches (parallel vs sequential)

## Path Convention
Default output location:
- `specs/features/<feature-id>/functional-spec.json`
- `specs/features/<feature-id>/technical-spec.json`
- `specs/features/<feature-id>/todos.json`

## Iteration Rules
- Keep each JSON editable and versioned in place.
- Resolve functional ambiguities in functional JSON, not in technical JSON.
- Resolve architecture ambiguities in technical JSON, not in todos JSON.
- Keep todos short and operator-friendly for multi-agent execution.
- Never advance gates automatically: after each document draft/revision, wait for explicit user approval.
- Mandatory gate prompts:
  - After functional spec: ask if it is approved to move to technical spec.
  - After technical spec: ask if it is approved to move to todos/plan.
  - After todos/plan: ask if it is approved to start implementation.

## Implementation Gate
Do not implement code until:
- functional JSON approved
- technical JSON approved
- todos JSON approved
- each approval is explicitly confirmed by the user in conversation

When gate opens:
- implement in atomic commits by topic
- run tests and runtime checks
- report blockers with concrete file-level impact

## Quality Checklist
Before moving between gates, verify:
- requirements traceability: every scope item maps to AC
- technical traceability: every AC has a planned implementation path
- task traceability: every planned change appears in `todos.json`
- parallel safety: tasks marked parallel do not conflict on same files/modules

## References
For reusable templates and checklists, read:
- `references/json-contracts.md`
