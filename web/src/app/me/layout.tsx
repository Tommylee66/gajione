import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

/**
 * The employee app.
 *
 * A phone-width column with a bottom tab bar, because that is the shape the
 * mockup designs for and the shape it is used in — on a factory floor, on a
 * personal handset. It is a web app rather than a native one; what the mockup
 * previews as iOS and Android chrome is the same five screens.
 */
const TABS = [
  { href: '/me', label: '홈' },
  { href: '/me/attendance', label: '근태' },
  { href: '/me/payslip', label: '급여명세' },
  { href: '/me/credit', label: '신용' },
  { href: '/me/more', label: '더보기' },
];

export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  if (!session.employee_id) {
    return (
      <main className="mx-auto w-full max-w-md px-4 py-8">
        <h1 className="text-xl font-semibold">직원 앱</h1>
        <p className="mt-3 text-sm text-neutral-500">
          이 계정은 직원 기록과 연결되어 있지 않습니다. 인사 담당자에게 문의하세요.
        </p>
      </main>
    );
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col">
      <div className="flex-1 px-4 pb-24 pt-6">{children}</div>
      {/* Fixed within the column, not the viewport, so it stays under the
          thumb on a phone and stays with the content on a desktop. */}
      <nav className="fixed bottom-0 left-1/2 z-10 w-full max-w-md -translate-x-1/2 border-t border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
        <div className="grid grid-cols-5">
          {TABS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="py-3 text-center text-xs text-neutral-600 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-neutral-50"
            >
              {t.label}
            </Link>
          ))}
        </div>
      </nav>
    </div>
  );
}
