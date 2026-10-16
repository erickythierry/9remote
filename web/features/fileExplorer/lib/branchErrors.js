// One user-facing sentence per switch failure code the host reports. Unknown codes fall
// back to git's own text, which carries the reason when we have no better wording.
const list = (files) => (files || []).slice(0, 5).join(", ");

export function branchErrorText(t, res, branch) {
  switch (res?.code) {
    case "inWorktree": return t("git.branchErrInWorktree", { name: branch, path: res.path || "" });
    case "operationInProgress": return t("git.branchErrOperation", { operation: res.operation });
    case "unmerged": return t("git.branchErrUnmerged", { files: list(res.files) });
    case "locked": return t("git.branchErrLocked");
    case "notFound": return t("git.branchErrNotFound", { name: branch });
    case "invalidName": return t("git.branchErrInvalid", { name: branch });
    case "exists": return t("git.branchErrExists", { name: branch });
    default: return res?.error || t("git.branchErrGeneric");
  }
}
