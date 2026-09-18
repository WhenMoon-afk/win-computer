"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { execFileSync, spawnSync } = require("child_process");

const VERSION = "0.0.3";
function joinStatePath() {
  return path.join(stateDir(), "join.json");
}

function newJoinTicket() {
  const id = crypto.randomBytes(24).toString("base64url");
  const ticket = { id, exp: Date.now() + 2 * 60 * 1000 };
  ensureDir(stateDir());
  fs.writeFileSync(joinStatePath(), JSON.stringify(ticket) + "\n");
  return ticket;
}

function isTailscaleAddr(ip) {
  const v4 = ip.match(/^100\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const n = Number(v4[1]);
    return n >= 64 && n <= 127;
  }
  return String(ip).toLowerCase().startsWith("fd7a:115c:a1e0:");
}

function socketIp(req) {
  let ip = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

function joinClientIp(req) {
  const ip = socketIp(req);
  if (ip === "127.0.0.1" || ip === "::1") {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
      let first = xff.split(",")[0].trim();
      if (first.startsWith("::ffff:")) first = first.slice(7);
      return first;
    }
  }
  return ip;
}

function tailscaleWhois(ip) {
  const raw = execFileSync("tailscale", ["whois", "--json", ip], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  return JSON.parse(raw);
}

function whoisUserId(w) {
  const id = w && w.UserProfile && w.UserProfile.ID;
  return id == null ? "" : String(id);
}

function assertSameTailscaleUser(ip) {
  if (ip === "127.0.0.1" || ip === "::1") {
    return { ok: true, node: "localhost" };
  }
  if (!isTailscaleAddr(ip)) {
    return { ok: false, error: "join only from Tailscale Serve or a Tailscale address" };
  }
  let selfW;
  let them;
  try {
    const status = JSON.parse(
      execFileSync("tailscale", ["status", "--json"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      }),
    );
    const selfIp = (status.Self && status.Self.TailscaleIPs && status.Self.TailscaleIPs[0]) || ip;
    selfW = tailscaleWhois(selfIp);
    them = tailscaleWhois(ip);
  } catch {
    return { ok: false, error: "tailscale whois failed" };
  }
  const a = whoisUserId(selfW);
  const b = whoisUserId(them);
  if (!a || !b || a !== b) {
    return { ok: false, error: "join only from your Tailscale user" };
  }
  return { ok: true, node: them.Node && them.Node.ComputedName };
}

function enableTailscaleServe(port) {
  execFileSync("tailscale", ["serve", "--bg", String(port)], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
}

function disableTailscaleServe() {
  try {
    execFileSync("tailscale", ["serve", "reset"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function tailscaleHttpsOrigin() {
  const status = JSON.parse(
    execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }),
  );
  const dns = String((status.Self && status.Self.DNSName) || "").replace(/\.$/, "");
  if (!dns) return null;
  return `https://${dns}`;
}



function readJoinTicket() {
  try {
    return JSON.parse(fs.readFileSync(joinStatePath(), "utf8"));
  } catch {
    return null;
  }
}

function consumeJoinTicket(id) {
  const t = readJoinTicket();
  if (!t || t.id !== id) return null;
  if (Date.now() > t.exp) return null;
  try {
    fs.unlinkSync(joinStatePath());
  } catch {
    /* ignore */
  }
  return t;
}

function joinUrl(advertiseUrl, id) {
  const u = new URL(advertiseUrl);
  return `${u.origin}/join/${id}`;
}

const TASK_NAME = "OMP Win Computer MCP";
const DEFAULT_PORT = 7420;
const DEFAULT_HOST = "127.0.0.1";

function homedir() {
  return process.env.USERPROFILE || os.homedir();
}

function stateDir() {
  return process.env.COMPUTER_MCP_STATE || path.join(homedir(), ".omp", "win-computer");
}

function pluginRoot() {
  return path.resolve(__dirname, "..");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function tokenPath() {
  return path.join(stateDir(), "token");
}

function configPath() {
  return path.join(stateDir(), "config.json");
}

function pidPath() {
  return path.join(stateDir(), "watchdog.pid");
}

function logDir() {
  return path.join(stateDir(), "logs");
}

function nodePath() {
  if (process.execPath && /node(\.exe)?$/i.test(process.execPath)) return process.execPath;
  const where = spawnSync(process.platform === "win32" ? "where" : "which", ["node"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const line = (where.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (line && fs.existsSync(line)) return line;
  const fallback = "C:\\Program Files\\nodejs\\node.exe";
  if (fs.existsSync(fallback)) return fallback;
  throw new Error("node.exe not found");
}

function findNatives() {
  if (process.env.COMPUTER_MCP_NATIVES && fs.existsSync(process.env.COMPUTER_MCP_NATIVES)) {
    return process.env.COMPUTER_MCP_NATIVES;
  }
  const cfg = safeLoadConfig();
  if (cfg?.natives && fs.existsSync(cfg.natives)) return cfg.natives;
  const root = path.join(homedir(), ".omp", "natives");
  if (!fs.existsSync(root)) {
    throw new Error("OMP natives not found under ~/.omp/natives. Install Oh My Pi on this Windows host first.");
  }
  const hits = [];
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name, "pi_natives.win32-x64-baseline.node");
    if (fs.existsSync(p)) hits.push({ p, t: fs.statSync(p).mtimeMs });
  }
  if (!hits.length) {
    throw new Error("No pi_natives.win32-x64-baseline.node under ~/.omp/natives");
  }
  hits.sort((a, b) => b.t - a.t);
  return hits[0].p;
}

function safeLoadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function loadConfig() {
  return safeLoadConfig();
}

function saveConfig(cfg) {
  ensureDir(stateDir());
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}

function migrateAndEnsureToken() {
  const dest = tokenPath();
  ensureDir(stateDir());
  if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8").trim()) return dest;
  const old = path.join(homedir(), ".omp", "computer-mcp", "token");
  if (fs.existsSync(old)) {
    const t = fs.readFileSync(old, "utf8").trim();
    if (t) {
      fs.writeFileSync(dest, t + "\n");
      return dest;
    }
  }
  fs.writeFileSync(dest, crypto.randomBytes(32).toString("base64url") + "\n");
  return dest;
}

function readToken() {
  const env = process.env.COMPUTER_MCP_TOKEN;
  if (env && env.trim()) return env.trim();
  const p = tokenPath();
  if (!fs.existsSync(p)) {
    throw new Error(`Missing token. Run: node bin/win-computer.cjs host install`);
  }
  const t = fs.readFileSync(p, "utf8").trim();
  if (!t) throw new Error(`Empty token file: ${p}`);
  return t;
}

function resolvedListen() {
  const cfg = safeLoadConfig() || {};
  return {
    host: process.env.COMPUTER_MCP_HOST || cfg.host || DEFAULT_HOST,
    port: Number(process.env.COMPUTER_MCP_PORT || cfg.port || DEFAULT_PORT),
  };
}

function health(host = "127.0.0.1", port = resolvedListen().port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/health`, { timeout: timeoutMs }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, status: res.statusCode, body: JSON.parse(b) });
        } catch {
          resolve({ ok: false, status: res.statusCode, body: b });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: String(e.message || e) }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

function pidOnPort(port) {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
    const re = new RegExp(`[:\\[]${port}\\]?\\s+.+LISTENING\\s+(\\d+)`, "i");
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(re);
      if (m) return Number(m[1]);
    }
  } catch {
    /* ignore */
  }
  return null;
}

function detectAdvertiseUrls(port) {
  const urls = [];
  try {
    const ip = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    })
      .trim()
      .split(/\r?\n/)[0];
    if (ip) urls.push(`http://${ip}:${port}/mcp`);
  } catch {
    /* optional */
  }
  try {
    const raw = execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
    });
    const j = JSON.parse(raw);
    const dns = String(j.Self?.DNSName || "").replace(/\.$/, "");
    if (dns) urls.push(`http://${dns}:${port}/mcp`);
  } catch {
    /* optional */
  }
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.internal || a.family !== "IPv4") continue;
      urls.push(`http://${a.address}:${port}/mcp`);
    }
  }
  return [...new Set(urls)];
}

function clientSnippet(url, token) {
  return {
    $schema: "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
    mcpServers: {
      "win-computer": {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 120000,
      },
    },
  };
}

function userMcpPath() {
  return path.join(homedir(), ".omp", "agent", "mcp.json");
}

function mergeClientMcp(url, token) {
  const p = userMcpPath();
  ensureDir(path.dirname(p));
  let doc = {
    $schema: "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
    mcpServers: {},
  };
  if (fs.existsSync(p)) {
    try {
      doc = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      throw new Error(`Could not parse ${p}`);
    }
  }
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

function removeClientMcp() {
  const p = userMcpPath();
  if (!fs.existsSync(p)) return p;
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  if (doc.mcpServers) delete doc.mcpServers["win-computer"];
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
  return p;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function currentUserId() {
  const domain = process.env.USERDOMAIN || os.hostname();
  return `${domain}\\${os.userInfo().username}`;
}

function taskXml(watchdogFile) {
  const cmd = nodePath();
  const args = `"${watchdogFile}"`;
  const cwd = path.dirname(watchdogFile);
  const user = currentUserId();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Oh My Pi win-computer MCP host. Starts at logon, crash-restarts the desktop MCP server.</Description>
    <URI>\\${TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
      <Delay>PT20S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>8</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(cmd)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(cwd)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function tryFirewall(port) {
  if (process.platform !== "win32") return { ok: false, skipped: true };
  const name = "OMP Win Computer MCP";
  const script = path.join(__dirname, "open-firewall.ps1");
  const show = () => {
    try {
      const out = execFileSync("netsh", ["advfirewall", "firewall", "show", "rule", `name=${name}`], {
        encoding: "utf8",
        windowsHide: true,
      });
      return /Enabled:\s+Yes/i.test(out);
    } catch {
      return false;
    }
  };
  if (show()) return { ok: true, method: "already" };
  try {
    try {
      execFileSync("netsh", ["advfirewall", "firewall", "delete", "rule", `name=${name}`], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      /* no existing rule */
    }
    execFileSync(
      "netsh",
      [
        "advfirewall",
        "firewall",
        "add",
        "rule",
        `name=${name}`,
        "dir=in",
        "action=allow",
        "protocol=TCP",
        `localport=${port}`,
        "profile=any",
        "remoteip=100.64.0.0/10,192.168.0.0/16,10.0.0.0/8,172.16.0.0/12",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    return { ok: true, method: "current-user" };
  } catch (err) {
    const inner = `-NoProfile -ExecutionPolicy Bypass -File "${script}" -Port ${Number(port)}`;
    fs.writeSync(
      1,
      "Windows will show a UAC prompt now. Click Yes to allow inbound TCP " +
        port +
        " from Tailscale and your LAN. Click No and remote OMP cannot connect.\n",
    );
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '${inner.replace(/'/g, "''")}'`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 120000 },
      );
      if (show()) return { ok: true, method: "uac" };
      return { ok: false, error: "UAC finished but the rule is missing", script };
    } catch (e2) {
      return {
        ok: false,
        error: String(err.stderr || err.message || err).trim(),
        elevate: String(e2.stderr || e2.message || e2).trim(),
        script,
      };
    }
  }
}

module.exports = {
  VERSION,
  TASK_NAME,
  DEFAULT_PORT,
  DEFAULT_HOST,
  homedir,
  stateDir,
  pluginRoot,
  ensureDir,
  tokenPath,
  configPath,
  pidPath,
  logDir,
  nodePath,
  findNatives,
  loadConfig,
  saveConfig,
  migrateAndEnsureToken,
  readToken,
  resolvedListen,
  health,
  pidOnPort,
  detectAdvertiseUrls,
  clientSnippet,
  userMcpPath,
  mergeClientMcp,
  removeClientMcp,
  taskXml,
  currentUserId,
  tryFirewall,
  joinStatePath,
  newJoinTicket,
  readJoinTicket,
  consumeJoinTicket,
  joinUrl,
  socketIp,
  joinClientIp,
  assertSameTailscaleUser,
  isTailscaleAddr,
  enableTailscaleServe,
  disableTailscaleServe,
  tailscaleHttpsOrigin,
};
