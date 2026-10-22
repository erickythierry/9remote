"use client";

// Compiled pick data — the same shape the "Copy for AI" prompt uses, multi-element.
export type PickRect = { x: number; y: number; width: number; height: number };
export type PickItem = { tag: string; selector?: string | null; text?: string | null; href?: string | null; rect?: PickRect | null };

export function buildPickPayload(items: PickItem[], url: string | null = null): string {
  return [
    `## Browser Elements (${items.length})`,
    url ? `Page: ${url}` : null,
    "Selectors are unique CSS paths — reuse with document.querySelector() or a find/click-by-selector tool.",
    "",
    ...items.map((it, i) => [
      `### ${i + 1}. \`<${it.tag}>\``,
      `- Selector: \`${it.selector || it.tag}\``,
      it.text ? `- Text: "${it.text}"` : null,
      it.href ? `- Link: ${it.href}` : null,
      it.rect ? `- Rect: ${it.rect.x},${it.rect.y} ${it.rect.width}×${it.rect.height}` : null
    ].filter(Boolean).join("\n"))
  ].filter(Boolean).join("\n");
}
