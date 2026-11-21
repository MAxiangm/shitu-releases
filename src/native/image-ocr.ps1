$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$stream = $null
$bitmap = $null

function Emit-Json($value) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Depth 8 -Compress))
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object {
        @{ tag = $_.LanguageTag; name = $_.NativeName }
    })
    $maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($env:SHITU_OCR_MODE -eq 'status') {
        Emit-Json @{ ok = $true; languages = $languages; maxImageDimension = $maxDimension }
        exit 0
    }
    if ($languages.Count -eq 0) {
        Emit-Json @{ ok = $false; code = 'NO_LANGUAGE' }
        exit 1
    }
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
    if ($env:SHITU_OCR_LANGUAGE -eq 'auto') {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if ($null -eq $engine) {
            $language = New-Object Windows.Globalization.Language($languages[0].tag)
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
        }
    } else {
        $language = New-Object Windows.Globalization.Language($env:SHITU_OCR_LANGUAGE)
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    }
    if ($null -eq $engine) {
        Emit-Json @{ ok = $false; code = 'UNSUPPORTED_LANGUAGE' }
        exit 1
    }
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and
        $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Wait-Operation($operation, [Type]$resultType) {
        $task = $script:asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
        $task.GetAwaiter().GetResult()
    }
    if (-not [System.IO.File]::Exists($env:SHITU_OCR_IMAGE)) {
        Emit-Json @{ ok = $false; code = 'INVALID_IMAGE' }
        exit 1
    }
    $file = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:SHITU_OCR_IMAGE)) ([Windows.Storage.StorageFile])
    $stream = Wait-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Wait-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $width = $decoder.OrientedPixelWidth
    $height = $decoder.OrientedPixelHeight
    if ([double]$width * [double]$height -gt 100000000) {
        Emit-Json @{ ok = $false; code = 'IMAGE_TOO_LARGE' }
        exit 1
    }
    $scale = [Math]::Min(1.0, [double]$maxDimension / [Math]::Max($width, $height))
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($width * $scale))
    $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($height * $scale))
    $bitmap = Wait-Operation ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::ColorManageToSRgb
    )) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Wait-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($result.Lines | ForEach-Object { $_.Text })
    Emit-Json @{ ok = $true; text = ($lines -join "`n"); language = $engine.RecognizerLanguage.LanguageTag; width = $width; height = $height; scaled = ($scale -lt 1.0) }
} catch {
    Emit-Json @{ ok = $false; error = $_.Exception.Message }
    exit 1
} finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
}
