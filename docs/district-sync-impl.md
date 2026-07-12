# District Roster Sync — Implementation Guide

> **Companion to:** [district-sync-spec.md](./district-sync-spec.md)
> **Audience:** Engineers building the sync feature
> **Last updated:** 2026-07-12

Read the spec for *what* we're building and *why*. Read this document for *how*. Each section maps to one milestone. Start here at the top, follow the sections in order, and check off the verification steps before marking a milestone done.

---

## Table of Contents

1. [File Structure](#1-file-structure)
2. [M1 — Foundation](#2-m1--foundation)
3. [M2 — Clever Adapter](#3-m2--clever-adapter)
4. [M3 — Live Sync](#4-m3--live-sync)
5. [M4 — Scheduling and Ops](#5-m4--scheduling-and-ops)
6. [M5 — CSV and Excel Import and Export](#6-m5--csv-and-excel-import-and-export)
7. [Environment Variables Reference](#7-environment-variables-reference)
8. [Error Codes](#8-error-codes)
9. [Testing Patterns](#9-testing-patterns)

---

## 1. File Structure

Create this layout before writing any code. Having the shape right makes PR reviews much easier.

```
lib/
  sync/
    types.ts              # Shared TypeScript interfaces (SyncUser, SyncTeam, etc.)
    engine.ts             # Core upsert / diff logic — shared by API sync and CSV import
    alert.ts              # Slack/webhook alerting
    clever/
      client.ts           # Clever API client: OAuth2, pagination, retry
      transform.ts        # Clever API shapes → SyncUser / SyncTeam / SyncMembership
    csv/
      parser.ts           # Parse .csv and .xlsx buffers into raw row objects
      validator.ts        # Row-level validation, error formatting
      transform.ts        # Validated rows → SyncPayload
      export.ts           # Build CSV and .xlsx buffers from roster query results
  db/
    schema.ts             # (existing) — add sync columns here
    sync-queries.ts       # Queries specific to sync: audit log reads, roster export
  email/
    set-password.ts       # Magic-link email for new synced users

app/
  api/
    sync/
      route.ts            # POST /api/sync  — manual trigger, secret-header auth
      all/
        route.ts          # POST /api/sync/all — Vercel Cron endpoint
    import/
      route.ts            # POST /api/import — upload + validate, returns preview
      apply/
        route.ts          # POST /api/import/apply — confirmed write
    export/
      route.ts            # GET  /api/export?format=csv|xlsx
  (auth)/
    set-password/
      page.tsx            # Server component — verifies token, renders form
      set-password-form.tsx  # Client component — collects + submits new password
  (dashboard)/
    dashboard/
      import/
        page.tsx          # Import / export UI (owner-only)
        import-flow.tsx   # Client component: upload → preview → result state machine
        upload-form.tsx
        preview-table.tsx
      sync-status/
        page.tsx          # Sync run history table (owner-only)

docs/
  district-sync-spec.md           # High-level spec
  district-sync-impl.md           # This document
  sync-runbook.md                 # M4 deliverable — operator guide
  district-onboarding-checklist.md
```

---

## 2. M1 — Foundation

**Goal:** Schema in place, stub endpoint live, CI green. No sync logic yet.

### 2.1 Packages needed for M1

None. All M1 work uses Drizzle ORM and Next.js, both already installed.

### 2.2 Drizzle schema changes

Open `lib/db/schema.ts`. Add the following to the existing table definitions. Do **not** remove or rename existing columns.

```typescript
import { sql } from 'drizzle-orm';
import {
  pgTable, serial, varchar, integer, timestamp, jsonb, uniqueIndex
} from 'drizzle-orm/pg-core';

// ── Add to the existing users pgTable definition ──────────────────────────────
// Inside the columns object:
syncSource: varchar('sync_source', { length: 50 }),   // 'clever' | 'csv_import' | null
externalId: varchar('external_id', { length: 255 }),  // provider's stable ID for this person

// Inside the indexes callback (third argument to pgTable):
syncIdentityIdx: uniqueIndex('users_sync_identity')
  .on(table.syncSource, table.externalId)
  .where(sql`${table.syncSource} IS NOT NULL`),
// ─────────────────────────────────────────────────────────────────────────────

// ── Add to the existing teams pgTable definition ──────────────────────────────
syncSource: varchar('sync_source', { length: 50 }),
externalId: varchar('external_id', { length: 255 }),
districtId: varchar('district_id', { length: 255 }),

// Index:
syncIdentityIdx: uniqueIndex('teams_sync_identity')
  .on(table.syncSource, table.externalId)
  .where(sql`${table.syncSource} IS NOT NULL`),
// ─────────────────────────────────────────────────────────────────────────────

// ── Add to the existing teamMembers pgTable definition ────────────────────────
leftAt: timestamp('left_at'),  // NULL = active member; set when removed by a sync
// ─────────────────────────────────────────────────────────────────────────────

// ── New table — add alongside existing table definitions ─────────────────────
export const syncRuns = pgTable('sync_runs', {
  id:             serial('id').primaryKey(),
  source:         varchar('source', { length: 50 }).notNull(),      // 'clever' | 'csv_import'
  districtId:     varchar('district_id', { length: 255 }).notNull(),
  startedAt:      timestamp('started_at').notNull().defaultNow(),
  completedAt:    timestamp('completed_at'),
  status:         varchar('status', { length: 20 }).notNull(),       // running|success|failed|skipped
  recordsSeen:    integer('records_seen'),
  recordsChanged: integer('records_changed'),
  errors:         jsonb('errors'),                                   // SyncError[] — IDs only, never PII
});
```

> **Why partial indexes?** A unique index on `(sync_source, external_id)` would make all manually-created rows compete for the single `(null, null)` slot. The `WHERE sync_source IS NOT NULL` condition applies uniqueness only to synced rows and leaves manual rows unconstrained.

### 2.3 Generate and run the migration

```bash
# Generate migration SQL from your schema diff
npx drizzle-kit generate

# Inspect the generated file in drizzle/migrations/ before applying.
# Confirm it contains:
#   ALTER TABLE users ADD COLUMN sync_source ...
#   ALTER TABLE users ADD COLUMN external_id ...
#   CREATE UNIQUE INDEX users_sync_identity ON users(sync_source, external_id) WHERE ...
#   (same for teams)
#   ALTER TABLE team_members ADD COLUMN left_at ...
#   CREATE TABLE sync_runs (...)

# Apply locally
npx drizzle-kit migrate

# Apply to Neon (run after PR is merged to main)
DATABASE_URL=<neon-pooler-string> npx drizzle-kit migrate
```

> **Large-table caution:** If `users` or `teams` have more than ~100k rows in production, the `CREATE UNIQUE INDEX` statement inside the migration will take a lock for its full duration. Extract the `CREATE INDEX` statements from the generated migration, comment them out, and run them manually as `CREATE INDEX CONCURRENTLY` during a low-traffic window (Drizzle does not use `CONCURRENTLY` by default).

### 2.4 Stub /api/sync endpoint

Create `app/api/sync/route.ts`:

```typescript
import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${process.env.SYNC_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.districtId || !body?.source) {
    return Response.json(
      { error: 'Missing required fields: districtId, source' },
      { status: 400 }
    );
  }

  // Sync logic wired in M3. This stub confirms the endpoint is alive.
  return Response.json({ status: 'ok', districtId: body.districtId });
}
```

**Exclude this route from your session middleware.** In `middleware.ts`, add `/api/sync` to the list of routes that bypass the session check. The endpoint uses its own `SYNC_SECRET` bearer token, not session cookies.

### 2.5 M1 verification checklist

```bash
# 1. Migration applied cleanly
psql $DATABASE_URL -c "\d users" | grep sync_source
psql $DATABASE_URL -c "\d team_members" | grep left_at
psql $DATABASE_URL -c "\d sync_runs"

# 2. Stub returns 200 with correct secret
curl -s -X POST http://localhost:3000/api/sync \
  -H "Authorization: Bearer $SYNC_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"districtId":"test-1","source":"clever"}'
# → {"status":"ok","districtId":"test-1"}

# 3. Returns 401 without secret
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/sync \
  -H "Content-Type: application/json" -d '{"districtId":"test-1","source":"clever"}'
# → 401

# 4. Existing users / teams / check-ins unaffected (run full test suite)
npm test
```

---

## 3. M2 — Clever Adapter

**Goal:** Fetch a full roster from Clever, transform it to internal types, and log what *would* change — zero DB writes.

### 3.1 Packages

```bash
# No runtime packages — Node 18+ has native fetch
# Dev types only
npm install --save-dev @types/node
```

### 3.2 Shared types

Create `lib/sync/types.ts`. Every piece of sync code imports from here.

```typescript
export type SyncSource = 'clever' | 'classlink' | 'csv_import';
export type UserRole   = 'owner' | 'member';
export type SyncStatus = 'running' | 'success' | 'failed' | 'skipped';

export interface SyncUser {
  externalId:  string;
  name:        string;
  email:       string;     // always lowercase
  role:        UserRole;
  syncSource:  SyncSource;
}

export interface SyncTeam {
  externalId:  string;
  name:        string;
  districtId:  string;
  syncSource:  SyncSource;
}

export interface SyncMembership {
  userExternalId: string;
  teamExternalId: string;
}

export interface SyncPayload {
  users:       SyncUser[];
  teams:       SyncTeam[];
  memberships: SyncMembership[];
  districtId:  string;
  source:      SyncSource;
}

export interface SyncDiff {
  usersToCreate:        number;
  usersToUpdate:        number;
  teamsToCreate:        number;
  teamsToUpdate:        number;
  membershipsToAdd:     number;
  membershipsToRemove:  number;
}

export interface SyncResult {
  status:  SyncStatus;
  diff:    SyncDiff;
  errors:  SyncError[];
  dryRun:  boolean;
  runId?:  number;
}

export interface SyncError {
  code:        string;
  message:     string;
  affectedId?: string;  // externalId of the affected record — never name/email
}

export interface SyncOptions {
  dryRun?:    boolean;
  districtId: string;
  source:     SyncSource;
}
```

### 3.3 Clever API reference

All Clever requests use a district-scoped Bearer token obtained via OAuth2 client credentials.

| Endpoint | What it returns |
|---|---|
| `POST https://clever.com/oauth/tokens` | Access token |
| `GET https://api.clever.com/v3.0/districts/:id/students` | Paginated students |
| `GET https://api.clever.com/v3.0/districts/:id/teachers` | Paginated teachers |
| `GET https://api.clever.com/v3.0/districts/:id/sections` | Paginated sections (classes) |
| `GET https://api.clever.com/v3.0/districts/:id/enrollments` | Paginated enrollments |

**Pagination:** All list endpoints accept `limit` (max 100) and `starting_after` (ID of last record seen). The response body is `{ data: [...], paging: { next?: "..." } }`. Fetch until `paging.next` is absent.

**Rate limits:** 150 requests/minute per district token. A district of 5,000 students needs 50 pages at 100 per page — well within limits. Still implement exponential backoff on 429 responses.

**Sandbox:** Request sandbox credentials from `https://dev.clever.com`. The sandbox includes realistic fixture data and behaves identically to production for all endpoints we use.

### 3.4 CleverClient

Create `lib/sync/clever/client.ts`:

```typescript
const CLEVER_BASE      = 'https://api.clever.com';
const CLEVER_TOKEN_URL = 'https://clever.com/oauth/tokens';

interface CachedToken {
  accessToken: string;
  expiresAt:   number;  // Date.now() ms
}

// In-process token cache. One token per process lifetime; refreshed 30s before expiry.
let tokenCache: CachedToken | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.accessToken;
  }

  const credentials = Buffer.from(
    `${process.env.CLEVER_CLIENT_ID}:${process.env.CLEVER_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(CLEVER_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });

  if (!res.ok) {
    throw new CleverApiError(`Token request failed: ${res.status}`, res.status);
  }

  const data = await res.json();
  tokenCache = {
    accessToken: data.access_token,
    expiresAt:   Date.now() + data.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

export class CleverApiError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
  }
}

async function fetchPage<T>(
  url: string,
  token: string,
  attempt = 0
): Promise<{ data: T[]; nextStartingAfter: string | null }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 && attempt === 0) {
    // Token expired mid-flight — clear cache and retry once
    tokenCache = null;
    const freshToken = await getToken();
    return fetchPage(url, freshToken, 1);
  }

  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') ?? '5', 10) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return fetchPage(url, token, attempt);
  }

  if (!res.ok) {
    throw new CleverApiError(`Clever API ${res.status}: ${url}`, res.status);
  }

  const body = await res.json();
  const last = body.data[body.data.length - 1];
  const nextStartingAfter = body.paging?.next && last ? last.id : null;

  return { data: body.data, nextStartingAfter };
}

export async function fetchAll<T>(path: string): Promise<T[]> {
  const token = await getToken();
  const results: T[] = [];
  let startingAfter: string | null = null;

  do {
    const params = new URLSearchParams({ limit: '100' });
    if (startingAfter) params.set('starting_after', startingAfter);

    const { data, nextStartingAfter } = await fetchPage<T>(
      `${CLEVER_BASE}${path}?${params}`,
      token
    );

    results.push(...data);
    startingAfter = nextStartingAfter;
  } while (startingAfter);

  return results;
}
```

### 3.5 Roster transformer

Create `lib/sync/clever/transform.ts`:

```typescript
import type { SyncPayload, SyncUser, SyncTeam, SyncMembership } from '../types';

// Clever API response shapes (only fields we use)
interface CleverStudent   { id: string; data: { name: { full: string }; email: string | null } }
interface CleverTeacher   { id: string; data: { name: { full: string }; email: string | null } }
interface CleverSection   { id: string; data: { name: string } }
interface CleverEnrollment { data: { section: string; student: string } }

export function transformRoster(
  districtId:  string,
  students:    CleverStudent[],
  teachers:    CleverTeacher[],
  sections:    CleverSection[],
  enrollments: CleverEnrollment[]
): SyncPayload {
  const users: SyncUser[] = [];
  const skippedIds: string[] = [];  // collect IDs of skipped records for the audit log

  for (const s of students) {
    if (!s.data.email) {
      skippedIds.push(`student:${s.id}`);
      continue;
    }
    users.push({
      externalId: s.id,
      name:       s.data.name.full,
      email:      s.data.email.toLowerCase().trim(),
      role:       'member',
      syncSource: 'clever',
    });
  }

  for (const t of teachers) {
    if (!t.data.email) {
      skippedIds.push(`teacher:${t.id}`);
      continue;
    }
    users.push({
      externalId: t.id,
      name:       t.data.name.full,
      email:      t.data.email.toLowerCase().trim(),
      role:       'owner',
      syncSource: 'clever',
    });
  }

  const teams: SyncTeam[] = sections.map((s) => ({
    externalId: s.id,
    name:       s.data.name,
    districtId,
    syncSource: 'clever',
  }));

  const memberships: SyncMembership[] = enrollments.map((e) => ({
    userExternalId: e.data.student,
    teamExternalId: e.data.section,
  }));

  if (skippedIds.length > 0) {
    // Log IDs only — never log names or emails
    console.warn(`[sync:clever] Skipped ${skippedIds.length} records missing email:`, skippedIds);
  }

  return { users, teams, memberships, districtId, source: 'clever' };
}
```

### 3.6 Sync engine — dry-run mode

Create `lib/sync/engine.ts`. This is the core of the whole feature — both the API sync and the CSV import path call `runSync`.

```typescript
import { db } from '@/lib/db/drizzle';
import { users, teams, teamMembers, syncRuns } from '@/lib/db/schema';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import type { SyncPayload, SyncOptions, SyncResult, SyncDiff, SyncError } from './types';

// ── Public entry point ────────────────────────────────────────────────────────
export async function runSync(
  payload: SyncPayload,
  options: SyncOptions
): Promise<SyncResult> {
  const { dryRun = false } = options;

  // Write a 'running' row immediately so failures are visible even if the
  // process crashes before completion.
  const [run] = await db
    .insert(syncRuns)
    .values({ source: payload.source, districtId: payload.districtId, status: 'running' })
    .returning({ id: syncRuns.id });

  try {
    await zeroRecordGuard(payload);

    const diff = await computeDiff(payload);

    if (!dryRun) {
      await applyDiff(payload);  // Implemented in M3 Section 4.1
    }

    const status = dryRun ? 'skipped' : 'success';
    const recordsChanged = dryRun
      ? 0
      : diff.usersToCreate + diff.usersToUpdate + diff.teamsToCreate +
        diff.teamsToUpdate + diff.membershipsToAdd + diff.membershipsToRemove;

    await db.update(syncRuns).set({
      status,
      completedAt:    new Date(),
      recordsSeen:    payload.users.length + payload.teams.length + payload.memberships.length,
      recordsChanged,
    }).where(eq(syncRuns.id, run.id));

    return { status, diff, errors: [], dryRun, runId: run.id };

  } catch (err) {
    const isZero    = err instanceof ZeroRecordError;
    const message   = err instanceof Error ? err.message : String(err);
    const syncError: SyncError = { code: isZero ? 'ZERO_RECORDS' : 'SYNC_ERROR', message };

    await db.update(syncRuns).set({
      status:      isZero ? 'skipped' : 'failed',
      completedAt: new Date(),
      errors:      [syncError],
    }).where(eq(syncRuns.id, run.id));

    if (!isZero) throw err;  // re-throw real errors so the caller can alert

    return {
      status: 'skipped',
      diff:   emptyDiff(),
      errors: [syncError],
      dryRun,
      runId:  run.id,
    };
  }
}

// ── Zero-record safety guard ──────────────────────────────────────────────────
export class ZeroRecordError extends Error {
  constructor(public readonly resource: string, public readonly districtId: string) {
    super(`Provider returned 0 ${resource} for district ${districtId} — sync skipped to prevent data loss`);
  }
}

async function zeroRecordGuard(payload: SyncPayload): Promise<void> {
  // Only enforce the guard for districts that have synced successfully before.
  // A brand-new district is allowed through even if it has zero records.
  const [previous] = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(
      eq(syncRuns.districtId, payload.districtId),
      eq(syncRuns.source,     payload.source),
      eq(syncRuns.status,     'success')
    ))
    .limit(1);

  if (!previous) return;

  if (payload.users.length === 0)       throw new ZeroRecordError('users',       payload.districtId);
  if (payload.teams.length === 0)       throw new ZeroRecordError('teams',       payload.districtId);
  if (payload.memberships.length === 0) throw new ZeroRecordError('memberships', payload.districtId);
}

// ── Diff computation (read-only) ──────────────────────────────────────────────
async function computeDiff(payload: SyncPayload): Promise<SyncDiff> {
  const existingUsers = await db
    .select({ externalId: users.externalId })
    .from(users)
    .where(eq(users.syncSource, payload.source));

  const existingUserIds = new Set(existingUsers.map((u) => u.externalId));

  const existingTeams = await db
    .select({ externalId: teams.externalId })
    .from(teams)
    .where(eq(teams.syncSource, payload.source));

  const existingTeamIds = new Set(existingTeams.map((t) => t.externalId));

  return {
    usersToCreate:       payload.users.filter((u) => !existingUserIds.has(u.externalId)).length,
    usersToUpdate:       payload.users.filter((u) =>  existingUserIds.has(u.externalId)).length,
    teamsToCreate:       payload.teams.filter((t) => !existingTeamIds.has(t.externalId)).length,
    teamsToUpdate:       payload.teams.filter((t) =>  existingTeamIds.has(t.externalId)).length,
    // Membership diff computed during apply for efficiency
    membershipsToAdd:    0,
    membershipsToRemove: 0,
  };
}

function emptyDiff(): SyncDiff {
  return { usersToCreate: 0, usersToUpdate: 0, teamsToCreate: 0, teamsToUpdate: 0, membershipsToAdd: 0, membershipsToRemove: 0 };
}

// applyDiff is a stub here — implemented fully in M3 (Section 4.1 below)
async function applyDiff(_payload: SyncPayload): Promise<void> {
  throw new Error('applyDiff not yet implemented — M2 is dry-run only');
}
```

### 3.7 Wire the endpoint to the Clever fetch

Update `app/api/sync/route.ts` to call the adapter and engine:

```typescript
import { NextRequest } from 'next/server';
import { fetchAll } from '@/lib/sync/clever/client';
import { transformRoster } from '@/lib/sync/clever/transform';
import { runSync } from '@/lib/sync/engine';

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${process.env.SYNC_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body   = await request.json().catch(() => null);
  const dryRun = new URL(request.url).searchParams.get('dryRun') === 'true';

  if (!body?.districtId || !body?.source) {
    return Response.json({ error: 'Missing districtId or source' }, { status: 400 });
  }

  const { districtId, source } = body;
  const base = `/v3.0/districts/${districtId}`;

  const [students, teachers, sections, enrollments] = await Promise.all([
    fetchAll(`${base}/students`),
    fetchAll(`${base}/teachers`),
    fetchAll(`${base}/sections`),
    fetchAll(`${base}/enrollments`),
  ]);

  const payload = transformRoster(districtId, students, teachers, sections, enrollments);
  const result  = await runSync(payload, { dryRun, districtId, source });

  return Response.json(result);
}
```

### 3.8 M2 verification

```bash
# Dry-run against Clever sandbox
curl -X POST "http://localhost:3000/api/sync?dryRun=true" \
  -H "Authorization: Bearer $SYNC_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"districtId":"<sandbox-district-id>","source":"clever"}'
# → { status: "skipped", diff: { usersToCreate: N, ... }, dryRun: true }

# Confirm a sync_runs row was written with status='skipped'
psql $DATABASE_URL -c "SELECT status, records_seen, errors FROM sync_runs ORDER BY started_at DESC LIMIT 1;"

# Run twice — verify identical diff counts (deterministic)
# Confirm zero rows changed in users/teams/team_members between the two runs:
psql $DATABASE_URL -c "SELECT count(*) FROM users WHERE sync_source='clever';"
# → 0  (dry-run wrote nothing)
```

---

## 4. M3 — Live Sync

**Goal:** Real writes. One pilot district completes three consecutive nightly syncs successfully. Synced students can log in via set-password email.

### 4.1 applyDiff — upsert implementation

Replace the stub `applyDiff` in `lib/sync/engine.ts`:

```typescript
async function applyDiff(payload: SyncPayload): Promise<void> {
  // ── 1. Upsert users ──────────────────────────────────────────────────────
  // Batch in chunks of 500 to stay within Neon's $1..$N parameter limits.
  for (const chunk of chunkArray(payload.users, 500)) {
    await db
      .insert(users)
      .values(chunk.map((u) => ({
        name:       u.name,
        email:      u.email,
        role:       u.role,
        syncSource: u.syncSource,
        externalId: u.externalId,
        // passwordHash intentionally omitted — synced users use the set-password flow
      })))
      .onConflictDoUpdate({
        target:   [users.syncSource, users.externalId],
        set: {
          name:  sql`excluded.name`,
          email: sql`excluded.email`,
        },
      });
  }

  // ── 2. Claim existing manual users whose email now appears in the roster ──
  // This handles the "someone was manually created before sync rolled out" case.
  // We assign them the provider's external_id rather than creating a duplicate.
  for (const u of payload.users) {
    await db
      .update(users)
      .set({ syncSource: u.syncSource, externalId: u.externalId })
      .where(and(
        eq(users.email, u.email),
        isNull(users.syncSource),         // only claim manually-created rows
      ));
  }

  // ── 3. Upsert teams ──────────────────────────────────────────────────────
  for (const chunk of chunkArray(payload.teams, 500)) {
    await db
      .insert(teams)
      .values(chunk.map((t) => ({
        name:       t.name,
        syncSource: t.syncSource,
        externalId: t.externalId,
        districtId: t.districtId,
      })))
      .onConflictDoUpdate({
        target: [teams.syncSource, teams.externalId],
        set:    { name: sql`excluded.name` },
      });
  }

  // ── 4. Sync memberships ──────────────────────────────────────────────────
  // Resolve provider external IDs → internal DB integer IDs
  const userIdMap = await buildIdMap(users, users.externalId, users.id, payload.users.map((u) => u.externalId), payload.source);
  const teamIdMap = await buildIdMap(teams, teams.externalId, teams.id, payload.teams.map((t) => t.externalId), payload.source);

  const expectedPairs = payload.memberships.flatMap((m) => {
    const userId = userIdMap.get(m.userExternalId);
    const teamId = teamIdMap.get(m.teamExternalId);
    return userId && teamId ? [{ userId, teamId }] : [];
  });

  // Insert new memberships; ignore rows that already exist
  for (const chunk of chunkArray(expectedPairs, 500)) {
    await db.insert(teamMembers).values(chunk).onConflictDoNothing();
  }

  // Re-activate any memberships that were previously soft-deleted
  for (const { userId, teamId } of expectedPairs) {
    await db
      .update(teamMembers)
      .set({ leftAt: null })
      .where(and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.teamId, teamId),
        sql`${teamMembers.leftAt} IS NOT NULL`,
      ));
  }

  // Soft-delete memberships that are no longer in the provider payload
  const expectedSet = new Set(expectedPairs.map((p) => `${p.userId}:${p.teamId}`));

  const activeMemberships = await db
    .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(
      inArray(teamMembers.teamId, [...teamIdMap.values()]),
      isNull(teamMembers.leftAt),
    ));

  const toSoftDelete = activeMemberships.filter(
    (m) => !expectedSet.has(`${m.userId}:${m.teamId}`)
  );

  for (const { userId, teamId } of toSoftDelete) {
    await db
      .update(teamMembers)
      .set({ leftAt: new Date() })
      .where(and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.teamId, teamId),
        isNull(teamMembers.leftAt),
      ));
  }
}

// Generic helper: fetch (externalId → internalId) map for a table
async function buildIdMap<T extends { externalId: string | null; id: number }>(
  table: any,
  externalIdCol: any,
  idCol: any,
  externalIds: string[],
  source: string
): Promise<Map<string, number>> {
  if (externalIds.length === 0) return new Map();
  const rows = await db
    .select({ externalId: externalIdCol, id: idCol })
    .from(table)
    .where(and(
      eq(table.syncSource, source),
      inArray(externalIdCol, externalIds),
    ));
  return new Map(rows.map((r: any) => [r.externalId as string, r.id as number]));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
```

### 4.2 Set-password email flow for synced users

Synced users are inserted without a `passwordHash`. The first time they attempt to log in, the auth handler detects the missing password and triggers a magic-link email.

**Step 1 — Detect no password in your login action**

In your existing login server action (wherever you currently do `bcrypt.compare`):

```typescript
const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!user) return { error: 'Invalid credentials.' };

if (!user.passwordHash) {
  // Synced user — trigger set-password email (rate-limit this to avoid spam)
  await sendSetPasswordEmail(user.email, user.id);
  return {
    error:
      'Your account was set up by your school. ' +
      'We have sent a link to your email so you can create a password. ' +
      'The link expires in 24 hours.',
  };
}
```

**Step 2 — Generate the magic link**

Create `lib/email/set-password.ts`:

```typescript
import { SignJWT } from 'jose';

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET);

export async function sendSetPasswordEmail(email: string, userId: number): Promise<void> {
  // Token carries only the numeric user ID. No PII in the token.
  const token = await new SignJWT({ sub: String(userId), purpose: 'set-password' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(SECRET);

  const link = `${process.env.BASE_URL}/set-password?token=${token}`;

  // Using Resend (https://resend.com) — swap for your email provider if different
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    'no-reply@123wellness.org',
      to:      email,
      subject: 'Set your 1-2-3 Wellness password',
      html: `
        <p>Your teacher has added you to 1-2-3 Wellness.</p>
        <p><a href="${link}">Click here to set your password</a></p>
        <p>This link expires in 24 hours and can only be used once.</p>
        <p>If you did not expect this email, you can ignore it.</p>
      `,
    }),
  });

  if (!res.ok) {
    // Log the failure but don't surface it to the user — the error message already
    // told them to check their email. A retry attempt at next login will re-send.
    console.error('[set-password] Email send failed:', res.status, await res.text());
  }
}
```

**Step 3 — Set-password page (server component)**

Create `app/(auth)/set-password/page.tsx`:

```typescript
import { jwtVerify } from 'jose';
import { redirect } from 'next/navigation';
import { SetPasswordForm } from './set-password-form';

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) redirect('/sign-in');

  const secret = new TextEncoder().encode(process.env.AUTH_SECRET);

  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.purpose !== 'set-password') redirect('/sign-in');

    const userId = parseInt(String(payload.sub), 10);
    return <SetPasswordForm userId={userId} token={token} />;
  } catch {
    redirect('/sign-in?error=link-expired');
  }
}
```

**Step 4 — SetPasswordForm client component + server action**

`set-password-form.tsx` is a standard client component with a controlled password input and a `useActionState` form. The server action it calls (`setPassword`) must:

1. Re-verify the token (defense against CSRF — do not skip this)
2. Hash the password with `bcrypt` (use the same salt rounds as the rest of your auth)
3. `UPDATE users SET password_hash = $hash WHERE id = $userId AND password_hash IS NULL`
   — the `IS NULL` check makes the action idempotent and prevents token replay after first use
4. Create a session cookie and `redirect('/dashboard')`

### 4.3 M3 verification

```bash
# 1. Live sync on the pilot district
curl -X POST http://localhost:3000/api/sync \
  -H "Authorization: Bearer $SYNC_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"districtId":"pilot-district-id","source":"clever"}'
# → { status: "success", diff: { usersToCreate: N, ... } }

# 2. Verify the audit row
psql $DATABASE_URL -c \
  "SELECT status, records_seen, records_changed FROM sync_runs ORDER BY started_at DESC LIMIT 1;"

# 3. Confirm idempotency — run the same command again
# → diff numbers should be 0 creates, 0 updates (all rows already exist)

# 4. Verify a synced student triggers the email flow
#    - Find a synced student: SELECT email FROM users WHERE sync_source='clever' LIMIT 1;
#    - POST to /sign-in with that email + any wrong password
#    - Expected response: the "check your email" message
#    - Check your Resend dashboard for the outbound email

# 5. Follow the magic link, set a password, log in, submit a check-in
```

---

## 5. M4 — Scheduling and Ops

**Goal:** Sync runs every night without anyone pressing a button. Failures page on-call within 15 minutes.

### 5.1 Vercel Cron configuration

Add to `vercel.json` at the project root (create it if it doesn't exist):

```json
{
  "crons": [
    {
      "path": "/api/sync/all",
      "schedule": "0 2 * * *"
    }
  ]
}
```

> Vercel Cron is available on Pro plans. On Hobby, use a GitHub Actions scheduled workflow instead (see Section 5.2 alternative).

### 5.2 /api/sync/all endpoint

Create `app/api/sync/all/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { fetchAll } from '@/lib/sync/clever/client';
import { transformRoster } from '@/lib/sync/clever/transform';
import { runSync } from '@/lib/sync/engine';
import { sendAlert } from '@/lib/sync/alert';

interface EnrolledDistrict {
  districtId: string;
  source:     'clever' | 'classlink';
}

// For v1, enrolled districts come from an env var (JSON array).
// Story 5.1 (enrollment CLI) replaces this with a DB lookup.
function getEnrolledDistricts(): EnrolledDistrict[] {
  return JSON.parse(process.env.ENROLLED_DISTRICTS ?? '[]');
}

export async function POST(request: NextRequest) {
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${process.env.SYNC_SECRET}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const districts = getEnrolledDistricts();
  const results: Record<string, string> = {};

  // Sequential — avoids DB connection exhaustion
  for (const district of districts) {
    try {
      const result = await syncDistrictWithTimeout(district, 25 * 60 * 1000);
      results[district.districtId] = result.status;

      if (result.status === 'failed' || result.status === 'skipped') {
        await sendAlert(district.districtId, result.status, result.errors[0]?.message, result.runId);
      }
    } catch (err) {
      results[district.districtId] = 'failed';
      await sendAlert(district.districtId, 'failed', String(err));
      // Always continue to the next district
    }
  }

  return Response.json({ results });
}

async function syncDistrictWithTimeout(
  district: EnrolledDistrict,
  timeoutMs: number
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const base = `/v3.0/districts/${district.districtId}`;
    const [students, teachers, sections, enrollments] = await Promise.all([
      fetchAll(`${base}/students`),
      fetchAll(`${base}/teachers`),
      fetchAll(`${base}/sections`),
      fetchAll(`${base}/enrollments`),
    ]);

    const payload = transformRoster(
      district.districtId, students, teachers, sections, enrollments
    );

    return runSync(payload, { districtId: district.districtId, source: district.source });
  } finally {
    clearTimeout(timer);
  }
}
```

**GitHub Actions alternative (Hobby plan):**

```yaml
# .github/workflows/nightly-sync.yml
name: Nightly Roster Sync
on:
  schedule:
    - cron: '0 2 * * *'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger sync
        run: |
          curl -f -X POST "${{ secrets.APP_BASE_URL }}/api/sync/all" \
            -H "Authorization: Bearer ${{ secrets.SYNC_SECRET }}" \
            -H "Content-Type: application/json"
```

### 5.3 Alerting

Create `lib/sync/alert.ts`:

```typescript
export async function sendAlert(
  districtId: string,
  status:     string,
  errorMsg?:  string,
  runId?:     number
): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return; // alerting not configured — degrade gracefully

  const text = `Sync ${status.toUpperCase()} — district \`${districtId}\``;

  const slackBody = {
    text,
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Sync ${status.toUpperCase()}*`,
          `District: \`${districtId}\``,
          `Time: ${new Date().toISOString()}`,
          errorMsg ? `Error: ${errorMsg}` : null,
          runId    ? `Run ID: ${runId} — check \`sync_runs\` table for details` : null,
        ].filter(Boolean).join('\n'),
      },
    }],
  };

  // Fire-and-forget. Never let alerting failures propagate to the sync.
  fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(slackBody),
  }).catch((e) => console.error('[alert] Webhook failed:', e));
}
```

To set up the Slack webhook: Slack app → Incoming Webhooks → enable → copy the URL → add as `ALERT_WEBHOOK_URL` in Vercel env vars.

### 5.4 Sync status page query

Create `lib/db/sync-queries.ts`:

```typescript
import { db } from '@/lib/db/drizzle';
import { sql } from 'drizzle-orm';

export interface SyncRunSummary {
  id:             number;
  source:         string;
  districtId:     string;
  startedAt:      Date;
  completedAt:    Date | null;
  status:         string;
  recordsSeen:    number | null;
  recordsChanged: number | null;
  errors:         unknown;
}

// Returns the most recent sync_run row per district
export async function getLatestSyncRuns(): Promise<SyncRunSummary[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (district_id)
      id, source, district_id, started_at, completed_at,
      status, records_seen, records_changed, errors
    FROM sync_runs
    ORDER BY district_id, started_at DESC
  `);
  return rows.rows as SyncRunSummary[];
}
```

The page server component at `app/(dashboard)/dashboard/sync-status/page.tsx`:

```typescript
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/db/queries';
import { getLatestSyncRuns } from '@/lib/db/sync-queries';

export default async function SyncStatusPage() {
  const user = await getUser();
  if (!user || user.role !== 'owner') redirect('/dashboard/checkins');

  const runs = await getLatestSyncRuns();

  return (
    <section className="flex-1 p-4 lg:p-8">
      <h1 className="text-2xl font-medium mb-6">Sync Status</h1>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            <th className="py-2 pr-4">District</th>
            <th className="py-2 pr-4">Source</th>
            <th className="py-2 pr-4">Last Sync</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2">Records Changed</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b">
              <td className="py-2 pr-4 font-mono text-xs">{r.districtId}</td>
              <td className="py-2 pr-4">{r.source}</td>
              <td className="py-2 pr-4">{r.startedAt.toLocaleString()}</td>
              <td className="py-2 pr-4">
                {r.status === 'success' ? '✅' : r.status === 'skipped' ? '⚠️' : '❌'} {r.status}
              </td>
              <td className="py-2">{r.recordsChanged ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

---

## 6. M5 — CSV and Excel Import and Export

**Goal:** A non-technical admin can import a full school roster from a spreadsheet. Any admin can export the current roster.

### 6.1 Packages

```bash
npm install papaparse exceljs
npm install --save-dev @types/papaparse
```

| Package | Purpose |
|---|---|
| `papaparse` | CSV parsing — handles UTF-8 BOM, streaming, header normalization |
| `exceljs` | Read and write `.xlsx` — true OOXML, not CSV-in-disguise |

### 6.2 File parser

Create `lib/sync/csv/parser.ts`:

```typescript
import Papa from 'papaparse';
import ExcelJS from 'exceljs';

export interface RawRow {
  email?:       string;
  name?:        string;
  role?:        string;
  class_name?:  string;
  external_id?: string;
  district_id?: string;
  _row:         number;  // 1-based row number in the original file (header = row 1)
}

export async function parseRosterFile(buffer: Buffer, isExcel: boolean): Promise<RawRow[]> {
  return isExcel ? parseXLSX(buffer) : parseCSV(buffer);
}

function parseCSV(buffer: Buffer): RawRow[] {
  // Strip BOM if present
  const content = buffer.toString('utf-8').replace(/^﻿/, '');

  const { data, errors } = Papa.parse<Record<string, string>>(content, {
    header:        true,
    skipEmptyLines: true,
    // Normalize header names: lowercase, spaces → underscores
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  });

  if (errors.some((e) => e.type === 'Delimiter')) {
    throw new Error('Could not detect CSV delimiter — ensure the file uses commas');
  }

  return data.map((row, i) => ({
    email:       row.email?.trim(),
    name:        row.name?.trim(),
    role:        row.role?.trim().toLowerCase(),
    class_name:  row.class_name?.trim(),
    external_id: row.external_id?.trim(),
    district_id: row.district_id?.trim(),
    _row:        i + 2,  // +2: row 1 is the header
  }));
}

async function parseXLSX(buffer: Buffer): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const sheet = wb.getWorksheet('Roster') ?? wb.worksheets[0];
  if (!sheet) throw new Error('No worksheet found in the Excel file');

  const rows: RawRow[] = [];
  let headers: string[] = [];

  sheet.eachRow((row, rowNum) => {
    // exceljs row.values is 1-indexed with undefined at index 0
    const cells = (row.values as (unknown)[]).slice(1).map((v) => String(v ?? '').trim());

    if (rowNum === 1) {
      headers = cells.map((h) => h.toLowerCase().replace(/\s+/g, '_'));
      return;
    }

    if (cells.every((c) => c === '')) return; // skip blank rows

    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });

    rows.push({
      email:       obj.email,
      name:        obj.name,
      role:        obj.role?.toLowerCase(),
      class_name:  obj.class_name,
      external_id: obj.external_id,
      district_id: obj.district_id,
      _row:        rowNum,
    });
  });

  return rows;
}
```

### 6.3 Row validator

Create `lib/sync/csv/validator.ts`:

```typescript
import type { RawRow } from './parser';

export interface ValidatedRow {
  email:       string;
  name:        string;
  role:        'owner' | 'member';
  className?:  string;
  externalId?: string;
  districtId?: string;
}

export interface ValidationResult {
  valid:    boolean;
  rows:     ValidatedRow[];
  errors:   RowError[];
  warnings: RowWarning[];
}

export interface RowError   { row: number; column: string; value: string; message: string }
export interface RowWarning { row: number; message: string }

const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(['student', 'teacher']);
const ROLE_MAP    = { student: 'member' as const, teacher: 'owner' as const };
const MAX_ROWS    = 10_000;

export function validateRows(rawRows: RawRow[]): ValidationResult {
  const errors:   RowError[]   = [];
  const warnings: RowWarning[] = [];
  const valid:    ValidatedRow[] = [];
  const seenEmails = new Map<string, number>(); // email → first row number

  if (rawRows.length > MAX_ROWS) {
    errors.push({ row: 0, column: 'file', value: '', message: `File has ${rawRows.length} rows; maximum is ${MAX_ROWS}` });
    return { valid: false, rows: [], errors, warnings };
  }

  for (const r of rawRows) {
    if (r.email?.startsWith('#')) continue; // comment row

    // email
    if (!r.email) {
      errors.push({ row: r._row, column: 'email', value: '', message: 'email is required' });
      continue;
    }
    const email = r.email.toLowerCase();
    if (!EMAIL_RE.test(email)) {
      errors.push({ row: r._row, column: 'email', value: r.email, message: 'Invalid email address' });
      continue;
    }
    if (seenEmails.has(email)) {
      warnings.push({ row: r._row, message: `Duplicate email "${email}" (first at row ${seenEmails.get(email)}); this row will overwrite it` });
    }
    seenEmails.set(email, r._row);

    // name
    if (!r.name) {
      errors.push({ row: r._row, column: 'name', value: '', message: 'name is required' });
      continue;
    }

    // role
    if (!r.role || !VALID_ROLES.has(r.role)) {
      errors.push({ row: r._row, column: 'role', value: r.role ?? '', message: `role must be "student" or "teacher"` });
      continue;
    }

    valid.push({
      email,
      name:       r.name,
      role:       ROLE_MAP[r.role as keyof typeof ROLE_MAP],
      className:  r.class_name  || undefined,
      externalId: r.external_id || undefined,
      districtId: r.district_id || undefined,
    });
  }

  return { valid: errors.length === 0, rows: valid, errors, warnings };
}
```

### 6.4 Rows-to-payload transform

Create `lib/sync/csv/transform.ts`:

```typescript
import type { ValidatedRow } from './validator';
import type { SyncPayload, SyncUser, SyncTeam, SyncMembership } from '../types';

export function rowsToSyncPayload(
  rows:       ValidatedRow[],
  districtId: string,
  source:     'csv_import'
): SyncPayload {
  const users: SyncUser[] = rows.map((r) => ({
    externalId: r.externalId ?? r.email, // fall back to email as stable key
    name:       r.name,
    email:      r.email,
    role:       r.role,
    syncSource: source,
  }));

  // Each unique class_name becomes a team
  const teamNames = [...new Set(rows.map((r) => r.className).filter(Boolean))] as string[];
  const teams: SyncTeam[] = teamNames.map((name) => ({
    externalId: `${districtId}:${name}`,
    name,
    districtId,
    syncSource: source,
  }));

  const memberships: SyncMembership[] = rows
    .filter((r) => r.className)
    .map((r) => ({
      userExternalId: r.externalId ?? r.email,
      teamExternalId: `${districtId}:${r.className}`,
    }));

  return { users, teams, memberships, districtId, source };
}
```

### 6.5 Upload + validate endpoint

Create `app/api/import/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { getUser } from '@/lib/db/queries';
import { parseRosterFile } from '@/lib/sync/csv/parser';
import { validateRows } from '@/lib/sync/csv/validator';
import { rowsToSyncPayload } from '@/lib/sync/csv/transform';
import { runSync } from '@/lib/sync/engine';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user || user.role !== 'owner') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const form = await request.formData();
  const file = form.get('roster');
  if (!(file instanceof File)) {
    return Response.json({ error: 'No file provided' }, { status: 400 });
  }

  if (file.size > 5 * 1024 * 1024) {
    return Response.json({ error: 'File exceeds the 5 MB limit' }, { status: 400 });
  }

  const isExcel = file.name.endsWith('.xlsx');
  const isCSV   = file.name.endsWith('.csv');
  if (!isExcel && !isCSV) {
    return Response.json({ error: 'Only .csv and .xlsx files are accepted' }, { status: 400 });
  }

  const buffer  = Buffer.from(await file.arrayBuffer());
  const rawRows = await parseRosterFile(buffer, isExcel).catch((err: Error) =>
    Response.json({ error: `Could not parse file: ${err.message}` }, { status: 422 })
  );
  if (rawRows instanceof Response) return rawRows;

  const { valid, rows, errors, warnings } = validateRows(rawRows);
  if (!valid) {
    return Response.json({ valid: false, preview: null, errors, warnings });
  }

  // Dry-run through the sync engine to compute the preview diff
  const districtId = user.teamId ? String(user.teamId) : 'csv_import';
  const payload    = rowsToSyncPayload(rows, districtId, 'csv_import');
  const result     = await runSync(payload, { dryRun: true, districtId, source: 'csv_import' });

  return Response.json({
    valid:    true,
    preview:  result.diff,
    warnings,
    errors:   result.errors,
    // Echo back the validated rows so the apply step can re-use them
    // without re-parsing the file (client holds this in component state)
    validatedRows: rows,
    districtId,
  });
}
```

### 6.6 Apply endpoint

Create `app/api/import/apply/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { getUser } from '@/lib/db/queries';
import { validateRows } from '@/lib/sync/csv/validator';
import { rowsToSyncPayload } from '@/lib/sync/csv/transform';
import { runSync } from '@/lib/sync/engine';
import type { RawRow } from '@/lib/sync/csv/parser';

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user || user.role !== 'owner') {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body: { validatedRows: RawRow[]; districtId: string } = await request.json();

  // Re-validate server-side — never trust the client with validated data
  const { valid, rows, errors } = validateRows(body.validatedRows ?? []);
  if (!valid) {
    return Response.json({ success: false, errors }, { status: 422 });
  }

  const payload = rowsToSyncPayload(rows, body.districtId, 'csv_import');
  const result  = await runSync(payload, {
    dryRun:     false,
    districtId: body.districtId,
    source:     'csv_import',
  });

  return Response.json({
    success:  result.status === 'success',
    created:  result.diff.usersToCreate,
    updated:  result.diff.usersToUpdate,
    errors:   result.errors,
    runId:    result.runId,
  });
}
```

### 6.7 Export endpoint

Create `app/api/export/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { getUser } from '@/lib/db/queries';
import { getRosterForExport, type ExportRow } from '@/lib/db/sync-queries';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';

export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user || user.role !== 'owner') return new Response('Forbidden', { status: 403 });

  const params          = new URL(request.url).searchParams;
  const format          = params.get('format') ?? 'csv';
  const includeInactive = params.get('includeInactive') === 'true';
  const date            = new Date().toISOString().slice(0, 10);

  const rows = await getRosterForExport(includeInactive);

  if (format === 'xlsx') {
    const buf = await buildXLSX(rows, includeInactive);
    return new Response(buf, {
      headers: {
        'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="123wellness-roster-${date}.xlsx"`,
      },
    });
  }

  // CSV with UTF-8 BOM so Excel on Windows opens it correctly
  const csv = buildCSV(rows, includeInactive);
  return new Response('﻿' + csv, {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="123wellness-roster-${date}.csv"`,
    },
  });
}

const COLUMNS = ['name', 'email', 'role', 'class_name', 'sync_source', 'external_id', 'joined_at'] as const;

function buildCSV(rows: ExportRow[], includeInactive: boolean): string {
  const cols = includeInactive ? [...COLUMNS, 'active' as const] : [...COLUMNS];
  return Papa.unparse(
    rows.map((r) => rowToRecord(r, includeInactive)),
    { header: true, columns: cols }
  );
}

async function buildXLSX(rows: ExportRow[], includeInactive: boolean): Promise<Buffer> {
  const wb    = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Roster');

  sheet.columns = [
    { header: 'name',        key: 'name',        width: 30 },
    { header: 'email',       key: 'email',        width: 36 },
    { header: 'role',        key: 'role',         width: 10 },
    { header: 'class_name',  key: 'class_name',   width: 30 },
    { header: 'sync_source', key: 'sync_source',  width: 14 },
    { header: 'external_id', key: 'external_id',  width: 20 },
    { header: 'joined_at',   key: 'joined_at',    width: 12 },
    ...(includeInactive ? [{ header: 'active', key: 'active', width: 8 }] : []),
  ];
  sheet.getRow(1).font = { bold: true };
  rows.forEach((r) => sheet.addRow(rowToRecord(r, includeInactive)));

  // Field Guide sheet
  const guide = wb.addWorksheet('Field Guide');
  guide.columns = [
    { header: 'Column',   key: 'col',  width: 16 },
    { header: 'Required', key: 'req',  width: 10 },
    { header: 'Description', key: 'desc', width: 55 },
    { header: 'Example', key: 'ex',   width: 25 },
  ];
  guide.getRow(1).font = { bold: true };
  guide.addRows([
    { col: 'email',       req: 'Yes', desc: 'Email address — used as the match key on import', ex: 'jsmith@springfield.edu' },
    { col: 'name',        req: 'Yes', desc: 'Full name',                                       ex: 'Jane Smith' },
    { col: 'role',        req: 'Yes', desc: '"student" or "teacher"',                          ex: 'student' },
    { col: 'class_name',  req: 'No',  desc: 'Class to enroll this person in. Repeat row for multiple classes.', ex: 'Period 3 Wellness' },
    { col: 'external_id', req: 'No',  desc: "Your system's stable ID for this person",         ex: 'STU-10042' },
    { col: 'district_id', req: 'No',  desc: 'Groups classes under a district',                 ex: 'springfield-usd' },
  ]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function rowToRecord(r: ExportRow, includeInactive: boolean): Record<string, string> {
  const rec: Record<string, string> = {
    name:        r.name,
    email:       r.email,
    role:        r.role === 'owner' ? 'teacher' : 'student',
    class_name:  r.classNames.join(', '),
    sync_source: r.syncSource ?? '',
    external_id: r.externalId ?? '',
    joined_at:   r.joinedAt.toISOString().slice(0, 10),
  };
  if (includeInactive) rec.active = String(r.active);
  return rec;
}
```

Add `getRosterForExport` to `lib/db/sync-queries.ts`:

```typescript
export interface ExportRow {
  name:       string;
  email:      string;
  role:       string;
  classNames: string[];
  syncSource: string | null;
  externalId: string | null;
  joinedAt:   Date;
  active:     boolean;
}

export async function getRosterForExport(includeInactive: boolean): Promise<ExportRow[]> {
  // One row per user; aggregate class names
  const rows = await db.execute(sql`
    SELECT
      u.name,
      u.email,
      u.role,
      u.sync_source,
      u.external_id,
      u.created_at AS joined_at,
      array_agg(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL) AS class_names,
      bool_and(tm.left_at IS NULL) AS active
    FROM users u
    LEFT JOIN team_members tm ON tm.user_id = u.id
    LEFT JOIN teams t ON t.id = tm.team_id
    ${includeInactive ? sql`` : sql`WHERE tm.left_at IS NULL OR tm.left_at IS NULL`}
    GROUP BY u.id, u.name, u.email, u.role, u.sync_source, u.external_id, u.created_at
    ORDER BY u.name
  `);

  return (rows.rows as any[]).map((r) => ({
    name:       r.name,
    email:      r.email,
    role:       r.role,
    classNames: r.class_names ?? [],
    syncSource: r.sync_source,
    externalId: r.external_id,
    joinedAt:   new Date(r.joined_at),
    active:     r.active ?? true,
  }));
}
```

### 6.8 Import UI component structure

`app/(dashboard)/dashboard/import/page.tsx` — server component, redirects students:

```typescript
import { redirect } from 'next/navigation';
import { getUser } from '@/lib/db/queries';
import { ImportFlow } from './import-flow';

export default async function ImportPage() {
  const user = await getUser();
  if (!user || user.role !== 'owner') redirect('/dashboard/checkins');
  return (
    <section className="flex-1 p-4 lg:p-8">
      <h1 className="text-2xl font-medium mb-2">Import / Export Roster</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Import students and teachers from a CSV or Excel file, or export your
        current roster. Files must follow the{' '}
        <a href="/api/import/template?format=csv" className="underline">CSV template</a>{' '}
        or{' '}
        <a href="/api/import/template?format=xlsx" className="underline">Excel template</a>.
      </p>
      <ImportFlow />
    </section>
  );
}
```

`import-flow.tsx` is a client component that manages this state machine:

```typescript
type State =
  | { step: 'upload' }
  | { step: 'preview'; diff: SyncDiff; warnings: RowWarning[]; validatedRows: ValidatedRow[]; districtId: string }
  | { step: 'applying' }
  | { step: 'done'; created: number; updated: number; errors: SyncError[] }
  | { step: 'error'; message: string; rowErrors: RowError[] };
```

Transitions:
- `upload` → `preview`: POST `/api/import`, receive `{ valid, preview, validatedRows, warnings }`
- `preview` → `applying` → `done`: POST `/api/import/apply` with `{ validatedRows, districtId }`
- Any error → `error`

### 6.9 M5 verification

```bash
# 1. Download the CSV template
curl -o template.csv http://localhost:3000/api/import/template?format=csv
# Inspect: confirm headers, example rows, BOM present

# 2. Upload a file with a validation error (missing role)
# Create test-bad.csv with one row missing the role column
curl -X POST http://localhost:3000/api/import \
  -H "Cookie: <your-session-cookie>" \
  -F "roster=@test-bad.csv"
# → { valid: false, errors: [{ row: 2, column: 'role', ... }] }

# 3. Upload a valid file
curl -X POST http://localhost:3000/api/import \
  -H "Cookie: <your-session-cookie>" \
  -F "roster=@valid-roster.csv"
# → { valid: true, preview: { usersToCreate: N, ... }, validatedRows: [...] }

# 4. Apply the import (use the validatedRows from step 3)
curl -X POST http://localhost:3000/api/import/apply \
  -H "Cookie: <your-session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"validatedRows":[...],"districtId":"test-district"}'
# → { success: true, created: N, updated: 0 }

# 5. Re-apply the same payload — verify idempotency
# → { success: true, created: 0, updated: N }  (or updated: 0 if names/emails unchanged)

# 6. Export
curl -o roster.csv "http://localhost:3000/api/export?format=csv" \
  -H "Cookie: <your-session-cookie>"
# Confirm BOM, correct columns, no wellness data

curl -o roster.xlsx "http://localhost:3000/api/export?format=xlsx" \
  -H "Cookie: <your-session-cookie>"
# Open in Excel — confirm two sheets: Roster + Field Guide
```

---

## 7. Environment Variables Reference

Add all of these to `.env.local` for development and to Vercel's Environment Variables dashboard for staging and production.

| Variable | Required by | Description |
|---|---|---|
| `DATABASE_URL` | All milestones | Neon PostgreSQL pooler connection string |
| `AUTH_SECRET` | All milestones | JWT signing secret — also used for set-password magic links. 32+ random hex chars. |
| `BASE_URL` | M3+ | Full app URL, e.g. `https://123-wellness.vercel.app`. Used in magic-link emails. |
| `SYNC_SECRET` | M1+ | Shared secret for `/api/sync` and `/api/sync/all`. 32+ random hex chars. Rotate quarterly. |
| `CLEVER_CLIENT_ID` | M2+ | From the Clever developer dashboard. |
| `CLEVER_CLIENT_SECRET` | M2+ | From the Clever developer dashboard. |
| `RESEND_API_KEY` | M3+ | From `resend.com`. Used to send set-password emails. |
| `ALERT_WEBHOOK_URL` | M4+ | Slack incoming webhook URL. Optional — alerting degrades gracefully if unset. |
| `ENROLLED_DISTRICTS` | M4+ | JSON array: `[{"districtId":"d1","source":"clever"}]`. Replaced by DB table after Story 5.1. |

**Generate secrets:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 8. Error Codes

These appear in `sync_runs.errors[].code` and in API response `errors[].code`.

| Code | Source | Meaning | Action |
|---|---|---|---|
| `ZERO_RECORDS` | `engine.ts` | Provider returned 0 records for a resource that previously had data. Sync skipped. | Check provider API / Clever dashboard. Do not manually fix DB. |
| `SYNC_ERROR` | `engine.ts` | Unhandled exception during sync. Run marked `failed`. | Check Vercel logs for stack trace. Re-trigger manually after fix. |
| `CLEVER_AUTH_ERROR` | `client.ts` | Could not obtain Clever access token. | Verify `CLEVER_CLIENT_ID` and `CLEVER_CLIENT_SECRET` in env. |
| `CLEVER_RATE_LIMIT` | `client.ts` | 429 after backoff retry. | Check Clever dashboard usage. Stagger district sync times. |
| `CLEVER_API_ERROR` | `client.ts` | Clever returned non-200 for a data endpoint. | Check Clever status page. Retry next cycle. |
| `VALIDATION_ERROR` | `validator.ts` | One or more CSV/Excel rows failed validation. | Download the error list from the import UI and fix the file. |
| `FILE_TOO_LARGE` | `/api/import` | File exceeds 5 MB or 10,000 rows. | Split the file and import in batches. |
| `UNSUPPORTED_FORMAT` | `/api/import` | File is not `.csv` or `.xlsx`. | Convert file to one of the supported formats. |
| `TOKEN_EXPIRED` | `/set-password` | Magic link has expired (> 24 hours). | User should attempt login again to trigger a new email. |

---

## 9. Testing Patterns

### Unit tests — no DB, no network

**`lib/sync/csv/validator.test.ts`** — covers the most validation edge cases:

```typescript
describe('validateRows', () => {
  it('requires email', () => {
    const { valid, errors } = validateRows([{ name: 'A', role: 'student', _row: 2 }]);
    expect(valid).toBe(false);
    expect(errors[0]).toMatchObject({ row: 2, column: 'email' });
  });

  it('rejects invalid email', () => {
    const { errors } = validateRows([{ email: 'not-email', name: 'A', role: 'student', _row: 2 }]);
    expect(errors[0].column).toBe('email');
  });

  it('rejects unknown role', () => {
    const { errors } = validateRows([{ email: 'a@b.com', name: 'A', role: 'admin', _row: 2 }]);
    expect(errors[0].column).toBe('role');
  });

  it('warns on duplicate email, last row wins', () => {
    const { valid, warnings, rows } = validateRows([
      { email: 'a@b.com', name: 'First',  role: 'student', _row: 2 },
      { email: 'a@b.com', name: 'Second', role: 'student', _row: 3 },
    ]);
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(rows.find((r) => r.email === 'a@b.com')?.name).toBe('Second');
  });

  it('skips comment rows', () => {
    const { rows } = validateRows([{ email: '# example row', name: 'X', role: 'student', _row: 2 }]);
    expect(rows).toHaveLength(0);
  });

  it('rejects files over 10,000 rows', () => {
    const big = Array.from({ length: 10_001 }, (_, i) => ({
      email: `s${i}@school.edu`, name: 'S', role: 'student', _row: i + 2,
    }));
    const { valid } = validateRows(big);
    expect(valid).toBe(false);
  });
});
```

**`lib/sync/clever/transform.test.ts`:**

```typescript
it('skips students with null email and does not throw', () => {
  const { users } = transformRoster('d1',
    [{ id: 's1', data: { name: { full: 'No Email' }, email: null } }],
    [], [], []
  );
  expect(users).toHaveLength(0);
});

it('lowercases all emails', () => {
  const { users } = transformRoster('d1',
    [{ id: 's1', data: { name: { full: 'Alice' }, email: 'ALICE@SCHOOL.EDU' } }],
    [], [], []
  );
  expect(users[0].email).toBe('alice@school.edu');
});
```

### Integration tests — real DB, mocked network

Use a separate Neon branch or a local Postgres container. Run migrations in `beforeAll`. Truncate `users`, `teams`, `team_members`, `sync_runs` in `beforeEach`.

Mock Clever HTTP with `msw` (recommended for Next.js projects):

```typescript
// tests/mocks/clever.ts
import { http, HttpResponse } from 'msw';

export const cleverHandlers = [
  http.post('https://clever.com/oauth/tokens', () =>
    HttpResponse.json({ access_token: 'test-token', expires_in: 3600 })
  ),
  http.get('https://api.clever.com/v3.0/districts/test-district/students', () =>
    HttpResponse.json({
      data: [{ id: 'stu-1', data: { name: { full: 'Alice Smith' }, email: 'alice@school.edu' } }],
      paging: {},
    })
  ),
  // Add handlers for teachers, sections, enrollments
];
```

Key integration test cases:
1. Full sync on an empty DB → creates users and teams
2. Re-run of same sync → zero records changed (idempotency)
3. Provider omits a previously-enrolled student → membership gets `left_at` set
4. Student re-enrolled → `left_at` cleared
5. Zero-record guard → status = 'skipped', no records deleted
6. Email collision → manual user gets `external_id` assigned without duplication

### End-to-end (Playwright) for M3 pilot sign-off

```typescript
test('synced student can set password and log in', async ({ page }) => {
  // 1. Trigger sync via API
  await fetch('/api/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SYNC_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ districtId: 'pilot-district', source: 'clever' }),
  });

  // 2. Attempt login with synced student email
  await page.goto('/sign-in');
  await page.fill('[name=email]',    'alice@school.edu');
  await page.fill('[name=password]', 'wrong-password');
  await page.click('[type=submit]');
  await expect(page.locator('text=Check your email')).toBeVisible();

  // 3. Intercept the magic link (in test env, read the token from the DB or a test email sink)
  // Follow the link and set a password
  await page.goto(`/set-password?token=${testToken}`);
  await page.fill('[name=password]',        'NewPassword123!');
  await page.fill('[name=confirmPassword]', 'NewPassword123!');
  await page.click('[type=submit]');

  // 4. Confirm redirect to dashboard
  await expect(page).toHaveURL('/dashboard/checkins');
});
```
