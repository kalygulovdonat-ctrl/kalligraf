# Сборка Kalligraf.apk без Gradle и без интернета: только Android SDK и JDK на этом компьютере.
# Запуск: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$web = Join-Path $here '..'
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$bt = Get-ChildItem (Join-Path $sdk 'build-tools') | Sort-Object { [version]$_.Name } | Select-Object -Last 1 -ExpandProperty FullName
$platform = Get-ChildItem (Join-Path $sdk 'platforms') | Sort-Object Name | Select-Object -Last 1 -ExpandProperty FullName
$androidJar = Join-Path $platform 'android.jar'
Write-Host "SDK: $bt, $platform"

# 1. Телефонная версия интерфейса
Push-Location $web
npm run build:mobile  # + файлы распознавания текста (ocr)
if ($LASTEXITCODE) { throw 'Сборка интерфейса не удалась' }
Pop-Location

# Инструменты SDK плохо работают с русскими буквами в пути — собираем во временной папке
$w = Join-Path $env:TEMP 'kalligraf-apk-build'
if (Test-Path $w) { Remove-Item $w -Recurse -Force }
New-Item -ItemType Directory -Force "$w\assets\www", "$w\classes", "$w\gen", "$w\dex" | Out-Null
Copy-Item "$web\dist-mobile\*" "$w\assets\www" -Recurse
Copy-Item "$here\res" "$w\res" -Recurse
Copy-Item "$here\src" "$w\src" -Recurse
Copy-Item "$here\AndroidManifest.xml" "$w\AndroidManifest.xml"

# 2. Ресурсы и манифест
& "$bt\aapt2.exe" compile --dir "$w\res" -o "$w\res.zip"
if ($LASTEXITCODE) { throw 'aapt2 compile' }
& "$bt\aapt2.exe" link -I $androidJar --manifest "$w\AndroidManifest.xml" -R "$w\res.zip" `
  --java "$w\gen" --min-sdk-version 24 --target-sdk-version 34 --version-code 5 --version-name 1.4 -o "$w\app.unsigned.apk"
if ($LASTEXITCODE) { throw 'aapt2 link' }

# 3. Java → dex
$java = Get-ChildItem "$w\src", "$w\gen" -Recurse -Filter *.java | ForEach-Object FullName
& javac -encoding UTF-8 --release 11 -classpath $androidJar -d "$w\classes" @java
if ($LASTEXITCODE) { throw 'javac' }
$classes = Get-ChildItem "$w\classes" -Recurse -Filter *.class | ForEach-Object FullName
& "$bt\d8.bat" --min-api 24 --lib $androidJar --output "$w\dex" @classes
if ($LASTEXITCODE) { throw 'd8' }

# 4. Положить classes.dex в APK
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$w\app.unsigned.apk", 'Update')
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$w\dex\classes.dex", 'classes.dex') | Out-Null
# интерфейс: в APK пути пишутся только с прямой косой чертой
$root = (Resolve-Path "$w\assets").Path
Get-ChildItem $root -Recurse -File | ForEach-Object {
  $name = 'assets/' + $_.FullName.Substring($root.Length + 1).Replace('\', '/')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $name) | Out-Null
}
$zip.Dispose()

# 5. Выравнивание и подпись (ключ для домашней установки, создаётся один раз)
& "$bt\zipalign.exe" -f -p 4 "$w\app.unsigned.apk" "$w\app.aligned.apk"
if ($LASTEXITCODE) { throw 'zipalign' }
$ks = Join-Path $here 'kalligraf.keystore'
if (-not (Test-Path $ks)) {
  & keytool -genkeypair -keystore $ks -storepass kalligraf -keypass kalligraf -alias kalligraf `
    -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Kalligraf, O=Kalligraf, C=KG'
  if ($LASTEXITCODE) { throw 'keytool' }
}
Copy-Item $ks "$w\k.keystore"
& "$bt\apksigner.bat" sign --ks "$w\k.keystore" --ks-pass pass:kalligraf --key-pass pass:kalligraf --out "$w\Kalligraf.apk" "$w\app.aligned.apk"
if ($LASTEXITCODE) { throw 'apksigner' }
& "$bt\apksigner.bat" verify "$w\Kalligraf.apk"
if ($LASTEXITCODE) { throw 'apksigner verify' }

$dst = Join-Path $here 'Kalligraf.apk'
Copy-Item "$w\Kalligraf.apk" $dst -Force
Write-Host "Готово: $((Resolve-Path $dst).Path) ($([math]::Round((Get-Item $dst).Length / 1MB, 1)) МБ)"
