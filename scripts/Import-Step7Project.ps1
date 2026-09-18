#requires -Version 7.0
param(
    [Parameter(Mandatory)][string]$ProjectFile,
    [int]$CodePage = 936
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Add-Type -Path (Join-Path $root '.tools/packages/sharpziplib.1.4.2/lib/netstandard2.1/ICSharpCode.SharpZipLib.dll')
Add-Type -Path (Join-Path $root '.tools/packages/toolbox.4.4.10/lib/netstandard2.1/DotNetSiemensPLCToolBoxLibrary.dll')
$inputFile = Get-Item -LiteralPath $ProjectFile
if ($inputFile.Extension -ine '.s7p') { throw '请选择 .s7p 工程入口。' }
$sourceRoot = $inputFile.Directory.FullName
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$snapshotRoot = Join-Path $root "data/snapshots/$runId"
$exportRoot = Join-Path $root "data/imports/$runId"
$relativeDestination = [IO.Path]::GetRelativePath($sourceRoot, $snapshotRoot)
if (!$relativeDestination.StartsWith('..') -and ![IO.Path]::IsPathRooted($relativeDestination)) {
    throw '工程目录包含本工具的数据输出目录，请将工程放在独立子目录或外部目录。'
}
$manifest = [Collections.Generic.List[object]]::new()
$diagnostics = [Collections.Generic.List[object]]::new()
[IO.Directory]::CreateDirectory((Join-Path $exportRoot 'blocks')) | Out-Null

function Write-JsonFile($Value, [string]$Path) {
    $Value | ConvertTo-Json -Depth 70 | Set-Content -LiteralPath $Path -Encoding utf8
}
function Add-Diagnostic([string]$Code, [string]$Message, [string]$BlockId = '') {
    $diagnostics.Add(@{code=$Code; message=$Message; blockId=$BlockId})
}

# Snapshot only regular files. Never allow junctions to silently import another tree.
foreach ($entry in Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "不支持工程内的链接目录/文件：$($entry.FullName)" }
    if ($entry.PSIsContainer) { continue }
    $relative = [IO.Path]::GetRelativePath($sourceRoot, $entry.FullName)
    $destination = Join-Path $snapshotRoot $relative
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    $beforeLength = $entry.Length
    $beforeTime = $entry.LastWriteTimeUtc.Ticks
    $reader = [IO.File]::Open($entry.FullName, 'Open', 'Read', 'ReadWrite')
    try {
        $writer = [IO.File]::Create($destination)
        try { $reader.CopyTo($writer) } finally { $writer.Dispose() }
    } finally { $reader.Dispose() }
    $after = Get-Item -LiteralPath $entry.FullName
    if ($after.Length -ne $beforeLength -or $after.LastWriteTimeUtc.Ticks -ne $beforeTime) {
        throw "复制时工程文件发生变化，请保存工程后重试：$relative"
    }
    $manifest.Add(@{path=$relative.Replace('\','/'); size=$beforeLength; sha256=(Get-FileHash -LiteralPath $destination).Hash; sourceTicks=$beforeTime})
}
# Detect edits to previously copied files before parsing starts.
if (@(Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force -File).Count -ne $manifest.Count) {
    throw '复制期间工程文件数量变化，请保存工程后重试。'
}
foreach ($item in $manifest) {
    $current = Get-Item -LiteralPath (Join-Path $sourceRoot $item.path)
    if ($current.Length -ne $item.size -or $current.LastWriteTimeUtc.Ticks -ne $item.sourceTicks) { throw "工程在复制期间发生变化：$($item.path)" }
}
Write-JsonFile @($manifest) (Join-Path $exportRoot 'manifest.json')
$manifestHash = (Get-FileHash -LiteralPath (Join-Path $exportRoot 'manifest.json')).Hash.ToLowerInvariant()
$snapshotId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("$manifestHash|reader-4.4.10|schema-1|cp-$CodePage"))).ToLowerInvariant()
$snapshotFile = Join-Path $snapshotRoot $inputFile.Name
$project = [DotNetSiemensPLCToolBoxLibrary.Projectfiles.Step7ProjectV5]::new($snapshotFile, $false, [Text.Encoding]::GetEncoding($CodePage))
$project.ProjectLanguage = 'English'
$structure = $project.ProjectStructure
$options = [DotNetSiemensPLCToolBoxLibrary.DataTypes.AWL.Step7V5.S7ConvertingOptions]::new([DotNetSiemensPLCToolBoxLibrary.DataTypes.MnemonicLanguage]::English)
$options.ReplaceDBAccessesWithSymbolNames = $false
$options.ReplaceDIAccessesWithSymbolNames = $false
$options.ReplaceLokalDataAddressesWithSymbolNames = $true
$options.ExpandArrays = $false
$options.CheckForInterfaceTimestampConflicts = $true

function Convert-DataRow($Row, [int]$Depth = 0) {
    if ($null -eq $Row) { return $null }
    if ($Depth -gt 40) { throw '结构嵌套超过 40 层。' }
    return @{
        name=[string]$Row.Name; type=[string]$Row.DataType; address=[string]$Row.BlockAddress
        byteLength=$Row.ByteLength; comment=[string]$Row.Comment
        isArray=[bool]$Row.IsArray; arrayStart=@($Row.ArrayStart); arrayStop=@($Row.ArrayStop)
        children=@(foreach($child in $Row.Children) { Convert-DataRow $child ($Depth+1) })
    }
}

$programs = [Collections.Generic.List[object]]::new()
$blocks = [Collections.Generic.List[object]]::new()
$calls = [Collections.Generic.List[object]]::new()
$sources = [Collections.Generic.List[object]]::new()
$programIndex=0
foreach ($program in $project.S7ProgrammFolders) {
    $programIndex++
    $folder = $program.BlocksOfflineFolder
    if ($null -eq $folder) { Add-Diagnostic 'NO_BLOCK_FOLDER' $program.Name; continue }
    $folderRelative = [IO.Path]::GetRelativePath($snapshotRoot, $folder.Folder).TrimEnd('\','/').Replace('\','/')
    $programId = 'p-' + ($folderRelative -replace '[^A-Za-z0-9_-]', '-')
    $symbols = @(foreach ($symbol in $program.SymbolTable.SymbolTableEntrys) {
        @{name=[string]$symbol.Symbol; operand=[string]$symbol.OperandIEC; type=[string]$symbol.DataType; comment=[string]$symbol.Comment}
    })
    $programs.Add(@{
        id=$programId; name=$program.Name; cpu=[string]$program.Parent.Name
        station=[string]$program.Parent.Parent.Name; folder=$folderRelative; symbols=$symbols
    })
    foreach ($info in $folder.BlockInfos) {
        if ($info.Deleted) { continue }
        $name=[string]$info.BlockName
        $blockId="$programId--$name"
        $meta=@{id=$blockId; programId=$programId; name=$name; type=[string]$info.BlockType; symbol=[string]$info.SymbolTabelEntry.Symbol; status='metadata'; rowCount=0; networkCount=0; description=''; protected=[bool]$info.KnowHowProtection}
        $blocks.Add($meta)
        if ($info.BlockType -notin @('OB','FC','FB','DB','UDT')) { $meta.status='metadata-only'; continue }
        if ($info.KnowHowProtection) { $meta.status='protected'; Add-Diagnostic 'PROTECTED_BLOCK' '块有保护标记，未反编译。' $blockId; continue }
        try {
            $block=$folder.GetBlock($info,$options)
            if ($null -eq $block) { throw '读取库未返回块。' }
            $rows=[Collections.Generic.List[object]]::new()
            $network=0; $rowIndex=0
            if ($block -is [DotNetSiemensPLCToolBoxLibrary.DataTypes.Blocks.Step7V5.S7FunctionBlock]) {
                foreach ($row in $block.AWLCode) {
                    $rowIndex++
                    if ($row.Command -eq 'NETWORK') { $network++; }
                    $parameters=@(foreach($parameter in $row.CallParameter) {
                        @{name=[string]$parameter.Name; value=[string]$parameter.Value; direction=[string]$parameter.ParameterType; type=[string]$parameter.ParameterDataType; comment=[string]$parameter.Comment}
                    })
                    $record=@{
                        index=$rowIndex; network=$network; command=[string]$row.Command; operand=[string]$row.Parameter
                        label=[string]$row.Label; comment=[string]$row.Comment; parameters=$parameters
                        calledBlock=[string]$row.CalledBlock; instance=[string]$row.DiName
                    }
                    $rows.Add($record)
                }
                $data=Convert-DataRow $block.Parameter
                $meta.description=[string]$block.Description
            } elseif ($block -is [DotNetSiemensPLCToolBoxLibrary.DataTypes.Blocks.Step7V5.S7DataBlock]) {
                $data=Convert-DataRow $block.Structure
            } else { throw "暂不支持读取库对象类型 $($block.GetType().Name)" }
            $meta.rowCount=$rows.Count; $meta.networkCount=$network; $meta.status='parsed'
            $detail=@{id=$blockId; name=$name; programId=$programId; description=$meta.description; interface=$data; rows=@($rows); provenance=@{kind='offline-block'; folder=$folderRelative; snapshotId=$snapshotId; locationUnit='decoded-row-index'}}
            Write-JsonFile $detail (Join-Path $exportRoot "blocks/$blockId.json")
            foreach($record in $rows) {
                if ($record.command -in @('CALL','UC','CC')) {
                    $target=($record.calledBlock -replace '\s','')
                    if (!$target) { $target=($record.operand -replace '\s','') }
                    $calls.Add(@{id="$blockId--r$($record.index)"; programId=$programId; caller=$blockId; targetName=$target; target="$programId--$target"; network=$record.network; row=$record.index; instance=$record.instance; parameters=$record.parameters; conditional=($record.command -eq 'CC')})
                }
            }
        } catch {
            $meta.status='failed'
            Add-Diagnostic 'BLOCK_PARSE_FAILED' $_.Exception.Message $blockId
        }
        Write-Host "$name : $($meta.status) ($($meta.rowCount) 行)"
    }
}
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $snapshotRoot 's7asrcom') -Recurse -File -Filter '*.AWL' -ErrorAction SilentlyContinue) {
    $content=[Text.Encoding]::GetEncoding($CodePage).GetString([IO.File]::ReadAllBytes($file.FullName))
    $declarations=@([regex]::Matches($content,'(?m)^\s*(FUNCTION_BLOCK|FUNCTION|ORGANIZATION_BLOCK|DATA_BLOCK)\s+(\w+)') | ForEach-Object {$_.Groups[2].Value})
    $sources.Add(@{path=[IO.Path]::GetRelativePath($snapshotRoot,$file.FullName).Replace('\','/'); declarations=$declarations; bytes=$file.Length; networks=[regex]::Matches($content,'(?m)^NETWORK\s*$').Count; status='unverified-saved-source'})
}
foreach($declaration in @($sources | ForEach-Object {$_.declarations} | Group-Object | Where-Object {$_.Count -gt 1})) {
    Add-Diagnostic 'DUPLICATE_SAVED_SOURCE' "多份保存源码声明 $($declaration.Name)，没有合并进离线程序。"
}
foreach($call in $calls) {
    $targetMeta=$blocks | Where-Object {$_.id -eq $call.target} | Select-Object -First 1
    $call.targetStatus=if($targetMeta){$targetMeta.status}else{'unresolved'}
}
$result=@{
    schemaVersion=1; projectId=$inputFile.BaseName.ToLowerInvariant(); projectName=$inputFile.BaseName; libraryProjectName=$project.ProjectName
    snapshotId=$snapshotId; importedAt=[DateTime]::UtcNow.ToString('o'); sourcePath=$inputFile.FullName; fileCount=$manifest.Count
    callCount=$calls.Count
    reader=@{name='DotNetSiemensPLCToolBoxLibrary'; version='4.4.10'; codePage=$CodePage; showDeleted=$false; mnemonic='English'}
    programs=@($programs); blocks=@($blocks); calls=@($calls); savedSources=@($sources); diagnostics=@($diagnostics)
    limitations=@('静态离线分析，不代表 PLC 当前状态。','行号是反编译指令序号，不是原始源码行号。','系统块与变量表仅列目录。','数组结构未逐元素展开。','保存的 AWL 源码未自动并入离线程序。')
}
Write-JsonFile $result (Join-Path $exportRoot 'project.json')
# Publish the pointer only after a complete import. Failed imports leave the previous dataset available.
$pointer=Join-Path $root 'data/current.json'
Write-JsonFile @{importId=$runId; snapshotId=$snapshotId} ($pointer+'.tmp')
Move-Item -LiteralPath ($pointer+'.tmp') -Destination $pointer -Force
Write-Host "导入完成：$($blocks.Count) 条块记录，$($calls.Count) 个调用点，$($diagnostics.Count) 条诊断。"
