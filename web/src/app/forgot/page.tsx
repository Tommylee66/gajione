import Link from 'next/link';
import { ForgotForm } from '@/components/auth-forms';

export default function ForgotPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <ForgotForm />
        <p className="mt-4 text-center text-sm text-neutral-500">
          <Link href="/login" className="text-blue-600 underline">
            로그인으로 돌아가기
          </Link>
        </p>
      </div>
    </main>
  );
}
