import { ResetForm } from '@/components/auth-forms';

export const dynamic = 'force-dynamic';

/**
 * Where the reset link lands.
 *
 * Supabase exchanges the link for a session before this renders, so the form
 * only has to set a new password — there is no token to handle here, and none
 * to accidentally log or leak into a query string we control.
 */
export default function ResetPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <ResetForm />
      </div>
    </main>
  );
}
