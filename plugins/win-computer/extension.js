"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const lib = require("./host/lib.cjs");

function mcpPath() {
  return path.join(os.homedir(), ".omp", "agent", "mcp.json");
}

function merge(url, token) {
  const p = mcpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let doc = {
    $schema: "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
    mcpServers: {},
  };
  if (fs.existsSync(p)) doc = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!doc.mcpServers || typeof doc.mcpServers !== "object") doc.mcpServers = {};
  doc.mcpServers["win-computer"] = {
    type: "http",
    url,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 120000,
  };
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
  return p;
}

function runHostInstall() {
  return new Promise((resolve, reject) => {
    let node;
    try {
      node = lib.nodePath();
    } catch (err) {
      reject(err);
      return;
    }
    const cli = path.join(__dirname, "bin", "win-computer.cjs");
    const child = spawn(node, [cli, "host", "install"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(out.trim() || `host install exit ${code}`));
      else resolve(out);
    });
  });
}

module.exports = function winComputer(pi) {
  pi.registerCommand("win-computer", {
    description: "Set up or join a remote Windows desktop over MCP",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "help";

      if (sub === "host") {
        if (process.platform !== "win32") {
          ctx.ui.notify("/win-computer host is Windows-only", "error");
          return;
        }
        ctx.ui.notify("Running host install. Watch this terminal for a UAC prompt.", "info");
        try {
          const out = await runHostInstall();
          pi.sendMessage({ customType: "win-computer-host", content: out, display: true }, { triggerTurn: false });
        } catch (err) {
          ctx.ui.notify(String(err.message || err), "error");
        }
        return;
      }

      if (sub === "join") {
        const joinUrl = parts[1];
        if (!joinUrl) {
          ctx.ui.notify("Usage: /win-computer join <url from the Windows host>", "error");
          return;
        }
        ctx.ui.notify("Fetching join URL (one-time ticket).", "info");
        try {
          const res = await fetch(joinUrl);
          const text = await res.text();
          if (!res.ok) throw new Error(`${res.status} ${text}`);
          const body = JSON.parse(text);
          const mcp = body.mcp;
          if (!mcp || !mcp.url || !mcp.headers || !mcp.headers.Authorization) {
            throw new Error("join payload missing mcp url/token");
          }
          const token = String(mcp.headers.Authorization).replace(/^Bearer\s+/i, "");
          const p = merge(mcp.url, token);
          ctx.ui.notify(`Wrote ${p}. Run /mcp reload, then mcp__win_computer_capabilities.`, "info");
        } catch (err) {
          ctx.ui.notify(String(err.message || err), "error");
        }
        return;
      }

      if (sub === "connect") {
        const url = parts[1];
        const token = parts[2];
        if (!url || !token) {
          ctx.ui.notify("Recovery: /win-computer connect <mcp-url> <token>", "error");
          return;
        }
        const p = merge(url, token);
        ctx.ui.notify(`Wrote ${p}. Run /mcp reload.`, "info");
        return;
      }

      ctx.ui.notify(
        "Windows: /win-computer host. Other machine: /win-computer join <url>. Then /mcp reload. Not local computer.*",
        "info",
      );
    },
  });
};
