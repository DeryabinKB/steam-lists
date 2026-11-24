<#
  steam-sync.ps1 — мост между Steam на этом ПК и твоим репо данных Steam Lists.

  Запуск (PowerShell):   powershell -ExecutionPolicy Bypass -File steam-sync.ps1
    без параметров  — выгрузить библиотеку и коллекции Steam в репо (Steam можно не закрывать)
    -Export         — записать списки приложения в коллекции Steam (Steam должен быть ЗАКРЫТ)
    -Reset          — заново ввести настройки

  Настройки хранятся в %APPDATA%\steam-lists\config.json. Токен и ключ зашифрованы
  Windows (DPAPI) — прочитать их можно только под твоей учёткой на этом ПК.
  Пароль Steam скрипту не нужен и не запрашивается.
#>
param([switch]$Export, [switch]$Reset, [int]$MaxNew = 5000)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$utf8 = New-Object Text.UTF8Encoding $false
$dir = Join-Path $env:APPDATA 'steam-lists'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$cfgPath = Join-Path $dir 'config.json'
$metaPath = Join-Path $dir 'meta.json'

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
  if (Get-Process steam -ErrorAction SilentlyContinue) { throw "Закрой Steam полностью (трей → Выход) и запусти снова." }
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
  Write-Host "Готово: записано списков в Steam: $n. Запусти Steam и проверь коллекции." -ForegroundColor Green
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

# 4) ачивки (только с ключом; обновляются у игр, в которые играл с прошлого раза)
if ($steamKey) {
  $need = @($games.Values | Where-Object { $_.hours -gt 0 -and (!$meta["$($_.appid)"] -or $meta["$($_.appid)"].achLast -ne $_.last) })
  if ($need.Count) { Write-Host "Ачивки: обновляю $($need.Count) игр" }
  $k = 0
  foreach ($g in $need) {
    $k++; Write-Progress -Activity 'Ачивки' -Status "$k / $($need.Count)" -PercentComplete (100 * $k / $need.Count)
    $id = "$($g.appid)"; $ach = $null
    try {
      $a = Invoke-RestMethod "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=$steamKey&steamid=$id64&appid=$id"
      if ($a.playerstats.achievements) { $all = @($a.playerstats.achievements); $ach = @(@($all | Where-Object { $_.achieved -eq 1 }).Count, $all.Count) }
    } catch {}
    if (!$meta[$id]) { $meta[$id] = [pscustomobject]@{ t = 0 } }
    $meta[$id] | Add-Member -Force ach $ach; $meta[$id] | Add-Member -Force achLast $g.last
  }
  Write-Progress -Activity 'Ачивки' -Completed
}
$meta | ConvertTo-Json -Depth 5 | Set-Content $metaPath -Encoding UTF8

# 5) собрать и отправить
$list = foreach ($g in $games.Values) {
  $m = $meta["$($g.appid)"]
  $name = if ($g.name) { $g.name } elseif ($m.name) { $m.name } else { "App $($g.appid)" }
  [ordered]@{ appid = $g.appid; name = $name; hours = $g.hours; last = $g.last; genres = @($m.genres); tags = @($m.tags); ach = $(if ($m.ach) { @($m.ach) } else { $null }) }
}
$lib = [ordered]@{ version = 1; steamid = $id64; source = $(if ($fromApi) { 'api' } else { 'local' }); updated = (Get-Date).ToUniversalTime().ToString('o'); games = @($list) }
GhPut 'library.json' ($lib | ConvertTo-Json -Depth 6 -Compress) "steam-sync: библиотека ($($games.Count) игр)"
GhPut 'steam-collections.json' $scJson 'steam-sync: коллекции Steam'
Write-Host "Готово: в репо отправлено $($games.Count) игр и $($col.list.Count) коллекций." -ForegroundColor Green
if ($todo.Count -gt $MaxNew) { Write-Host "Жанры получены не для всех ($($todo.Count - $MaxNew) осталось) — запусти ещё раз позже." -ForegroundColor Yellow }
