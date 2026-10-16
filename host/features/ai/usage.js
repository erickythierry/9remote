// Session-long token totals, apart from the per-turn fields each engine already keeps:
// those are the window's current fill (assigned) or a mix of sums, so none of them can
// answer "how much has this chat cost in tokens".
// `input` counts everything the CLI resent, cache included; `cached` is the cache-read share.
export function addSessionUsage(stats, { input = 0, cached = 0, output = 0 }) {
  stats.sessionInputTokens = (stats.sessionInputTokens || 0) + input;
  stats.sessionCachedTokens = (stats.sessionCachedTokens || 0) + cached;
  stats.sessionOutputTokens = (stats.sessionOutputTokens || 0) + output;
}
