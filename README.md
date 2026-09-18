# whenmoon-afk / win-computer

Remote Windows desktop for [Oh My Pi](https://github.com/can1357/oh-my-pi) over HTTP MCP.

The Windows host runs a Node server on `127.0.0.1`. Tailscale Serve publishes it to your tailnet as HTTPS. Nothing opens on Windows Firewall, so there is no UAC prompt.

Package: `@whenmoon-afk/win-computer` `0.0.3`

This repo has no tokens, IPs, or mcp.json. Token and config live on the host in `~/.omp/win-computer/`.

## Setup

In OMP on both machines:

```
/marketplace add WhenMoon-afk/win-computer
```

Install `win-computer` from that marketplace.

On Windows, in OMP (or over SSH into that session):

```
/win-computer host
```

That checks Node, OMP natives, and Tailscale (installs Node/Tailscale via winget if needed), writes a logon task, binds localhost, runs `tailscale serve --bg 7420`, and prints a join URL. Each step says what it is doing and why. If Serve fails, install stops. It does not fall back to a firewall rule.

On the other OMP session:

```
/win-computer join https://HOST.ts.net/join/...
```

The join URL is a 2-minute, one-time ticket. The Node server only accepts connections from localhost (Tailscale Serve). If Serve forwards `X-Forwarded-For`, join also requires that IP to `tailscale whois` as the same Tailscale user. Then `/mcp reload`. Call `mcp__win_computer_capabilities`. Not local `computer.*`.

The Windows user still has to be logged on for desktop capture. That is not UAC. It is the interactive session.

## Recovery

If the join URL expired, run `/win-computer host` again. `host snippet` prints the raw token. Do not commit it.

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

Stops the watchdog, removes the logon task, and runs `tailscale serve reset` on this node. Keeps the token file until you delete `~/.omp/win-computer/`.
