'use client';

import { useActionState, useState } from 'react';
import { logCheckIn } from './actions';
import { EMOTIONS } from '@/lib/wellness/emotions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';

type ActionState = { error?: string; success?: string };

export function CheckInForm() {
  const [selected, setSelected] = useState('');
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    logCheckIn,
    {}
  );

  return (
    <Card className="mb-8">
      <CardHeader>
        <CardTitle>How are you feeling today?</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="emotion" value={selected} />
          <div className="flex flex-wrap gap-2">
            {EMOTIONS.map((e) => (
              <button
                type="button"
                key={e.label}
                onClick={() => setSelected(e.label)}
                className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition ${
                  selected === e.label
                    ? 'border-orange-500 bg-orange-50 text-orange-700'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <span className="text-lg">{e.emoji}</span>
                {e.label}
              </button>
            ))}
          </div>
          <div>
            <Label htmlFor="note" className="mb-2">
              Anything you want to share? (optional)
            </Label>
            <textarea
              id="note"
              name="note"
              rows={2}
              maxLength={300}
              className="w-full rounded-md border border-gray-200 p-2 text-sm"
              placeholder="A few words about your day…"
            />
          </div>
          {state?.error && <p className="text-sm text-red-500">{state.error}</p>}
          {state?.success && (
            <p className="text-sm text-green-600">{state.success}</p>
          )}
          <Button
            type="submit"
            disabled={isPending || !selected}
            className="bg-orange-500 hover:bg-orange-600 text-white"
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Log check-in'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
