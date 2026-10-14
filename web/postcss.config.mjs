// Plugins as string paths only — next build --webpack rejects inline plugin
// functions ("Malformed PostCSS Configuration"). unwrap-at-layer is for
// iOS 15.0–15.3, which drop every rule nested in @layer (supported in 15.4).
const config = {
  plugins: [
    "@tailwindcss/postcss",
    "./postcss-plugins/unwrap-at-layer.cjs"
  ]
};

export default config;
