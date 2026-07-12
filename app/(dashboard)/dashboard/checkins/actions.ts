'use server';

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db/drizzle';
import {
  checkIns,
  teamMembers,
  activityLogs,
  ActivityType
} from '@/lib/db/schema';
import { validatedActionWithUser } from '@/lib/auth/middleware';
import { EMOTION_MAP } from '@/lib/wellness/emotions';

const logCheckInSchema = z.object({
  emotion: z.string().min(1, 'Please choose how you feel.'),
  note: z.string().max(300).optional()
});

export const logCheckIn = validatedActionWithUser(
  logCheckInSchema,
  async (data, _formData, user) => {
    const emotion = EMOTION_MAP[data.emotion];
    if (!emotion) {
      return { error: 'That emotion is not recognized.' };
    }

    const membership = await db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, user.id))
      .limit(1);

    if (membership.length === 0) {
      return { error: 'You are not enrolled in a class yet.' };
    }

    const teamId = membership[0].teamId;

    await db.insert(checkIns).values({
      userId: user.id,
      teamId,
      emotion: emotion.label,
      sentiment: emotion.sentiment,
      note: data.note?.trim() || null
    });

    await db.insert(activityLogs).values({
      teamId,
      userId: user.id,
      action: ActivityType.LOG_CHECK_IN,
      ipAddress: ''
    });

    revalidatePath('/dashboard/checkins');
    return {
      success: `Check-in logged — you're feeling ${emotion.label.toLowerCase()}.`
    };
  }
);

const deleteCheckInSchema = z.object({
  checkInId: z.coerce.number().int().positive()
});

// Students can only delete their own check-ins — ownership is verified
// server-side before the DELETE runs.
export const deleteCheckIn = validatedActionWithUser(
  deleteCheckInSchema,
  async (data, _formData, user) => {
    const [existing] = await db
      .select({ userId: checkIns.userId })
      .from(checkIns)
      .where(eq(checkIns.id, data.checkInId))
      .limit(1);

    if (!existing || existing.userId !== user.id) {
      return { error: 'Check-in not found or not yours to delete.' };
    }

    await db.delete(checkIns).where(eq(checkIns.id, data.checkInId));

    revalidatePath('/dashboard/checkins');
    return { success: 'Check-in deleted.' };
  }
);
