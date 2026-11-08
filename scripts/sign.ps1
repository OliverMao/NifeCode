# 给 exe 打 Authenticode 签名（自签名证书，首次会自动生成）
# 用法: powershell -ExecutionPolicy Bypass -File scripts\sign.ps1 <exe路径> [更多 exe...]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE ".nifecode-signing"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like "*CN=Oliver Mao*" } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Oliver Mao, O=NifeCode, C=CN" `
    -KeyUsage DigitalSignature -KeyExportPolicy Exportable -KeyLength 3072 `
    -NotAfter (Get-Date).AddYears(5) -CertStoreLocation Cert:\CurrentUser\My
  # 自签名证书要先信任自己，否则签名 API 会拒绝
  foreach ($n in @("Root", "TrustedPublisher")) {
    $s = New-Object System.Security.Cryptography.X509Certificates.X509Store($n, "CurrentUser")
    $s.Open("ReadWrite"); $s.Add($cert); $s.Close()
  }
  Export-PfxCertificate -Cert $cert -FilePath (Join-Path $dir "nifecode-selfsigned.pfx") `
    -Password (ConvertTo-SecureString "nifecode" -Force -AsPlainText) | Out-Null
  Export-Certificate -Cert $cert -FilePath (Join-Path $dir "nifecode-selfsigned.cer") -Type CERT | Out-Null
  "生成新证书: $($cert.Thumbprint)"
}

foreach ($f in $Files) {
  if (-not (Test-Path $f)) { "跳过（不存在）: $f"; continue }
  $r = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -HashAlgorithm SHA256 `
    -TimestampServer "http://timestamp.digicert.com"
  "$([System.IO.Path]::GetFileName($f))  ->  $($r.Status)"
}
