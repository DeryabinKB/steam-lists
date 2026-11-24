<#
  steam-sync.ps1 — мост между Steam на этом ПК и твоим репо данных Steam Lists.

  Запуск (PowerShell):   powershell -ExecutionPolicy Bypass -File steam-sync.ps1
    без параметров  — выгрузить библиотеку и коллекции Steam в репо (Steam можно не закрывать)
    -Export         — записать списки приложения в коллекции Steam (Steam должен быть ЗАКРЫТ)
    -Reset          — заново ввести настройки
    -Url steamlists://export | steamlists://sync — так его запускают кнопки приложения
    При запуске проверяет новую версию на GitHub и спрашивает, обновиться ли.

  При каждом запуске скрипт копирует себя в %APPDATA%\steam-lists и регистрирует
  ссылку steamlists:// (только для текущего пользователя, без прав админа), чтобы
  кнопка «💾 В Steam» в приложении могла его запустить.

  Настройки хранятся в %APPDATA%\steam-lists\config.json. Токен и ключ зашифрованы
  Windows (DPAPI) — прочитать их можно только под твоей учёткой на этом ПК.
  Пароль Steam скрипту не нужен и не запрашивается.
#>
param([switch]$Export, [switch]$Reset, [int]$MaxNew = 5000, [string]$Url = '')
if ($Url -match 'export') { $Export = $true }
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$utf8 = New-Object Text.UTF8Encoding $false
$dir = Join-Path $env:APPDATA 'steam-lists'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$cfgPath = Join-Path $dir 'config.json'
$metaPath = Join-Path $dir 'meta.json'

# ---------- обновление скрипта: новая версия с GitHub, только с твоего согласия ----------
if (!$env:SL_NOUPDATE -and $PSCommandPath) {
  try {
    $new = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Uri 'https://raw.githubusercontent.com/DeryabinKB/steam-lists/main/tools/steam-sync.ps1').RawContentStream.ToArray()
    $cur = [IO.File]::ReadAllBytes($PSCommandPath)
    if ($new.Length -gt 5000 -and [Convert]::ToBase64String($new) -ne [Convert]::ToBase64String($cur)) {
      $why = ''
      try { $c = Invoke-RestMethod -TimeoutSec 15 -Headers @{ 'User-Agent' = 'steam-lists' } 'https://api.github.com/repos/DeryabinKB/steam-lists/commits?path=tools/steam-sync.ps1&per_page=3'
        $lines = foreach ($x in $c) { '  - ' + ([string]$x.commit.message).Split("`n")[0] + ' (' + $x.commit.author.name + ', ' + ([datetime]$x.commit.author.date).ToString('dd.MM HH:mm') + ')' }; $why = $lines -join "`n" } catch {}
      Write-Host "Есть новая версия скрипта. Последние изменения:`n$why" -ForegroundColor Cyan
      if ((Read-Host "Обновить? [Y/n]") -notmatch '^\s*[nNнН]') {
        [IO.File]::WriteAllBytes($PSCommandPath, $new)
        Write-Host "Обновлено, перезапускаю…" -ForegroundColor Green
        $env:SL_NOUPDATE = '1'
        $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
        foreach ($kv in $PSBoundParameters.GetEnumerator()) { if ($kv.Value -is [switch]) { if ($kv.Value) { $a += "-$($kv.Key)" } } else { $a += "-$($kv.Key)"; $a += [string]$kv.Value } }
        & powershell.exe @a
        exit $LASTEXITCODE
      }
    }
  } catch { Write-Host "Проверка обновлений не удалась (нет сети?), работаю на текущей версии." -ForegroundColor DarkGray }
}

function Protect([string]$s) { if (!$s) { return '' }; ConvertTo-SecureString $s -AsPlainText -Force | ConvertFrom-SecureString }
function Unprotect([string]$s) {
  if (!$s) { return '' }
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString $s))
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function AskSecret($prompt) {
  $ss = Read-Host $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

# ---------- настройки ----------
$bad = $false; if (Test-Path $cfgPath) { $c0 = Get-Content $cfgPath -Raw | ConvertFrom-Json; $bad = !$c0.repo -or !$c0.token }
if ($Reset -or $bad -or !(Test-Path $cfgPath)) {
  Write-Host "Первичная настройка Steam Lists" -ForegroundColor Cyan
  do { $repo = (Read-Host "Репо с данными (логин/steam-lists-data)").Trim() -replace '^https://github\.com/', '' -replace '/$', '' } while ($repo -notmatch '^[\w.-]+/[\w.-]+$')
  do {
    $tok = (AskSecret "Токен GitHub для репо данных (ввод скрыт, вставка — правой кнопкой)").Trim()
    $ok = $false
    if ($tok) { try { Invoke-RestMethod -Uri "https://api.github.com/repos/$repo" -Headers @{ Authorization = "Bearer $tok"; 'User-Agent' = 'steam-lists' } | Out-Null; $ok = $true } catch { Write-Host "Токен не подходит к $repo, попробуй ещё раз." -ForegroundColor Red } }
  } while (!$ok)
  Write-Host "Репо и токен в порядке." -ForegroundColor Green
  Write-Host "Ключ Steam API (steamcommunity.com/dev/apikey). Нужен для полной библиотеки и ачивок."
  $key = AskSecret "Ключ Steam API (Enter — без ключа)"
  @{ repo = $repo.Trim(); token = (Protect $tok.Trim()); steamKey = (Protect $key.Trim()) } | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
}
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$repo = $cfg.repo; $ghTok = Unprotect $cfg.token; $steamKey = Unprotect $cfg.steamKey
$ghHead = @{ Authorization = "Bearer $ghTok"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'steam-lists' }

# ---------- ссылка steamlists:// для кнопок приложения ----------
try {
  $self = Join-Path $dir 'steam-sync.ps1'
  if ($PSCommandPath -and ($PSCommandPath -ne $self)) { Copy-Item $PSCommandPath $self -Force }
  $runCmd = Join-Path $dir 'run.cmd'
  [IO.File]::WriteAllText($runCmd, "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0steam-sync.ps1`" -Url %1`r`npause`r`n", (New-Object Text.ASCIIEncoding))
  $cls = 'HKCU:\Software\Classes\steamlists'
  foreach ($k in @($cls, "$cls\shell", "$cls\shell\open", "$cls\shell\open\command")) { if (!(Test-Path $k)) { New-Item -Path $k | Out-Null } }
  Set-ItemProperty $cls -Name '(default)' -Value 'URL:Steam Lists'
  Set-ItemProperty $cls -Name 'URL Protocol' -Value ''
  Set-ItemProperty "$cls\shell\open\command" -Name '(default)' -Value "`"$runCmd`" `"%1`""
} catch { Write-Host "Не смог зарегистрировать кнопку приложения: $($_.Exception.Message)" -ForegroundColor Yellow }

# ---------- ярлык приложения с иконкой — в папке программы (рядом с tools) ----------
try {
  if ($PSScriptRoot -and ((Split-Path $PSScriptRoot -Leaf) -eq 'tools')) {
    $ico = Join-Path $dir 'icon.ico'
    if (!(Test-Path $ico)) { Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 'https://deryabinkb.github.io/steam-lists/icon.ico' -OutFile $ico }
    $lnk = Join-Path (Split-Path $PSScriptRoot) 'Steam Lists.url'
    [IO.File]::WriteAllText($lnk, "[InternetShortcut]`r`nURL=https://deryabinkb.github.io/steam-lists/`r`nIconFile=$ico`r`nIconIndex=0`r`n", [Text.Encoding]::Default)
  }
} catch {}

function GhSend($method, $url, $obj) {
  Invoke-RestMethod -Method $method -Uri $url -Headers $ghHead -Body ($utf8.GetBytes(($obj | ConvertTo-Json -Depth 8 -Compress))) -ContentType 'application/json; charset=utf-8'
}
# много файлов одним коммитом (Git Data API): $files = @{ 'путь' = 'текст' }
function GhPushFiles($files, $msg) {
  $api = "https://api.github.com/repos/$repo"
  $br = (Invoke-RestMethod $api -Headers $ghHead).default_branch
  for ($try = 0; $try -lt 3; $try++) {
    try {
      $head = (Invoke-RestMethod "$api/git/ref/heads/$br" -Headers $ghHead).object.sha
      $base = (Invoke-RestMethod "$api/git/commits/$head" -Headers $ghHead).tree.sha
      $entries = @($files.GetEnumerator() | ForEach-Object { @{ path = $_.Key; mode = '100644'; type = 'blob'; content = $_.Value } })
      $tree = GhSend Post "$api/git/trees" @{ base_tree = $base; tree = $entries }
      $c = GhSend Post "$api/git/commits" @{ message = $msg; tree = $tree.sha; parents = @($head) }
      GhSend Patch "$api/git/refs/heads/$br" @{ sha = $c.sha } | Out-Null
      return
    } catch { if ($try -eq 2) { throw }; Start-Sleep 3 }
  }
}

function GhGet($path) {
  try { $r = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/$path" -Headers $ghHead }
  catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }; throw }
  if ($r.content) { $txt = $utf8.GetString([Convert]::FromBase64String($r.content)) }
  else { $txt = $utf8.GetString((Invoke-WebRequest -UseBasicParsing -Uri $r.download_url).RawContentStream.ToArray()) }
  return @{ sha = $r.sha; data = ($txt | ConvertFrom-Json) }
}
function GhPut($path, $json, $msg) {
  $old = $null; try { $old = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/$path" -Headers $ghHead } catch {}
  $body = @{ message = $msg; content = [Convert]::ToBase64String($utf8.GetBytes($json)) }
  if ($old) { $body.sha = $old.sha }
  Invoke-RestMethod -Method Put -Uri "https://api.github.com/repos/$repo/contents/$path" -Headers $ghHead `
    -Body ($utf8.GetBytes(($body | ConvertTo-Json))) -ContentType 'application/json; charset=utf-8' | Out-Null
}

# ---------- где Steam и чей аккаунт ----------
$steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam').SteamPath -replace '/', '\'
$login = Get-Content (Join-Path $steam 'config\loginusers.vdf') -Raw
$id64 = $null
foreach ($m in [regex]::Matches($login, '"(7656\d{13})"\s*\{([^}]*)\}')) {
  if (!$id64 -or $m.Groups[2].Value -match '"MostRecent"\s*"1"') { $id64 = $m.Groups[1].Value }
}
if (!$id64) { throw "Не нашёл аккаунт Steam в $steam\config\loginusers.vdf" }
$acc = [string]([decimal]$id64 - 76561197960265728)
$udir = Join-Path $steam "userdata\$acc\config"
$nsFile = Join-Path $udir 'cloudstorage\cloud-storage-namespace-1.json'
$nsVerFile = Join-Path $udir 'cloudstorage\cloud-storage-namespaces.json'
Write-Host "Steam: $steam, аккаунт $id64" -ForegroundColor DarkGray

function ReadCollections {
  $res = @{ list = New-Object System.Collections.ArrayList; dynamic = New-Object System.Collections.ArrayList; raw = $null }
  if (!(Test-Path $nsFile)) { return $res }
  $raw = [IO.File]::ReadAllText($nsFile, $utf8) | ConvertFrom-Json
  $res.raw = $raw
  foreach ($pair in $raw) {
    $k = $pair[0]; $e = $pair[1]
    if ($k -notlike 'user-collections.*' -or $e.is_deleted -or !$e.value) { continue }
    $v = $e.value | ConvertFrom-Json
    if ($v.id -eq 'hidden') { continue }
    $name = if ($v.id -eq 'favorite') { 'Избранное' } else { $v.name }
    if ($v.filterSpec) { [void]$res.dynamic.Add($name); continue }
    $rm = @($v.removed)
    $apps = @(@($v.added) | Where-Object { $_ -and $rm -notcontains $_ } | ForEach-Object { [int]$_ })
    [void]$res.list.Add([ordered]@{ id = $v.id; name = $name; apps = $apps })
  }
  return $res
}

# ======================================================================
if ($Export) {
  $steamExe = Join-Path $steam 'steam.exe'; $wasRunning = $false
  if (Get-Process steam -ErrorAction SilentlyContinue) {
    Write-Host "Запись списков в Steam. Steam сейчас открыт: закрою его, запишу коллекции и запущу снова." -ForegroundColor Cyan
    Read-Host "Enter — продолжить (закрой открытые игры), Ctrl+C — отмена" | Out-Null
    $wasRunning = $true
    Start-Process $steamExe -ArgumentList '-shutdown'
    $t = 0; while ((Get-Process steam -ErrorAction SilentlyContinue) -and $t -lt 90) { Start-Sleep 1; $t++ }
    if (Get-Process steam -ErrorAction SilentlyContinue) { throw "Steam не закрылся за 90 сек. Закрой вручную (трей → Выход) и нажми кнопку снова." }
    Start-Sleep 2
  }
  if (!(Test-Path $nsFile)) { throw "Не найден файл коллекций: $nsFile" }
  $lf = GhGet 'lists.json'; if (!$lf) { throw "В репо нет lists.json — сначала создай списки в приложении." }
  $bak = Join-Path $dir ("backup\cloud-storage-namespace-1." + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
  New-Item -ItemType Directory -Force -Path (Split-Path $bak) | Out-Null
  Copy-Item $nsFile $bak; if (Test-Path $nsVerFile) { Copy-Item $nsVerFile ($bak -replace 'namespace-1', 'namespaces') }
  Write-Host "Бэкап коллекций Steam: $bak"

  $raw = [IO.File]::ReadAllText($nsFile, $utf8) | ConvertFrom-Json
  $maxVer = 0; foreach ($p in $raw) { if ([int64]$p[1].version -gt $maxVer) { $maxVer = [int64]$p[1].version } }
  if (Test-Path $nsVerFile) { foreach ($p in ([IO.File]::ReadAllText($nsVerFile, $utf8) | ConvertFrom-Json)) { if ([int64]$p[1] -gt $maxVer) { $maxVer = [int64]$p[1] } } }
  $ver = [string]($maxVer + 1); $now = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  $byKey = @{}; $out = New-Object System.Collections.ArrayList
  foreach ($p in $raw) { $byKey[$p[0]] = $p[1]; [void]$out.Add($p) }
  $listsChanged = $false; $n = 0
  foreach ($l in $lf.data.lists) {
    if ($null -ne $l.query) { continue }   # умные списки в Steam не выгружаем
    $cid = $l.steamId
    if (!$cid -or $cid -eq 'favorite') { if ($cid -ne 'favorite') { $cid = 'uc-' + -join ((48..57) + (97..122) | Get-Random -Count 12 | ForEach-Object { [char]$_ }); $l | Add-Member -Force steamId $cid; $listsChanged = $true } }
    $key = "user-collections.$cid"
    $items = @($l.items | ForEach-Object { [int]$_ })
    $prev = @()
    if ($byKey[$key] -and $byKey[$key].value) { $pv = $byKey[$key].value | ConvertFrom-Json; $prev = @(@($pv.added) + @($pv.removed) | ForEach-Object { [int]$_ }) }
    $removed = @($prev | Where-Object { $items -notcontains $_ } | Select-Object -Unique)
    $name = if ($cid -eq 'favorite') { 'favorite' } else { $l.name }
    $val = [ordered]@{ id = $cid; name = $name; added = $items; removed = $removed } | ConvertTo-Json -Compress -Depth 5
    $entry = [pscustomobject][ordered]@{ key = $key; timestamp = $now; value = $val; version = $ver; conflictResolutionMethod = 'custom'; strMethodId = 'union-collections' }
    if ($byKey.ContainsKey($key)) { for ($i = 0; $i -lt $out.Count; $i++) { if ($out[$i][0] -eq $key) { $out[$i] = @($key, $entry) } } }
    else { [void]$out.Add(@($key, $entry)) }
    $n++
  }
  $json = '[' + (($out | ForEach-Object { '[' + ($_[0] | ConvertTo-Json) + ',' + ($_[1] | ConvertTo-Json -Compress -Depth 5) + ']' }) -join ',') + ']'
  [IO.File]::WriteAllText($nsFile, $json, $utf8)
  if (Test-Path $nsVerFile) { [IO.File]::WriteAllText($nsVerFile, "[[1,`"$ver`"]]", $utf8) }
  if ($listsChanged) { GhPut 'lists.json' ($lf.data | ConvertTo-Json -Depth 6) 'steam-sync: id коллекций Steam' }
  Write-Host "Готово: записано списков в Steam: $n. Проверь коллекции в Steam." -ForegroundColor Green
  if ($wasRunning) { Write-Host "Запускаю Steam…"; Start-Process $steamExe }
  Write-Host "Если что-то не так: закрой Steam и скопируй бэкап обратно в $nsFile"
  exit
}

# ======================================================================
# 1) коллекции Steam
$col = ReadCollections
$scJson = [ordered]@{ updated = (Get-Date).ToUniversalTime().ToString('o'); collections = @($col.list); dynamic = @($col.dynamic) } | ConvertTo-Json -Depth 6
Write-Host "Коллекций Steam: $($col.list.Count) (динамических пропущено: $($col.dynamic.Count))"

# 2) библиотека
$meta = @{}
if (Test-Path $metaPath) { (Get-Content $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $meta[$_.Name] = $_.Value } }
$games = @{}
$fromApi = $false
if ($steamKey) {
  $r = Invoke-RestMethod "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=$steamKey&steamid=$id64&include_appinfo=1&include_played_free_games=1&format=json"
  if ($r.response.game_count) {
    $fromApi = $true
    foreach ($g in $r.response.games) { $games[[string]$g.appid] = @{ appid = [int]$g.appid; name = $g.name; hours = [math]::Round($g.playtime_forever / 60, 1); last = [int64]$g.rtime_last_played } }
    Write-Host "Steam API: игр $($r.response.game_count)"
  } else { Write-Host "Steam API вернул пусто (закрытый профиль?). Беру локальные данные." -ForegroundColor Yellow }
}
if (!$fromApi) {
  # локально: сыгранное из localconfig.vdf + установленное + всё из коллекций
  $lc = Join-Path $udir 'localconfig.vdf'
  if (Test-Path $lc) {
    $t = Get-Content $lc -Raw -Encoding UTF8
    $i = $t.IndexOf('"apps"'); if ($i -ge 0) {
      foreach ($m in [regex]::Matches($t.Substring($i), '"(\d+)"\s*\{([^{}]*)\}')) {
        $b = $m.Groups[2].Value; $pt = [regex]::Match($b, '"Playtime"\s*"(\d+)"'); $lp = [regex]::Match($b, '"LastPlayed"\s*"(\d+)"')
        if ($pt.Success -or $lp.Success) { $games[$m.Groups[1].Value] = @{ appid = [int]$m.Groups[1].Value; hours = [math]::Round(([int]$pt.Groups[1].Value) / 60, 1); last = [int64]$lp.Groups[1].Value } }
      }
    }
  }
  $libs = @(Join-Path $steam 'steamapps')
  $lf2 = Join-Path $steam 'steamapps\libraryfolders.vdf'
  if (Test-Path $lf2) { foreach ($m in [regex]::Matches((Get-Content $lf2 -Raw), '"path"\s*"([^"]+)"')) { $libs += (Join-Path ($m.Groups[1].Value -replace '\\\\', '\') 'steamapps') } }
  foreach ($l in ($libs | Select-Object -Unique)) {
    Get-ChildItem -Path $l -Filter 'appmanifest_*.acf' -ErrorAction SilentlyContinue | ForEach-Object {
      $t = Get-Content $_.FullName -Raw -Encoding UTF8
      $id = [regex]::Match($t, '"appid"\s*"(\d+)"').Groups[1].Value; $nm = [regex]::Match($t, '"name"\s*"([^"]*)"').Groups[1].Value
      if ($id) { if (!$games[$id]) { $games[$id] = @{ appid = [int]$id; hours = 0; last = 0 } }; $games[$id].name = $nm }
    }
  }
  foreach ($c in $col.list) { foreach ($a in $c.apps) { if (!$games["$a"]) { $games["$a"] = @{ appid = [int]$a; hours = 0; last = 0 } } } }
  Write-Host "Локально найдено игр: $($games.Count) (без ключа — только сыгранные, установленные и из коллекций)"
}

# 3) жанры/теги (магазин Steam + SteamSpy), кэш в meta.json, не больше $MaxNew новых за запуск
$todo = @($games.Keys | Where-Object { !$meta[$_] -or !$meta[$_].t })
if ($todo.Count) { Write-Host "Жанры и теги: новых игр $($todo.Count), за этот запуск беру до $MaxNew (~2 сек на игру)" }
$k = 0
foreach ($id in ($todo | Select-Object -First $MaxNew)) {
  $k++; Write-Progress -Activity 'Жанры и теги' -Status "$k / $([math]::Min($todo.Count, $MaxNew))" -PercentComplete (100 * $k / [math]::Min($todo.Count, $MaxNew))
  $m = [ordered]@{ name = $null; genres = @(); tags = @(); t = 1 }
  try {
    $s = Invoke-RestMethod "https://store.steampowered.com/api/appdetails?appids=$id&l=russian&cc=ru&filters=basic,genres"
    $d = $s.$id
    if ($d.success) { $m.name = $d.data.name; $m.genres = @($d.data.genres | ForEach-Object { $_.description }) }
  } catch { Start-Sleep 30 }
  try {
    $sp = Invoke-RestMethod "https://steamspy.com/api.php?request=appdetails&appid=$id"
    if ($sp.tags) { $m.tags = @($sp.tags.PSObject.Properties | Sort-Object { -[int]$_.Value } | Select-Object -First 12 | ForEach-Object { $_.Name }) }
    if (!$m.name -and $sp.name) { $m.name = $sp.name }
  } catch {}
  if ($meta[$id] -and $meta[$id].ach) { $m.ach = $meta[$id].ach; $m.achLast = $meta[$id].achLast }
  $meta[$id] = [pscustomobject]$m
  Start-Sleep -Milliseconds 1500
  if ($k % 25 -eq 0) { $meta | ConvertTo-Json -Depth 5 | Set-Content $metaPath -Encoding UTF8 }
}
Write-Progress -Activity 'Жанры и теги' -Completed

# 3b) обложки: у новых игр стандартной картинки нет — берём адрес из магазина (один раз на игру)
$imgTodo = @($games.Keys | Where-Object { $meta[$_] -and $null -eq $meta[$_].img })
if ($imgTodo.Count) { Write-Host "Обложки: проверяю $($imgTodo.Count) игр" }
$k = 0
foreach ($id in $imgTodo) {
  $k++; Write-Progress -Activity 'Обложки' -Status "$k / $($imgTodo.Count)" -PercentComplete (100 * $k / $imgTodo.Count)
  $img = ''
  try { Invoke-WebRequest -UseBasicParsing -Method Head "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/$id/capsule_184x69.jpg" | Out-Null }
  catch {
    try { $s = Invoke-RestMethod "https://store.steampowered.com/api/appdetails?appids=$id&filters=basic"; if ($s.$id.success) { $img = [string]$s.$id.data.header_image } } catch {}
    Start-Sleep -Milliseconds 1500
  }
  $meta[$id] | Add-Member -Force img $img
}
Write-Progress -Activity 'Обложки' -Completed

# прогресс ачивок (34/100): связь «счётчик → ачивка» есть только в файлах Steam на ПК
# (appcache\stats\UserGameStatsSchema_<appid>.bin, бинарный KeyValues)
function KvStr { $s0 = $script:kp; while ($script:kb[$script:kp] -ne 0) { $script:kp++ }; $r = $utf8.GetString($script:kb, $s0, $script:kp - $s0); $script:kp++; return $r }
function KvNode {
  $o = @{}
  while ($script:kp -lt $script:kb.Length) {
    $t = $script:kb[$script:kp]; $script:kp++
    if ($t -eq 8 -or $t -eq 11) { break }
    $name = KvStr
    switch ($t) {
      0 { $o[$name] = KvNode }
      1 { $o[$name] = KvStr }
      2 { $o[$name] = [BitConverter]::ToInt32($script:kb, $script:kp); $script:kp += 4 }
      3 { $o[$name] = [BitConverter]::ToSingle($script:kb, $script:kp); $script:kp += 4 }
      4 { $script:kp += 4 }
      5 { while ($script:kb[$script:kp] -ne 0 -or $script:kb[$script:kp + 1] -ne 0) { $script:kp += 2 }; $script:kp += 2 }
      6 { $script:kp += 4 }
      7 { $o[$name] = [BitConverter]::ToUInt64($script:kb, $script:kp); $script:kp += 8 }
      10 { $o[$name] = [BitConverter]::ToInt64($script:kb, $script:kp); $script:kp += 8 }
      default { throw "kv: тип $t" }
    }
  }
  return $o
}
function FindProg($node, $map) {
  foreach ($k in @($node.Keys)) {
    $v = $node[$k]
    if ($v -isnot [hashtable]) { continue }
    if ($v.ContainsKey('progress') -and $v.ContainsKey('name') -and $v['progress'] -is [hashtable]) {
      $p = $v['progress']; $op = $null
      if ($p['value'] -is [hashtable]) { $op = $p['value']['operand1'] }
      if ($op) { try { $map[[string]$v['name']] = @([string]$op, [double]$p['min_val'], [double]$p['max_val']) } catch {} }
    }
    FindProg $v $map
  }
}
function ReadProg($appid) {
  $f = Join-Path $steam "appcache\stats\UserGameStatsSchema_$appid.bin"
  if (!(Test-Path $f)) { return $null }
  try { $script:kb = [IO.File]::ReadAllBytes($f); $script:kp = 0; $root = KvNode; $map = @{}; FindProg $root $map; return $map } catch { return @{} }
}

# 4) карточки игр: описание из магазина + все ачивки (иконки, редкость, дата) → games/<appid>.json
#    первый раз долго (все игры), дальше — только новые и те, в которые играл с прошлого раза
$gdir = Join-Path $dir 'games'; New-Item -ItemType Directory -Force -Path $gdir | Out-Null
$pendPath = Join-Path $dir 'pending.json'
$pending = New-Object 'System.Collections.Generic.HashSet[string]'
if (Test-Path $pendPath) { foreach ($x in @(Get-Content $pendPath -Raw | ConvertFrom-Json)) { if ($x) { [void]$pending.Add([string]$x) } } }
function SavePending { [IO.File]::WriteAllText($pendPath, '[' + (($pending | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']', $utf8) }
$work = New-Object System.Collections.ArrayList
foreach ($g in $games.Values) {
  $id = "$($g.appid)"; $f = Join-Path $gdir "$id.json"; $d = $null
  if (Test-Path $f) { try { $d = [IO.File]::ReadAllText($f, $utf8) | ConvertFrom-Json } catch {} }
  $needInfo = !$d -or !$d.info
  $needAch = [bool]$steamKey -and (!$d -or $null -eq $d.achLast -or ([int64]$d.achLast -ne [int64]$g.last))
  # прогресс ещё не собирали, а файл схемы Steam есть
  if (!$needAch -and $steamKey -and $d -and @($d.ach).Count -and $null -eq $d.prog -and (Test-Path (Join-Path $steam "appcache\stats\UserGameStatsSchema_$id.bin"))) { $needAch = $true }
  if ($needInfo -or $needAch) { [void]$work.Add(@($g, $d, $needInfo, $needAch)) }
}
$total = [math]::Min($work.Count, $MaxNew)
if ($total) { Write-Host "Карточки игр и ачивки: $($work.Count) игр (~2-3 сек на игру; первый раз долго, дальше только изменения)" }
$k = 0
foreach ($w in ($work | Select-Object -First $MaxNew)) {
  $g = $w[0]; $d = $w[1]; $needInfo = $w[2]; $needAch = $w[3]; $id = "$($g.appid)"
  $k++; Write-Progress -Activity 'Карточки игр и ачивки' -Status "$k / $total" -PercentComplete (100 * $k / $total)
  $out = [ordered]@{ appid = $g.appid; name = $g.name; info = $null; ach = @(); achLast = $null; prog = $null; stats = $null; updated = (Get-Date).ToUniversalTime().ToString('o') }
  if ($d) { if ($d.name) { $out.name = $d.name }; $out.info = $d.info; $out.ach = @($d.ach | Where-Object { $_ }); $out.achLast = $d.achLast; $out.prog = $d.prog; $out.stats = $d.stats }
  if ($needInfo) {
    try {
      $s = Invoke-RestMethod "https://store.steampowered.com/api/appdetails?appids=$id&l=russian&cc=ru"
      $sd = $s.$id
      $inf = [ordered]@{ desc = ''; dev = @(); pub = @(); release = ''; mc = $null; site = ''; shots = @() }
      if ($sd.success) {
        $x = $sd.data; $out.name = $x.name
        $inf.desc = [string]$x.short_description; $inf.release = [string]$x.release_date.date; $inf.site = [string]$x.website
        $inf.dev = @($x.developers | Where-Object { $_ }); $inf.pub = @($x.publishers | Where-Object { $_ })
        if ($x.metacritic) { $inf.mc = [int]$x.metacritic.score }
        $inf.shots = @($x.screenshots | Select-Object -First 6 | ForEach-Object { $_.path_thumbnail })
      }
      $out.info = $inf
    } catch { Start-Sleep 30 }   # магазин ограничил частоту — эта игра догрузится в следующий раз
    Start-Sleep -Milliseconds 1500
  }
  if ($needAch) {
    $list = @($out.ach)
    if (!$list.Count) {
      try {
        $sc = Invoke-RestMethod "https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=$steamKey&appid=$id&l=russian"
        $list = @($sc.game.availableGameStats.achievements | Where-Object { $_ } | ForEach-Object {
          [pscustomobject][ordered]@{ id = $_.name; n = $_.displayName; d = [string]$_.description; i = $_.icon; g = $_.icongray; h = [int]$_.hidden; p = $null; t = 0 } })
      } catch {}
    }
    if ($list.Count) {
      try {
        $gp = Invoke-RestMethod "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=$id"
        $pm = @{}; foreach ($x in @($gp.achievementpercentages.achievements)) { $pm[[string]$x.name] = [math]::Round([double]$x.percent, 1) }
        foreach ($a in $list) { if ($pm.ContainsKey([string]$a.id)) { $a.p = $pm[[string]$a.id] } }
      } catch {}
      if ($g.hours -gt 0) {
        try {
          $pa = Invoke-RestMethod "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=$steamKey&steamid=$id64&appid=$id"
          $um = @{}; foreach ($x in @($pa.playerstats.achievements)) { if ($x.achieved -eq 1) { $um[[string]$x.apiname] = [math]::Max([int64]$x.unlocktime, [int64]1) } }
          foreach ($a in $list) { $a.t = $(if ($um.ContainsKey([string]$a.id)) { $um[[string]$a.id] } else { 0 }) }
        } catch {}
      }
    }
    if ($list.Count) {
      $pm = ReadProg $id
      if ($null -ne $pm) { $out.prog = $pm }
      if ($pm -and $pm.Count -and $g.hours -gt 0) {
        try {
          $us = Invoke-RestMethod "https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?key=$steamKey&steamid=$id64&appid=$id"
          $sv = @{}; foreach ($x in @($us.playerstats.stats)) { if ($x) { $sv[[string]$x.name] = $x.value } }; $out.stats = $sv
        } catch {}
      }
    }
    $out.ach = $list; $out.achLast = $g.last
    $ach = $null; if ($list.Count -and $g.hours -gt 0) { $ach = @(@($list | Where-Object { $_.t -gt 0 }).Count, $list.Count) }
    if (!$meta[$id]) { $meta[$id] = [pscustomobject]@{ t = 0 } }
    $meta[$id] | Add-Member -Force ach $ach; $meta[$id] | Add-Member -Force achLast $g.last
  }
  [IO.File]::WriteAllText((Join-Path $gdir "$id.json"), ($out | ConvertTo-Json -Depth 6 -Compress), $utf8)
  [void]$pending.Add($id)
  if ($k % 25 -eq 0) { $meta | ConvertTo-Json -Depth 5 | Set-Content $metaPath -Encoding UTF8; SavePending }
}
Write-Progress -Activity 'Карточки игр и ачивки' -Completed
SavePending
$meta | ConvertTo-Json -Depth 5 | Set-Content $metaPath -Encoding UTF8

# 5) собрать и отправить
$list = foreach ($g in $games.Values) {
  $m = $meta["$($g.appid)"]
  $name = if ($g.name) { $g.name } elseif ($m.name) { $m.name } else { "App $($g.appid)" }
  [ordered]@{ appid = $g.appid; name = $name; hours = $g.hours; last = $g.last; genres = @($m.genres); tags = @($m.tags); img = $(if ($m.img) { $m.img } else { $null }); ach = $(if ($m.ach) { @($m.ach) } else { $null }) }
}
$lib = [ordered]@{ version = 1; steamid = $id64; source = $(if ($fromApi) { 'api' } else { 'local' }); updated = (Get-Date).ToUniversalTime().ToString('o'); games = @($list) }
GhPut 'library.json' ($lib | ConvertTo-Json -Depth 6 -Compress) "steam-sync: библиотека ($($games.Count) игр)"
GhPut 'steam-collections.json' $scJson 'steam-sync: коллекции Steam'
Write-Host "Готово: в репо отправлено $($games.Count) игр и $($col.list.Count) коллекций." -ForegroundColor Green

# 6) карточки игр — пачками по 60 файлов, одним коммитом каждая
if ($pending.Count) {
  $ids = @($pending); Write-Host "Отправляю карточки игр: $($ids.Count)"
  try {
    for ($i = 0; $i -lt $ids.Count; $i += 60) {
      $batch = @($ids[$i..([math]::Min($i + 59, $ids.Count - 1))])
      Write-Progress -Activity 'Отправка карточек' -Status "$i / $($ids.Count)" -PercentComplete (100 * $i / $ids.Count)
      $files = @{}; foreach ($id in $batch) { $f = Join-Path $gdir "$id.json"; if (Test-Path $f) { $files["games/$id.json"] = [IO.File]::ReadAllText($f, $utf8) } }
      if ($files.Count) { GhPushFiles $files "steam-sync: карточки игр ($($files.Count))" }
      foreach ($id in $batch) { [void]$pending.Remove($id) }; SavePending
    }
    Write-Progress -Activity 'Отправка карточек' -Completed
    Write-Host "Карточки отправлены." -ForegroundColor Green
  } catch { Write-Host "Карточки отправлены не все ($($pending.Count) осталось) — догрузятся при следующем запуске. $($_.Exception.Message)" -ForegroundColor Yellow }
}
if ($todo.Count -gt $MaxNew) { Write-Host "Жанры получены не для всех ($($todo.Count - $MaxNew) осталось) — запусти ещё раз позже." -ForegroundColor Yellow }
