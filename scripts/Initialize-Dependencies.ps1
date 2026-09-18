#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$packages = @(
    @{ Name='toolbox.4.4.10'; Id='dotnetprojects.dotnetsiemensplctoolboxlibrary'; Version='4.4.10'; Hash='0D8EE690D14DB4EAE5E549987973FEBD157212B7CE7BC2AFBAF222709AAEA16D' },
    @{ Name='sharpziplib.1.4.2'; Id='sharpziplib'; Version='1.4.2'; Hash='FE0895AA2930A2B1B65CAA9F37DB8BCA35125EBDF9CC1B99D855F6AFC5FF5946' }
)
$base = Join-Path $root '.tools/packages'
[IO.Directory]::CreateDirectory($base) | Out-Null
foreach ($package in $packages) {
    $archive = Join-Path $base ($package.Name + '.zip')
    if (!(Test-Path -LiteralPath $archive)) {
        $url = "https://api.nuget.org/v3-flatcontainer/$($package.Id)/$($package.Version)/$($package.Id).$($package.Version).nupkg"
        Invoke-WebRequest -Uri $url -OutFile $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $package.Hash) {
        throw "Dependency checksum mismatch: $($package.Name)"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $base $package.Name) -Force
}
Write-Host '固定版本依赖已就绪。'
