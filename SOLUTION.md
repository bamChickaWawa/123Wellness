# Solution Notes

## Part 1 — Features Built

### 1. Check-in Streak _(~45 min)_

**What:** A flame badge on the student Check-ins page showing how many consecutive calendar days they have checked in.

**How it works:**  
`getStreakForUser()` in `lib/db/queries.ts` fetches distinct UTC calendar dates for the student's check-ins, then walks backward from today counting consecutive days. One grace rule: if the student hasn't checked in yet *today*, the streak count starts from yesterday instead of zeroing out the moment they open the app in the morning.

**Key decisions:**
- "Consecutive" = calendar day (UTC), not 24-hour rolling window. Multiple check-ins on the same day count as one day.
- The grace window prevents the badge from showing "0" at 8 AM before a student has had a chance to check in, which would feel punishing.
- Streak is student-only (teachers don't have personal check-ins to track).

**What I'd improve:** Let the app show local timezone dates instead of UTC — right now a student checking in at 11 PM PST is on a different UTC date than one checking in at 1 AM PST. Storing a `date` column at insert time (in the user's timezone) would be cleaner.

---

### 2. Support Flags for Teachers _(~30 min)_

**What:** On the teacher's Check-ins view, a banner alerts when any student has logged ≥2 negative check-ins in the last 7 days, and each flagged student's entries are highlighted amber throughout the feed.

**How it works:**  
`getSupportFlaggedUserIds()` runs a single `GROUP BY userId HAVING count(*) >= 2` query filtered to `sentiment = 'negative'` in a 7-day window. The result is a `Set<number>` of user IDs that the server component uses to conditionally style list items — no client-side JS needed.

**Key decisions:**
- 7-day rolling window (not calendar week) to avoid "Monday morning amnesia" where Friday's distress disappears after the weekend.
- Highlighting *every* entry from a flagged student (not just the negative ones) makes it easy to see the pattern at a glance rather than scanning for individual red badges.
- Auth is enforced in the query itself (`role !== 'owner'` returns early) and the page never renders flagged data for students.

**What I'd improve:** Add a "mark as reviewed" action so teachers can acknowledge they've followed up, clearing the flag. Also consider push notifications or email digests for teachers who don't visit the dashboard daily.

---

### 3. Admin-only Insights Page _(~45 min)_

**What:** A `/dashboard/insights` route showing the class's sentiment breakdown (count + percentage bar chart) for the last 7 days. Students who navigate there directly are redirected to `/dashboard/checkins`.

**How it works:**  
The page is a Next.js App Router server component. The first thing it does is `await getUser()` and check `role !== 'owner'` — if so, it calls `redirect('/dashboard/checkins')` before any data is fetched. This is real server-side enforcement; there is no data visible in the HTML response for a student.

`getWeeklySentimentBreakdown()` returns a `GROUP BY sentiment COUNT(*)` aggregation for the team. The UI shows three stat cards (positive / neutral / negative) and a proportional bar chart.

**Key decisions:**
- Authorization in the page server component, not just in middleware. The middleware only checks "is there a session?" — role checks belong closer to the data.
- All three sentiments are always rendered (with count 0 if none) so the layout is stable even for new classes with few check-ins.
- The Insights link is visible in the sidebar for everyone — clicking it as a student just redirects you. Hiding it would require making the layout a server component (losing the `usePathname` active-state highlight), which felt like more complexity than the nav UX is worth.

**What I'd improve:** Add a date-range picker (this week / last 30 days / all time). Show per-student breakdown so teachers can see individual trends, not just class averages.

---

### 4. Crisis keyword detection _(~40 min)_

**What:** When a student's check-in note contains high-risk language (e.g. "suicide", "want to die", "kill myself"), the teacher's page shows a bold red **URGENT — Immediate Attention Required** banner at the very top of the page, above all other content, listing the student(s) by name. The specific check-in entry is also outlined in red in the feed with a "crisis flag" badge. Crisis-flagged entries cannot be deleted by the student — the record is preserved so the teacher can act on it.

**How it works:**  
`lib/wellness/crisis.ts` exports `hasCrisisKeywords(text)`, which lowercases the note and checks it against a list of ~20 high-risk phrases. The function is called in two places: (1) in the server component when rendering the teacher feed, to identify flagged entries; (2) in the `deleteCheckIn` server action, to block deletion of flagged records.

Detection is intentionally broad — false positives (a student writing "I don't want to kill myself... just tired") are far less harmful than a missed genuine crisis. Teachers are trained to assess context.

**Key decisions:**
- Flags are computed from the note text at render time, not stored in the database. This means no migration is needed and the keyword list can be updated without a schema change. The tradeoff: if a student edits their note (not implemented), the flag could disappear. For production, I'd add a `crisisFlag boolean` column set at insert time so the record is immutable.
- The crisis banner appears **above the streak badge, support flag, and everything else** — it's the first thing a teacher sees when they open the page.
- Students cannot delete crisis-flagged entries. The block is enforced in the server action (not just hidden in the UI), so it cannot be bypassed via raw requests.
- The keyword check is not exposed to students — the note content is shown as normal in the student's own feed; only the teacher sees the flag.

**What I'd improve:** Add push notifications / email to teachers the moment a crisis check-in is submitted (not just when they open the dashboard). Also consider a separate "crisis log" page that shows only flagged entries with timestamps, so teachers can review the history without scrolling through the full feed.

---

### 5. Delete your own check-in _(~30 min)_

**What:** A trash icon on each check-in row in the student view. Clicking it deletes the entry immediately (with a spinner while the server action runs).

**How it works:**  
`deleteCheckIn` in `actions.ts` uses `validatedActionWithUser` — the same pattern as `logCheckIn`. Before running the `DELETE`, it fetches the check-in and compares `userId` to the logged-in user. If they don't match (or the row doesn't exist), it returns an error and nothing is deleted. The enforcement is entirely server-side.

`DeleteCheckInButton` is a thin client component that wraps a `<form action={deleteCheckIn}>` and uses `useFormStatus` to show a spinner during the pending state. No JS required for the actual submission — the form degrades gracefully.

**Key decisions:**
- Ownership check happens in the server action, not just by filtering the UI. A student who crafts a raw POST with someone else's `checkInId` gets an error, not a successful delete.
- No confirmation dialog — the list reloads immediately after deletion. For a production app I'd add an undo toast or a confirm step.
- Teachers do not see delete buttons (they don't own student check-ins).

**What I'd improve:** Optimistic UI so the row disappears instantly on click rather than waiting for the server round-trip. Also a brief undo window (like Gmail's delete) would be a nicer UX than a hard delete.

---

### 5. Filter the feed by sentiment and date range _(~35 min)_

**What:** A filter bar above the check-in list with a sentiment dropdown and from/to date pickers. Active filters are reflected in the URL as query params (`?sentiment=negative&from=2026-07-01&to=2026-07-12`) so the filtered view is shareable and bookmarkable.

**How it works:**  
`getCheckInsForUser` now accepts an optional `{ sentiment, from, to }` object. Each non-empty filter is appended to the Drizzle `and()` clause — `undefined` conditions are ignored, so no filter = full feed. The `to` date is made inclusive by incrementing it one day and using `lt` instead of `lte`.

The page reads `searchParams` (Next.js App Router server prop), passes the values to the query, and also passes them as props to `CheckInFilters` (a client component). The filter component uses `router.push` to update the URL on change — sentiment auto-submits on `onChange`, dates require clicking Apply. A "Clear" link appears whenever any filter is active.

**Key decisions:**
- URL params instead of local state — filters survive a page refresh and can be shared with a colleague ("look at this student's negative check-ins this week").
- Sentiment values are validated in the query (`VALID_SENTIMENTS.includes(...)`) so a hand-crafted URL with `?sentiment=foo` is silently ignored rather than crashing.
- Filters apply to both student and teacher views — teachers benefit from filtering the class feed too.

**What I'd improve:** Add a count badge ("Showing 3 of 12 check-ins") so it's clear the feed is filtered. Also debounce the date inputs instead of requiring the Apply button.

---

## Part 2 — District Roster Sync Design

> **Prompt:** Design a nightly sync that onboards entire school districts from an external roster provider (Clever / ClassLink).

### Context and goals

Today, users are created one-off by admins. At district scale (hundreds of schools, tens of thousands of students), that's not viable. We need to:

- Pull students, teachers, and class rosters nightly from a provider's API
- Map them to our `users`, `teams`, and `team_members` tables
- Handle changes (student transfers, class renames, teacher reassignments) without breaking active sessions
- Handle failures gracefully — a flaky provider sync must never prevent students from logging in

---

### Data model changes

**Add to `users`:**
```sql
ALTER TABLE users
  ADD COLUMN sync_source  VARCHAR(50),   -- 'clever' | 'classlink' | null (manual)
  ADD COLUMN external_id  VARCHAR(255);  -- provider's stable ID for this person

CREATE UNIQUE INDEX users_sync_source_external_id
  ON users (sync_source, external_id)
  WHERE sync_source IS NOT NULL;
```

**Add to `teams`:**
```sql
ALTER TABLE teams
  ADD COLUMN sync_source VARCHAR(50),
  ADD COLUMN external_id VARCHAR(255),
  ADD COLUMN district_id VARCHAR(255);  -- top-level grouping

CREATE UNIQUE INDEX teams_sync_source_external_id
  ON teams (sync_source, external_id)
  WHERE sync_source IS NOT NULL;
```

**New `sync_runs` audit table:**
```sql
CREATE TABLE sync_runs (
  id            SERIAL PRIMARY KEY,
  source        VARCHAR(50) NOT NULL,    -- 'clever'
  district_id   VARCHAR(255) NOT NULL,
  started_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMP,
  status        VARCHAR(20) NOT NULL,    -- 'running' | 'success' | 'failed' | 'skipped'
  records_seen  INTEGER,
  errors        JSONB
);
```

**Why a separate audit table?** We need an immutable record of every sync attempt for debugging and compliance. Storing errors as JSONB keeps the schema simple while allowing structured error detail.

---

### Mapping external IDs to our records

| Provider concept | Our concept | Match key |
|---|---|---|
| Clever `Student` | `users` (role=member) | `clever_id` → `external_id` |
| Clever `Teacher` | `users` (role=owner) | `clever_id` → `external_id` |
| Clever `Section` | `teams` | `section_id` → `external_id` |
| Clever `Enrollment` | `team_members` | derived from section + student |

**Collision handling (email already exists without an `external_id`):**  
On first sync, if we see an email that matches an existing manually-created user, we assign them the `external_id` rather than creating a duplicate. After that, the `external_id` is the canonical key — email changes flow from the provider.

---

### The sync job

**Where it runs:** A scheduled function in Vercel Cron (or a GitHub Actions scheduled workflow calling our `/api/sync` endpoint with a secret header). No long-running server needed.

**How often:** Nightly at 2 AM local district time. Provider rate limits are typically generous for nightly full-fetches.

**Algorithm (idempotent by design):**

```
for each district:
  1. Fetch full roster from provider (students, teachers, sections, enrollments)
  2. FAIL SAFE: if any resource returns 0 records, skip that resource and alert
  3. Upsert users: INSERT ... ON CONFLICT (sync_source, external_id) DO UPDATE name, email
  4. Upsert teams: INSERT ... ON CONFLICT (sync_source, external_id) DO UPDATE name
  5. Sync memberships:
       a. Compute expected set from provider enrollments
       b. INSERT new memberships
       c. Soft-delete removed memberships (set a `left_at` timestamp; don't DELETE rows)
  6. Never touch records where sync_source IS NULL (manually-created users/teams are immutable)
  7. Write sync_run row with status + counts
```

**Idempotency:** Every upsert is keyed on `(sync_source, external_id)`. Re-running the job produces the same state. This means we can safely retry on failure without worrying about duplicates.

---

### Failure and partial data handling

| Scenario | Behavior |
|---|---|
| Provider API is down | Log failed `sync_run`, alert on-call, skip — retry next scheduled window |
| Provider returns 0 students for a section | SKIP that section entirely, do not remove enrollments, alert |
| A student's record is missing from the payload | Treat as "not yet removed" — only remove after 2 consecutive missing syncs (grace window) |
| A school has no classes yet | Create the district record, leave teams empty, succeed silently |
| Sync job exceeds timeout | Mark run as `failed`, alert. Next run is still idempotent. |

**What must never break:** A student must always be able to log in and submit a check-in, even mid-sync or after a failed sync. Syncs only add/update records — they never delete users or active sessions.

---

### Milestones

**M1 — Schema & plumbing** _(Week 1)_  
Deliverables: migration adding `sync_source` / `external_id` to users and teams; `sync_runs` table; a stub `/api/sync` endpoint (auth-gated, returns 200).  
Exit criteria: migration runs on prod without downtime; existing users/teams unaffected; endpoint returns 200 with a valid secret.  
Owner: Backend engineer  
Risk: Index on nullable column — test with existing null data before shipping.

**M2 — Clever adapter + dry-run mode** _(Weeks 2–3)_  
Deliverables: Clever OAuth2 client; fetch + transform logic for students, teachers, sections, enrollments; sync job that logs what *would* change but makes no writes (dry-run flag).  
Exit criteria: dry-run against a real Clever sandbox shows correct upsert/delete diffs with zero DB mutations.  
Owner: Backend engineer  
Risk: Clever API pagination and rate limits — validate against their sandbox before testing on a real district.

**M3 — Live sync on one pilot district** _(Week 4)_  
Deliverables: Sync job writing to DB; manual trigger; email alert on failure; `sync_runs` visible in an internal admin page.  
Exit criteria: Three consecutive nightly syncs complete successfully; re-running same sync is a no-op; teacher and student can log in post-sync.  
Owner: Backend engineer + 1 QA pass  
Risk: Email collision with manually-created accounts — confirm merge logic with pilot district before go-live.

**M4 — Scheduled cron + rollout to all districts** _(Week 5)_  
Deliverables: Vercel Cron (or GitHub Actions) triggering nightly; partial-roster guard (`count == 0` → skip); district-by-district onboarding checklist; runbook for on-call.  
Exit criteria: 5+ districts syncing nightly; on-call can diagnose a failed run in < 15 min using `sync_runs` + logs alone; zero student login disruptions over 2-week observation window.  
Owner: Backend engineer + on-call rotation  
Risk: Sync window collides with school start time — run at 2 AM, add a hard 30-min timeout so failures don't drag into morning.

---

### Biggest risks and mitigations

| Risk | Mitigation |
|---|---|
| Wiping a class by mistake (provider sends empty payload) | Zero-records guard: if `students.length === 0`, skip and alert — never delete |
| Duplicate users (email collision) | Match by email on first sync, assign `external_id`; unique index prevents future dupes |
| Provider downtime during school year | Alert + skip; students keep access; sync catches up next night |
| PII in sync logs | Store only counts and error codes in `sync_runs.errors`, not names or emails |
| Scope creep (custom field mappings per district) | Defer to M5; start with canonical Clever fields only |

---

### Assumptions I'd validate with Angel/Drew before building

1. Is there one Clever OAuth app per district or one shared app for all districts?
2. Should removed students (left the school) lose login access immediately, or have a grace period?
3. Are there any classes that must stay "manual" and not be touched by sync?
4. What's the SLA expectation if sync fails — same-day fix, or next-cycle is acceptable?
