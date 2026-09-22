'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { submitSignupAction } from '@/app/signup/actions';

export interface TermsDoc {
  code: string;
  version: string;
  title: string;
  body: string;
  required: boolean;
}

const INDUSTRIES = [
  '제조업 - 금속가공',
  '제조업 - 섬유',
  '제조업 - 전자',
  '식음료',
  '물류',
  '기타',
];
const BANDS = ['1 - 50명', '51 - 200명', '201 - 500명', '500명 이상'];
const REGIONS = ['DKI Jakarta', 'Jawa Barat', 'Jawa Timur', 'Banten', '기타 지역'];

const field =
  'mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

/** Length over composition: a rule that forces a symbol produces Password1!. */
function strength(pw: string): { label: string; tone: string } {
  if (pw.length === 0) return { label: '', tone: '' };
  if (pw.length < 10) return { label: '너무 짧습니다 (10자 이상)', tone: 'text-red-600' };
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 16 || variety >= 3) return { label: '강함', tone: 'text-emerald-600' };
  return { label: '보통', tone: 'text-amber-600' };
}

export function SignupWizard({ terms }: { terms: TermsDoc[] }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const [f, setF] = useState({
    companyName: '',
    npwp: '',
    industry: INDUSTRIES[0],
    headcountBand: BANDS[0],
    region: REGIONS[0],
    contactName: '',
    contactTitle: '',
    email: '',
    phone: '',
    password: '',
    confirm: '',
  });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));

  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const requiredOk = terms.filter((t) => t.required).every((t) => accepted[t.code]);
  const pw = strength(f.password);
  const pwMatch = f.password.length > 0 && f.password === f.confirm;

  async function submit() {
    setBusy(true);
    setError(null);
    const r = await submitSignupAction({
      companyName: f.companyName,
      npwp: f.npwp,
      industry: f.industry,
      headcountBand: f.headcountBand,
      region: f.region,
      contactName: f.contactName,
      contactTitle: f.contactTitle,
      email: f.email,
      phone: f.phone,
      password: f.password,
      acceptances: terms.map((t) => ({
        code: t.code,
        version: t.version,
        accepted: Boolean(accepted[t.code]),
      })),
    });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? '가입 신청에 실패했습니다.');
    setDone(true);
    router.refresh();
  }

  if (done) {
    return (
      <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-8 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-lg font-semibold">가입 신청이 완료되었습니다</h2>
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
          GajiOne 운영팀 검토 후 계정이 활성화됩니다. 승인 전까지는 로그인해도 대기 화면만
          표시됩니다.
        </p>
        <a
          href="/login"
          className="mt-6 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white"
        >
          로그인 화면으로
        </a>
      </div>
    );
  }

  return (
    <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
        {['회사 정보', '관리자 계정', '약관 동의'].map((s, i) => (
          <li key={s} className={step === i + 1 ? 'font-semibold text-blue-600' : ''}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <div className="mt-5 space-y-3">
          <label className="block text-sm">
            <span className="font-medium">회사명</span>
            <input value={f.companyName} onChange={(e) => set('companyName', e.target.value)} className={field} />
          </label>
          <label className="block text-sm">
            <span className="font-medium">사업자등록번호 (NPWP)</span>
            <input value={f.npwp} onChange={(e) => set('npwp', e.target.value)} className={field} />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Select label="업종" value={f.industry} options={INDUSTRIES} onChange={(v) => set('industry', v)} />
            <Select label="예상 직원 수" value={f.headcountBand} options={BANDS} onChange={(v) => set('headcountBand', v)} />
            <Select label="소재지" value={f.region} options={REGIONS} onChange={(v) => set('region', v)} />
          </div>
          <button
            disabled={!f.companyName.trim()}
            onClick={() => setStep(2)}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            다음
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="mt-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="font-medium">담당자 이름</span>
              <input value={f.contactName} onChange={(e) => set('contactName', e.target.value)} className={field} />
            </label>
            <label className="block text-sm">
              <span className="font-medium">직책</span>
              <input value={f.contactTitle} onChange={(e) => set('contactTitle', e.target.value)} className={field} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="font-medium">이메일</span>
            <input
              type="email"
              autoComplete="username"
              value={f.email}
              onChange={(e) => set('email', e.target.value)}
              className={field}
            />
            <span className="mt-1 block text-xs text-neutral-500">
              이 주소가 로그인 ID가 됩니다.
            </span>
          </label>
          <label className="block text-sm">
            <span className="font-medium">휴대폰번호</span>
            <input value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+62" className={field} />
          </label>
          <label className="block text-sm">
            <span className="font-medium">비밀번호</span>
            <input
              type="password"
              autoComplete="new-password"
              value={f.password}
              onChange={(e) => set('password', e.target.value)}
              className={field}
            />
            {pw.label && <span className={`mt-1 block text-xs ${pw.tone}`}>{pw.label}</span>}
          </label>
          <label className="block text-sm">
            <span className="font-medium">비밀번호 확인</span>
            <input
              type="password"
              autoComplete="new-password"
              value={f.confirm}
              onChange={(e) => set('confirm', e.target.value)}
              className={field}
            />
            {f.confirm.length > 0 && !pwMatch && (
              <span className="mt-1 block text-xs text-red-600">비밀번호가 일치하지 않습니다.</span>
            )}
          </label>
          <div className="flex gap-2">
            <button onClick={() => setStep(1)} className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
              이전
            </button>
            <button
              disabled={!f.contactName.trim() || !f.email.trim() || f.password.length < 10 || !pwMatch}
              onClick={() => setStep(3)}
              className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              다음
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="mt-5 space-y-3">
          <label className="flex items-center gap-2 border-b border-neutral-200 pb-3 text-sm font-medium dark:border-neutral-800">
            <input
              type="checkbox"
              checked={terms.every((t) => accepted[t.code])}
              onChange={(e) =>
                setAccepted(Object.fromEntries(terms.map((t) => [t.code, e.target.checked])))
              }
            />
            전체 동의합니다
          </label>
          {terms.map((t) => (
            <div key={t.code}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(accepted[t.code])}
                    onChange={(e) => setAccepted((p) => ({ ...p, [t.code]: e.target.checked }))}
                  />
                  [{t.required ? '필수' : '선택'}] {t.title}
                  <span className="text-xs text-neutral-500">v{t.version}</span>
                </label>
                <button
                  onClick={() => setOpen(open === t.code ? null : t.code)}
                  className="shrink-0 text-xs text-blue-600 underline"
                >
                  {open === t.code ? '접기' : '전문 보기'}
                </button>
              </div>
              {open === t.code && (
                /* The text is shown here, not linked away to. A consent given
                   without the document in front of somebody is a click. */
                <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-xs text-neutral-600 dark:bg-neutral-950 dark:text-neutral-400">
                  {t.body}
                </pre>
              )}
            </div>
          ))}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button onClick={() => setStep(2)} className="rounded-md border border-neutral-300 px-4 py-2 text-sm dark:border-neutral-700">
              이전
            </button>
            <button
              disabled={busy || !requiredOk}
              onClick={submit}
              className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              가입 신청
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={field}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
