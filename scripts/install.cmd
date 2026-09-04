@echo off
setlocal
rem Installs a ColumnKit .vsix into every VS Code family editor found on this machine.
rem
rem Exists because double-clicking a .vsix on Windows hands it to Visual Studio's
rem VSIX Installer, which is what the .vsix file association points at whenever
rem Visual Studio or its Build Tools are present. That installer refuses VS Code
rem extensions with "not successful for all the selected products". A .vsix is an
rem archive the editor unpacks, not an installer, so it has to go through the
rem editor's own CLI.
rem
rem Usage: double-click this file, or: install.cmd "C:\path\to\columnkit-0.2.0.vsix"

title ColumnKit - install

rem Delayed expansion is deliberately still off here. Turning it on before %~1
rem is read eats any "!" in the path, and a folder named "new!" is a perfectly
rem ordinary thing to have. It goes on further down, once the path is captured.
set "VSIX=%~1"
set "COUNT=0"
if "%VSIX%"=="" (
    for %%F in ("%~dp0*.vsix") do (
        set /a COUNT+=1
        set "VSIX=%%~fF"
    )
)
if "%VSIX%"=="" (
    for %%F in ("%~dp0..\dist\*.vsix") do (
        set /a COUNT+=1
        set "VSIX=%%~fF"
    )
)

if "%VSIX%"=="" (
    echo [ERROR] No .vsix found next to this script or in ..\dist.
    echo         Pass one explicitly:  install.cmd "C:\path\to\columnkit-0.2.0.vsix"
    echo.
    pause
    exit /b 1
)
rem More than one and the wildcard picks whichever sorts last, which for 0.9.0
rem beside 0.10.0 is the older build. Better to ask than to install the wrong one.
if %COUNT% GTR 1 (
    echo [ERROR] Found %COUNT% .vsix files, so it is not clear which to install.
    echo         Pass the one you want:  install.cmd "C:\path\to\columnkit-0.2.0.vsix"
    echo.
    pause
    exit /b 1
)
if not exist "%VSIX%" (
    echo [ERROR] Not found: %VSIX%
    echo.
    pause
    exit /b 1
)

rem The release is unsigned, so SHA256SUMS.txt is the only integrity check there
rem is. Verified when the file is present, reported when it is not.
set "SUMS=%~dp0SHA256SUMS.txt"
if not exist "%SUMS%" set "SUMS=%~dp0..\dist\SHA256SUMS.txt"

rem Hashed with certutil, not PowerShell. Windows PowerShell cannot load its own
rem Utility module when it inherits a PowerShell 7 PSModulePath, which is exactly
rem what a pwsh terminal hands to a child cmd. Get-FileHash then does not resolve
rem at all, ACTUAL stays empty, and a perfectly good download was reported as a
rem checksum mismatch with nothing after "Got:". It worked from Explorer, where
rem the environment is clean, so the failure looked intermittent. certutil ships
rem with Windows and has no module path to inherit.
rem
rem `exit /b` from inside nested parentheses does not set the process exit code,
rem so a mismatch reported the failure on screen and still exited 0. The jumps
rem leave the block first and exit at the top level.
rem
rem Delayed expansion is not used out here at all. It would be the obvious way to
rem read ACTUAL back inside an `if exist (...)` block, and it eats any "!" in a
rem path, including the one %~dp0 produces for a folder named "new!". Labels and
rem a subroutine do the same job with none of that.
if not exist "%SUMS%" goto :nosums

rem Checked before :strip as well as after. With ACTUAL undefined, cmd leaves
rem !ACTUAL: =! as the literal " =" and assigns that, so ACTUAL becomes defined
rem and the gate below can never fire: a hash certutil could not compute was
rem reported as "Checksum OK:  =" and the file installed. The integrity check
rem has to fail closed.
for /f "skip=1 delims=" %%H in ('certutil -hashfile "%VSIX%" SHA256') do if not defined ACTUAL set "ACTUAL=%%H"
if not defined ACTUAL goto :nohash
call :strip
if not defined ACTUAL goto :nohash
findstr /i /c:"%ACTUAL%" "%SUMS%" >nul
if errorlevel 1 goto :badsum
echo Checksum OK: %ACTUAL%
goto :verified

:nosums
echo [WARN] No SHA256SUMS.txt beside the .vsix, so the download was not verified.

:verified
echo Installing: %VSIX%
echo.

set "FOUND=0"
set "INSTALLED=0"
call :install "code"   "Visual Studio Code"
call :install "codium" "VSCodium"
call :install "code-insiders" "VS Code Insiders"
call :install "cursor" "Cursor"
call :install "windsurf" "Windsurf"

if "%FOUND%"=="0" (
    echo [ERROR] No VS Code family editor found on PATH.
    echo         Open the editor, then: Extensions view -^> ... -^> Install from VSIX...
    echo.
    pause
    exit /b 1
)
rem Every editor found and every one of them refused. Saying "Done." and
rem exiting 0 there is a lie.
if "%INSTALLED%"=="0" (
    echo.
    echo [ERROR] Every editor found refused the install. Nothing was installed.
    echo.
    pause
    exit /b 1
)

echo.
echo Done. Reload the editor window ^(Command Palette -^> Developer: Reload Window^)
echo and the ColumnKit button appears in the status bar.
echo The status bar has to be visible, or there is nowhere for it to go.
echo.
pause
exit /b 0

rem Older certutil builds print the digest in space-separated groups. Delayed
rem expansion is confined to here, where the only value it touches is a hash.
:strip
setlocal enabledelayedexpansion
set "STRIPPED=!ACTUAL: =!"
endlocal & set "ACTUAL=%STRIPPED%"
exit /b 0

:nohash
echo [ERROR] Could not compute the SHA-256 of %VSIX%
echo         certutil returned no hash, so the file was not verified.
echo         Do not install it until you can check it yourself.
echo.
pause
exit /b 1

:badsum
echo [ERROR] Checksum mismatch for %VSIX%
echo         Expected one of the hashes in %SUMS%
echo         Got: %ACTUAL%
echo         Do not install this file.
echo.
pause
exit /b 1

:install
where %~1 >nul 2>&1
if errorlevel 1 exit /b 0
set "FOUND=1"
echo   %~2 ...
call %~1 --install-extension "%VSIX%" --force
if errorlevel 1 (
    echo   [FAILED] %~2 returned an error.
) else (
    set "INSTALLED=1"
    echo   [OK] %~2
)
exit /b 0
