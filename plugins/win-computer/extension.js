"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

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

module.exports = function winComputer(pi) {
  pi.registerCommand("win-computer", {
    description: "Connect this OMP session to a remote Windows desktop MCP host",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "help";
      if (sub === "connect") {
        const url = parts[1];
        const token = parts[2];
        if (!url || !token) {
          ctx.ui.notify("Usage: /win-computer connect <url> <token>", "error");
          return;
        }
        const p = merge(url, token);
        ctx.ui.notify(`Wrote ${p}. Run /mcp reload.`, "info");
        return;
      }
      ctx.ui.notify(
        "Drive a Windows host with mcp__win_computer_* (not local computer.*). /win-computer connect <url> <token> then /mcp reload. Host: node bin/win-computer.cjs host install",
        "info",
      );
    },
  });
};
