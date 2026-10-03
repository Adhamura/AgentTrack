@echo off
rem Packs Agent Track into a release zip: dist\agent-track-<version>.zip
rem The zip holds one folder, agent-track\, that is both the plugin and its own
rem marketplace, so it can be installed with /plugin marketplace add <folder>.
setlocal EnableExtensions
cd /d "%~dp0"

set "NAME=agent-track"
set "STAGE=dist\%NAME%"

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content -Raw '.claude-plugin\plugin.json' | ConvertFrom-Json).version"`) do set "VERSION=%%v"
if "%VERSION%"=="" (
  echo Could not read the version from .claude-plugin\plugin.json
  exit /b 1
)
echo Packing %NAME% %VERSION%

where claude >nul 2>nul
if errorlevel 1 (
  echo claude is not on PATH: skipping validation and tests.
) else (
  echo.
  echo == Validating the marketplace and the plugin
  call claude plugin validate . || goto :failed
  call claude plugin validate .claude-plugin\plugin.json || goto :failed
  echo.
  echo == Running the tests
  call claude plugin test . || goto :failed
)

echo.
echo == Staging %STAGE%
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%" || goto :failed
rem .claude-plugin	ypes is written by Claude Code on each load; it is not shipped.
robocopy ".claude-plugin" "%STAGE%\.claude-plugin" /e /xd types /njh /njs /ndl /nfl /nc /ns >nul
if errorlevel 8 goto :failed
for %%d in (hooks types tests docs) do (
  robocopy "%%d" "%STAGE%\%%d" /e /njh /njs /ndl /nfl /nc /ns >nul
  if errorlevel 8 goto :failed
)
for %%f in (README.md LICENSE tsconfig.json) do copy /y "%%f" "%STAGE%\" >nul || goto :failed

rem The public build greets with no name until the person sets their own.
powershell -NoProfile -Command "$p = '%STAGE%\.claude-plugin\plugin.json'; $t = (Get-Content -Raw $p) -replace '(\x22default\x22:\s*)\x22[^\x22]*\x22', '$1[[EMPTY]]'; $t = $t.Replace('[[EMPTY]]', [string][char]34 + [char]34); [IO.File]::WriteAllText((Resolve-Path $p), $t)" || goto :failed

echo.
echo == Zipping
set "ZIP=dist\%NAME%-%VERSION%.zip"
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%' -DestinationPath '%ZIP%'" || goto :failed

echo.
echo Done: %ZIP%
echo Try it:  /plugin marketplace add %CD%\%STAGE%
echo          /plugin install %NAME%@%NAME%
exit /b 0

:failed
echo.
echo Packing failed.
exit /b 1
