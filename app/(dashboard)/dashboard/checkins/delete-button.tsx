'use client';

import { useFormStatus } from 'react-dom';
import { deleteCheckIn } from './actions';
import { Trash2, Loader2 } from 'lucide-react';

function TrashButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      title="Delete check-in"
      className="rounded p-1 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 disabled:opacity-50"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Trash2 className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export function DeleteCheckInButton({ checkInId }: { checkInId: number }) {
  return (
    <form action={deleteCheckIn}>
      <input type="hidden" name="checkInId" value={checkInId} />
      <TrashButton />
    </form>
  );
}
