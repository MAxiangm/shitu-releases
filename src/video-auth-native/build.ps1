param([string]$OutputPath = (Join-Path $PSScriptRoot 'Mosaic.VideoAuth.exe'))
$ErrorActionPreference = 'Stop'
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $framework 'csc.exe'
$references = @('System.dll', 'System.Core.dll', 'System.Net.Http.dll', 'System.Web.Extensions.dll', 'System.Security.dll', 'System.Xaml.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$references += @('PresentationCore.dll', 'PresentationFramework.dll', 'WindowsBase.dll') | ForEach-Object { '/reference:' + (Join-Path (Join-Path $framework 'WPF') $_) }
& $csc /nologo /target:exe /platform:anycpu /optimize+ ('/out:' + $OutputPath) @references (Join-Path $PSScriptRoot 'Program.cs') (Join-Path $PSScriptRoot 'YouTubeConnection.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native YouTube connection helper compilation failed.' }
