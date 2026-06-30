@echo off
chcp 65001 >nul
cd /d "E:\Agents Basement\projects\Prospecting Email"

echo ============================================
echo   Milogin's Prospector - 一键发布
echo ============================================
echo.

:: 版本号 — 交给 Node.js 处理，避免 batch 变量展开的坑
for /f %%v in ('node -e "console.log(require('./package.json').version)"') do set OLD_VER=%%v
echo 当前: v%OLD_VER%
set /p NEW_VER="新版本号 (回车 +0.0.1): "

:: 更新 package.json + 打 tag + 提交推送
node -e "var p=require('./package.json');var v='%NEW_VER%';if(!v){var x=p.version.split('.');x[2]=Number(x[2])+1;v=x.join('.')}p.version=v;require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n');console.log(v)"
for /f %%v in ('node -e "console.log(require('./package.json').version)"') do set NEW_VER=%%v

echo 发布: v%NEW_VER%
git add -A
git commit -m "release: v%NEW_VER%"
git tag "v%NEW_VER%"
git push && git push --tags
if %errorlevel% neq 0 (echo 推送失败 & pause & exit /b 1)

echo.
echo 构建 + 打包 + 发布...
call npm run release

echo.
echo v%NEW_VER% 完成!
pause
