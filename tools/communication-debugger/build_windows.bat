@echo off
setlocal
cd /d "%~dp0"

py -3 -m pip install pyinstaller
if errorlevel 1 goto :error

py -3 -m PyInstaller --clean --noconfirm --onefile --windowed --name "HRT通讯工具" main.py
if errorlevel 1 goto :error

echo.
echo Build completed: dist\HRT通讯工具.exe
pause
exit /b 0

:error
echo.
echo Build failed.
pause
exit /b 1
