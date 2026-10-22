import DocsLayout from "@/components/DocsLayout";
import DocsContent from "@/components/DocsContent";
import { extractHeadings } from "@/utils/markdown";
import { notFound } from "next/navigation";
import contentData from "@/generated/content.json";

type DocPageProps = { params: Promise<{ slug: string[] }> };
const contentBySlug: Record<string, string> = contentData;

export default async function DocPage({ params }: DocPageProps) {
  const resolvedParams = await params;
  const slug = resolvedParams.slug.join("/");

  const content = contentBySlug[slug];
  if (!content) {
    notFound();
  }

  const headings = extractHeadings(content);

  return (
    <DocsLayout headings={headings}>
      <DocsContent content={content} />
    </DocsLayout>
  );
}

export async function generateStaticParams() {
  return Object.keys(contentBySlug)
    .filter(key => key !== "index")
    .map(slug => ({
      slug: slug.split("/")
    }));
}

export const dynamicParams = false;
