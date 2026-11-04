@echo off
rem 本地看板：双击运行，或 start-dashboard.cmd 8791 指定端口
rem 前提：能解析出产物目录（COMFY_OUTPUT_DIR / COMFY_ROOT / comfyforge.config.json）
cd /d "%~dp0"
if not "%~1"=="" set DASHBOARD_PORT=%~1
if "%~1"=="" set DASHBOARD_PORT=8790
start "" node "ui\server.mjs"
echo Dashboard: http://127.0.0.1:%DASHBOARD_PORT%
