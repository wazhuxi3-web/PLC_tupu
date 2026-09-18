#requires -Version 7.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = [Windows.Forms.FolderBrowserDialog]::new()
try {
    $dialog.Description = '选择包含 .S7P 文件及配套目录的 STEP7 工程文件夹'
    $dialog.UseDescriptionForTitle = $true
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {
        @{path=$dialog.SelectedPath; cancelled=$false} | ConvertTo-Json -Compress
    } else { @{path=''; cancelled=$true} | ConvertTo-Json -Compress }
} finally { $dialog.Dispose() }
