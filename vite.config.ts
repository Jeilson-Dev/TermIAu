import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Por consulta, e não pelos avisos do sistema: o projeto mora num volume
    // externo, e lá os avisos de mudança param de chegar no meio da sessão — o
    // Vite seguia servindo o arquivo de antes, sem erro nenhum.
    watch: { ignored: ["**/src-tauri/**", "**/node_modules/**"], usePolling: true, interval: 300 },
  },
  build: {
    // Duas páginas: o terminal e o differ. São bundles separados porque a aba
    // presa carrega o differ num <iframe> — e assim o React e o shiki, que só
    // ele usa, não entram no bundle que abre a janela.
    rollupOptions: {
      input: {
        index: "index.html",
        differ: "differ.html",
      },
    },
  },
});
