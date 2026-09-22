import Link from 'next/link';
import { getSession } from '@/lib/auth/session';

const LINKS = [
  { href: '/', label: '홈' },
  { href: '/employees', label: '직원' },
  { href: '/org', label: '부서·직급' },
  { href: '/upload', label: '원천데이터' },
  { href: '/attendance', label: '근태' },
  { href: '/shifts', label: '교대' },
  { href: '/overtime', label: 'OT' },
  { href: '/policy', label: '정책·요율' },
  { href: '/payroll', label: '급여' },
  { href: '/loans', label: '대출·신용' },
  { href: '/devices', label: '장치' },
  { href: '/reports', label: '리포트' },
];

/**
 * Renders nothing without a session, so the login screen stays a login screen
 * and the nav never advertises routes the visitor cannot open.
 */
export async function AppNav() {
  const session = await getSession();
  if (!session) return null;

  // A partner is not a tenant user. Showing them the payroll menu would be
  // advertising routes RLS will refuse, and inviting the question of why.
  if (session.role === 'lender_officer') {
    return (
      <nav className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          <span className="text-sm font-semibold">GajiOne</span>
          <Link href="/partner" className="text-sm text-neutral-600 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-neutral-50">
            파트너 포털
          </Link>
          <span className="ml-auto text-sm text-neutral-500">{session.full_name}</span>
        </div>
      </nav>
    );
  }

  return (
    <nav className="border-b border-neutral-200 dark:border-neutral-800">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        <span className="text-sm font-semibold">GajiOne</span>
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="text-sm text-neutral-600 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-neutral-50"
          >
            {l.label}
          </Link>
        ))}
        <span className="ml-auto text-sm text-neutral-500">{session.full_name}</span>
      </div>
    </nav>
  );
}
