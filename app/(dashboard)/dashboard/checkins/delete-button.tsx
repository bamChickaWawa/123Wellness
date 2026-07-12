'use client';

import { useActionState } from 'react';
import { deleteCheckIn } from './actions';
import { Trash2, Loader2 } from 'lucide-react';

type ActionState = { error?: string; success?: string };

export function DeleteCheckInButton({ checkInId }: { checkInId: number }) {
  const [state, formAction, isPending] = useActionState<ActionState, FormData>(
    deleteCheckIn,
    {}
  );

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="checkInId" value={checkInId} />
        <button
          type="submit"
          disabled={isPending}
          title={state.error || 'Delete check-in'}
          className="rounded p-1 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </button>
      </form>
      {state.error && (
        <p className="mt-1 text-xs text-red-500">{state.error}</p>
      )}
    </div>
  );
}
