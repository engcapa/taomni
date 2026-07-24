@echo off
title Taomni SocksCap Multi-Profile Single-Helper E2E Test Launcher
cd /d "C:\code\person\taomni"
echo =========================================================================
echo  Taomni SocksCap Multi-Profile Single-Helper E2E Test
echo  (4 Profiles: Global-HTTP, Global-SOCKS5, Apps-HTTP, Apps-SSH)
echo  (Single WinDivert capture, relay port hot-swap via capture_update)
echo =========================================================================
echo.
echo Make sure sockscap-helper.exe is built first:
echo   pwsh scripts/stage-sockscap-windows.ps1
echo.
echo Launching test. Windows 11 UAC prompt will appear...
echo.
python -u qa-ui-auto-tests\cases\test_sockscap_multiprofile_e2e.py
echo.
pause
