# 给运价看板放行局域网访问（右键“以管理员身份运行 PowerShell”后执行本脚本）
# 只做一件事：在 Windows 防火墙为 TCP 8788 添加一条专用网络入站放行规则。

param([int]$Port = 8788)

$rule = Get-NetFirewallRule -DisplayName "FreightBoard-$Port" -ErrorAction SilentlyContinue
if ($rule) {
    Write-Host "规则已存在，无需重复添加。" -ForegroundColor Yellow
} else {
    New-NetFirewallRule -DisplayName "FreightBoard-$Port" -Direction Inbound `
        -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
    Write-Host "已放行 TCP $Port（仅专用网络）。" -ForegroundColor Green
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
       Select-Object -First 1).IPAddress
Write-Host "同事访问地址： http://${ip}:$Port/" -ForegroundColor Cyan
Write-Host "接口地址：     http://${ip}:$Port/api/rates" -ForegroundColor Cyan
