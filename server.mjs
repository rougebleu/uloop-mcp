#!/usr/bin/env node
// uloop-mcp v0.3 - MCP server that AUTO-GENERATES its tool list from the live Unity tool
// definitions ('uloop list' inside the target project). No curated option tables to
// maintain: schemas always match the installed Unity CLI Loop version. Executes via the
// native uloop dispatcher (dispatcher -> project runner -> named pipe -> Unity Editor).
// No MCP SDK needed: stdio transport = newline-delimited JSON-RPC 2.0.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WIN = process.platform === "win32";
const DEBUG = !!process.env.ULOOP_DEBUG;
const PROJECT_DIR = process.env.ULOOP_PROJECT_DIR || process.cwd();
const TIMEOUT_MS = Number(process.env.ULOOP_TIMEOUT_MS || 240000);
const LIST_TTL_MS = 30000;
const VERSION = "0.3.0";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const LATEST_PROTOCOL = "2025-06-18";

function dbg(...a) { if (DEBUG) console.error("[uloop-mcp]", ...a); }

// v3 CLI is the native dispatcher installed by the official install.ps1.
function cliTarget() {
  const local = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
  const nativePath = path.join(local, "Programs", "uloop", "bin", "uloop.exe");
  for (const c of [{ path: process.env.ULOOP_CLI }, { path: nativePath }]) {
    if (c.path && existsSync(c.path)) return { path: c.path, isNode: /\.[cm]?js$/i.test(c.path) };
  }
  return { path: process.env.ULOOP || "uloop", isNode: false };
}

function runUloop(args) {
  return new Promise((resolve) => {
    const target = cliTarget();
    let child;
    try {
      const opts = { cwd: PROJECT_DIR, windowsHide: true, env: process.env };
      child = target.isNode
        ? spawn(process.execPath, [target.path, ...args], opts)
        : spawn(target.path, args, { ...opts, shell: false });
    } catch (err) {
      return resolve({ ok: false, stdout: "", stderr: String((err && err.message) || err), code: -1 });
    }
    let out = ""; let errOut = ""; let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, stdout: out, stderr: errOut + "\n[uloop-mcp] timed out after " + TIMEOUT_MS + "ms", code: -2 }); }
    }, TIMEOUT_MS);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { errOut += c; });
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, stdout: out, stderr: String(e.message || e), code: -1 }); } });
    child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, stdout: out, stderr: errOut, code: code === null ? -3 : code }); } });
  });
}

// ---- Live tool discovery: parse 'uloop list' JSON ----------------
// Each entry: { Name, Description, Options: [{ Name: '--flag', Type, Default?, Values? }] }.
const cache = { tools: null, error: null, at: 0 };

async function fetchToolList() {
  const res = await runUloop(["list"]);
  if (!res.ok || !res.stdout) return null;
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { return null; }
  return parsed && Array.isArray(parsed.Tools) ? parsed.Tools : null;
}

async function getTools(force) {
  const now = Date.now();
  const staleError = cache.error && now - cache.at > LIST_TTL_MS;
  if (force || !cache.tools || staleError) {
    const fresh = await fetchToolList();
    cache.at = now;
    if (fresh) { cache.tools = fresh; cache.error = null; dbg("discovered", fresh.length, "tools"); }
    else if (!cache.tools) cache.error = "Could not fetch 'uloop list'. Is the Unity project running and uloop installed? (" + PROJECT_DIR + ")";
  }
  return cache.tools || [];
}

function toolName(display) { return "unity_" + display.replace(/-/g, "_"); }
function propName(flag) { return flag.replace(/^--/, "").replace(/-/g, "_"); }
function jsonType(t) {
  if (t === "boolean") return "boolean";
  if (t === "number" || t === "integer") return "number";
  if (t === "array") return "array";
  if (t === "object") return "object";
  return "string";
}

function toMCP(tool) {
  const properties = {};
  const opts = Array.isArray(tool.Options) ? tool.Options : [];
  const spec = [];
  for (const o of opts) {
    const flag = typeof o.Name === "string" ? o.Name : "";
    if (!flag) continue;
    const key = propName(flag);
    const type = jsonType(o.Type);
    const schemaProp = { type, description: o.Description || "" };
    if (Array.isArray(o.Values) && o.Values.length) schemaProp.enum = o.Values;
    if (type === "array") schemaProp.items = { type: "string" };
    if (o.Default !== undefined && o.Default !== null) schemaProp.default = o.Default;
    properties[key] = schemaProp;
    spec.push({ flag, key, type });
  }
  const cmd = tool.Name;
  return {
    name: toolName(cmd),
    cmd,
    description: (tool.Description || ("Unity CLI Loop tool: " + cmd)) + " | CLI: uloop " + cmd + " (auto-generated from the live tool list)",
    spec,
    schema: { type: "object", properties, additionalProperties: false },
  };
}

function buildArgv(tool, args) {
  const out = [tool.cmd];
  for (const s of tool.spec) {
    const v = args[s.key];
    if (v === undefined || v === null || v === "") continue;
    if (s.type === "boolean") { if (v === true) out.push(s.flag); continue; }
    if (s.type === "array") {
      const arr = Array.isArray(v) ? v : String(v).split(",");
      const clean = arr.map((x) => String(x).trim()).filter(Boolean);
      if (clean.length) out.push(s.flag, clean.join(","));
      continue;
    }
    if (s.type === "object") {
      out.push(s.flag, typeof v === "string" ? v : JSON.stringify(v));
      continue;
    }
    out.push(s.flag, String(v));
  }
  return out;
}

// Generic escape hatch (always available, even when Unity is unreachable).
const RUN_TOOL = {
  name: "unity_run",
  cmd: null,
  description: "Escape hatch: run any raw uloop command not exposed above (native dispatcher commands like focus-window, pause-point-status, await-pause-point, launch, or Unity tools without parameters). | CLI: uloop <command> [args...]",
  spec: null,
  schema: { type: "object", properties: { command: { type: "string", description: "uloop command name" }, args: { type: "array", items: { type: "string" }, description: "Raw CLI arguments" } }, additionalProperties: false },
  required: ["command"],
};

// ---- JSON-RPC plumbing ----
function respond(id, result) { writeMsg({ jsonrpc: "2.0", id, result }); }
function respondError(id, code, message) { writeMsg({ jsonrpc: "2.0", id, error: { code, message } }); }
function writeMsg(m) { process.stdout.write(JSON.stringify(m) + "\n"); }

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (id === undefined) { dbg("notification:", method); return; }
  switch (method) {
    case "initialize": {
      const wanted = params && params.protocolVersion;
      respond(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(wanted) ? wanted : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "uloop-mcp", version: VERSION },
      });
      return;
    }
    case "ping": respond(id, {}); return;
    case "tools/list": {
      const live = await getTools(false);
      const tools = live.map(toMCP);
      tools.push(RUN_TOOL);
      respond(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
      return;
    }
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (name === RUN_TOOL.name) {
        const argv = [String(args.command || ""), ...(Array.isArray(args.args) ? args.args.map(String) : [])];
        if (!argv[0]) return respondError(id, -32602, "unity_run requires command");
        const res = await runUloop(argv);
        const parts = [];
        if ((res.stdout || "").trim()) parts.push({ type: "text", text: res.stdout.trim() });
        if ((res.stderr || "").trim()) parts.push({ type: "text", text: "--- stderr ---\n" + res.stderr.trim() });
        if (!parts.length) parts.push({ type: "text", text: "(no output)" });
        respond(id, { content: parts, isError: !res.ok });
        return;
      }
      const live = await getTools(false);
      const found = live.find((t) => toolName(t.Name) === name);
      if (!found) return respondError(id, -32602, "Unknown tool: " + name + (cache.error ? " (" + cache.error + ")" : ""));
      const tool = toMCP(found);
      let argv;
      try { argv = buildArgv(tool, args); } catch (err) { return respondError(id, -32602, "Bad arguments: " + (err.message || err)); }
      dbg("call", name, "->", "uloop", argv.join(" "), "in", PROJECT_DIR);
      const res = await runUloop(argv);
      const parts = [];
      if ((res.stdout || "").trim()) parts.push({ type: "text", text: res.stdout.trim() });
      if ((res.stderr || "").trim()) parts.push({ type: "text", text: "--- stderr ---\n" + res.stderr.trim() });
      if (!parts.length) parts.push({ type: "text", text: "(no output)" });
      respond(id, { content: parts, isError: !res.ok });
      return;
    }
    default:
      respondError(id, -32601, "Method not found: " + method);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handleRequest(msg).catch((err) => { if (msg && msg.id !== undefined) respondError(msg.id, -32603, String((err && err.message) || err)); });
});
rl.on("close", () => process.exit(0));
dbg("uloop-mcp v" + VERSION, "| project dir:", PROJECT_DIR, "| cli:", JSON.stringify(cliTarget()));