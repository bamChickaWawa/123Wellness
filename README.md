# 1-2-3 Wellness — TPM Take-Home

A minimal school-wellness app used as a technical take-home for a TPM role.
Students log a daily **check-in** (how they're feeling); teachers/admins see
their class's check-ins on a role-gated dashboard.

> **Candidates:** the full exercise (setup, what to build, what to plan, and how
> to submit) is in **[`ASSIGNMENT.md`](./ASSIGNMENT.md)**. Start there.

## Tech stack

- **Next.js** (App Router) + **TypeScript**
- **Postgres** via **Drizzle ORM**
- **Tailwind** + shadcn/ui components
- Email/password auth with a JWT session cookie; route protection via middleware

## Quick start

Requires **Node 20+** and a Postgres database ([Neon](https://neon.tech) free
tier is easiest).

```bash
npm install
cp .env.example .env      # then fill in POSTGRES_URL, BASE_URL, AUTH_SECRET
npm run db:migrate        # create tables
npm run db:seed           # seed a class: 1 teacher, 3 students, sample check-ins
npm run dev               # http://localhost:3000
```

Seeded logins (password `password123`): `teacher@test.com`,
`student1@test.com`, `student2@test.com`, `student3@test.com`.

## Where things live

| Area | Path |
|------|------|
| Data model | `lib/db/schema.ts` (`checkIns` table) |
| Queries (incl. role-aware feed) | `lib/db/queries.ts` (`getCheckInsForUser`) |
| Check-in feature | `app/(dashboard)/dashboard/checkins/` |
| Emotions + sentiment | `lib/wellness/emotions.ts` |
| Server-action + validation pattern | `app/(dashboard)/dashboard/checkins/actions.ts`, `lib/auth/middleware.ts` |

## Role model

`owner` = teacher/admin (sees the whole class); `member` = student (sees only
their own check-ins). This app is built on a SaaS starter that calls a class a
"team" — read **team = class** throughout.

> Billing/Stripe from the underlying starter is **out of scope** and left
> unwired; nothing in the assignment uses it.
