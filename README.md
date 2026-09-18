# whenmoon-afk / win-computer

Remote Windows desktop for [Oh My Pi](https://github.com/can1357/oh-my-pi) over HTTP MCP.

The Windows host runs a Node server that wraps OMP's `DesktopSession` native.
Any other OMP session (Linux, macOS, another Windows box) calls `mcp__win_computer_*`.

Package: `@whenmoon-afk/win-computer` `0.0.1`

This repo has no tokens, IPs, or mcp.json. Token and config live on the host in `~/.omp/win-computer/`.

## Install

From this directory:

```
omp plugin marketplace add .
omp plugin install win-computer@whenmoon-afk
```

After this repo is on GitHub:

```
omp plugin marketplace add WhenMoon-afk/win-computer
omp plugin install win-computer@whenmoon-afk
```

Or:

```
omp plugin link ./plugins/win-computer
```

## Windows host

Needs Node 18+ and Oh My Pi (for `~/.omp/natives/*/pi_natives.win32-x64-baseline.node`).

```
node ./plugins/win-computer/bin/win-computer.cjs host install
```

Install prints each step and why. It:

- writes token + config to `~/.omp/win-computer/` so upgrades and reboots keep them
- registers a logon Scheduled Task that starts a crash-restart watchdog in your interactive session (SYSTEM cannot capture the desktop)
- opens inbound TCP 7420 from Tailscale CGNAT and private LAN. If you are not Administrator, Windows asks once.
- does not print the token

```
node ./plugins/win-computer/bin/win-computer.cjs host status
node ./plugins/win-computer/bin/win-computer.cjs host snippet   # prints the secret
node ./plugins/win-computer/bin/win-computer.cjs host firewall  # retry the firewall rule
```

## Remote OMP client

```
node ./plugins/win-computer/bin/win-computer.cjs client connect http://HOST:7420/mcp TOKEN
```

Then `/mcp reload`. Call `mcp__win_computer_capabilities`. Not local `computer.*`.

## Restart

| Event | What happens |
|---|---|
| Windows reboot + user logon | Scheduled Task starts the watchdog after 20s |
| node crash | watchdog restarts with backoff |
| plugin upgrade | token/config stay in `~/.omp/win-computer/` |
| Tailscale IP change | use the MagicDNS URL from `host snippet` |

## Uninstall host

```
node ./plugins/win-computer/bin/win-computer.cjs host uninstall
```

Keeps the token file until you delete `~/.omp/win-computer/`.
