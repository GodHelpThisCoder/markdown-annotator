---
title: Async deploy plan
status: draft
---

# Plan: Async Deploy Pipeline

This plan moves deployments off the request thread. It touches the repository
layer, the project service and the HTTP handlers. See README.md and main.py for
context, and replace <project-id> with a real id when testing.

## Goals

- Deployments run in the background
  and report progress over SSE
- A second deploy for the same project is rejected
  - while one is in progress
  - unless `--force` is passed
- Status survives a server restart

1. Add the repository method

   It queries deployments with `status=deploying` for a project.

2. Wire it into the service

## Tasks

- [x] Write the migration
- [ ] Add the repository query
- [ ] Update the handlers

## Design

The combination of mutex (for in-process synchronization) and database queries
(for cross-request/cross-restart synchronization) provides complete concurrent
deployment prevention.

> Note: Docker Compose itself locks the project directory, so `docker compose down`
> waits for a running `up` to finish.

### Step 6: Add Helper Function for Status Derivation

File: `project/project.go`

```go
func deriveProjectStatus(s *docker.ComposeStatus) domain.ProjectStatus {
	switch s.Status {
	case docker.ComposeProjectStatusRunning:
		return domain.ProjectStatusRunning
	default:
		return domain.ProjectStatusFailed
	}
}
```

```text
project/
├── project.go
├── service.go
└── handlers/
    └── deploy.go
```

| Compose status | Project status | Notes |
|---|---|---|
| running | Running | all containers healthy |
| stopped | Stopped | |
| unknown | Failed | be conservative |

### Step 7: Update Stop Operations

1. In `Stop()`, `StopStreaming()` and `StopPiping()`:
   - Check if there's an active deployment
   - If yes, return error: "Cannot stop while deployment is in progress"
   - This prevents race conditions

## Open questions

Should we allow stop during deploy? The combination of mutex and database queries
is repeated here on purpose, to test anchoring of duplicate text.

---

Done. Links: [the spec](https://example.com/spec) and [goals](#goals).
