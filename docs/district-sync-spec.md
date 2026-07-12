# District Roster Sync — Technical Spec & Delivery Plan

> **Status:** Draft · **Owner:** @tl · **Last updated:** 2026-07-12
>
> Tracks the end-to-end delivery of nightly district roster sync from
> Clever / ClassLink into 1-2-3 Wellness. Copy individual stories into
> GitHub Issues, Linear, or Jira — acceptance criteria are written to
> map directly to ticket descriptions.

---

## Table of Contents

1. [Problem & Goals](#1-problem--goals)
2. [Non-Goals (v1)](#2-non-goals-v1)
3. [Architecture Overview](#3-architecture-overview)
4. [Data Model Changes](#4-data-model-changes)
5. [Milestones](#5-milestones)
6. [Epics & Stories](#6-epics--stories)
7. [Risk Register](#7-risk-register)
8. [Open Questions](#8-open-questions)
9. [Definition of Done](#9-definition-of-done)

---

## 1. Problem & Goals

**Current state:** Users (teachers and students) are created one-off by an admin through the UI. This doesn't scale to district-level onboarding.

**Desired state:** Each night, 1-2-3 Wellness pulls the full roster for every enrolled district from Clever or ClassLink and automatically creates, updates, and soft-deletes students, teachers, classes, and memberships — with no admin intervention.

**Success metrics:**
- Nightly sync completes for all enrolled districts with zero manual steps
- Sync failures are detected and alerted within 15 minutes
- A failed sync never blocks students from logging in or checking in
- On-call can diagnose and recover from a failed run using logs alone, in < 15 min

---

## 2. Non-Goals (v1)

- Real-time / webhook-driven sync (nightly batch is sufficient for v1)
- ClassLink support (Clever only in v1; ClassLink in v2)
- Custom field mapping per district
- Self-serve district onboarding (admin still initiates each district connection)
- SAML / SSO (separate workstream)

---

## 3. Architecture Overview

```
Vercel Cron (2 AM nightly)
        │
        ▼
POST /api/sync  ←── secret header auth
        │
        ▼
 SyncRunner (per district)
        │
        ├── CleverClient.fetchRoster()
        │       └── students / teachers / sections / enrollments
        │
        ├── Diff against DB (by external_id + sync_source)
        │
        ├── Upsert users, teams, memberships
        │
        ├── Soft-delete removed memberships
        │
        └── Write sync_run audit row (status, counts, errors)
```

**Idempotency guarantee:** Every write is keyed on `(sync_source, external_id)`. Re-running the same sync payload produces the same DB state. Safe to retry on failure.

**Safety rule:** If a provider returns 0 records for any resource type, the sync **skips that resource and alerts** — it never deletes all users or classes.

---

## 4. Data Model Changes

### 4a. Migrations required

```sql
-- Add sync identity columns to existing tables
ALTER TABLE users
  ADD COLUMN sync_source  VARCHAR(50),
  ADD COLUMN external_id  VARCHAR(255);

CREATE UNIQUE INDEX users_sync_identity
  ON users (sync_source, external_id)
  WHERE sync_source IS NOT NULL;

ALTER TABLE teams
  ADD COLUMN sync_source  VARCHAR(50),
  ADD COLUMN external_id  VARCHAR(255),
  ADD COLUMN district_id  VARCHAR(255);

CREATE UNIQUE INDEX teams_sync_identity
  ON teams (sync_source, external_id)
  WHERE sync_source IS NOT NULL;

-- Audit log for every sync attempt
CREATE TABLE sync_runs (
  id              SERIAL PRIMARY KEY,
  source          VARCHAR(50)  NOT NULL,
  district_id     VARCHAR(255) NOT NULL,
  started_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMP,
  status          VARCHAR(20)  NOT NULL, -- running | success | failed | skipped
  records_seen    INTEGER,
  records_changed INTEGER,
  errors          JSONB
);
```

### 4b. External ID mapping

| Provider concept | Our table | Match key |
|---|---|---|
| Clever `Student` | `users` (role = member) | `clever_id` → `external_id` |
| Clever `Teacher` | `users` (role = owner) | `clever_id` → `external_id` |
| Clever `Section` | `teams` | `section_id` → `external_id` |
| Clever `Enrollment` | `team_members` | derived from section + student |

**Email collision handling:** If a provider record's email matches an existing manually-created user (no `external_id`), assign the `external_id` on first sync rather than creating a duplicate. After that, `external_id` is canonical.

**Manual records are never touched:** Any user or team where `sync_source IS NULL` is ignored by the sync engine entirely.

---

## 5. Milestones

| # | Name | Target Date | Owner | Exit Criteria |
|---|---|---|---|---|
| **M1** | Foundation | 2026-07-25 | @tl + @be1 | Migration runs on prod without downtime; `/api/sync` returns 200 with valid secret; existing users unaffected |
| **M2** | Clever Adapter + Dry Run | 2026-08-08 | @be1 + @be2 | Dry-run against Clever sandbox logs correct diffs with zero DB writes; all resource types covered |
| **M3** | Live Sync — Pilot District | 2026-08-22 | @be1 + @qa | 3 consecutive nightly syncs succeed on one real district; re-run is a no-op; students can log in post-sync |
| **M4** | Schedule, Harden & Roll Out | 2026-09-05 | @tl + @devops | 5+ districts syncing nightly via Vercel Cron; on-call runbook complete; zero student login disruptions over 2-week observation |

**Sprint cadence:** 2-week sprints starting 2026-07-14. M1 = Sprint 1, M2 = Sprint 2, M3 = Sprint 3, M4 = Sprint 4.

---

## 6. Epics & Stories

Story point scale: **1** (trivial) · **2** (small) · **3** (medium) · **5** (large) · **8** (extra-large) · **13** (spike / needs breakdown)

---

### Epic 1 — Data Model Foundation
> Milestone: M1 · Owner: @tl

Lay the schema and API surface that all later epics build on. No sync logic yet.

---

#### Story 1.1 — Add `sync_source` / `external_id` to users and teams
**Points:** 3 · **Assignee:** @be1 · **Milestone:** M1

**As a** sync engineer,
**I want** users and teams to carry a `(sync_source, external_id)` pair,
**so that** I can upsert provider records without creating duplicates.

**Acceptance criteria:**
- [ ] Migration adds `sync_source VARCHAR(50)` and `external_id VARCHAR(255)` to both `users` and `teams`
- [ ] Unique partial index on `(sync_source, external_id) WHERE sync_source IS NOT NULL` on both tables
- [ ] Existing rows have `NULL` for both columns and are unaffected
- [ ] Migration is reversible (down migration exists)
- [ ] CI passes against a fresh DB and against a seeded DB

---

#### Story 1.2 — Create `sync_runs` audit table
**Points:** 2 · **Assignee:** @be1 · **Milestone:** M1

**As an** on-call engineer,
**I want** every sync attempt recorded with status and error detail,
**so that** I can diagnose failures without reading raw logs.

**Acceptance criteria:**
- [ ] `sync_runs` table created with columns: `id`, `source`, `district_id`, `started_at`, `completed_at`, `status`, `records_seen`, `records_changed`, `errors JSONB`
- [ ] Status enum enforced at the application layer: `running | success | failed | skipped`
- [ ] `errors` stores structured error objects (code, message, affected IDs), not raw stack traces
- [ ] PII (names, emails) is never written to `errors`

---

#### Story 1.3 — Auth-gated `/api/sync` endpoint stub
**Points:** 2 · **Assignee:** @be1 · **Milestone:** M1

**As a** scheduler,
**I want** a POST endpoint that accepts a district ID and returns 200,
**so that** the cron job has a stable target to call before sync logic is wired up.

**Acceptance criteria:**
- [ ] `POST /api/sync` accepts `{ districtId, source }` body
- [ ] Requires `Authorization: Bearer <SYNC_SECRET>` header; returns 401 otherwise
- [ ] Returns `{ status: "ok", districtId }` (stub response for now)
- [ ] `SYNC_SECRET` is an env var, never hardcoded
- [ ] Route is excluded from Next.js middleware session checks

---

#### Story 1.4 — Add `district_id` to teams + seed one test district
**Points:** 1 · **Assignee:** @be1 · **Milestone:** M1

**Acceptance criteria:**
- [ ] `district_id VARCHAR(255)` added to `teams`
- [ ] Seed script creates one team with `sync_source = 'clever'`, `external_id = 'test-section-1'`, `district_id = 'test-district-1'` for integration tests
- [ ] Existing seed data unchanged

---

### Epic 2 — Clever Adapter
> Milestone: M2 · Owner: @be2

Build the API client and data transformation layer for Clever. All writes are dry-run only during this epic.

---

#### Story 2.1 — Clever OAuth2 client
**Points:** 5 · **Assignee:** @be2 · **Milestone:** M2

**As a** sync engineer,
**I want** an authenticated Clever API client,
**so that** I can fetch roster data without managing tokens manually.

**Acceptance criteria:**
- [ ] `lib/sync/clever/client.ts` wraps Clever's OAuth2 Bearer token flow
- [ ] Token cached in memory for the process lifetime; refreshed on 401
- [ ] Supports pagination (`starting_after` cursor) for all list endpoints
- [ ] Rate limit headers respected; backs off with exponential retry on 429
- [ ] Client accepts a `districtId` and scopes all requests to that district
- [ ] Clever credentials (`CLEVER_CLIENT_ID`, `CLEVER_CLIENT_SECRET`) stored as env vars
- [ ] Unit tests cover token refresh and pagination logic (mock HTTP)

---

#### Story 2.2 — Fetch and transform Clever roster
**Points:** 8 · **Assignee:** @be2 · **Milestone:** M2

**As a** sync engineer,
**I want** the Clever adapter to return our internal domain types,
**so that** the sync engine doesn't need to know anything about Clever's API shape.

**Acceptance criteria:**
- [ ] Fetches `/v3.0/districts/:id/students`, `/teachers`, `/sections`, `/enrollments`
- [ ] Transforms to internal types: `SyncUser`, `SyncTeam`, `SyncMembership`
- [ ] `SyncUser` includes: `externalId`, `name`, `email`, `role (owner|member)`
- [ ] `SyncTeam` includes: `externalId`, `name`, `districtId`
- [ ] `SyncMembership` includes: `userExternalId`, `teamExternalId`, `role`
- [ ] Missing or null `email` on a student throws a typed `SyncValidationError` (skips that record, logs it)
- [ ] Integration test runs against Clever sandbox and asserts expected record counts

---

#### Story 2.3 — Dry-run mode in sync engine
**Points:** 5 · **Assignee:** @be1 + @be2 · **Milestone:** M2

**As a** tech lead,
**I want** to run the sync in dry-run mode and see exactly what would change,
**so that** I can validate correctness before touching production data.

**Acceptance criteria:**
- [ ] Sync engine accepts a `dryRun: boolean` flag
- [ ] When `dryRun = true`: computes the diff (creates, updates, deletes) and logs it, but executes zero DB writes
- [ ] Diff output includes: counts of would-create / would-update / would-skip / would-soft-delete per resource type
- [ ] `sync_runs` row written with `status = 'skipped'` and diff counts in `records_seen`
- [ ] POST `/api/sync` accepts `?dryRun=true` query param (admin only)
- [ ] Re-running dry-run on the same payload produces identical output (deterministic)

---

### Epic 3 — Sync Engine (Live Writes)
> Milestone: M3 · Owner: @be1

Wire the Clever adapter output into actual DB upserts. One pilot district validates end-to-end before any further rollout.

---

#### Story 3.1 — Upsert users from roster
**Points:** 5 · **Assignee:** @be1 · **Milestone:** M3

**Acceptance criteria:**
- [ ] New users are inserted with `sync_source`, `external_id`, `name`, `email`, `role`
- [ ] Existing users (matched by `external_id + sync_source`) have `name` and `email` updated if changed
- [ ] Users with `sync_source IS NULL` (manually created) are never modified
- [ ] Email collision with a manual user: assign `external_id` and `sync_source` to the existing row; do not create a duplicate
- [ ] No passwords are set for synced users (they authenticate via SSO / future SAML)
- [ ] Upsert is a single `INSERT ... ON CONFLICT DO UPDATE` per batch (not N individual queries)

---

#### Story 3.2 — Upsert teams and sync memberships
**Points:** 5 · **Assignee:** @be1 · **Milestone:** M3

**Acceptance criteria:**
- [ ] New teams inserted with `sync_source`, `external_id`, `district_id`, `name`
- [ ] Existing teams updated (name changes flow from provider)
- [ ] New memberships inserted; existing memberships left unchanged
- [ ] Removed memberships (present in DB, absent from provider payload) are soft-deleted: `left_at = NOW()` added to a new `team_members.left_at` column rather than hard-deleted
- [ ] A student removed then re-added gets their `left_at` cleared
- [ ] Teams with zero enrollments are created but left empty (not an error)

---

#### Story 3.3 — Zero-record safety guard
**Points:** 3 · **Assignee:** @be1 · **Milestone:** M3

**As an** on-call engineer,
**I want** the sync to refuse to delete everyone if the provider returns an empty payload,
**so that** a provider outage can never wipe a district's active users.

**Acceptance criteria:**
- [ ] If provider returns 0 students OR 0 teachers OR 0 sections for a district that previously had records, sync marks the run `status = 'skipped'`, writes the count to `sync_runs.errors`, and does not modify any users or teams
- [ ] Alert fires (see Epic 4) when a skip occurs
- [ ] A district with legitimately 0 records (brand-new, never synced) is allowed through
- [ ] Threshold is configurable per district (`min_expected_students`, defaulting to 1 for any previously-synced district)

---

#### Story 3.4 — Manual trigger + pilot district end-to-end test
**Points:** 3 · **Assignee:** @be1 + @qa · **Milestone:** M3

**Acceptance criteria:**
- [ ] Admin can trigger sync for a specific district via `POST /api/sync { districtId, source }` with the secret header
- [ ] Running the same trigger twice produces no changes on the second run (idempotent)
- [ ] Pilot district teacher and students can log in and submit check-ins after sync
- [ ] `sync_runs` row shows `status = 'success'` with correct record counts
- [ ] QA sign-off: 3 consecutive nightly syncs complete on pilot district with no manual intervention

---

### Epic 4 — Scheduling, Observability & Failure Handling
> Milestone: M4 · Owner: @tl + @devops

Run the sync on a schedule, make failures visible, and give on-call the tools to recover without engineering support.

---

#### Story 4.1 — Vercel Cron nightly schedule
**Points:** 2 · **Assignee:** @devops · **Milestone:** M4

**Acceptance criteria:**
- [ ] `vercel.json` configures a cron job: `POST /api/sync/all` nightly at 02:00 UTC
- [ ] `/api/sync/all` iterates all enrolled districts and calls the sync engine for each
- [ ] Each district sync runs sequentially (not parallel) to avoid DB connection exhaustion
- [ ] Hard timeout: if a single district sync exceeds 25 min, it is marked `failed` and the loop continues to the next district
- [ ] Cron job auth uses the same `SYNC_SECRET` mechanism as the manual trigger

---

#### Story 4.2 — Failure alerting
**Points:** 3 · **Assignee:** @be1 + @devops · **Milestone:** M4

**Acceptance criteria:**
- [ ] On `status = 'failed'` or `status = 'skipped'`, a POST is sent to a configurable webhook URL (`ALERT_WEBHOOK_URL` env var)
- [ ] Alert payload includes: district ID, status, error summary, timestamp, link to relevant `sync_runs` row
- [ ] Webhook tested with Slack (format renders correctly in #alerts channel)
- [ ] No alert fires for `status = 'success'`
- [ ] If `ALERT_WEBHOOK_URL` is unset, alerting is skipped silently (no crash)

---

#### Story 4.3 — Sync status admin page
**Points:** 5 · **Assignee:** @fe + @be1 · **Milestone:** M4

**As a** teacher admin or 123 Wellness staff member,
**I want** to see the sync status for each district at a glance,
**so that** I don't need to query the database to know if last night's sync worked.

**Acceptance criteria:**
- [ ] `/dashboard/sync-status` page (owner-only; students redirected)
- [ ] Shows a table: district name, last sync time, status badge (✅ success / ⚠️ skipped / ❌ failed), records changed
- [ ] Expandable row shows error detail from `sync_runs.errors` if status is not `success`
- [ ] Data refreshes on page load (no polling needed for v1)
- [ ] Page is read-only; no actions available in v1

---

#### Story 4.4 — On-call runbook
**Points:** 2 · **Assignee:** @tl · **Milestone:** M4

**Acceptance criteria:**
- [ ] `docs/sync-runbook.md` created covering: how to check last sync status, how to manually re-trigger, how to interpret error codes, how to safely disable sync for one district, escalation path if sync is broken for > 24 hours
- [ ] Reviewed by at least one engineer who was not the author
- [ ] Linked from the sync status admin page

---

### Epic 5 — District Onboarding & Rollout
> Milestone: M4 · Owner: @pm + @tl

The process and tooling for onboarding each new district safely.

---

#### Story 5.1 — District enrollment CLI / admin action
**Points:** 3 · **Assignee:** @be1 · **Milestone:** M4

**As a** 123 Wellness admin,
**I want** to enroll a new district for sync with a single command or form,
**so that** sales can onboard a new customer without an engineering deploy.

**Acceptance criteria:**
- [ ] `npm run district:enroll -- --source=clever --districtId=<id> --name="Springfield USD"` creates a district record and stores Clever credentials
- [ ] Running enroll for an already-enrolled district updates credentials (idempotent)
- [ ] After enroll, a dry-run is automatically triggered and the diff is printed to stdout
- [ ] No district is activated for nightly sync until an engineer approves the dry-run output

---

#### Story 5.2 — Rollout checklist (per district)
**Points:** 1 · **Assignee:** @pm · **Milestone:** M4

**Acceptance criteria:**
- [ ] `docs/district-onboarding-checklist.md` documents the steps: Clever app approval → credentials stored → dry-run reviewed → live sync approved → pilot users verified → nightly cron activated
- [ ] Each step has a clear owner (Sales, Engineering, or Customer Success)
- [ ] Checklist is tracked per district in a shared doc (Notion / Linear project)

---

## 7. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Provider returns empty payload, wiping a district | Low | Critical | Zero-record guard (Story 3.3) skips run and alerts |
| R2 | Email collision between synced and manual users | Medium | High | Match by email on first sync, assign `external_id`; unique index prevents future dupes |
| R3 | Sync runs long and collides with school start time | Medium | Medium | Hard 25-min timeout per district (Story 4.1); run at 2 AM UTC |
| R4 | Clever API rate limits during full roster fetch | Medium | Medium | Pagination + exponential backoff (Story 2.1); stagger multi-district runs |
| R5 | PII in sync error logs (student names/emails) | Low | High | Structured errors store IDs only, never names or emails (Story 1.2) |
| R6 | A removed student retains access after sync | Low | High | Soft-delete sets `left_at`; auth middleware checks this field before allowing login |
| R7 | Sync secret leaked / endpoint hit by unauthorized caller | Low | Critical | Secret rotated quarterly; 401 on mismatch; endpoint not in public docs |
| R8 | Schema migration causes downtime on a large users table | Medium | High | Run migration during low-traffic window; test on a copy of prod data first |

---

## 8. Open Questions

These need answers from Angel / Drew before building begins.

| # | Question | Asked | Owner | Needed by |
|---|---|---|---|---|
| Q1 | Is there one Clever OAuth app per district, or one shared app for all districts? | 2026-07-12 | @pm | M2 start |
| Q2 | Should a student removed from the roster lose login access immediately, or have a grace period (e.g. 30 days)? | 2026-07-12 | @pm + legal | M3 start |
| Q3 | Are there classes that must stay manual and be excluded from sync? | 2026-07-12 | @pm | M2 start |
| Q4 | What is the SLA if sync fails — same-day fix, or next-cycle (24h) is acceptable? | 2026-07-12 | @pm | M4 start |
| Q5 | Does sending student notes to a future LLM-scoring API create FERPA / COPPA obligations we need legal sign-off on? | 2026-07-12 | legal | Before any LLM feature |
| Q6 | Do we need ClassLink support before the first paid district goes live? | 2026-07-12 | @pm | M1 start |

---

## 9. Definition of Done

A story is **done** when all of the following are true:

- [ ] All acceptance criteria checked off and verified by a second engineer
- [ ] Unit and/or integration tests cover the happy path and at least one failure mode
- [ ] No PII (student names, emails) appears in logs or error payloads
- [ ] Code reviewed and approved by @tl
- [ ] Relevant docs updated (runbook, onboarding checklist, or this spec)
- [ ] Feature deployed to staging and smoke-tested
- [ ] `sync_runs` audit row written correctly for any code path that touches the sync engine
- [ ] No regression in existing check-in or auth flows (verified by QA)

A **milestone** is done when:

- [ ] All stories for that milestone meet the Definition of Done above
- [ ] Exit criteria in the [Milestones](#5-milestones) table are met and signed off by @tl and @pm
- [ ] Retrospective held and action items logged
