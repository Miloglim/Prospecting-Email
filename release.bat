@echo off
chcp 65001 >nul
cd /d "E:\Agents Basement\projects\Prospecting Email"

echo ============================================
echo   Milogin's Prospector - 一键发布
echo ============================================
echo.

:: 版本号
for /f "tokens=2 delims=: " %%v in ('node -e "console.log(require('./package.json').version)"') do set OLD_VER=%%v
echo 当前: v%OLD_VER%
set /p NEW_VER="新版本号 (回车 +0.0.1): "
if "%NEW_VER%"=="" (
    for /f "tokens=1,2,3 delims=." %%a in ("%OLD_VER%") do (
        set /a PATCH=%%c+1
        set NEW_VER=%%a.%%b.!PATCH!
    )
)
echo 发布: v%NEW_VER%

:: 更新 package.json
node -e "var p=require('./package.json');p.version='%NEW_VER%';require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"

:: 提交
git add -A
git commit -m "release: v%NEW_VER%"
git tag "v%NEW_VER%"
git push && git push --tags

:: 构建发布
echo.
echo 正在构建...
call npm run release

echo.
echo v%NEW_VER% 发布完成!
pause
