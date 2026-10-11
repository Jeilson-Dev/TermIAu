import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Polling, not system notifications: the project lives on an external
    // volume, and there change notifications stop arriving mid-session — Vite
    // kept serving the previous file, with no error at all.
    watch: { ignored: ["**/src-tauri/**", "**/node_modules/**"], usePolling: true, interval: 300 },
  },
  build: {
    // Two pages: the terminal and the differ. They are separate bundles because
    // the pinned tab loads the differ in an <iframe> — so React and shiki, which
    // only it uses, stay out of the bundle that opens the window.
    rollupOptions: {
      input: {
        index: "index.html",
        differ: "differ.html",
      },
    },
  },
});
