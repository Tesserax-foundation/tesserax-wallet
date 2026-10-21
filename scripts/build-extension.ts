/**
 * Builds the browser extension in dist-extension/: the wallet pages, the background, the content
 * script and the in-page provider, with a Manifest V3 for Chromium browsers and one for Firefox,
 * each unpacked and zipped.
 */

import { execFileSync } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { CSP } from "../vite.config";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist-extension");
const app = resolve(out, "app");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { version: string };
const define = { "import.meta.env.VITE_TARGET": JSON.stringify("extension") };

await rm(out, { recursive: true, force: true });

// The pages: popup, full tab and approval window, from the wallet itself.
await build({ root, configFile: resolve(root, "vite.config.ts"), define, logLevel: "warn", build: { outDir: app, emptyOutDir: true } });

// Scripts the browser loads by themselves: single files without imports.
for (const name of ["background", "content", "inpage"]) {
  await build({
    root,
    configFile: false,
    publicDir: false,
    define,
    logLevel: "warn",
    build: {
      outDir: app,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      lib: { entry: resolve(root, `src/extension/${name}.ts`), formats: ["iife"], name: `tesserax_${name}`, fileName: () => `${name}.js` },
    },
  });
}

await cp(resolve(root, "extension/icons"), resolve(app, "icons"), { recursive: true });

const icons = Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/icon-${size}.png`]));
// Sites over HTTPS, and sites in development on this computer.
const sites = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];

const manifest = {
  manifest_version: 3,
  name: "Tesserax Wallet",
  short_name: "Tesserax",
  version,
  description: "Post-quantum wallet of Tesserax: ML-DSA-87 accounts, AI agent budgets, payment channels and the task market.",
  icons,
  action: { default_title: "Tesserax Wallet", default_popup: "index.html?popup=1", default_icon: icons },
  permissions: ["storage", "alarms"],
  content_scripts: [
    { matches: sites, js: ["content.js"], run_at: "document_start", all_frames: false },
    { matches: sites, js: ["inpage.js"], run_at: "document_start", all_frames: false, world: "MAIN" },
  ],
  content_security_policy: { extension_pages: `${CSP}; frame-ancestors 'none'` },
};

const targets = {
  chrome: { ...manifest, background: { service_worker: "background.js" }, minimum_chrome_version: "116" },
  firefox: {
    ...manifest,
    background: { scripts: ["background.js"] },
    browser_specific_settings: { gecko: { id: "wallet@tesserax.app", strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } } },
  },
};

for (const [browser, content] of Object.entries(targets)) {
  const dir = resolve(out, browser);
  await cp(app, dir, { recursive: true });
  await writeFile(resolve(dir, "manifest.json"), JSON.stringify(content, null, 2) + "\n");
  execFileSync("zip", ["-qr", resolve(out, `tesserax-wallet-${browser}-${version}.zip`), "."], { cwd: dir });
}
await rm(app, { recursive: true });

console.log(`dist-extension/chrome and dist-extension/firefox, version ${version}`);
