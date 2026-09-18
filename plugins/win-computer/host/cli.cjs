"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const lib = require("./lib.cjs");

function usage() {
  process.stdout.write(`omp-win-computer ${lib.VERSION}

Remote Windows desktop over HTTP MCP.

Windows host:
  host install     Prereqs, token, logon task, firewall, watchdog, join URL
  host uninstall   Stop server, remove logon task (keeps token)
  host start | stop | status | firewall
  host snippet     Recovery: print mcp.json (includes the token)

Other OMP:
  client join <join-url>     Write mcp.json from the host join URL
  client disconnect

  serve            Foreground MCP server (Windows)
`);
}

function say(what, why) {
  process.stdout.write(`${what}\n  why: ${why}\n`);
}

function wingetInstall(id) {
  execFileSync(
    "winget",
    ["install", "--id", id, "-e", "--accept-package-agreements", "--accept-source-agreements"],
    { stdio: "inherit", windowsHide: false },
  );
}

function ensurePrereqs() {
  try {
    lib.nodePath();
    say("Node.js found", "the MCP server is a Node process");
  } catch {
    say(
      "Installing Node.js LTS via winget (OpenJS.NodeJS.LTS)",
      "Microsoft catalog, signed. Needed because this server runs on Node.",
    );
    wingetInstall("OpenJS.NodeJS.LTS");
  }

  try {
    const natives = lib.findNatives();
    say(`OMP native ${natives}`, "capture/input/AX come from Oh My Pi, not this plugin");
  } catch (err) {
    die(
      "Oh My Pi natives not found. Install OMP on this Windows machine, then rerun host install. " +
        String(err.message || err),
    );
  }

  try {
    execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    say("Tailscale is up", "the other computer reaches this host on your tailnet without pasted IPs");
  } catch {
    say(
      "Installing Tailscale via winget (Tailscale.Tailscale)",
      "Microsoft catalog, signed. Join uses your tailnet, not a public IP.",
    );
    try {
      wingetInstall("Tailscale.Tailscale");
    } catch (err) {
      process.stdout.write(`  winget: ${err.message || err}\n`);
    }
    say(
      "If Tailscale asks you to log in, a browser window is expected",
      "that login is how only your devices see this desktop",
    );
    try {
      execFileSync("tailscale", ["up"], { stdio: "inherit", timeout: 180000 });
    } catch {
      process.stdout.write("  tailscale up did not finish. Log in, then rerun host install.\n");
    }
  }
}

function die(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* already dead */
  }
}

function readPidFile() {
  try {
    const n = Number(fs.readFileSync(lib.pidPath(), "utf8").trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function hostStop() {
  const { port } = lib.resolvedListen();
  killPid(readPidFile());
  const listener = lib.pidOnPort(port);
  if (listener) killPid(listener);
  try {
    fs.unlinkSync(lib.pidPath());
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 20; i++) {
    const h = await lib.health("127.0.0.1", port, 400);
    if (!h.ok && !lib.pidOnPort(port)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

function startWatchdogDetached() {
  const child = spawn(lib.nodePath(), [path.join(__dirname, "watchdog.cjs")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: __dirname,
    env: { ...process.env, COMPUTER_MCP_STATE: lib.stateDir() },
  });
  child.unref();
}

async function waitHealth(timeoutMs = 8000) {
  const { port } = lib.resolvedListen();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h = await lib.health("127.0.0.1", port, 800);
    if (h.ok) return h;
    await new Promise((r) => setTimeout(r, 250));
  }
  return lib.health("127.0.0.1", lib.resolvedListen().port, 800);
}

function writeTask() {
  const xmlPath = path.join(lib.stateDir(), "task.xml");
  const xml = lib.taskXml(path.join(__dirname, "watchdog.cjs"));
  // schtasks /XML wants UTF-16 LE with BOM
  fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  execFileSync("schtasks", ["/Create", "/TN", lib.TASK_NAME, "/XML", xmlPath, "/F"], {
    windowsHide: true,
    encoding: "utf8",
  });
}

async function hostInstall(args) {
  if (process.platform !== "win32") die("host install is Windows-only");
  const port = Number(flag(args, "--port") || lib.DEFAULT_PORT);
  const host = flag(args, "--host") || "127.0.0.1";
  process.stdout.write(`win-computer host install ${lib.VERSION}\n\n`);

  ensurePrereqs();

  say(`State dir ${lib.stateDir()}`, "token/config/logs stay here across plugin upgrades and reboots");
  lib.ensureDir(lib.stateDir());
  lib.ensureDir(lib.logDir());

  const existed = fs.existsSync(lib.tokenPath()) && fs.readFileSync(lib.tokenPath(), "utf8").trim();
  const tokenFile = lib.migrateAndEnsureToken();
  say(
    existed ? `Token reused at ${tokenFile}` : `Token created at ${tokenFile}`,
    "not printed. the join URL is how the other machine gets it",
  );

  const natives = lib.findNatives();
  lib.saveConfig({
    version: lib.VERSION,
    host,
    port,
    natives,
    installedAt: new Date().toISOString(),
  });

  say(
    `Logon task "${lib.TASK_NAME}" (interactive, 20s delay, restart on fail)`,
    "the server must run in your logged-on session; SYSTEM cannot capture the desktop",
  );
  let task = { ok: false };
  try {
    writeTask();
    task = { ok: true };
    process.stdout.write("  ok\n");
  } catch (err) {
    task = { ok: false, error: String(err.stderr || err.message || err).trim() };
    process.stdout.write(`  failed: ${task.error}\n`);
  }
  say(
    `Listen on 127.0.0.1:${port} and Tailscale Serve`,
    "no Windows Firewall rule, no UAC. only your tailnet can reach this. you do not have to sit at the PC.",
  );
  try {
    lib.enableTailscaleServe(port);
    process.stdout.write("  tailscale serve --bg ok\n");
  } catch (err) {
    die(
      "tailscale serve failed: " +
        String(err.stderr || err.message || err).trim() +
        "\nLog into Tailscale on this Windows machine (`tailscale up`), then rerun host install. We do not open a firewall port.",
    );
  }

  say(`Start watchdog on ${host}:${port}`, "watchdog restarts node if it crashes, without waiting for next logon");
  await hostStop();
  startWatchdogDetached();
  const h = await waitHealth(10000);
  if (h.ok) process.stdout.write(`  health ok  capture=${h.body?.capture} input=${h.body?.input} ax=${h.body?.ax}\n`);
  else process.stdout.write(`  health failed ${JSON.stringify(h)}\n`);

  const ticket = lib.newJoinTicket();
  let base;
  try {
    const origin = lib.tailscaleHttpsOrigin();
    base = origin ? `${origin}/mcp` : null;
  } catch {
    base = null;
  }
  if (!base) {
    const urls = lib.detectAdvertiseUrls(port);
    base = urls.find((u) => u.includes(".ts.net")) || urls[0] || `http://127.0.0.1:${port}/mcp`;
  }
  const join = lib.joinUrl(base, ticket.id);
  process.stdout.write(
    `\nOn the other OMP session, run this as-is (valid 2 minutes, your Tailscale user only):\n  /win-computer join ${join}\n`,
  );
  if (!h.ok) process.exit(2);
}

async function hostUninstall() {
  if (process.platform !== "win32") die("host uninstall is Windows-only");
  await hostStop();
  try {
    execFileSync("schtasks", ["/Delete", "/TN", lib.TASK_NAME, "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    /* missing */
  }
  if (lib.disableTailscaleServe()) {
    process.stdout.write("cleared Tailscale Serve on this node\n");
  }
  process.stdout.write(`stopped. token kept at ${lib.tokenPath()}\n`);
}

async function hostStart() {
  if (process.platform !== "win32") die("host start is Windows-only");
  const h0 = await lib.health("127.0.0.1", lib.resolvedListen().port, 800);
  if (h0.ok) {
    process.stdout.write("already up\n");
    return;
  }
  startWatchdogDetached();
  const h = await waitHealth(10000);
  process.stdout.write(JSON.stringify(h, null, 2) + "\n");
  if (!h.ok) process.exit(2);
}

async function hostStatus() {
  const { host, port } = lib.resolvedListen();
  const h = await lib.health("127.0.0.1", port, 1500);
  let task = "unknown";
  if (process.platform === "win32") {
    try {
      execFileSync("schtasks", ["/Query", "/TN", lib.TASK_NAME], {
        windowsHide: true,
        stdio: "ignore",
      });
      task = "registered";
    } catch {
      task = "missing";
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        version: lib.VERSION,
        state: lib.stateDir(),
        listen: { host, port },
        health: h,
        watchdogPid: readPidFile(),
        listenerPid: lib.pidOnPort(port),
        logonTask: task,
        advertise: lib.detectAdvertiseUrls(port),
      },
      null,
      2,
    ) + "\n",
  );
  if (!h.ok) process.exit(2);
}

function hostSnippet() {
  process.stdout.write("Prints the bearer token. Treat it as a password. Do not commit it.\n");
  const token = lib.readToken();
  const { port } = lib.resolvedListen();
  const urls = lib.detectAdvertiseUrls(port);
  const url = urls[0] || `http://127.0.0.1:${port}/mcp`;
  process.stdout.write(JSON.stringify({ urls, mcpJson: lib.clientSnippet(url, token) }, null, 2) + "\n");
}

function hostFirewall(args) {
  if (process.platform !== "win32") die("host firewall is Windows-only");
  const port = Number(flag(args, "--port") || lib.resolvedListen().port);
  process.stdout.write(
    `Open inbound TCP ${port} from Tailscale CGNAT and private LAN.\n  why: remote OMP cannot connect until Windows Firewall allows that port.\n  If this process is not Administrator, Windows will ask.\n`,
  );
  const fw = lib.tryFirewall(port);
  process.stdout.write(JSON.stringify(fw, null, 2) + "\n");
  if (!fw.ok) process.exit(2);
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return null;
}

async function clientConnect(args) {
  const url = args[0];
  if (!url) die("usage: client connect <url> [token]");
  const token = args[1] || process.env.COMPUTER_MCP_TOKEN || (fs.existsSync(lib.tokenPath()) ? lib.readToken() : "");
  if (!token) die("token required as argument, COMPUTER_MCP_TOKEN, or host token file");
  const p = lib.mergeClientMcp(url, token);
  process.stdout.write(`wrote ${p}\nreload MCP in OMP: /mcp reload\n`);
}

async function clientJoin(args) {
  const joinUrl = args[0];
  if (!joinUrl) die("usage: client join <join-url>");
  say(`Fetching ${joinUrl}`, "the host join URL carries a one-time ticket, not something you type");
  const res = await fetch(joinUrl);
  const text = await res.text();
  if (!res.ok) die(`join failed: ${res.status} ${text}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    die("join URL did not return JSON");
  }
  const mcp = body.mcp;
  if (!mcp || !mcp.url || !mcp.headers || !mcp.headers.Authorization) die("join payload missing mcp url/token");
  const token = String(mcp.headers.Authorization).replace(/^Bearer\s+/i, "");
  const p = lib.mergeClientMcp(mcp.url, token);
  process.stdout.write(`wrote ${p}\nIn OMP: /mcp reload\nThen call mcp__win_computer_capabilities. Not local computer.*\n`);
}

function clientDisconnect() {
  const p = lib.removeClientMcp();
  process.stdout.write(`updated ${p}\n`);
}

function serve() {
  require("./server.cjs");
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const sub = argv[1];
  const rest = argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(lib.VERSION + "\n");
    return;
  }
  if (cmd === "serve") return serve();
  if (cmd === "host") {
    if (sub === "install") return hostInstall(rest);
    if (sub === "uninstall") return hostUninstall();
    if (sub === "start") return hostStart();
    if (sub === "stop") return hostStop();
    if (sub === "status") return hostStatus();
    if (sub === "snippet") return hostSnippet();
    if (sub === "firewall") return hostFirewall(rest);
    die("usage: host install|uninstall|start|stop|status|snippet|firewall");
  }
  if (cmd === "client") {
    if (sub === "join") return clientJoin(rest);
    if (sub === "connect") return clientConnect(rest);
    if (sub === "disconnect") return clientDisconnect();
    die("usage: client join <join-url> | client connect <url> [token] | client disconnect");
  }
  die("unknown command. --help");
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
