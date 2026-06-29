@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

echo ============================================
echo   Milogin's Prospector - 一键发布
echo ============================================
echo.

:: 1. 检查并提交
git diff --quiet
if %errorlevel% neq 0 (
    echo [1/3] 提交未保存变更...
    git add -A
    set /p MSG="  提交信息 (回车默认 chore): "
    if "%MSG%"=="" set MSG=chore: 快速发布
    git commit -m "%MSG%"
) else (
    echo [1/3] 工作区干净
)

:: 2. 推送
echo [2/3] 推送到 GitHub...
git push
if %errorlevel% neq 0 (
    echo 推送失败，请检查网络/Git配置
    pause & exit /b 1
)

:: 3. 构建+打包+发布
echo [3/3] 构建 + 打包 + 发布...
call npm run release
if %errorlevel% neq 0 (
    echo 发布失败。检查 GH_TOKEN 是否已设。
    pause & exit /b 1
)

echo.
echo 发布完成!
echo  https://github.com/Miloglim/Prospecting-Email/releases
pause
