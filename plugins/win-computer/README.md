# @whenmoon-afk/win-computer

Remote Windows desktop computer-use over HTTP MCP for Oh My Pi.

See the marketplace [README](../../README.md) for install, host autostart, and client connect.

```
node bin/win-computer.cjs host install     # Windows
node bin/win-computer.cjs client connect <url> <token>
```

Tools on the client: `mcp__win_computer_*`. Not local `computer.*`.
