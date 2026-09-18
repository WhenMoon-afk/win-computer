"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const lib = require("./lib.cjs");

function usage() {
  process.stdout.write(`omp-win-computer ${lib.VERSION}

Remote Windows desktop computer-use over HTTP MCP.

Host (Windows, the machine whose screen you want to control):
  host install     Token, logon task, firewall, watchdog
  host uninstall   Stop server, remove logon task (keeps token)
  host start       Start watchdog now
  host stop        Stop watchdog and listener
  host status      Health, pid, advertise URLs
  host snippet     Print client mcp.json (includes the token)
  host firewall    Open inbound TCP 7420 (UAC once if needed)

Client (any OMP machine):
  client connect <url> [token]   Merge win-computer into ~/.omp/agent/mcp.json
  client disconnect              Remove that server entry

  serve            Run the MCP server in the foreground (Windows)

Docs: plugin README. Tools on the client are mcp__win_computer_*.
`);
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
  const host = flag(args, "--host") || lib.DEFAULT_HOST;
  process.stdout.write(`win-computer host install ${lib.VERSION}\n\n`);

  process.stdout.write(`State dir ${lib.stateDir()}\n  why: token/config/logs stay here across plugin upgrades and reboots\n`);
  lib.ensureDir(lib.stateDir());
  lib.ensureDir(lib.logDir());

  const existed = fs.existsSync(lib.tokenPath()) && fs.readFileSync(lib.tokenPath(), "utf8").trim();
  const tokenFile = lib.migrateAndEnsureToken();
  process.stdout.write(
    existed
      ? `Token reused at ${tokenFile}\n  why: keep existing clients working; not printed (desktop-control secret)\n`
      : `Token created at ${tokenFile}\n  why: remote OMP authenticates with this bearer; not printed (desktop-control secret)\n`,
  );

  const natives = lib.findNatives();
  process.stdout.write(`Native ${natives}\n  why: capture/input/AX come from Oh My Pi's DesktopSession, not this plugin\n`);
  lib.saveConfig({
    version: lib.VERSION,
    host,
    port,
    natives,
    installedAt: new Date().toISOString(),
  });

  process.stdout.write(
    `Logon task "${lib.TASK_NAME}" (interactive, 20s delay, restart on fail)\n  why: the server must run in your logged-on session; SYSTEM cannot capture the desktop\n`,
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

  process.stdout.write(
    `Firewall inbound TCP ${port} from Tailscale CGNAT + private LAN\n  why: remote OMP cannot reach this host until Windows Firewall allows that port\n`,
  );
  const fw = lib.tryFirewall(port);
  if (fw.ok) process.stdout.write(`  ok (${fw.method})\n`);
  else {
    process.stdout.write(
      `  not set. Remote clients will fail until you rerun: node bin/win-computer.cjs host firewall\n`,
    );
  }

  process.stdout.write(`Bind ${host}:${port} and start watchdog\n  why: watchdog restarts node if it crashes, without waiting for next logon\n`);
  await hostStop();
  startWatchdogDetached();
  const h = await waitHealth(10000);
  if (h.ok) process.stdout.write(`  health ok  capture=${h.body?.capture} input=${h.body?.input} ax=${h.body?.ax}\n`);
  else process.stdout.write(`  health failed ${JSON.stringify(h)}\n`);

  const urls = lib.detectAdvertiseUrls(port);
  process.stdout.write(`\nReachable as:\n${urls.map((u) => "  " + u).join("\n") || "  (no Tailscale/LAN IP found)"}\n`);
  process.stdout.write(
    `\nNext, on the OMP client (token is not printed here):\n  omp plugin install win-computer@whenmoon-afk\n  omp-win-computer host snippet     # on this Windows box; prints the secret\n  /win-computer connect <url> <token>\n  /mcp reload\n  then call mcp__win_computer_capabilities — not local computer.*\n`,
  );
  if (!h.ok) process.exit(2);
  if (!task.ok || !fw.ok) process.exit(0);
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
    if (sub === "connect") return clientConnect(rest);
    if (sub === "disconnect") return clientDisconnect();
    die("usage: client connect <url> [token] | client disconnect");
  }
  die("unknown command. --help");
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
  process.exit(1);
});
