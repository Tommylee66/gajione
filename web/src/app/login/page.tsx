import { LoginForm } from '@/components/login-form';
import { Suspense } from 'react';

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
