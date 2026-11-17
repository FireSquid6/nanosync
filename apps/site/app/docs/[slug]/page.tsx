import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { CodeBlock } from '../../../components/CodeBlock';
import { getDocs, topics } from '../../../lib/docs';

type Props = { params: Promise<{ slug: string }> };
export function generateStaticParams() { return topics.map(([slug]) => ({ slug })); }
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: topics.find(topic => topic[0] === slug)?.[1] ?? 'Not found' };
}
export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const docs = getDocs();
  const index = docs.findIndex(doc => doc.slug === slug);
  const doc = docs[index];
  if (!doc) notFound();
  const previous = docs[index - 1];
  const next = docs[index + 1];
  return <>
    <p className="breadcrumb">docs / {doc.title.toLowerCase()}</p>
    <article><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight, rehypeSlug, [rehypeAutolinkHeadings, { behavior: 'wrap' }]]} components={{ pre: CodeBlock, a: ({ href, children }) => <a href={href?.replace(/^([\w-]+)\.md(?=#|$)/, '/docs/$1')}>{children}</a> }}>{doc.content}</Markdown></article>
    <nav className="page-navigation" aria-label="Previous and next documentation">
      <span>{previous && <Link rel="prev" href={`/docs/${previous.slug}`}>← {previous.title}</Link>}</span>
      <span>{next && <Link rel="next" href={`/docs/${next.slug}`}>{next.title} →</Link>}</span>
    </nav>
  </>;
}
