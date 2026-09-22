'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { requestPasswordResetAction } from '@/app/signup/actions';

const card =
  'w-full rounded-xl border border-neutral-200 bg-white p-8 dark:border-neutral-800 dark:bg-neutral-900';
const field =
  'mt-1 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

export function ForgotForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await requestPasswordResetAction(email);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '요청에 실패했습니다.');
    setSent(true);
  }

  if (sent) {
    return (
      <div className={card}>
        <h1 className="text-xl font-semibold">재설정 링크를 보냈습니다</h1>
        {/* The same message whether or not the address has an account. Saying
            "no such account" turns this form into a way to find out which
            addresses exist. */}
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
          가입된 주소라면 재설정 링크가 발송됩니다. 받은편지함과 스팸함을 확인해 주세요.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={card}>
      <h1 className="text-xl font-semibold">비밀번호 찾기</h1>
      <p className="mt-1 text-sm text-neutral-500">가입한 이메일 주소로 재설정 링크를 보냅니다.</p>
      <label className="mt-6 block text-sm font-medium">
        이메일
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={field}
        />
      </label>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <button
        disabled={busy}
        className="mt-4 w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        재설정 링크 받기
      </button>
    </form>
  );
}

export function ResetForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < 10;
  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      // The commonest cause is an expired or already-used link, which is
      // worth saying rather than showing the raw message.
      return setError(
        '비밀번호를 변경하지 못했습니다. 링크가 만료되었거나 이미 사용되었을 수 있습니다. 재설정을 다시 요청해 주세요.'
      );
    }
    setDone(true);
    router.refresh();
  }

  if (done) {
    return (
      <div className={card}>
        <h1 className="text-xl font-semibold">비밀번호를 변경했습니다</h1>
        <a
          href="/login"
          className="mt-6 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
        >
          로그인
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={card}>
      <h1 className="text-xl font-semibold">새 비밀번호 설정</h1>
      <label className="mt-6 block text-sm font-medium">
        새 비밀번호
        <input
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={field}
        />
        {tooShort && <span className="mt-1 block text-xs text-red-600">10자 이상이어야 합니다.</span>}
      </label>
      <label className="mt-3 block text-sm font-medium">
        새 비밀번호 확인
        <input
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={field}
        />
        {mismatch && <span className="mt-1 block text-xs text-red-600">비밀번호가 일치하지 않습니다.</span>}
      </label>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <button
        disabled={busy || password.length < 10 || password !== confirm}
        className="mt-4 w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        비밀번호 변경
      </button>
    </form>
  );
}
