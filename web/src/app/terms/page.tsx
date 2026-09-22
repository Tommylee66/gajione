import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string }>;
}) {
  const { doc } = await searchParams;
  const supabase = await createClient();
  const { data: docs } = await supabase
    .from('terms_documents')
    .select('code, version, title, body, effective_from')
    .is('effective_to', null)
    .order('code');

  const list = docs ?? [];
  const selected = list.find((d) => d.code === doc) ?? list[0];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">서비스 정책 센터</h1>
      <nav className="mt-4 flex flex-wrap gap-2">
        {list.map((d) => (
          <Link
            key={d.code as string}
            href={`/terms?doc=${d.code}`}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              d.code === selected?.code
                ? 'border-blue-600 text-blue-600'
                : 'border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400'
            }`}
          >
            {d.title as string}
          </Link>
        ))}
      </nav>

      {selected ? (
        <article className="mt-6">
          <h2 className="text-lg font-semibold">{selected.title as string}</h2>
          <p className="mt-1 text-sm text-neutral-500">
            v{selected.version as string} · 시행 {selected.effective_from as string}
          </p>
          <pre className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
            {selected.body as string}
          </pre>
        </article>
      ) : (
        <p className="mt-6 text-sm text-neutral-500">등록된 문서가 없습니다.</p>
      )}
    </main>
  );
}
