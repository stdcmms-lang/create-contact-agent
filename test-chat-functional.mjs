#!/usr/bin/env node
/**
 * Standalone functional smoke test: chat with an agent over a Unix socket.
 *
 * Protocol (one message per line):
 *   client → server: {"query": "..."}\n
 *   server → client: {"reply": "..."}\n
 *
 * Usage:
 *   node test-chat-functional.mjs
 *   SOCKET_PATH=/tmp/agent.sock node test-chat-functional.mjs
 *
 * Env vars:
 *   SOCKET_PATH    Unix socket path the agent listens on (default /tmp/agent.sock)
 *   SERVICE_CMD    Command to launch the service (default: "node dist/index.js")
 *   AGENT_CMD      Command to launch the agent (default: "./start-agent")
 *   PORT           Port for the spawned service (default 3000)
 *   TIMEOUT_MS     Per-turn socket reply timeout (default 30000)
 */

import net from "node:net";
import { spawn } from "node:child_process";
import { createTestResults } from "./test-results.mjs";

const SOCKET_PATH = process.env.SOCKET_PATH ?? "/tmp/agent.sock";
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const SERVICE_CMD = (process.env.SERVICE_CMD ?? "node dist/index.js").split(/\s+/);
const AGENT_CMD = (process.env.AGENT_CMD ?? "./start-agent").split(/\s+/);
const PORT = process.env.PORT ?? "3000";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30_000);

const testResults = createTestResults("test-chat-functional.mjs", BASE_URL);

const COLOR = process.stdout.isTTY;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c("2", s);

const QUESTIONS = [
  "hello",
  "what can you do?",
  "what's the weather like today?",
  "tell me a short joke",
  "goodbye",
];

// ---------------------------------------------------------------------------
// Service subprocess
// ---------------------------------------------------------------------------

let serviceProc = null;
let agentProc = null;

function startService() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT };
    const [cmd, ...args] = SERVICE_CMD;
    serviceProc = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let ready = false;
    const onLine = (line) => {
      if (!line) {return;}
      let parsed;
      try { parsed = JSON.parse(line); } catch { return; }
      if (!parsed || typeof parsed !== "object") {return;}
      if (parsed.type === "server.listening" && !ready) { ready = true; resolve(); }
    };
    serviceProc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) {break;}
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    serviceProc.stderr.on("data", (chunk) => {
      process.stderr.write(dim(`[svc] ${chunk}`));
    });
    serviceProc.on("exit", (code) => {
      if (!ready) {reject(new Error(`service exited before ready (code ${code})`));}
    });
    setTimeout(() => {
      if (!ready) {reject(new Error("service did not become ready in 10s"));}
    }, 10_000).unref();
  });
}

function stopService() {
  if (serviceProc && !serviceProc.killed) {
    try { serviceProc.kill("SIGTERM"); } catch {}
  }
}

function startAgent() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SOCKET_PATH };
    const [cmd, ...args] = AGENT_CMD;
    agentProc = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let ready = false;
    agentProc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) {break;}
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) {continue;}
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (!parsed || typeof parsed !== "object") {continue;}
        if (parsed.type === "agent.listening" && !ready) { ready = true; resolve(); }
      }
    });
    agentProc.stderr.on("data", (chunk) => {
      process.stderr.write(dim(`[agent] ${chunk}`));
    });
    agentProc.on("exit", (code) => {
      if (!ready) {reject(new Error(`agent exited before ready (code ${code})`));}
    });
    setTimeout(() => {
      if (!ready) {reject(new Error("agent did not become ready in 15s"));}
    }, 15_000).unref();
  });
}

function stopAgent() {
  if (agentProc && !agentProc.killed) {
    try { agentProc.kill("SIGTERM"); } catch {}
  }
}

// ---------------------------------------------------------------------------

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

function ask(sock, query, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) {return;}
      const line = buf.slice(0, nl);
      cleanup();
      try {
        const msg = JSON.parse(line);
        resolve(typeof msg.reply === "string" ? msg.reply : line);
      } catch {
        resolve(line);
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout after ${timeoutMs}ms waiting for reply to ${JSON.stringify(query)}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("error", onError);
    };
    sock.on("data", onData);
    sock.on("error", onError);
    sock.write(JSON.stringify({ query }) + "\n");
  });
}

async function main() {
  testResults.installIsolation();
  console.log(`Starting service: ${SERVICE_CMD.join(" ")} (PORT=${PORT})`);
  await startService();
  console.log(`Service ready.`);
  console.log(`Starting agent: ${AGENT_CMD.join(" ")}`);
  await startAgent();
  console.log(`Agent ready. Connecting to ${SOCKET_PATH}`);
  const sock = await connect(SOCKET_PATH);
  console.log("Connected.\n");

  let failed = 0;
  for (const q of QUESTIONS) {
    console.log("---------------------------------------------------------");
    console.log(`>>> ${q}`);
    testResults.beginCase(q);
    const caseStart = performance.now();
    let runError;
    let emptyReply = false;
    try {
      const reply = await ask(sock, q, TIMEOUT_MS);
      console.log(`<<< ${reply}`);
      if (!reply || !reply.trim()) {
        console.log("    [FAIL] empty reply");
        emptyReply = true;
      }
    } catch (err) {
      runError = err;
    }
    const asyncErrors = testResults.endCase();
    const errors = [
      runError,
      ...(emptyReply ? [new Error("empty reply")] : []),
      ...asyncErrors,
    ].filter((e) => e !== undefined);
    const durationMs = Math.round(performance.now() - caseStart);
    if (errors.length === 0) {
      testResults.recordCase({ name: q, status: "pass", durationMs });
    } else {
      failed += 1;
      const msg = errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("\n");
      if (runError) {console.log(`    [FAIL] ${runError.message}`);}
      testResults.recordCase({ name: q, status: "fail", error: msg, durationMs });
    }
  }

  sock.end();
  console.log("---------------------------------------------------------");
  const passed = QUESTIONS.length - failed;
  console.log(failed === 0 ? `OK: ${QUESTIONS.length} queries` : `FAILED: ${failed}/${QUESTIONS.length}`);
  const exitCode = failed === 0 ? 0 : 1;
  await testResults.finalize({ passed, failed, exitCode });
  stopAgent();
  stopService();
  process.exit(exitCode);
}

process.on("SIGINT", () => { stopAgent(); stopService(); process.exit(130); });
process.on("SIGTERM", () => { stopAgent(); stopService(); process.exit(143); });

main().catch(async (err) => {
  console.error("Fatal:", err.message);
  await testResults.finalize({ passed: 0, failed: 0, exitCode: 2, fatal: err });
  stopAgent();
  stopService();
  process.exit(2);
});
