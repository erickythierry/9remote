import DocsLayout from "@/components/DocsLayout";
import DocsContent from "@/components/DocsContent";
import { extractHeadings } from "@/utils/markdown";
import contentData from "@/generated/content.json";

export default function HomePage() {
  const contentBySlug: Record<string, string> = contentData;
  const content = contentBySlug["index"] || "# Welcome to 9Remote Documentation\n\nContent coming soon...";
  const headings = extractHeadings(content);

  return (
    <DocsLayout headings={headings}>
      <DocsContent content={content} />
    </DocsLayout>
  );
}
