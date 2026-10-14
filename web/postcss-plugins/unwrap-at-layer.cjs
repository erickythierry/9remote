// iOS 15.0–15.3 drop every rule nested in @layer (supported starting in 15.4).
// Standalone module so postcss.config.mjs can reference it by path — Next's
// webpack build accepts PostCSS plugins as string module paths only.
module.exports = {
  postcssPlugin: "unwrap-at-layer",
  Once(root) {
    let pending = true;
    while (pending) {
      pending = false;
      root.walkAtRules("layer", (atRule) => {
        if (atRule.nodes) atRule.replaceWith(atRule.nodes);
        else atRule.remove();
        pending = true;
        return false;
      });
    }
  }
};
