import { getUser, getCheckInsForUser } from '@/lib/db/queries';
import { CheckInForm } from './check-in-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EMOTION_MAP } from '@/lib/wellness/emotions';

function sentimentBadge(sentiment: string) {
  const styles: Record<string, string> = {
    positive: 'bg-green-100 text-green-700',
    neutral: 'bg-gray-100 text-gray-600',
    negative: 'bg-red-100 text-red-700'
  };
  return styles[sentiment] || styles.neutral;
}

export default async function CheckInsPage() {
  const user = await getUser();
  const isEducator = user?.role === 'owner';
  const feed = await getCheckInsForUser();

  return (
    <section className="flex-1 p-4 lg:p-8">
      <h1 className="text-lg lg:text-2xl font-medium mb-6">Check-ins</h1>

      {!isEducator && <CheckInForm />}

      <Card>
        <CardHeader>
          <CardTitle>
            {isEducator
              ? 'Your class’s recent check-ins'
              : 'Your recent check-ins'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {feed.length === 0 ? (
            <p className="text-muted-foreground">No check-ins yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {feed.map((c) => {
                const emoji = EMOTION_MAP[c.emotion]?.emoji ?? '•';
                return (
                  <li key={c.id} className="flex items-start gap-3 py-3">
                    <span className="text-2xl">{emoji}</span>
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{c.emotion}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${sentimentBadge(
                            c.sentiment
                          )}`}
                        >
                          {c.sentiment}
                        </span>
                        {isEducator && (
                          <span className="text-sm text-muted-foreground">
                            · {c.userName || c.userEmail}
                          </span>
                        )}
                      </div>
                      {c.note && (
                        <p className="text-sm text-gray-600 mt-1">{c.note}</p>
                      )}
                    </div>
                    <time className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
