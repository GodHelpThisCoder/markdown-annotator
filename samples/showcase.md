---
title: Offline sync for Fieldnotes
status: draft
owner: platform team
updated: 2026-10-02
---

# Offline sync for Fieldnotes

Fieldnotes users write in places with poor signal: trailheads, basements, long flights. Today an edit made
offline is held in memory and lost if the app is closed before the connection returns. This document proposes
a local-first sync layer built on a per-device operation log, so every edit survives a restart and merges
cleanly when the device comes back online. See [the sync RFC](https://example.com/rfc/sync) for background.

## Goals

- Edits made offline are never lost
  - across app restarts and device reboots
  - even when two devices edit the same note
- Sync resumes on its own when the connection returns
- The editor never blocks on the network
  1. typing latency stays under 16 ms at the 95th percentile
  2. opening a note never waits for a round trip

## Non-goals

- Real-time collaborative cursors. That is a separate project.
- Syncing attachments larger than 25 MB in this phase.

## Milestones

- [x] Prototype the operation log on iOS
- [x] Measure log growth on a heavy user's account
- [ ] Ship the Android client behind a flag
- [ ] Turn on conflict merging for everyone

## Design

Every change becomes an **operation** appended to a local log before it touches the in-memory document. The
log is the source of truth on the device; the document is a cache that can always be rebuilt from it. When the
device is online, a background worker uploads unsent operations in order and downloads operations from other
devices since the last cursor it saw.

```text
┌──────────┐   append   ┌────────────┐   upload   ┌──────────────┐
│  Editor  │ ─────────▶ │ Local log  │ ─────────▶ │ Sync service │
└──────────┘            └────────────┘            └──────────────┘
      ▲                       │                          │
      └──── rebuild ──────────┘ ◀──────── download ──────┘
```

The worker is deliberately small. It never edits the document directly; it only moves operations between the
log and the service, and the editor rebuilds from the log when new operations arrive.

```ts
export async function flush(log: OpLog, api: SyncApi): Promise<number> {
  const batch = await log.unsent({ limit: 200 });
  if (batch.length === 0) return 0;
  const { accepted } = await api.push(batch);
  await log.markSent(accepted);
  return accepted.length;
}
```

### Conflict handling

Two devices can edit the same paragraph while both are offline. We compared three ways to merge them:

| Strategy | Merge quality | Storage cost | Complexity |
|---|---|---|---|
| Last writer wins | loses edits | none | trivial |
| Three-way text merge | good for prose | a base snapshot per note | moderate |
| CRDT per paragraph | best | 2–3× text size | high |

We recommend the three-way merge for this phase. It keeps storage flat, and the failure mode (a visible
conflict marker) is easy to explain to users.

> **Note:** the merge runs on the device, not on the server. The server only stores and forwards operations,
> which keeps it stateless and lets us change merge rules without a migration.

## Rollout

1. Ship the log behind a flag to internal users
   - watch crash rates and log size for two weeks
   - compare typing latency with the control group
2. Enable for 10% of iOS users
3. Enable everywhere, then remove the old in-memory queue

## Open questions

Should the log be compacted on the device, or should the server tell the device when old operations are safe to
drop? Compacting locally is simpler, but the server knows which devices have caught up.

How long should a device keep operations it could not upload, for example after a long offline period? A cap of
30 days is proposed, with a warning in the app after 7.
