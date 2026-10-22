// Terminal-style line filtering for page content — the grep(1) semantics the
// agent already knows: pattern, context windows, line numbers, invert, match
// cap, link extraction, head/tail post-cuts. Pure string in/out, no browser.

const num = (v: unknown): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

type Matcher = { re: RegExp } | { needle: string };

// A bad regex (user-typed dot-separated prices etc.) must degrade to a plain
// substring needle, never throw.
const compile = (pattern: string, caseSensitive: boolean): Matcher => {
  try { return { re: new RegExp(pattern, caseSensitive ? "" : "i") }; }
  catch { return { needle: caseSensitive ? pattern : pattern.toLowerCase() }; }
};

const matches = (line: string, matcher: Matcher | null, caseSensitive: boolean): boolean => {
  if (!matcher) return true;
  if ('re' in matcher) return matcher.re.test(line);
  const hay = caseSensitive ? line : line.toLowerCase();
  return hay.includes(matcher.needle);
};

// Links mode: the page reader renders anchors as "[label](url)" — flatten them
// to "label -> url" lines that grep flags can then filter like any other line.
const extractLinks = (lines: string[]): string[] => {
  const out: string[] = [];
  for (const line of lines) {
    const re = /\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
    let m;
    while ((m = re.exec(line))) out.push(`${m[1]} -> ${m[2]}`);
  }
  return out;
};

export interface GrepOptions {
  links?: boolean;
  caseSensitive?: boolean;
  pattern?: string;
  invert?: boolean;
  max?: unknown;
  lineNumbers?: boolean;
  before?: unknown;
  after?: unknown;
  context?: unknown;
  head?: unknown;
  tail?: unknown;
}

export function grepContent(text: unknown, opts: GrepOptions = {}): { text: string; matched: number; totalLines: number } {
  let source = String(text || "").split("\n");
  if (opts.links) source = extractLinks(source);

  const caseSensitive = Boolean(opts.caseSensitive);
  const matcher = typeof opts.pattern === "string" && opts.pattern
    ? compile(opts.pattern, caseSensitive) : null;

  const invert = Boolean(opts.invert);
  const max = num(opts.max) || Infinity;
  const hitIdx = [];
  for (let i = 0; i < source.length && hitIdx.length < max; i++) {
    if (matches(source[i], matcher, caseSensitive) !== invert) hitIdx.push(i);
  }

  const showNums = Boolean(opts.lineNumbers);
  let out: string[];
  if (invert) {
    // grep -v carries no context, but -n still numbers the kept lines
    out = hitIdx.map((i) => (showNums ? `${i + 1}: ${source[i]}` : source[i]));
  } else {
    const before = num(opts.before) || num(opts.context);
    const after = num(opts.after) || num(opts.context);
    // Merge windows that overlap or touch (GNU grep: no separator when contiguous).
    const groups: { lo: number; hi: number; matches: Set<number> }[] = [];
    for (const idx of hitIdx) {
      const lo = Math.max(0, idx - before);
      const hi = Math.min(source.length - 1, idx + after);
      const last = groups[groups.length - 1];
      if (last && lo <= last.hi + 1) {
        last.hi = Math.max(last.hi, hi);
        last.matches.add(idx);
      } else {
        groups.push({ lo, hi, matches: new Set([idx]) });
      }
    }
    out = [];
    for (const g of groups) {
      // grep(1) only separates groups when context is requested — bare matches
      // print as plain lines.
      if (out.length && (before || after)) out.push("--");
      for (let i = g.lo; i <= g.hi; i++) {
        out.push(showNums ? `${i + 1}${g.matches.has(i) ? ":" : "-"} ${source[i]}` : source[i]);
      }
    }
  }

  if (num(opts.head)) out = out.slice(0, num(opts.head));
  else if (num(opts.tail)) out = out.slice(-num(opts.tail));

  return { text: out.join("\n"), matched: hitIdx.length, totalLines: source.length };
}
