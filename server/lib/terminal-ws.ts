/**
 * WebSocket Terminal — real shell sessions connected to project directories.
 *
 * When a client connects to /ws/terminal/:sessionId, we spawn a bash shell
 * with cwd set to the project path and pipe stdin/stdout/stderr bidirectionally.
 *
 * Falls back to spawn (no PTY) if node-pty is unavailable.
 */
import type http from "http";
import type { Duplex } from "stream";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { projectStore, userStore } from "../storage.js";
import { verifyToken } from "../middleware/auth.js";

// We use placeholders until ws is loaded. setupTerminalWs loads it lazily.
let WebSocketServer: any = null;
let WebSocket: any = { OPEN: 1 }; // Fallback constant

interface TerminalSession {
  sessionId: string;
  projectId: number;
  cwd: string; // Working directory for the shell
  ws: any; // WebSocket instance (typed as any since ws is dynamically loaded)
  process: ChildProcessWithoutNullStreams | any; // pty or spawn child
  createdAt: string;
}

// Active sessions map: sessionId → session
const activeSessions = new Map<string, TerminalSession>();

// Active sessions by projectId for REST API listing
const sessionsByProject = new Map<number, Set<string>>();

// Pending sessions (created via POST but not yet WebSocket-connected)
const pendingSessions = new Map<string, { projectId: number; cwd: string }>();

/**
 * Create a new terminal session for a project.
 * Returns the sessionId.
 */
export function createTerminalSession(projectId: number, cwd?: string): { sessionId: string; cwd: string } {
  const sessionId = `term-${projectId}-${Date.now()}`;

  // We just track it — the WS connection will start the actual process
  const project = projectStore.getById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  // Use provided cwd, fall back to project path
  const sessionCwd = cwd || project.path;

  // Store the pending session so handleTerminalConnection can find the cwd
  pendingSessions.set(sessionId, { projectId, cwd: sessionCwd });

  // Register the session in the by-project map
  if (!sessionsByProject.has(projectId)) {
    sessionsByProject.set(projectId, new Set());
  }
  sessionsByProject.get(projectId)!.add(sessionId);

  console.log(`[Terminal] Created session ${sessionId} for project ${project.name}, cwd=${sessionCwd}`);
  return { sessionId, cwd: sessionCwd };
}

/**
 * List active terminal sessions for a project.
 */
export function listTerminalSessions(projectId: number): { sessionId: string; projectId: number; createdAt: string }[] {
  const ids = sessionsByProject.get(projectId) || new Set();
  const sessions: { sessionId: string; projectId: number; createdAt: string }[] = [];

  for (const id of ids) {
    const session = activeSessions.get(id);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      sessions.push({ sessionId: id, projectId, createdAt: session.createdAt });
    } else {
      // Clean up dead sessions from the set
      ids.delete(id);
    }
  }

  return sessions;
}

/** Read a single cookie value from a raw `Cookie` header. */
function readCookie(header: string, name: string): string | undefined {
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Authenticate a terminal WebSocket upgrade using the SAME JWT scheme that
 * protects the REST API (verifyToken in middleware/auth.ts). Express
 * middleware does not run on raw `upgrade` events, so we must reproduce the
 * cookie/Bearer token check here — otherwise the upgrade reaches the shell
 * spawn with no authentication at all.
 *
 * Token sources (in priority order), mirroring requireAuth + the browser's
 * automatic cookie behaviour on same-origin WS handshakes:
 *   1. `Authorization: Bearer <jwt>` header (non-browser clients)
 *   2. `agent2077_token` cookie (what the browser sends automatically)
 *   3. `?token=<jwt>` query param (fallback for clients that can't set headers)
 */
function authenticateUpgrade(req: http.IncomingMessage): boolean {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  if (!token && req.headers.cookie) {
    token = readCookie(req.headers.cookie, "agent2077_token");
  }

  if (!token && req.url) {
    try {
      const q = new URL(req.url, "http://localhost").searchParams.get("token");
      if (q) token = q;
    } catch { /* unparseable url — no token */ }
  }

  if (!token) return false;

  const payload = verifyToken(token);
  if (!payload) return false;

  // Verify the user still exists (mirrors requireAuth).
  return !!userStore.getById(payload.userId);
}

/**
 * Validate the Origin header so that a random website the operator visits
 * cannot open a cross-origin WebSocket to the local terminal (browsers permit
 * cross-origin WS connection establishment, so cookies alone are insufficient).
 *
 * Rules:
 *  - No Origin header → allow. Non-browser clients (CLI, tests, internal
 *    tooling) omit Origin; browsers always send it. A browser CSRF-style attack
 *    cannot suppress the Origin header, so its absence means "not a browser".
 *  - Origin host === request Host → allow (true same-origin).
 *  - Origin host is a recognised localhost / .local loopback alias → allow
 *    (covers agent2077.local, devagent.local, 127.0.0.1, ::1 dev access).
 *  - Anything else → reject.
 */
function isAllowedOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client

  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false; // malformed Origin from a browser — reject
  }

  // Same-origin: the Origin host matches the host the request was sent to.
  const hostHeader = req.headers.host || "";
  const requestHost = hostHeader.split(":")[0].toLowerCase();
  if (requestHost && originHost === requestHost) return true;

  // Loopback / mDNS aliases used for local + dev access.
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (localHosts.has(originHost)) return true;
  if (originHost.endsWith(".local")) return true; // agent2077.local, devagent.local

  return false;
}

/**
 * Reject a WebSocket upgrade before any shell is spawned: write a minimal HTTP
 * response with the given status, then destroy the socket.
 */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const statusText = status === 401 ? "Unauthorized" : "Forbidden";
  try {
    socket.write(
      `HTTP/1.1 ${status} ${statusText}\r\n` +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n" +
        "\r\n",
    );
  } catch { /* socket may already be gone */ }
  socket.destroy();
  console.warn(`[Terminal] Rejected WS upgrade (${status}): ${reason}`);
}

/**
 * Set up the WebSocket server for terminal connections.
 * Handles /ws/terminal/:sessionId paths.
 */
export function setupTerminalWs(httpServer: http.Server): void {
  // Load ws lazily so startup doesn't fail if ws isn't installed yet
  try {
    // Node ESM projects need createRequire or dynamic import.
    // We use a synchronous import via the compiled CJS path.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wsModule = (globalThis as any).__wsModule ||
      (() => { try { return eval('require')("ws"); } catch { return null; } })();
    if (wsModule) {
      WebSocketServer = wsModule.WebSocketServer;
      WebSocket = wsModule.WebSocket;
      (globalThis as any).__wsModule = wsModule;
    }
  } catch { /* ws not available */ }

  if (!WebSocketServer) {
    console.warn("[Terminal] 'ws' package not installed — terminal WebSocket unavailable. Add 'ws' to package.json and run npm install.");
    return;
  }

  const wss = new WebSocketServer({ noServer: true });

  // Upgrade HTTP connections to WebSocket for terminal paths
  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    const match = url.match(/^\/ws\/terminal\/([^/?]+)/);
    if (!match) return; // Not a terminal request — ignore (other WS handlers may own it)

    // SECURITY: validate BEFORE handleUpgrade so no shell is ever spawned for an
    // unauthenticated or cross-origin request. Origin is checked first so a
    // hostile cross-site page cannot probe token validity.
    if (!isAllowedOrigin(req)) {
      return rejectUpgrade(socket, 403, `disallowed origin: ${req.headers.origin}`);
    }
    if (!authenticateUpgrade(req)) {
      return rejectUpgrade(socket, 401, "missing or invalid auth token");
    }

    wss.handleUpgrade(req, socket as any, head, (ws: any) => {
      wss.emit("connection", ws, req, match[1]);
    });
  });

  wss.on("connection", (ws: any, req: http.IncomingMessage, sessionId: string) => {
    handleTerminalConnection(ws, sessionId);
  });

  console.log("[Terminal] WebSocket server initialized at /ws/terminal/:sessionId");
}

function handleTerminalConnection(ws: any, sessionId: string): void {
  // Look up session info from pendingSessions (created via POST /terminal/sessions)
  const pending = pendingSessions.get(sessionId);

  let projectId: number;
  let sessionCwd: string;

  if (pending) {
    projectId = pending.projectId;
    sessionCwd = pending.cwd;
    pendingSessions.delete(sessionId);
  } else {
    // Fallback: parse project ID from session ID format term-{projectId}-{timestamp}
    const match = sessionId.match(/^term-(\d+)-/);
    if (!match) {
      ws.send(JSON.stringify({ type: "error", message: `Invalid session ID: ${sessionId}` }));
      ws.close();
      return;
    }
    projectId = parseInt(match[1]);
    const project = projectStore.getById(projectId);
    if (!project) {
      ws.send(JSON.stringify({ type: "error", message: `Project ${projectId} not found` }));
      ws.close();
      return;
    }
    sessionCwd = project.path;
  }

  const project = projectStore.getById(projectId);
  const projectName = project?.name || `project-${projectId}`;

  console.log(`[Terminal] New connection: sessionId=${sessionId}, project=${projectName}, cwd=${sessionCwd}`);

  // Try to use node-pty for full PTY support; fall back to spawn
  let proc: any;
  let isPty = false;

  try {
    // Dynamic require for optional node-pty
    const pty = require("node-pty");
    proc = pty.spawn("bash", [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: sessionCwd,
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });
    isPty = true;
    console.log(`[Terminal] Using node-pty for session ${sessionId}`);
  } catch {
    // Fallback: use spawn with pipes
    proc = spawn("bash", [], {
      cwd: sessionCwd,
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
        TERM: "xterm-256color",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`[Terminal] Using spawn (no PTY) for session ${sessionId}`);
  }

  // Store session
  const session: TerminalSession = {
    sessionId,
    projectId,
    cwd: sessionCwd,
    ws,
    process: proc,
    createdAt: new Date().toISOString(),
  };
  activeSessions.set(sessionId, session);

  // Notify client that session is ready
  ws.send(JSON.stringify({ type: "ready", sessionId, projectPath: sessionCwd, isPty }));

  // Route process output → WebSocket
  if (isPty) {
    proc.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode }));
        ws.close();
      }
      cleanupSession(sessionId, projectId);
    });
  } else {
    proc.stdout?.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data: data.toString() }));
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data: data.toString() }));
      }
    });

    proc.on("close", (code: number | null) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", exitCode: code }));
        ws.close();
      }
      cleanupSession(sessionId, projectId);
    });

    proc.on("error", (err: Error) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
        ws.close();
      }
      cleanupSession(sessionId, projectId);
    });
  }

  // Route WebSocket messages → process stdin
  ws.on("message", (rawMessage: Buffer | string) => {
    let msg: any;
    try {
      msg = JSON.parse(rawMessage.toString());
    } catch {
      // Raw input — send directly to stdin
      try {
        if (isPty) proc.write(rawMessage.toString());
        else proc.stdin?.write(rawMessage.toString());
      } catch { /* process may be dead */ }
      return;
    }

    switch (msg.type) {
      case "input":
        try {
          if (isPty) proc.write(msg.data);
          else proc.stdin?.write(msg.data);
        } catch { /* process dead */ }
        break;

      case "resize":
        if (isPty && typeof msg.cols === "number" && typeof msg.rows === "number") {
          try { proc.resize(msg.cols, msg.rows); } catch { /* ignore */ }
        }
        break;

      case "kill":
        try {
          if (isPty) proc.kill();
          else proc.kill("SIGTERM");
        } catch { /* ignore */ }
        break;
    }
  });

  // Cleanup on WebSocket close
  ws.on("close", () => {
    console.log(`[Terminal] WebSocket closed for session ${sessionId}`);
    try {
      if (isPty) proc.kill();
      else proc.kill("SIGTERM");
    } catch { /* already dead */ }
    cleanupSession(sessionId, projectId);
  });

  ws.on("error", (err: any) => {
    console.warn(`[Terminal] WebSocket error for session ${sessionId}:`, err.message);
  });
}

function cleanupSession(sessionId: string, projectId: number): void {
  activeSessions.delete(sessionId);
  sessionsByProject.get(projectId)?.delete(sessionId);
}
