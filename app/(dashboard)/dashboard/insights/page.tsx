import { redirect } from 'next/navigation';
import { getUser, getWeeklySentimentBreakdown } from '@/lib/db/queries';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const SENTIMENT_STYLES: Record<
  string,
  { bar: string; label: string; text: string }
> = {
  positive: {
    bar: 'bg-green-400',
    label: 'Positive',
    text: 'text-green-700'
  },
  neutral: { bar: 'bg-gray-300', label: 'Neutral', text: 'text-gray-600' },
  negative: { bar: 'bg-red-400', label: 'Negative', text: 'text-red-700' }
};

export default async function InsightsPage() {
  const user = await getUser();

  // Hard server-side guard — a student who navigates here directly is
  // redirected before any data is fetched.
  if (!user || user.role !== 'owner') {
    redirect('/dashboard/checkins');
  }

  const breakdown = await getWeeklySentimentBreakdown();
  const total = breakdown.reduce((sum, row) => sum + row.count, 0);

  // Ensure all three sentiments appear even if count is 0
  const sentiments = ['positive', 'neutral', 'negative'];
  const rows = sentiments.map((s) => ({
    sentiment: s,
    count: breakdown.find((r) => r.sentiment === s)?.count ?? 0
  }));

  return (
    <section className="flex-1 p-4 lg:p-8">
      <h1 className="text-lg lg:text-2xl font-medium mb-2">Class Insights</h1>
      <p className="text-sm text-muted-foreground mb-8">
        Check-in breakdown for the last 7 days
      </p>

      <div className="grid gap-6 sm:grid-cols-3 mb-8">
        {rows.map(({ sentiment, count }) => {
          const style = SENTIMENT_STYLES[sentiment];
          return (
            <Card key={sentiment}>
              <CardHeader className="pb-2">
                <CardTitle className={`text-sm font-medium ${style.text}`}>
                  {style.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{count}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {total > 0
                    ? `${Math.round((count / total) * 100)}% of check-ins`
                    : 'no check-ins yet'}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sentiment breakdown</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {total === 0 ? (
            <p className="text-muted-foreground text-sm">
              No check-ins logged in the last 7 days.
            </p>
          ) : (
            rows.map(({ sentiment, count }) => {
              const style = SENTIMENT_STYLES[sentiment];
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={sentiment}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className={style.text}>{style.label}</span>
                    <span className="text-muted-foreground">
                      {count} ({pct}%)
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-gray-100">
                    <div
                      className={`h-2 rounded-full ${style.bar}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </section>
  );
}
