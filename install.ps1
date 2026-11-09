# Установка мини-плеера: находит Python, ставит библиотеки, создаёт ярлык на рабочем столе.
param([switch]$NoShortcut, [switch]$AllowTemp)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
Say ''
Say '=== Мини-плеер: установка ===' Cyan
Say "Папка: $here"
Say ''

if (-not $AllowTemp -and ($here -match '\\AppData\\Local\\Temp\\' -or $here -match '\.zip')) {
    Say 'Похоже, ты запустил установку прямо из архива.' Yellow
    Say 'Сначала распакуй архив в обычную папку (например, C:\MiniPlayer), потом запусти install.bat оттуда.' Yellow
    exit 1
}

# ---------- 1. Python 3.10+ ----------
function Find-Python {
    $candidates = @(@('py', '-3.12'), @('py', '-3.13'), @('py', '-3.11'), @('py', '-3.10'), @('py', '-3'), @('python'),
                    @("$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"))
    foreach ($c in $candidates) {
        $exe = $c[0]
        $rest = @($c | Select-Object -Skip 1)
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        try {
            $ver = & $exe @rest -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        } catch { continue }
        if ($LASTEXITCODE -eq 0 -and "$ver" -match '^3\.(\d+)$' -and [int]$Matches[1] -ge 10) {
            return , $c
        }
    }
    return $null
}

$py = Find-Python
if (-not $py) {
    Say 'Python 3.10 или новее не найден.' Yellow
    $ans = Read-Host 'Установить Python 3.12 автоматически через winget? (Y/N)'
    if ($ans -match '^[YyДд]') {
        winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
        $py = Find-Python
    }
    if (-not $py) {
        Say 'Установи Python с https://www.python.org/downloads/ (галочка «Add python.exe to PATH»), потом запусти install.bat ещё раз.' Yellow
        Start-Process 'https://www.python.org/downloads/'
        exit 1
    }
}
$pyExe = $py[0]
$pyArgs = @($py | Select-Object -Skip 1)
Say ("Python: " + (& $pyExe @pyArgs --version)) Green

# ---------- 2. Окружение и библиотеки ----------
$venvPy = Join-Path $here '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
    Say 'Создаю окружение...'
    & $pyExe @pyArgs -m venv (Join-Path $here '.venv')
    if ($LASTEXITCODE -ne 0) { Say 'Не получилось создать окружение Python.' Red; exit 1 }
}
Say 'Ставлю библиотеки (1-3 минуты)...'
& $venvPy -m pip install --disable-pip-version-check -q --upgrade pip
& $venvPy -m pip install --disable-pip-version-check -q -r (Join-Path $here 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Say 'Библиотеки не установились. Проверь интернет и запусти install.bat ещё раз.' Red; exit 1 }
Say 'Библиотеки установлены.' Green

# ---------- 3. Ярлык ----------
if (-not $NoShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desktop 'Мини-плеер.lnk'
    $sh = New-Object -ComObject WScript.Shell
    $l = $sh.CreateShortcut($lnk)
    $l.TargetPath = Join-Path $here '.venv\Scripts\pythonw.exe'
    $l.Arguments = '"' + (Join-Path $here 'server.py') + '" --open'
    $l.WorkingDirectory = $here
    $l.IconLocation = "$env:SystemRoot\System32\imageres.dll,103"
    $l.Description = 'Мини-плеер на экране телефона'
    $l.Save()
    Say "Ярлык создан: $lnk" Green
}

Say ''
Say 'Готово! Подключи телефон через spacedesk (см. «ПРОЧТИ МЕНЯ.txt») и запусти ярлык «Мини-плеер» на рабочем столе.' Cyan
