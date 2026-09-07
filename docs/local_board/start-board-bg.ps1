# 后台启动运价看板（不留窗口，关掉 QoderWork/终端也不影响）
# 用法：
#   powershell -ExecutionPolicy Bypass -File start-board-bg.ps1            # 监听局域网（默认）
#   powershell -ExecutionPolicy Bypass -File start-board-bg.ps1 -NoLan    # 只允许本机访问
#   powershell -ExecutionPolicy Bypass -File start-board-bg.ps1 -Restart  # 已在跑就重启
# 停止： stop-board.ps1

param(
    [int]$Port = 8788,
    [switch]$NoLan,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$py   = 'C:\Users\YQN\AppData\Local\Programs\YQN OS\runtime\python\python.exe'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-Listener {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
}

if (-not (Test-Path $py)) { Write-Host "找不到内嵌 Python：$py" -ForegroundColor Red; exit 1 }

# 已在跑：要么复用，要么先停再起
$running = Get-Listener
if ($running) {
    if (-not $Restart) {
        Write-Host "端口 $Port 已有看板在跑（PID $($running[0].OwningProcess)），无需重复启动。" -ForegroundColor Yellow
        Write-Host "要重启：加 -Restart；要停止：跑 stop-board.ps1" -ForegroundColor Yellow
        exit 0
    }
    $running | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 600
    Write-Host "已停掉旧实例，重新启动…" -ForegroundColor Gray
}

$bind  = if ($NoLan) { '127.0.0.1' } else { '0.0.0.0' }
# --daemon：Python 内部以 DETACHED_PROCESS 重新拉起自己并立即返回，不留窗口也不占终端
& $py (Join-Path $here 'board_server.py') --host $bind --port $Port --daemon
Start-Sleep -Seconds 2

if (-not (Get-Listener)) {
    Write-Host "启动失败，端口 $Port 没起来。看日志：$(Join-Path $here 'board.log')" -ForegroundColor Red
    Get-Content (Join-Path $here 'board.log') -Tail 10 -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "运价看板已在后台运行" -ForegroundColor Green
Write-Host "  本机看板  http://127.0.0.1:$Port/" -ForegroundColor Cyan
Write-Host "  接口示例  http://127.0.0.1:$Port/api/rates?limit=10" -ForegroundColor Cyan

if (-not $NoLan) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
           Select-Object -First 1).IPAddress
    if ($ip) {
        Write-Host "  同事访问  http://${ip}:$Port/   （接口同理 http://${ip}:$Port/api/rates）" -ForegroundColor Cyan
    }
    # 防火墙：能加就加，没管理员权限就提示
    try {
        if (-not (Get-NetFirewallRule -DisplayName "FreightBoard-$Port" -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule -DisplayName "FreightBoard-$Port" -Direction Inbound `
                -Protocol TCP -LocalPort $Port -Action Allow -Profile Private | Out-Null
            Write-Host "  已自动放行防火墙（TCP $Port，仅专用网络）" -ForegroundColor Green
        }
    } catch {
        Write-Host "  防火墙未放行：本会话无管理员权限。同事连不上时，右键管理员 PowerShell 跑一次 allow-lan-firewall.ps1 即可（一次性的）。" -ForegroundColor Yellow
    }
}
Write-Host "  停止服务  powershell -ExecutionPolicy Bypass -File stop-board.ps1" -ForegroundColor Gray
