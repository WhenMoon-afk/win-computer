"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const lib = require("./lib.cjs");

const { host: HOST, port: PORT } = lib.resolvedListen();
const PROTOCOL = "2025-11-25";
const TOKEN = lib.readToken();
const NATIVES = lib.findNatives();

const addon = require(NATIVES);
try {
  addon.__ompInstallTokioRuntime?.();
} catch {
  /* older addons */
}

let session = new addon.DesktopSession();

function resetSession() {
  try {
    session.close?.();
  } catch {
    /* ignore */
  }
  session = new addon.DesktopSession();
}

function jsonClone(value) {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (v instanceof Uint8Array || Buffer.isBuffer(v)) return { $bytes: v.length };
      return v;
    }),
  );
}

function compactEl(el) {
  if (!el || typeof el !== "object") return el;
  const out = {
    ref: el.ref,
    role: el.role,
    nativeRole: el.nativeRole,
    title: el.title,
    description: el.description,
    value: el.value,
    enabled: el.enabled,
    focused: el.focused,
    childCount: el.childCount,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    actions: el.actions,
  };
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

function filterWindows(windows, args) {
  const app = String(args.app || "").toLowerCase();
  const title = String(args.title || "").toLowerCase();
  return windows.filter((w) => {
    if (app && !String(w.app || "").toLowerCase().includes(app)) return false;
    if (title && !String(w.title || "").toLowerCase().includes(title)) return false;
    return true;
  });
}

function splitChord(chord) {
  if (Array.isArray(chord)) return chord.map(String);
  return String(chord)
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePoints(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("drag requires at least two points");
  }
  return points.map((p) => {
    if (Array.isArray(p) && p.length >= 2) return { x: Number(p[0]), y: Number(p[1]) };
    if (p && typeof p === "object") return { x: Number(p.x), y: Number(p.y) };
    throw new Error("each drag point needs x,y");
  });
}

async function clipboardRead() {
  return await new Promise((resolve, reject) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
      windowsHide: true,
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(err.trim() || `clipboard read exit ${code}`));
      else resolve(out.replace(/\r\n/g, "\n"));
    });
  });
}

function textResult(obj) {
  return {
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
  };
}

async function capturePng(target, maxWidth, maxHeight) {
  const opts = {};
  if (maxWidth) opts.maxWidth = Number(maxWidth);
  if (maxHeight) opts.maxHeight = Number(maxHeight);
  const cap = Object.keys(opts).length ? await session.capture(target, opts) : await session.capture(target);
  const png = Buffer.from(cap.data);
  const meta = {
    target: cap.target,
    width: cap.width,
    height: cap.height,
    sourceWidth: cap.sourceWidth,
    sourceHeight: cap.sourceHeight,
    backend: cap.backend,
    note: "click/move/scroll/drag x,y are pixels of THIS screenshot for the same target",
  };
  return {
    content: [
      { type: "text", text: JSON.stringify(meta, null, 2) },
      { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    ],
  };
}

const TOOLS = [
  {
    name: "capabilities",
    description: "Windows host desktop capabilities (capture/input/AX/permissions).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "windows",
    description: "List visible Windows windows. Filter with optional app/title substrings.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "Case-insensitive app substring" },
        title: { type: "string", description: "Case-insensitive title substring" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "displays",
    description: "List displays on the Windows host.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "screenshot",
    description:
      "Capture the Windows desktop or a window. target is 'desktop' or a window id from windows. Pixel coordinates for later click/move/scroll/drag MUST use this capture of the same target.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "'desktop' or window id", default: "desktop" },
        maxWidth: { type: "number" },
        maxHeight: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click at screenshot-pixel coordinates of target. Screenshot that target first.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", default: "desktop" },
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        count: { type: "number", default: 1 },
        delivery: { type: "string", enum: ["background", "foreground"], default: "background" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "move",
    description: "Move pointer to screenshot-pixel coordinates of target.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", default: "desktop" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "drag",
    description: "Drag along screenshot-pixel points of target.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", default: "desktop" },
        points: {
          type: "array",
          minItems: 2,
          items: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"],
          },
        },
        delivery: { type: "string", enum: ["background", "foreground"], default: "background" },
      },
      required: ["points"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll at screenshot-pixel coordinates. dy>0 scrolls down.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", default: "desktop" },
        x: { type: "number" },
        y: { type: "number" },
        dx: { type: "number", default: 0 },
        dy: { type: "number", default: 1 },
        delivery: { type: "string", enum: ["background", "foreground"], default: "background" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description: "Type text into the target. Prefer AX setValue when a focused field exists.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", default: "desktop" },
        text: { type: "string" },
        delivery: { type: "string", enum: ["background", "foreground"], default: "background" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Press a key chord on the target, e.g. 'ctrl+c' or 'enter'.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", default: "desktop" },
        chord: { type: "string", description: "Keys joined with +, e.g. ctrl+shift+p" },
        delivery: { type: "string", enum: ["background", "foreground"], default: "background" },
      },
      required: ["chord"],
      additionalProperties: false,
    },
  },
  {
    name: "raise",
    description: "Foreground a window by id from windows.",
    inputSchema: {
      type: "object",
      properties: { windowId: { type: "string" } },
      required: ["windowId"],
      additionalProperties: false,
    },
  },
  {
    name: "ax",
    description:
      "Accessibility tree for a window. Prefer this over pixels. Returns [ref=eN] nodes. Refs expire after the next snapshot of that window.",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string" },
        maxDepth: { type: "number" },
        all: { type: "boolean", default: false },
      },
      required: ["windowId"],
      additionalProperties: false,
    },
  },
  {
    name: "ax_find",
    description: "Find AX nodes in a window. Take ax() first so refs are fresh.",
    inputSchema: {
      type: "object",
      properties: {
        windowId: { type: "string" },
        role: { type: "string" },
        title: { type: "string" },
        value: { type: "string" },
        limit: { type: "number" },
      },
      required: ["windowId"],
      additionalProperties: false,
    },
  },
  {
    name: "ax_action",
    description: "Act on an AX ref from ax()/ax_find()/element_at/focused_element.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        action: {
          type: "string",
          enum: ["press", "click", "focus", "setValue", "perform", "node", "children", "parent", "attributes"],
        },
        value: { type: "string", description: "For setValue" },
        perform: { type: "string", description: "Named AX action for perform, e.g. invoke" },
      },
      required: ["ref", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "element_at",
    description: "AX element at global desktop coordinates (not screenshot pixels).",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "focused_element",
    description: "Currently focused AX element on the Windows desktop.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "clipboard_read",
    description: "Read Windows clipboard text.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "clipboard_write",
    description: "Write Windows clipboard text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

async function callTool(name, args) {
  args = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const target = String(args.target || "desktop");
  const delivery = args.delivery || "background";

  switch (name) {
    case "capabilities":
      return textResult(jsonClone(session.capabilities));
    case "windows":
      return textResult(filterWindows(await session.listWindows(), args));
    case "displays":
      return textResult(await session.listDisplays());
    case "screenshot":
      return await capturePng(target, args.maxWidth, args.maxHeight);
    case "click":
      await session.click(target, Number(args.x), Number(args.y), {
        button: args.button || "left",
        count: args.count || 1,
        delivery,
      });
      return textResult({ ok: true, target, x: args.x, y: args.y });
    case "move":
      await session.moveMouse(target, Number(args.x), Number(args.y));
      return textResult({ ok: true, target, x: args.x, y: args.y });
    case "drag":
      await session.drag(target, parsePoints(args.points), { delivery });
      return textResult({ ok: true, target, points: args.points });
    case "scroll":
      await session.scroll(
        target,
        Number(args.x),
        Number(args.y),
        Number(args.dx || 0),
        Number(args.dy == null ? 1 : args.dy),
      );
      return textResult({
        ok: true,
        target,
        x: args.x,
        y: args.y,
        dx: args.dx || 0,
        dy: args.dy == null ? 1 : args.dy,
      });
    case "type":
      try {
        await session.typeText(target, String(args.text), { delivery });
      } catch {
        await session.typeText(target, String(args.text));
      }
      return textResult({ ok: true, target, n: String(args.text).length });
    case "press":
      await session.keyChord(target, splitChord(args.chord));
      return textResult({ ok: true, target, chord: splitChord(args.chord) });
    case "raise":
      await session.raiseWindow(String(args.windowId));
      return textResult({ ok: true, windowId: args.windowId });
    case "ax": {
      const opts = {};
      if (args.maxDepth != null) opts.maxDepth = Number(args.maxDepth);
      if (args.all) opts.all = true;
      const snap =
        Object.keys(opts).length > 0
          ? await session.axSnapshot(String(args.windowId), opts)
          : await session.axSnapshot(String(args.windowId));
      return textResult({
        windowId: args.windowId,
        nodeCount: snap.nodeCount,
        truncated: snap.truncated,
        text: snap.text,
      });
    }
    case "ax_find": {
      const q = {};
      if (args.role) q.role = String(args.role);
      if (args.title) q.title = String(args.title);
      if (args.value) q.value = String(args.value);
      if (args.limit != null) q.limit = Number(args.limit);
      const found = await session.axQuery(String(args.windowId), q);
      return textResult((found || []).map(compactEl));
    }
    case "ax_action": {
      const ref = String(args.ref);
      switch (args.action) {
        case "press":
          await session.axPerform(ref, "press");
          return textResult({ ok: true, ref, action: "press" });
        case "click":
          await session.axClick(ref);
          return textResult({ ok: true, ref, action: "click" });
        case "focus":
          await session.axFocus(ref);
          return textResult({ ok: true, ref, action: "focus" });
        case "setValue":
          await session.axSetValue(ref, String(args.value ?? ""));
          return textResult({ ok: true, ref, action: "setValue" });
        case "perform":
          await session.axPerform(ref, String(args.perform || "press"));
          return textResult({ ok: true, ref, action: args.perform || "press" });
        case "node":
          return textResult(compactEl(await session.axNode(ref)));
        case "children":
          return textResult((await session.axChildren(ref)).map(compactEl));
        case "parent":
          return textResult(compactEl(await session.axParent(ref)));
        case "attributes":
          return textResult(await session.axAttributes(ref));
        default:
          throw new Error(`unknown ax action: ${args.action}`);
      }
    }
    case "element_at":
      return textResult(compactEl(await session.axElementAt(Number(args.x), Number(args.y))));
    case "focused_element":
      return textResult(compactEl(await session.axFocused()));
    case "clipboard_read":
      return textResult(await clipboardRead());
    case "clipboard_write":
      await addon.copyToClipboard(String(args.text));
      return textResult({ ok: true, n: String(args.text).length });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const mcpSessions = new Map();

function newSessionId() {
  return crypto.randomUUID();
}

function authorized(req) {
  const h = req.headers.authorization || "";
  if (h === `Bearer ${TOKEN}`) return true;
  const alt = req.headers["x-computer-token"];
  return alt === TOKEN;
}

function sendJson(res, status, body, extraHeaders) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(data);
}

function sendSseMessage(res, body, extraHeaders, status = 200) {
  const data = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  res.writeHead(status, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    ...extraHeaders,
  });
  res.end(data);
}

function wantsSse(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/event-stream") && !accept.includes("application/json");
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

async function handleRpc(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;
  const isNotif = id === undefined;

  try {
    if (method === "initialize") {
      const pv = params?.protocolVersion || PROTOCOL;
      return rpcResult(id, {
        protocolVersion: pv,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "win-computer", version: lib.VERSION },
        instructions:
          "Remote Windows desktop MCP. Call tools by name (capabilities, windows, screenshot, ax, …). Prefer ax/ax_find/ax_action over screenshots. Screenshot a target before click/move/scroll/drag. Coordinates are screenshot pixels of that target, not AX global bounds. Do not use local eval computer.* on the client.",
      });
    }
    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return { _notification: true };
    }
    if (method === "ping") return rpcResult(id, {});
    if (method === "tools/list") return rpcResult(id, { tools: TOOLS });
    if (method === "tools/call") {
      const name = params?.name;
      if (!TOOL_MAP.has(name)) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        });
      }
      try {
        const result = await callTool(name, params?.arguments || {});
        return rpcResult(id, result);
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: "text", text: String(err?.message || err) }],
          isError: true,
        });
      }
    }
    if (method === "resources/list") return rpcResult(id, { resources: [] });
    if (method === "resources/templates/list") return rpcResult(id, { resourceTemplates: [] });
    if (method === "prompts/list") return rpcResult(id, { prompts: [] });
    if (isNotif) return { _notification: true };
    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (isNotif) return { _notification: true };
    return rpcError(id, -32603, String(err?.message || err));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 32 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        version: lib.VERSION,
        host: HOST,
        port: PORT,
        hostname: require("os").hostname(),
        backend: session.capabilities?.backend,
        capture: session.capabilities?.capture,
        input: session.capabilities?.input,
        ax: session.capabilities?.ax,
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/join/")) {
      const id = url.pathname.slice("/join/".length);
      const ticket = lib.consumeJoinTicket(id);
      if (!ticket) {
        sendJson(res, 404, { error: "join link expired or invalid" });
        return;
      }
      const origin = `http://${req.headers.host || "127.0.0.1:" + PORT}`;
      sendJson(res, 200, {
        ok: true,
        mcp: {
          type: "http",
          url: `${origin}/mcp`,
          headers: { Authorization: `Bearer ${TOKEN}` },
          timeout: 120000,
        },
      });
      return;
    }


    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (!authorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET") {
      const sid = req.headers["mcp-session-id"];
      if (sid && !mcpSessions.has(sid)) {
        sendJson(res, 404, { error: "unknown session" });
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...(sid ? { "mcp-session-id": sid } : {}),
      });
      res.write(": ok\n\n");
      const iv = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          clearInterval(iv);
        }
      }, 15000);
      req.on("close", () => clearInterval(iv));
      return;
    }

    if (req.method === "DELETE") {
      const sid = req.headers["mcp-session-id"];
      if (sid) mcpSessions.delete(sid);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    const raw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(raw || "null");
    } catch {
      sendJson(res, 400, rpcError(null, -32700, "Parse error"));
      return;
    }

    const batch = Array.isArray(payload);
    const messages = batch ? payload : [payload];
    const headers = {};
    const firstMethod = messages[0]?.method;
    if (firstMethod === "initialize") {
      const sid = newSessionId();
      mcpSessions.set(sid, { created: Date.now() });
      headers["mcp-session-id"] = sid;
    } else {
      const sid = req.headers["mcp-session-id"];
      if (sid) {
        if (!mcpSessions.has(sid)) mcpSessions.set(sid, { created: Date.now() });
        headers["mcp-session-id"] = sid;
      }
    }

    const results = [];
    for (const msg of messages) {
      const out = await handleRpc(msg);
      if (!out?._notification) results.push(out);
    }

    if (results.length === 0) {
      res.writeHead(202, headers);
      res.end();
      return;
    }

    const body = batch ? results : results[0];
    if (wantsSse(req)) sendSseMessage(res, body, headers);
    else sendJson(res, 200, body, headers);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
    else res.end();
  }
});

server.on("error", (err) => {
  console.error("listen error", err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`win-computer mcp ${lib.VERSION} listening on http://${HOST}:${PORT}/mcp natives=${NATIVES}`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    resetSession();
    process.exit(0);
  });
});
process.on("SIGINT", () => {
  server.close(() => {
    resetSession();
    process.exit(0);
  });
});
