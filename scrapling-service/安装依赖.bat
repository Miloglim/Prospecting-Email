@echo off
chcp 65001 >nul
title 安装 Scrapling 抓取服务依赖

echo.
echo ╔══════════════════════════════════════╗
echo ║   Milogin's Prospector              ║
echo ║   抓取服务 — 首次安装                 ║
echo ╚══════════════════════════════════════╝
echo.

:: 检查 Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Python，请先安装 Python 3.10+
    echo    下载地址: https://www.python.org/downloads/
    echo    ⚠️ 安装时务必勾选 "Add Python to PATH"
    pause
    exit /b 1
)

echo ✅ Python 已检测到
python --version
echo.

echo 📦 正在安装依赖（可能需要 1-3 分钟）...
pip install -r requirements.txt -q

if %errorlevel% neq 0 (
    echo.
    echo ❌ 依赖安装失败，请检查网络连接后重试
    pause
    exit /b 1
)

echo.
echo 🔧 正在下载浏览器指纹库...
scrapling install

echo.
echo ╔══════════════════════════════════════╗
echo ║  ✅ 安装完成！                       ║
echo ║  抓取服务会在工具启动时自动运行         ║
echo ╚══════════════════════════════════════╝
echo.
pause
