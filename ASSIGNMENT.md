# 1-2-3 Wellness — Take-Home Exercise

Welcome, and thanks for taking the time. This is a small, self-contained
**school-wellness** app: students log a daily **check-in** (how they're feeling),
and teachers/admins see their class's check-ins on a dashboard. It's a
deliberately stripped-down version of a real product.

We use this for a **technical TPM** role, so we care about *both* parts below:
the code you write **and** how you plan a larger change. Budget **~4 hours** —
please don't spend more than 5. If you run low on time, do less but do it well,
and write down what you'd do next.

---

## The app in 60 seconds

- **Stack:** Next.js (App Router) · TypeScript · Postgres via Drizzle ORM ·
  Tailwind. Auth is email/password with a JWT session cookie.
- **Roles** (this matters):
  - `owner` = **teacher/admin** — sees the whole class's check-ins.
  - `member` = **student** — sees only their own check-ins.
  > The starter this is built on calls a class a "team" and uses `owner`/`member`.
  > We kept those names in the database to avoid a noisy rename. Read
  > **team = class, owner = teacher/admin, member = student** throughout.
- **Where things live:**
  - Data model: `lib/db/schema.ts` (see the `checkIns` table)
  - Queries: `lib/db/queries.ts` (`getCheckInsForUser` is a good example)
  - The feature you'll extend: `app/(dashboard)/dashboard/checkins/`
  - Emotions + sentiment: `lib/wellness/emotions.ts`
  - Server actions pattern: `app/(dashboard)/dashboard/checkins/actions.ts`
    and `lib/auth/middleware.ts`

---

## Setup (~10 min)

**Prereqs (all free):** Node **20+**, a Postgres database
([Neon](https://neon.tech) is easiest — free, no card), a **GitHub** account,
and a **[Vercel](https://vercel.com)** account (you'll deploy at the end).
Create a Neon project and copy its connection string; any Postgres works.

```bash
npm install

# Create your .env (see .env.example). At minimum you need:
#   POSTGRES_URL=postgresql://...        # your Neon connection string
#   BASE_URL=http://localhost:3000
#   AUTH_SECRET=...                      # run: openssl rand -base64 32

npm run db:migrate   # create the tables
npm run db:seed      # create a class, a teacher, 3 students, sample check-ins
npm run dev          # http://localhost:3000
```

**Seeded logins** (password is `password123` for all):
- Teacher/admin: `teacher@test.com`
- Students: `student1@test.com`, `student2@test.com`, `student3@test.com`

Sign in as a student to log a check-in; sign in as the teacher to see the whole
class. That round-trip is the core of the app.

---

## Part 1 — Build (pick **2–3** of these)

Choose based on what best shows your range. Each is intentionally small. Prefer
**working, readable, well-scoped** code over volume. Follow the patterns already
in the repo (server actions, Drizzle queries, the role check in
`getCheckInsForUser`).

1. **Check-in streak.** Show each student their current streak — the number of
   consecutive days they've checked in — as a small badge on the Check-ins page.
   Decide what "consecutive" means and note it.

2. **Support flags for teachers.** On the teacher's Check-ins view, highlight
   students who have logged **2 or more `negative` check-ins in the last 7 days**
   so they stand out for follow-up. (Sentiment already lives on each check-in.)

3. **Admin-only Insights page.** Add a `/dashboard/insights` route that **only a
   teacher/admin (`owner`) can open** — a student who navigates there should be
   redirected. Show a simple class breakdown (count of check-ins by sentiment,
   e.g. this week). Real authorization matters here, not just hiding a link.

4. **Delete your own check-in.** Let a student delete a check-in **they created**
   (and only their own — enforce it on the server, not just the UI).

5. **Filter the feed.** Add a filter to the check-in list (e.g. by sentiment or
   date range) using a URL query param so the view is shareable/bookmarkable.

For each task you do, a short note in your `SOLUTION.md` (what you built, key
decisions, anything you'd improve with more time) goes a long way.

---

## Part 2 — Plan (required, written)

This is the TPM core. Pick **one** of the prompts below and write a **1–2 page
plan** in `SOLUTION.md` (or a linked doc). We're looking for how you decompose
ambiguity — not a specific "right" answer.

**Primary prompt — District roster sync.**
> Today, users are created one-off by an admin. We now want to **onboard entire
> school districts automatically** by syncing rosters nightly from an external
> provider (like Clever/ClassLink): students, teachers, classes, and their
> memberships. Design it.

Address at least:
- **Data model & mapping** — how external IDs map to our users/classes; what
  happens on updates vs. deletes (a student leaves; a class is removed).
- **The sync job** — where it runs, how often, idempotency (safe to re-run),
  and how you avoid clobbering data you shouldn't.
- **Failure & partial data** — what happens when the provider is down, returns
  a partial roster, or a school has *no* classes yet. What must never break?
- **Rollout** — break it into **milestones** with clear, verifiable exit
  criteria, and call out the biggest risks and how you'd de-risk them.

*(Alternative prompts, if you'd rather: (b) scale from one school to 5,000
schools / 2M students — what breaks and what you'd change; (c) go from a single
deploy to dev/staging/prod with CI/CD and secrets management; (d) deliver
real-time "student may need support" alerts to teachers reliably.)*

---

## Deploying (required)

Ship it. Deploying is part of the exercise — we want a live URL to click
through, and "can you get it running in the cloud" is a real signal.

1. Push your work to your **own** GitHub repo (private is fine).
2. Import the repo into **[Vercel](https://vercel.com)** — it auto-detects
   Next.js, so there's no build config to set.
3. In the Vercel project's **Environment Variables**, add:
   - `POSTGRES_URL` — your Neon connection string (the same DB you used locally is fine)
   - `AUTH_SECRET` — any random string (`openssl rand -base64 32`)
   - `BASE_URL` — your deployed URL (e.g. `https://your-app.vercel.app`)
4. Deploy. Your tables and seed data already live in Neon from setup, so the
   live app works immediately. (Re-run `npm run db:migrate` against your Neon DB
   if you add new tables.)

> Keep secrets in Vercel's dashboard — never commit `.env`.

## Submitting

1. Work on a branch and commit as you go.
2. Include a **`SOLUTION.md`** with: which Part 1 tasks you did (+ notes and
   tradeoffs), your Part 2 plan, and any assumptions/questions you'd have asked us.
3. Send us **(a)** a link to your repo and **(b)** your **live Vercel URL**.
4. Make sure it runs from a clean clone using your instructions.

Questions or blockers? Reach out — knowing when to ask is part of the job.
