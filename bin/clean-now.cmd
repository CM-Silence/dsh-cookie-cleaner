@echo off
rem 手动清一次（DSH 必须已完全退出；运行中清会报 in use）
rem 双击运行也行 —— 会停下来让你看清结果。
setlocal
cd /d "%~dp0.."
node "%~dp0clean.mjs" clean %*
echo.
pause
