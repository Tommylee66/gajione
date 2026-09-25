'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // "Not confirmed" is the one case worth naming. Supabase only answers
      // that way once the password has already matched, so it tells somebody
      // who cannot sign in nothing they did not supply themselves — while
      // "이메일 또는 비밀번호가 올바르지 않습니다" would send a person who just
      // signed up correctly off to reset a password that was never wrong.
      if (error.code === 'email_not_confirmed') {
        setError('이메일 확인이 아직 완료되지 않았습니다. 받은편지함의 확인 메일 링크를 눌러 주세요.');
        setBusy(false);
        return;
      }
      // Otherwise deliberately not distinguishing "no such account" from
      // "wrong password": that difference tells an attacker which addresses
      // exist.
      setError('이메일 또는 비밀번호가 올바르지 않습니다.');
      setBusy(false);
      return;
    }
    router.replace(params.get('redirect') || '/');
    router.refresh();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <h1 className="text-xl font-semibold">GajiOne</h1>
      <p className="mt-1 text-sm text-neutral-500">직원 계정으로 로그인하세요</p>

      <label className="mt-6 block text-sm font-medium" htmlFor="email">
        이메일
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      />

      <label className="mt-4 block text-sm font-medium" htmlFor="password">
        비밀번호
      </label>
      <input
        id="password"
        type="password"
        required
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      />

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="mt-6 w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? '로그인 중…' : '로그인'}
      </button>
      <div className="mt-4 flex items-center justify-between text-sm">
        <a href="/forgot" className="text-neutral-500 underline">
          비밀번호를 잊으셨나요?
        </a>
        <a href="/signup" className="text-blue-600 underline">
          신규 고객사 가입
        </a>
      </div>
      <p className="mt-4 text-center text-xs text-neutral-400">
        <a href="/terms" className="underline">
          이용약관 · 개인정보처리방침
        </a>
      </p>

    </form>
  );
}
