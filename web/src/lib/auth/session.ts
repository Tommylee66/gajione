import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { AppUser } from '@/types/domain';

/**
 * Wrapped in React's request cache so a layout and the page it renders share
 * one getUser() call. Without it, concurrent calls each try to spend the same
 * single-use refresh token and the loser fails — which surfaces as a session
 * that is randomly null right after signing in.
 */
export const getSession = cache(async (): Promise<AppUser | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('users')
    .select('id, email, full_name, role, company_id, employee_id, lender_id, is_active, is_approved')
    .eq('id', user.id)
    .maybeSingle();

  if (!data || !data.is_active || !data.is_approved) return null;
  return data as AppUser;
});

export async function requireSession(): Promise<AppUser> {
  const session = await getSession();
  if (!session) throw new Error('Unauthorized');
  return session;
}

/** Roles allowed to see unmasked NIK, salary and bank details. */
export function canSeeSensitive(role: UserRoleLike): boolean {
  return role === 'operator_admin' || role === 'hr_admin';
}

type UserRoleLike = AppUser['role'];
