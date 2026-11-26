#requires -Version 5.1
<#
.SYNOPSIS
  重新生成 Android 工程的签名配置（幂等），用于在 `tauri android init` 覆盖
  src-tauri/gen/android 之后恢复 release 签名。

.DESCRIPTION
  1. 从仓库之外的 signing.properties 读取 keystore 信息；
  2. 写入 src-tauri/gen/android/keystore.properties；
  3. 若 app/build.gradle.kts 尚未包含签名配置，则打补丁（已包含则跳过）。

.PARAMETER SourceProperties
  签名源配置路径，默认 %USERPROFILE%\.catchup-keystore\signing.properties

.PARAMETER AndroidProjectDir
  Tauri 生成的 Android 工程目录，默认 <repo>\src-tauri\gen\android

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\android-signing.ps1
#>
[CmdletBinding()]
param(
    [string]$SourceProperties = (Join-Path $env:USERPROFILE '.catchup-keystore\signing.properties'),
    [string]$AndroidProjectDir = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($AndroidProjectDir)) {
    $AndroidProjectDir = Join-Path $repoRoot 'src-tauri\gen\android'
}

$gradleFile = Join-Path $AndroidProjectDir 'app\build.gradle.kts'
$keystorePropsFile = Join-Path $AndroidProjectDir 'keystore.properties'

if (-not (Test-Path $gradleFile)) {
    Write-Warning "未找到 $gradleFile —— 请先运行 npx tauri android init，本次跳过签名配置。"
    exit 0
}

if (-not (Test-Path $SourceProperties)) {
    Write-Error "缺少签名源配置：$SourceProperties"
    exit 1
}

# ---- 1. 读取源配置 ----
$src = @{}
Get-Content -LiteralPath $SourceProperties | ForEach-Object {
    if ($_ -match '^\s*([^#=\s][^=]*?)\s*=\s*(.*)$') {
        $src[$matches[1].Trim()] = $matches[2].Trim()
    }
}
foreach ($key in @('storeFile', 'storePassword', 'keyAlias', 'keyPassword')) {
    if (-not $src.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($src[$key])) {
        Write-Error "签名源配置缺少字段：$key"
        exit 1
    }
}
if (-not (Test-Path $src['storeFile'])) {
    Write-Error "keystore 文件不存在：$($src['storeFile'])"
    exit 1
}

# ---- 2. 写 keystore.properties（Java Properties 需转义反斜杠）----
$escapedStoreFile = $src['storeFile'].Replace('\', '\\')
$propsText = @(
    "storeFile=$escapedStoreFile",
    "storePassword=$($src['storePassword'])",
    "keyAlias=$($src['keyAlias'])",
    "keyPassword=$($src['keyPassword'])"
) -join "`r`n"
[System.IO.File]::WriteAllText($keystorePropsFile, $propsText + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[1/3] keystore.properties 已写入：$keystorePropsFile"

# ---- 2. 应用名（启动器/最近任务显示，避免 "追更 CatchUp" 被截断）----
$stringsFile = Join-Path $AndroidProjectDir 'app\src\main\res\values\strings.xml'
if (Test-Path $stringsFile) {
    $stringsText = [System.IO.File]::ReadAllText($stringsFile)
    $patchedStrings = $stringsText `
        -replace '(<string name="app_name">)[^<]*(</string>)', '$1"追更"$2' `
        -replace '(<string name="main_activity_title">)[^<]*(</string>)', '$1"追更"$2'
    if ($patchedStrings -ne $stringsText) {
        [System.IO.File]::WriteAllText($stringsFile, $patchedStrings, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[2/3] strings.xml 应用名已更新为「追更」"
    }
    else {
        Write-Host "[2/3] strings.xml 应用名已是「追更」，跳过。"
    }
}
else {
    Write-Host "[2/3] 未找到 strings.xml，跳过应用名设置。"
}

# ---- 3. 补丁 build.gradle.kts ----
$text = [System.IO.File]::ReadAllText($gradleFile)
if ($text.Contains('keystoreProperties')) {
    Write-Host "[3/3] build.gradle.kts 已包含签名配置，跳过补丁。"
    exit 0
}

if ($text.Contains("`r`n")) { $nl = "`r`n" } else { $nl = "`n" }

$snippetVal = @"
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}
"@

$snippetSigningConfigs = @"
    signingConfigs {
        if (!keystoreProperties.isEmpty()) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }
"@

$snippetReleaseSigning = @"
        getByName("release") {
            if (!keystoreProperties.isEmpty()) {
                signingConfig = signingConfigs.getByName("release")
            }
"@

# 统一成目标文件的换行符
$snippetVal = ($snippetVal -replace "`r?`n", $nl).TrimEnd() + $nl
$snippetSigningConfigs = ($snippetSigningConfigs -replace "`r?`n", $nl).TrimEnd() + $nl
$snippetReleaseSigning = ($snippetReleaseSigning -replace "`r?`n", $nl).TrimEnd() + $nl

$patched = $text

$anchorVal = $nl + 'android {'
if (-not $patched.Contains($anchorVal)) {
    Write-Error "build.gradle.kts 中找不到 `android {` 锚点，模板可能已变化，请手动配置签名。"
    exit 1
}
$patched = $patched.Replace($anchorVal, $nl + $snippetVal + 'android {')

$anchorBuildTypes = '    buildTypes {'
if (-not $patched.Contains($anchorBuildTypes)) {
    Write-Error "build.gradle.kts 中找不到 `buildTypes {` 锚点，模板可能已变化，请手动配置签名。"
    exit 1
}
$patched = $patched.Replace($anchorBuildTypes, $snippetSigningConfigs + $anchorBuildTypes)

$anchorRelease = '        getByName("release") {' + $nl
if (-not $patched.Contains($anchorRelease)) {
    Write-Error "build.gradle.kts 中找不到 `getByName(""release"")` 锚点，模板可能已变化，请手动配置签名。"
    exit 1
}
$patched = $patched.Replace($anchorRelease, $snippetReleaseSigning)

if ($patched -eq $text) {
    Write-Error '补丁未产生任何变更，请手动检查 build.gradle.kts。'
    exit 1
}

[System.IO.File]::WriteAllText($gradleFile, $patched, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[3/3] build.gradle.kts 已注入签名配置：$gradleFile"
Write-Host ""
Write-Host "完成。现在 npm run build:android -- --apk 会直接产出已签名的 release APK。"
