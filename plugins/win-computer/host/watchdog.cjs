"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const lib = require("./lib.cjs");

const SERVER = path.join(__dirname, "server.cjs");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function openLog() {
  lib.ensureDir(lib.logDir());
  const file = path.join(lib.logDir(), "watchdog.log");
  return fs.createWriteStream(file, { flags: "a" });
}

function log(stream, msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    stream.write(line);
  } catch {
    /* ignore */
  }
  process.stdout.write(line);
}

async function main() {
  const cfg = lib.loadConfig() || {};
  const { port } = lib.resolvedListen();
  lib.ensureDir(lib.stateDir());
  fs.writeFileSync(lib.pidPath(), String(process.pid));
  const out = openLog();
  log(out, `watchdog start pid=${process.pid} port=${port} version=${lib.VERSION}`);

  let backoff = 2000;
  const stop = { value: false };
  const onStop = () => {
    stop.value = true;
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);

  while (!stop.value) {
    const h = await lib.health("127.0.0.1", port, 800);
    if (h.ok) {
      backoff = 2000;
      await sleep(5000);
      continue;
    }

    const env = {
      ...process.env,
      COMPUTER_MCP_HOST: process.env.COMPUTER_MCP_HOST || cfg.host || lib.DEFAULT_HOST,
      COMPUTER_MCP_PORT: String(process.env.COMPUTER_MCP_PORT || cfg.port || lib.DEFAULT_PORT),
      COMPUTER_MCP_STATE: lib.stateDir(),
    };
    if (cfg.natives) env.COMPUTER_MCP_NATIVES = cfg.natives;

    log(out, `starting server ${SERVER}`);
    const child = spawn(lib.nodePath(), [SERVER], {
      env,
      cwd: __dirname,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const serverLog = fs.createWriteStream(path.join(lib.logDir(), "server.log"), { flags: "a" });
    child.stdout.on("data", (d) => serverLog.write(d));
    child.stderr.on("data", (d) => serverLog.write(d));
    const code = await new Promise((resolve) => {
      child.on("exit", (c, sig) => resolve(sig ? `signal ${sig}` : c));
    });
    try {
      serverLog.end();
    } catch {
      /* ignore */
    }
    log(out, `server exited ${code}; retry in ${backoff}ms`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
  log(out, "watchdog stop");
  try {
    fs.unlinkSync(lib.pidPath());
  } catch {
    /* ignore */
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
