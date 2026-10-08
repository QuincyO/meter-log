# Windows built-in OCR (Windows.Media.Ocr) over one image; prints one line of text
# per recognized line. Run under Windows PowerShell 5.1 (powershell.exe) — the WinRT
# projection this needs is not available in PowerShell 7 (pwsh).
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File winocr.ps1 <image>
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Path).Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
# Upscale small images: a Telegram photo is ~1280 px on its long side, and at that
# size Windows OCR reads the leading 9 of "907110" as a 0. ~2600 px reads clean.
# The scale applies before the EXIF rotation, so it is set on the stored (pixel)
# dimensions; RespectExifOrientation stands a sideways-stored phone photo upright.
$long = [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight)
$scale = [Math]::Min(3.0, [Math]::Max(1.0, 2600.0 / $long))
$transform = New-Object Windows.Graphics.Imaging.BitmapTransform
$transform.ScaledWidth = [uint32][Math]::Round($decoder.PixelWidth * $scale)
$transform.ScaledHeight = [uint32][Math]::Round($decoder.PixelHeight * $scale)
$transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
$bitmap = Await ($decoder.GetSoftwareBitmapAsync(
  [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
  [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
  $transform,
  [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
  [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Lines | ForEach-Object { $_.Text }
