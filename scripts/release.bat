@echo off
chcp 65001 >nul
cd /d "%~dp0\.."

echo ============================================
echo   Milogin's Prospector - 一键发布
echo ============================================
echo.

:: 0. 确定版本号
for /f "tokens=2 delims=: " %%v in ('node -e "console.log(require('./package.json').version)"') do set OLD_VER=%%v
echo 当前版本: v%OLD_VER%
set /p NEW_VER="新版本号 (回车自动 +0.0.1): "
if "%NEW_VER%"=="" (
    for /f "tokens=1,2,3 delims=." %%a in ("%OLD_VER%") do (
        set /a PATCH=%%c+1
        set NEW_VER=%%a.%%b.!PATCH!
    )
)
echo 发布版本: v%NEW_VER%
echo.

:: 1. 更新版本号
node -e "var p=require('./package.json');p.version='%NEW_VER%';require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"

:: 2. 提交
git add -A
set /p MSG="提交信息 (回车默认 release): "
if "%MSG%"=="" set MSG=release: v%NEW_VER%
git commit -m "%MSG%"
if %errorlevel% neq 0 (
    echo 提交失败
    pause & exit /b 1
)

:: 3. 打 tag + 推送
git tag "v%NEW_VER%"
git push && git push --tags
if %errorlevel% neq 0 (
    echo 推送失败
    pause & exit /b 1
)

:: 4. 构建+打包+发布
echo.
echo 构建 + 打包 + 发布到 GitHub...
call npm run release
if %errorlevel% neq 0 (
    echo 发布失败。检查 GH_TOKEN 是否已设。
    pause & exit /b 1
)

echo.
echo v%NEW_VER% 发布完成!
echo https://github.com/Miloglim/Prospecting-Email/releases
pause
