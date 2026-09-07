# 停止后台运行的运价看板服务
# 用法： powershell -ExecutionPolicy Bypass -File stop-board.ps1  [-Port 8788]

param([int]$Port = 8788)

$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidF = Join-Path $here 'board.pid'

$killed = @()

if (Test-Path $pidF) {
    $saved = (Get-Content $pidF -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
    if ($saved -match '^\d+$') {
        $p = Get-Process -Id $saved -ErrorAction SilentlyContinue
        if ($p) { Stop-Process -Id $saved -Force; $killed += $saved }
    }
    # 不删文件，写个哨兵值；下次启动会自行覆盖
    Set-Content -Path $pidF -Value 'idle' -Encoding ASCII
}

# 兜底：PID 文件丢了就按端口找监听者
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        if ($killed -notcontains "$_") {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
            $killed += "$_"
        }
    }

if ($killed.Count -gt 0) {
    Write-Host "已停止运价看板（PID：$($killed -join ', ')）" -ForegroundColor Green
} else {
    Write-Host "没有找到正在运行的运价看板（端口 $Port 无监听）。" -ForegroundColor Yellow
}
