param(
  [int]$Port = 7420
)

$ErrorActionPreference = "Stop"
$name = "OMP Win Computer MCP"

Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule `
  -DisplayName $name `
  -Description "Oh My Pi win-computer MCP. Inbound TCP from Tailscale CGNAT and RFC1918 only." `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -RemoteAddress @("100.64.0.0/10", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12") `
  -Profile Any | Out-Null

Write-Output "ok port=$Port"
