import { desc, and, eq, isNull, gte, sql } from 'drizzle-orm';
import { db } from './drizzle';
import { activityLogs, checkIns, teamMembers, teams, users } from './schema';
import { cookies } from 'next/headers';
import { verifyToken } from '@/lib/auth/session';

export async function getUser() {
  const sessionCookie = (await cookies()).get('session');
  if (!sessionCookie || !sessionCookie.value) {
    return null;
  }

  const sessionData = await verifyToken(sessionCookie.value);
  if (
    !sessionData ||
    !sessionData.user ||
    typeof sessionData.user.id !== 'number'
  ) {
    return null;
  }

  if (new Date(sessionData.expires) < new Date()) {
    return null;
  }

  const user = await db
    .select()
    .from(users)
    .where(and(eq(users.id, sessionData.user.id), isNull(users.deletedAt)))
    .limit(1);

  if (user.length === 0) {
    return null;
  }

  return user[0];
}

export async function getTeamByStripeCustomerId(customerId: string) {
  const result = await db
    .select()
    .from(teams)
    .where(eq(teams.stripeCustomerId, customerId))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

export async function updateTeamSubscription(
  teamId: number,
  subscriptionData: {
    stripeSubscriptionId: string | null;
    stripeProductId: string | null;
    planName: string | null;
    subscriptionStatus: string;
  }
) {
  await db
    .update(teams)
    .set({
      ...subscriptionData,
      updatedAt: new Date()
    })
    .where(eq(teams.id, teamId));
}

export async function getUserWithTeam(userId: number) {
  const result = await db
    .select({
      user: users,
      teamId: teamMembers.teamId
    })
    .from(users)
    .leftJoin(teamMembers, eq(users.id, teamMembers.userId))
    .where(eq(users.id, userId))
    .limit(1);

  return result[0];
}

export async function getActivityLogs() {
  const user = await getUser();
  if (!user) {
    throw new Error('User not authenticated');
  }

  return await db
    .select({
      id: activityLogs.id,
      action: activityLogs.action,
      timestamp: activityLogs.timestamp,
      ipAddress: activityLogs.ipAddress,
      userName: users.name
    })
    .from(activityLogs)
    .leftJoin(users, eq(activityLogs.userId, users.id))
    .where(eq(activityLogs.userId, user.id))
    .orderBy(desc(activityLogs.timestamp))
    .limit(10);
}

export async function getTeamForUser() {
  const user = await getUser();
  if (!user) {
    return null;
  }

  const result = await db.query.teamMembers.findFirst({
    where: eq(teamMembers.userId, user.id),
    with: {
      team: {
        with: {
          teamMembers: {
            with: {
              user: {
                columns: {
                  id: true,
                  name: true,
                  email: true
                }
              }
            }
          }
        }
      }
    }
  });

  return result?.team || null;
}

// Returns sentiment counts for the last 7 days for the teacher's class.
// Used by the Insights page.
export async function getWeeklySentimentBreakdown(): Promise<
  { sentiment: string; count: number }[]
> {
  const user = await getUser();
  if (!user || user.role !== 'owner') return [];

  const membership = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, user.id))
    .limit(1);

  if (membership.length === 0) return [];
  const teamId = membership[0].teamId;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return await db
    .select({
      sentiment: checkIns.sentiment,
      count: sql<number>`COUNT(*)::int`
    })
    .from(checkIns)
    .where(
      and(eq(checkIns.teamId, teamId), gte(checkIns.createdAt, sevenDaysAgo))
    )
    .groupBy(checkIns.sentiment);
}

// Role-aware check-in feed. Teachers/admins (role 'owner') see every check-in
// for their class; students (role 'member') see only their own.
export async function getCheckInsForUser() {
  const user = await getUser();
  if (!user) {
    return [];
  }

  const membership = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, user.id))
    .limit(1);

  if (membership.length === 0) {
    return [];
  }

  const teamId = membership[0].teamId;
  const canSeeWholeClass = user.role === 'owner';
  const whereClause = canSeeWholeClass
    ? eq(checkIns.teamId, teamId)
    : and(eq(checkIns.teamId, teamId), eq(checkIns.userId, user.id));

  return await db
    .select({
      id: checkIns.id,
      emotion: checkIns.emotion,
      sentiment: checkIns.sentiment,
      note: checkIns.note,
      createdAt: checkIns.createdAt,
      userId: checkIns.userId,
      userName: users.name,
      userEmail: users.email
    })
    .from(checkIns)
    .leftJoin(users, eq(checkIns.userId, users.id))
    .where(whereClause)
    .orderBy(desc(checkIns.createdAt))
    .limit(100);
}
