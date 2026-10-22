// Friendly one-line git result summaries, shared by GitActionsModal and ScmPanel.
// Raw git output stays visible only on failure — it carries the reject reason.

type Translate = (key: string) => string;
const firstMatch = (out: string | null | undefined, pred: (line: string) => boolean): string => (out || "").split("\n").map((s) => s.trim()).find(pred) || "";

export const commitSummary = (t: Translate, out: string | null | undefined): string => {
  const line = firstMatch(out, s => /files? changed/.test(s));
  return t("git.commitSuccess") + (line ? ` · ${line}` : "");
};

export const pushSummary = (t: Translate, out: string | null | undefined): string => {
  if (/up.to.date/i.test(out || "")) return t("git.upToDate");
  const line = firstMatch(out, s => s.includes("->"));
  return t("git.pushSuccess") + (line ? ` · ${line}` : "");
};

export const pullSummary = (t: Translate, out: string | null | undefined): string => {
  if (/already up to date|up.to.date/i.test(out || "")) return t("git.upToDate");
  const line = firstMatch(out, s => /files? changed|fast-forward/i.test(s));
  return t("git.pullSuccess") + (line ? ` · ${line}` : "");
};
