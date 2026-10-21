import { resolve } from "node:path";
import { defineConfig } from "vite";

/// Two ES modules: `main.js`, which the host imports, and `differ.js`, which the diff
/// tab loads into its page. React comes from that page (src/react.ts), not bundled.
export default defineConfig({
  root: __dirname,
  logLevel: "warn",
  resolve: {
    alias: [
      { find: /^react\/jsx-runtime$/, replacement: resolve(__dirname, "src/jsx-runtime.ts") },
      { find: /^react$/, replacement: resolve(__dirname, "src/react.ts") },
    ],
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "safari15",
    minify: true,
    lib: {
      entry: { main: resolve(__dirname, "src/main.ts"), differ: resolve(__dirname, "src/differ.tsx") },
      formats: ["es"],
      fileName: (_, name) => `${name}.js`,
    },
  },
});
