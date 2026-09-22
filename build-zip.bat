@echo off
setlocal

rem Build skill-mahjong-netlify.zip for Netlify Drop deploy.
rem Run from anywhere; it always works on the folder where this .bat lives.

cd /d "%~dp0" || exit /b 1

set "OUT=skill-mahjong-netlify.zip"

echo [1/3] Checking source files...
for %%F in (index.html netlify.toml css js assets) do (
  if not exist "%%F" (
    echo ERROR: missing "%%F", abort.
    exit /b 1
  )
)

echo [2/3] Removing old archive if exists...
if exist "%OUT%" del /f /q "%OUT%" || exit /b 1

echo [3/3] Creating %OUT% ...
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Compress-Archive -Path 'index.html','netlify.toml','css','js','assets' -DestinationPath '%CD%\%OUT%' -Force"

if errorlevel 1 (
  echo ERROR: compression failed.
  exit /b 1
)

if not exist "%OUT%" (
  echo ERROR: %OUT% was not created.
  exit /b 1
)

echo Done: %CD%\%OUT%
echo Contents: index.html netlify.toml css/ js/ assets/
endlocal
