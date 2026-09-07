# 启动运价台账本机看板（双击/命令行运行本脚本即可）
# 用法： powershell -ExecutionPolicy Bypass -File start-board.ps1
# 可选： -Port 8788  -NoLan   （-NoLan 只监听 127.0.0.1，不对局域网开放）

param(
    [int]$Port = 8788,
    [switch]$NoLan
)

$ErrorActionPreference = 'Stop'
$py   = 'C:\Users\YQN\AppData\Local\Programs\YQN OS\runtime\python\python.exe'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $py)) { Write-Host "找不到内嵌 Python：$py" -ForegroundColor Red; exit 1 }

$host_ = if ($NoLan) { '127.0.0.1' } else { '0.0.0.0' }
Write-Host "启动运价看板： http://127.0.0.1:$Port/  (局域网 http://<本机IP>:$Port/)" -ForegroundColor Green
& $py (Join-Path $here 'board_server.py') --host $host_ --port $Port
