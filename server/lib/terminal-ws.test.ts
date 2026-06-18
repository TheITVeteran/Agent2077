// Run with: npx tsx server/lib/terminal-ws.test.ts
// Excluded from the build and from tsconfig (**/*.test.ts), so it adds no
// runtime/typecheck weight. Verifies the terminal WebSocket upgrade is gated by
// the same JWT auth as the REST API AND by an Origin check, so an
// unauthenticated or cross-origin browser cannot reach the shell-spawning path.
//
// Strategy: stand up a real http.Server with setupTerminalWs attached, then make
// real ws upgrade attempts for each scenario. A rejected upgrade surfaces as a
// ws "unexpected-response" / "error" with the HTTP status; an accepted one
// reaches handleTerminalConnection, which sends a {type:"ready"} frame BEFORE
// any input — that "ready" (or its absence) is our spawned/not-spawned signal.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

// Point at a throwaway DB BEFORE importing anything that opens it.
const tmpDb = path.join(os.tmpdir(), `agent2077-termws-test-${Date.now()}.db`);
process.env.AGENT2077_DB_PATH = tmpDb;
// Pin a known secret so generateToken/verifyToken agree regardless of env.
process.env.JWT_SECRET = "test-secret-for-terminal-ws";

const { bootstrapSchema, runMigrations, initNewTables } = await import("../db.ts");
const { userStore, projectStore } = await import("../storage.ts");
const { generateToken } = await import("../middleware/auth.ts");
const wsModule = await import("ws");
const WS = wsModule.WebSocket;
// setupTerminalWs lazily loads "ws" via eval('require'), which fails under tsx/ESM.
// It checks globalThis.__wsModule first, so pre-populate it with the ESM import.
(globalThis as any).__wsModule = wsModule;

const { setupTerminalWs } = await import("./terminal-ws.ts");

bootstrapSchema();
runMigrations();
initNewTables();

// Seed a user + project so a valid token maps to a real user and the session id
// resolves to a real project path.
const user = userStore.create({ username: "tester", passwordHash: "pw" });
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent2077-termws-proj-"));
const project = projectStore.create({ name: "t", path: projDir } as any);
const validToken = generateToken(user.id, user.username);
const sessionId = `term-${project.id}-0`; // fallback path resolves this to the project

const server = http.createServer();
setupTerminalWs(server);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
const wsUrl = `ws://127.0.0.1:${port}/ws/terminal/${sessionId}`;

let passed = 0;
let failed = 0;

/**
 * Attempt a WS upgrade. Resolves with the outcome:
 *  - { ready: true }              → upgrade accepted AND a shell was spawned
 *  - { rejected: true, code }     → upgrade rejected at HTTP level (no spawn)
 *  - { closedNoReady: true }      → opened but closed without "ready" (no spawn)
 */
function attempt(opts: { headers?: Record<string, string> } = {}): Promise<any> {
  return new Promise((resolve) => {
    const ws = new WS(wsUrl, { headers: opts.headers || {} });
    let settled = false;
    const done = (v: any) => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(v); } };

    ws.on("message", (buf: Buffer) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.type === "ready") done({ ready: true });
      } catch { /* ignore non-JSON */ }
    });
    // ws emits "unexpected-response" when the server returns a non-101 HTTP status.
    ws.on("unexpected-response", (_req: any, res: any) => done({ rejected: true, code: res.statusCode }));
    ws.on("error", (err: any) => {
      const m = String(err?.message || "");
      const code = /(\d{3})/.exec(m)?.[1];
      done({ rejected: true, code: code ? parseInt(code) : undefined, error: m });
    });
    ws.on("open", () => {
      // Connected at the WS layer. If no "ready" arrives shortly, no shell spawned.
      setTimeout(() => done({ closedNoReady: true }), 600);
    });
    setTimeout(() => done({ timeout: true }), 3000);
  });
}

function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}`); }
}

// 1. No auth, no origin → rejected 401, no shell.
{
  const r = await attempt();
  check("missing token is rejected (401), no shell spawned", r.rejected === true && r.code === 401 && !r.ready);
}

// 2. Invalid token → rejected 401, no shell.
{
  const r = await attempt({ headers: { Authorization: "Bearer not-a-real-jwt" } });
  check("invalid token is rejected (401), no shell spawned", r.rejected === true && r.code === 401 && !r.ready);
}

// 3. Valid token but cross-origin → rejected 403, no shell (Origin checked first).
{
  const r = await attempt({
    headers: { Authorization: `Bearer ${validToken}`, Origin: "http://evil.example.com" },
  });
  check("cross-origin is rejected (403) even with a valid token", r.rejected === true && r.code === 403 && !r.ready);
}

// 4. Valid token, same-origin (Origin host === request host) → accepted, shell spawned.
{
  const r = await attempt({
    headers: { Authorization: `Bearer ${validToken}`, Origin: `http://127.0.0.1:${port}` },
  });
  check("valid token + same-origin reaches the connection handler (shell spawned)", r.ready === true);
}

// 5. Valid token, no Origin (non-browser client) → accepted.
{
  const r = await attempt({ headers: { Authorization: `Bearer ${validToken}` } });
  check("valid token + no Origin header (non-browser client) is accepted", r.ready === true);
}

// 6. Valid token via cookie + localhost origin → accepted (browser path).
{
  const r = await attempt({
    headers: { Cookie: `agent2077_token=${validToken}`, Origin: "http://localhost:1234" },
  });
  check("valid cookie token + localhost origin is accepted", r.ready === true);
}

await new Promise<void>((r) => server.close(() => r()));
try { fs.rmSync(tmpDb, { force: true }); fs.rmSync(`${tmpDb}-wal`, { force: true }); fs.rmSync(`${tmpDb}-shm`, { force: true }); } catch {}
try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}

console.log(failed === 0 ? `\nAll ${passed} terminal-ws auth tests passed.` : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
