/**
 * Workspace navigation presence test.
 *
 * Regression guard: after the v16.74.20 workspace layout rework a user reported
 * the Workspace tab/page had "disappeared" (it had not — the route and page were
 * intact). The nav entry, its route, and the page component must all stay wired
 * together. This test pins, by static source inspection (no React render needed):
 *   1. the sidebar nav array still has an item pointing at /workspace,
 *   2. that item is user-visible with the "Workspace" label,
 *   3. App.tsx still registers the /workspace route to WorkspacePage,
 *   4. isActive() still highlights the tab on /workspace.
 *
 * Run with: npx tsx script/test-nav-projects.ts
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sidebar = readFileSync(join(root, "client/src/components/sidebar.tsx"), "utf8");
const app = readFileSync(join(root, "client/src/App.tsx"), "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── 1. Sidebar nav item points at /workspace and is labelled "Workspace" ─────
const navItem = /\{\s*href:\s*"\/workspace"\s*,\s*icon:\s*\w+\s*,\s*label:\s*"([^"]+)"\s*\}/.exec(sidebar);
check("sidebar has a nav item with href '/workspace'", !!navItem);
check("the /workspace nav item is labelled 'Workspace'",
  navItem?.[1] === "Workspace", `label=${navItem?.[1]}`);

// ── 2. The nav array is actually rendered (not dead code) ────────────────────
check("navItems is mapped into the rendered nav", /navItems\.map\(/.test(sidebar));
check("nav items render a wouter <Link href={item.href}>",
  /<Link href=\{item\.href\}>/.test(sidebar));

// ── 3. isActive highlights the tab on the /workspace route ───────────────────
check("isActive keys highlighting on the '/workspace' href",
  /href === "\/workspace"[\s\S]*?location\.startsWith\("\/workspace"\)/.test(sidebar));

// ── 4. App.tsx registers the /workspace route to WorkspacePage ───────────────
check("App imports WorkspacePage", /import WorkspacePage from ["'].\/pages\/workspace["']/.test(app));
check("App registers <Route path='/workspace' component={WorkspacePage} />",
  /<Route path="\/workspace" component=\{WorkspacePage\} \/>/.test(app));
check("App registers the /workspace/:id detail route",
  /<Route path="\/workspace\/:id" component=\{WorkspacePage\} \/>/.test(app));

// ── 5. The route is reachable from non-chat overlay (Switch block) ───────────
check("workspace route lives inside the non-chat Switch",
  /!isChatRoute &&[\s\S]*<Switch>[\s\S]*\/workspace[\s\S]*<\/Switch>/.test(app));

console.log(failures === 0 ? "\nAll nav/route checks passed." : `\n${failures} check(s) failed.`);
