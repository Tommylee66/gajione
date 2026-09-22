import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { SignupWizard, type TermsDoc } from '@/components/signup-wizard';

export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  const supabase = await createClient();
  const { data: docs } = await supabase
    .from('terms_documents')
    .select('code, version, title, body, required')
    .is('effective_to', null)
    .eq('at_signup', true)
    .order('required', { ascending: false });

  // at_signup is the filter, set in the database rather than by a code-side
  // exclusion list — so adding a document cannot leave the form and the
  // validator disagreeing about what is being agreed to.
  const terms: TermsDoc[] = (docs ?? []).map((d) => ({
      code: d.code as string,
      version: d.version as string,
      title: d.title as string,
      body: d.body as string,
    required: Boolean(d.required),
  }));

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-950">
      <div className="w-full max-w-lg">
        <h1 className="text-xl font-semibold">GajiOne 신규 고객사 가입</h1>
        <p className="mt-1 text-sm text-neutral-500">
          인도네시아 제조업을 위한 급여 품질관리 플랫폼
        </p>
        <SignupWizard terms={terms} />
        <p className="mt-4 text-center text-sm text-neutral-500">
          이미 계정이 있으신가요?{' '}
          <Link href="/login" className="text-blue-600 underline">
            로그인
          </Link>
        </p>
      </div>
    </main>
  );
}
