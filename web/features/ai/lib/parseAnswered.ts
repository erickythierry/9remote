// The host's only record of a past AskUserQuestion answer is plain text:
// 'Your questions have been answered: "Q"="A", "Q2"="A2".' — parse the pairs back
// out so the card can show question → answer. Null when nothing matches, letting
// the caller fall back to the raw text.
//
// Read as anonymous pairs this loses answers, measured on 133 real ones: the host writes
// question AND answer back verbatim without escaping, so a quote inside either ends the
// match early. '"Nhớ tab theo workspace" là nhớ tab nào?' read as the key ' là nhớ tab nào?'
// matched no question, and the card drew the bare "Answered" header with nothing under it.
// The question text is already known, so it is what locates each answer: everything after
// `"<question>"=` up to the last quote before the next question (or the host's own trailing
// sentence) is the answer, quotes and all.
const PAIR = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;
const unescape = (value: string): string => value.replace(/\\(.)/g, "$1");
const pairsOf = (text: string): [string, string][] =>
  [...text.matchAll(PAIR)].map((match) => [unescape(match[1]), unescape(match[2])]);

export function parseAnswered(text: unknown, questions: string[] = []): Record<string, string> | null {
  const raw = String(text || "");
  if (!questions.length) {
    const pairs = pairsOf(raw);
    return pairs.length ? Object.fromEntries(pairs) : null;
  }

  const out: Record<string, string> = {};
  let from = 0;
  for (const [i, question] of questions.entries()) {
    // Searched forward from the last answer, so a question asked twice keeps its own.
    const marker = raw.indexOf(`"${question}"=`, from);
    if (marker === -1) continue;
    const start = marker + question.length + 3;
    // The next question's own marker is the boundary; the last answer runs to the host's
    // trailing sentence, which is prose after the closing quote.
    const next = questions[i + 1] ? raw.indexOf(`"${questions[i + 1]}"=`, start) : -1;
    const slice = raw.slice(start, next === -1 ? undefined : next);
    const end = slice.lastIndexOf('"');
    if (end <= 0) continue;
    out[question] = unescape(slice.slice(1, end));
    from = start + end;
  }
  if (Object.keys(out).length) return out;
  const pairs = pairsOf(raw);
  return pairs.length ? Object.fromEntries(pairs) : null;
}
