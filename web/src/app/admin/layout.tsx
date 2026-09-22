import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

/**
 * The operator console.
 *
 * Gated on the same definition of "operator" the database uses — attached to
 * no tenant — rather than on the role name alone, so the screen and RLS agree
 * about who is looking.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  const isOperator =
    session.role === 'operator_admin' && !session.company_id && !session.lender_id;
  if (!isOperator) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold">운영 마스터</h1>
        <p className="mt-3 text-sm text-neutral-500">
          운영사 계정으로만 접근할 수 있습니다.
          {session.role === 'operator_admin' &&
            ' 이 계정은 특정 회사에 소속되어 있어 운영사로 인정되지 않습니다.'}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
            운영 마스터 · Internal Only
          </p>
          <h1 className="mt-1 text-2xl font-semibold">GajiOne 운영 콘솔</h1>
        </div>
        <nav className="flex gap-4 text-sm">
          <Link href="/admin" className="text-blue-600 underline">
            고객사
          </Link>
          <Link href="/admin/billing" className="text-blue-600 underline">
            요금제 · 빌링
          </Link>
        </nav>
      </header>
      {children}
    </main>
  );
}
