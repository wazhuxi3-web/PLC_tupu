#requires -Version 7.0
param(
    [string]$PowerShellHome = $PSHOME,
    [string]$NodeExe = (Get-Command node -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$destination = Join-Path $root "release/STEP7-Explorer-$version-win-x64"
$zip = "$destination.zip"
if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $zip)) {
    throw "打包目标已存在，保留原内容。请使用新版本或另行归档：$destination"
}
if (!(Test-Path -LiteralPath (Join-Path $PowerShellHome 'pwsh.exe'))) { throw '需要完整的 Windows PowerShell 7 运行目录。' }
foreach ($file in @('licenses/Node-LICENSE.txt','licenses/SharpZipLib-LICENSE.txt')) {
    if (!(Test-Path -LiteralPath (Join-Path $root $file))) { throw "缺少许可证：$file" }
}
[IO.Directory]::CreateDirectory($destination) | Out-Null
foreach ($item in @('src','web','scripts','tests','docs','licenses','server.mjs','package.json','README.md','THIRD_PARTY_NOTICES.md','启动工作台.cmd')) {
    Copy-Item -LiteralPath (Join-Path $root $item) -Destination $destination -Recurse
}
$runtime = Join-Path $destination '.tools/runtime'
[IO.Directory]::CreateDirectory($runtime) | Out-Null
Copy-Item -LiteralPath $PowerShellHome -Destination (Join-Path $runtime 'pwsh') -Recurse
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $runtime 'node.exe')
foreach ($package in @('toolbox.4.4.10','sharpziplib.1.4.2')) {
    $target=Join-Path $destination ".tools/packages/$package/lib/netstandard2.1"
    [IO.Directory]::CreateDirectory($target) | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $root ".tools/packages/$package/lib/netstandard2.1") -Filter '*.dll' |
        Copy-Item -Destination $target
}
# Do not package PLC projects, snapshots, vendor checkout or development caches.
$files=@(Get-ChildItem -LiteralPath $destination -Recurse -File -Force | ForEach-Object {
    @{path=[IO.Path]::GetRelativePath($destination,$_.FullName).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}
})
@{version=$version;builtAt=[DateTime]::UtcNow.ToString('o');node=(& $NodeExe --version);powershell=(& (Join-Path $PowerShellHome 'pwsh.exe') -NoProfile -Command '$PSVersionTable.PSVersion.ToString()');files=$files} |
    ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $destination 'package-manifest.json') -Encoding utf8
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($destination,$zip,[IO.Compression.CompressionLevel]::Optimal,$true)
Get-Item -LiteralPath $zip | Select-Object FullName,Length
Get-FileHash -LiteralPath $zip -Algorithm SHA256
