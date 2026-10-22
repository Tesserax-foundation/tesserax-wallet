import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Content security policy of the production build. Scripts, styles and fonts come from the
 * wallet itself only; the wallet talks to the node over websockets and, for the history, to the
 * explorer database. Nothing can embed it.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss: https://*.supabase.co",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

/** The policy as a meta tag in the built page (the dev server injects inline scripts). */
const csp = (): Plugin => ({
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

/**
 * `--mode desktop` builds the pages of the desktop application: Tauri sets their security policy
 * itself, with the hashes of the scripts it injects, from `src-tauri/tauri.conf.json`.
 */
export default defineConfig(({ mode }) => {
  const desktop = mode === "desktop";
  return {
    plugins: [react(), tailwindcss(), ...(desktop ? [] : [csp()])],
    define: desktop ? { "import.meta.env.VITE_TARGET": JSON.stringify("desktop") } : {},
    server: { port: desktop ? 5175 : 5174, strictPort: desktop },
    // Tauri prints in the same terminal: its output stays.
    clearScreen: !desktop,
    // Assets are files, never inlined as data: URLs, which the policy refuses for fonts.
    build: { sourcemap: false, target: "es2022", assetsInlineLimit: 0, chunkSizeWarningLimit: 1000, outDir: desktop ? "dist-desktop" : "dist" },
    worker: { format: "es" },
  };
});
