# whenmoon-afk / win-computer

Remote Windows desktop for [Oh My Pi](https://github.com/can1357/oh-my-pi) over HTTP MCP.

The Windows host runs a Node server that wraps OMP's `DesktopSession` native.
Any other OMP session calls `mcp__win_computer_*`.

Package: `@whenmoon-afk/win-computer` `0.0.2`

This repo has no tokens, IPs, or mcp.json. Token and config live on the host in `~/.omp/win-computer/`.

## Setup

In OMP on **both** machines:

```
/marketplace add WhenMoon-afk/win-computer
```

Install `win-computer` from that marketplace.

On the **Windows** machine, in OMP:

```
/win-computer host
```

That command checks Node, OMP natives, and Tailscale (installs Node/Tailscale via winget if needed), writes a logon task, asks Windows for a firewall rule (UAC), starts the watchdog, and prints a join URL. Each step says what it is doing and why.

On the **other** OMP session, paste that URL as:

```
/win-computer join http://HOST:7420/join/...
```

The join URL is a 30-minute, one-time ticket. It writes `~/.omp/agent/mcp.json`. Then `/mcp reload`. Call `mcp__win_computer_capabilities`. Not local `computer.*`.

## Recovery

If the join URL expired:

```
node bin/win-computer.cjs host install
```

prints a new one. `host snippet` prints the raw token. Do not commit it.

## Restart

| Event | What happens |
|---|---|
| Windows reboot + user logon | Scheduled Task starts the watchdog after 20s |
| node crash | watchdog restarts with backoff |
| plugin upgrade | token/config stay in `~/.omp/win-computer/` |

## Uninstall host

```
node bin/win-computer.cjs host uninstall
```

Keeps the token file until you delete `~/.omp/win-computer/`.
