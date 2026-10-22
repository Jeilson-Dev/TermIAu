import { resolve } from "node:path";
import { defineConfig } from "vite";

/// The notebook plugin builds to a single ES module: the host imports `main.js` from
/// `termiau-plugin://`, and one file means no relative imports to resolve there.
/// `scripts/package-plugin.sh claude-notes` zips it with the manifest and the stylesheet.
export default defineConfig({
  root: __dirname,
  logLevel: "warn",
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "safari15",
    minify: true,
    lib: {
      entry: resolve(__dirname, "src/main.ts"),
      formats: ["es"],
      fileName: () => "main.js",
    },
  },
});
