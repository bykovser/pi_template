@echo off
REM Clerk Ping — запускает pi в batch режиме, генерирует пинг и отправляет уведомление

setlocal

set PI_DIR=%USERPROFILE%\AppData\Local\pi-node\current
set AGENT_DIR=%USERPROFILE%\.pi\agent
set PING_FILE=%AGENT_DIR%\extensions\clerk\data\pings.md

REM Получаем текущее время
for /f "tokens=1-3 delims=:., " %%a in ("%TIME%") do set HOUR=%%a & set MIN=%%b

REM Определяем контекст времени
if %HOUR% GEQ 7 if %HOUR% LSS 12 set PERIOD=utro
if %HOUR% GEQ 12 if %HOUR% LSS 18 set PERIOD=den
if %HOUR% GEQ 18 if %HOUR% LSS 23 set PERIOD=vecher
if %HOUR% GEQ 23 set PERIOD=noch
if %HOUR% LSS 7 set PERIOD=noch

REM Запускаем pi с генерацией пинга
"%PI_DIR%\pi.cmd" -p --model deepseek/deepseek-v4-flash --print "[Clerk Ping] Ты — Жанночка, второй мозг Серёги. Время ~%TIME%, период: %PERIOD%. Посмотри на контекст — его задачи, интересы. Придумай короткий пинг (1-2 предложения) на русском, с матом, чёрный юмор. Что ему сказать? После генерации запиши пинг в файл %PING_FILE% (добавь строку с датой и текстом). И отправь Windows Toast уведомление через PowerShell: title='🧠 Clerk', body='текст пинга'."

echo.
echo Clerk ping complete at %DATE% %TIME%