'use client';

import { useRouter } from 'next/navigation';
import { useRef } from 'react';

export function CheckInFilters({
  sentiment = '',
  from = '',
  to = ''
}: {
  sentiment?: string;
  from?: string;
  to?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const hasFilters = sentiment || from || to;

  function push() {
    if (!formRef.current) return;
    const fd = new FormData(formRef.current);
    const params = new URLSearchParams();
    const s = fd.get('sentiment') as string;
    const f = fd.get('from') as string;
    const t = fd.get('to') as string;
    if (s) params.set('sentiment', s);
    if (f) params.set('from', f);
    if (t) params.set('to', t);
    router.push(`/dashboard/checkins?${params.toString()}`);
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        push();
      }}
      className="mb-6 flex flex-wrap items-end gap-3"
    >
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Sentiment
        </label>
        <select
          name="sentiment"
          defaultValue={sentiment}
          onChange={push}
          className="h-9 rounded-md border border-gray-200 px-2 text-sm"
        >
          <option value="">All</option>
          <option value="positive">Positive</option>
          <option value="neutral">Neutral</option>
          <option value="negative">Negative</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">From</label>
        <input
          type="date"
          name="from"
          defaultValue={from}
          className="h-9 rounded-md border border-gray-200 px-2 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">To</label>
        <input
          type="date"
          name="to"
          defaultValue={to}
          className="h-9 rounded-md border border-gray-200 px-2 text-sm"
        />
      </div>
      <button
        type="submit"
        className="h-9 rounded-md bg-orange-500 px-4 text-sm text-white hover:bg-orange-600"
      >
        Apply
      </button>
      {hasFilters && (
        <button
          type="button"
          onClick={() => router.push('/dashboard/checkins')}
          className="h-9 text-sm text-muted-foreground underline"
        >
          Clear
        </button>
      )}
    </form>
  );
}
