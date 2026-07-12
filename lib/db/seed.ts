import { db } from './drizzle';
import { users, teams, teamMembers, checkIns } from './schema';
import { hashPassword } from '@/lib/auth/session';
import { EMOTION_MAP } from '@/lib/wellness/emotions';

// Seeds one class with a teacher and three students, plus a few days of
// sample check-ins so the dashboards have something to show immediately.
//
// Role model (kept simple, inherited from the starter):
//   'owner'  -> teacher/admin: sees the whole class's check-ins
//   'member' -> student: sees only their own check-ins
async function seed() {
  const password = 'password123';
  const passwordHash = await hashPassword(password);

  const [teacher] = await db
    .insert(users)
    .values({
      name: 'Ms. Rivera',
      email: 'teacher@test.com',
      passwordHash,
      role: 'owner'
    })
    .returning();

  const studentSeed = [
    { name: 'Ava Chen', email: 'student1@test.com' },
    { name: 'Ben Torres', email: 'student2@test.com' },
    { name: 'Priya Shah', email: 'student3@test.com' }
  ];

  const students = [];
  for (const s of studentSeed) {
    const [u] = await db
      .insert(users)
      .values({
        name: s.name,
        email: s.email,
        passwordHash,
        role: 'member'
      })
      .returning();
    students.push(u);
  }

  const [team] = await db
    .insert(teams)
    .values({ name: 'Room 12 — 4th Grade' })
    .returning();

  await db.insert(teamMembers).values([
    { teamId: team.id, userId: teacher.id, role: 'owner' },
    ...students.map((u) => ({
      teamId: team.id,
      userId: u.id,
      role: 'member'
    }))
  ]);

  // Spread a variety of emotions (incl. a couple negative ones so the
  // "students who may need support" signal has data) over the last few days.
  const emotionOrder = [
    'Happy',
    'Calm',
    'Okay',
    'Tired',
    'Anxious',
    'Sad',
    'Excited',
    'Bored',
    'Angry'
  ];

  const rows = [];
  let i = 0;
  for (const student of students) {
    for (let d = 0; d < 4; d++) {
      const emotion = EMOTION_MAP[emotionOrder[(i + d) % emotionOrder.length]];
      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - d);
      rows.push({
        userId: student.id,
        teamId: team.id,
        emotion: emotion.label,
        sentiment: emotion.sentiment,
        note: d === 0 ? 'Logged from seed data.' : null,
        createdAt
      });
    }
    i++;
  }
  await db.insert(checkIns).values(rows);

  console.log('Seed complete.');
  console.log('  Teacher: teacher@test.com  / password123');
  console.log('  Student: student1@test.com / password123');
}

seed()
  .catch((error) => {
    console.error('Seed process failed:', error);
    process.exit(1);
  })
  .finally(() => {
    console.log('Seed process finished. Exiting...');
    process.exit(0);
  });
