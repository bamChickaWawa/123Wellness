import {
  getUser,
  getCheckInsForUser,
  getStreakForUser,
  getSupportFlaggedUserIds
} from '@/lib/db/queries';
import { CheckInForm } from './check-in-form';
import { CheckInFilters } from './checkin-filters';
import { DeleteCheckInButton } from './delete-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EMOTION_MAP } from '@/lib/wellness/emotions';
import { hasCrisisKeywords } from '@/lib/wellness/crisis';
import { Flame, AlertTriangle, ShieldAlert } from 'lucide-react';

function sentimentBadge(sentiment: string) {
  const styles: Record<string, string> = {
    positive: 'bg-green-100 text-green-700',
    neutral: 'bg-gray-100 text-gray-600',
    negative: 'bg-red-100 text-red-700'
  };
  return styles[sentiment] || styles.neutral;
}

export default async function CheckInsPage({
  searchParams
}: {
  searchParams: Promise<{ sentiment?: string; from?: string; to?: string }>;
}) {
  const filters = await searchParams;
  const user = await getUser();
  const isEducator = user?.role === 'owner';

  const [feed, streak, flaggedIds] = await Promise.all([
    getCheckInsForUser(filters),
    isEducator ? Promise.resolve(0) : getStreakForUser(),
    isEducator ? getSupportFlaggedUserIds() : Promise.resolve(new Set<number>())
  ]);

  // Crisis entries: check-ins whose note contains high-risk language.
  // Computed here (not stored) — see SOLUTION.md for the tradeoff note.
  const crisisEntries = isEducator
    ? feed.filter((c) => hasCrisisKeywords(c.note))
    : [];
  const crisisUserNames = [
    ...new Set(crisisEntries.map((c) => c.userName || c.userEmail || 'Unknown'))
  ];
  const crisisCheckInIds = new Set(crisisEntries.map((c) => c.id));

  return (
    <section className="flex-1 p-4 lg:p-8">
      {/* ── Crisis alert — shown above everything else ── */}
      {isEducator && crisisEntries.length > 0 && (
        <div className="mb-6 rounded-lg border-2 border-red-500 bg-red-50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert className="h-5 w-5 shrink-0 text-red-600" />
            <span className="font-bold text-red-700 uppercase tracking-wide text-sm">
              Urgent — Immediate Attention Required
            </span>
          </div>
          <p className="text-sm text-red-700 mb-2">
            The following student
            {crisisUserNames.length > 1 ? 's have' : ' has'} used language in
            their check-in that may indicate a crisis:
          </p>
          <ul className="text-sm font-semibold text-red-700 space-y-0.5 mb-3">
            {crisisUserNames.map((name) => (
              <li key={name}>• {name}</li>
            ))}
          </ul>
          <p className="text-xs text-red-600 font-medium">
            Follow your school's crisis response protocol immediately. The
            flagged entries are highlighted in red below.
          </p>
        </div>
      )}

      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-lg lg:text-2xl font-medium">Check-ins</h1>
        {!isEducator && streak > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-3 py-1 text-sm font-medium text-orange-700">
            <Flame className="h-4 w-4" />
            {streak} day streak
          </span>
        )}
      </div>

      {!isEducator && <CheckInForm />}

      {isEducator && flaggedIds.size > 0 && (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <span>
            <strong>{flaggedIds.size}</strong> student
            {flaggedIds.size > 1 ? 's have' : ' has'} logged 2 or more negative
            check-ins in the last 7 days. Their entries are highlighted below.
          </span>
        </div>
      )}

      <CheckInFilters
        sentiment={filters.sentiment}
        from={filters.from}
        to={filters.to}
      />

      <Card>
        <CardHeader>
          <CardTitle>
            {isEducator
              ? "Your class's recent check-ins"
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
                const isCrisis = isEducator && crisisCheckInIds.has(c.id);
                const needsSupport =
                  isEducator && !isCrisis && flaggedIds.has(c.userId);
                const isOwn = !isEducator && c.userId === user?.id;
                const canDelete = isOwn && !hasCrisisKeywords(c.note);

                return (
                  <li
                    key={c.id}
                    className={`flex items-start gap-3 py-3 ${
                      isCrisis
                        ? 'rounded-md border border-red-300 bg-red-50 px-3 -mx-2 my-1'
                        : needsSupport
                          ? 'rounded-md bg-amber-50 px-2 -mx-2'
                          : ''
                    }`}
                  >
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
                        {isCrisis && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-200 px-2 py-0.5 text-xs font-bold text-red-800">
                            <ShieldAlert className="h-3 w-3" />
                            crisis flag
                          </span>
                        )}
                        {needsSupport && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-200 px-2 py-0.5 text-xs font-medium text-amber-800">
                            <AlertTriangle className="h-3 w-3" />
                            needs support
                          </span>
                        )}
                      </div>
                      {c.note && (
                        <p className="text-sm text-gray-600 mt-1">{c.note}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <time className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(c.createdAt).toLocaleDateString()}
                      </time>
                      {isOwn && canDelete && (
                        <DeleteCheckInButton checkInId={c.id} />
                      )}
                    </div>
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
