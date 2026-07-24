@echo off
title Taomni SocksCap Full-Link Driver-Level UAC Test Launcher
cd /d "C:\code\person\taomni"
echo =========================================================================
echo  Taomni SocksCap Full-Link Driver-Level E2E Test (WinDivert + UAC)
echo =========================================================================
echo.
echo Launching full-link driver test. Windows 11 UAC prompt will appear...
echo.
python -u qa-ui-auto-tests\cases\test_sockscap_driver_e2e.py
echo.
pause
