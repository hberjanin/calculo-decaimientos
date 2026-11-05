param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,

    [ValidateNotNullOrEmpty()]
    [string]$BindAddress = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

try {
    $bindIp = [System.Net.IPAddress]::Parse($BindAddress)
} catch {
    Write-Error "La direccion de enlace '$BindAddress' no es una direccion IP valida."
    exit 1
}

$portProbe = [System.Net.Sockets.TcpListener]::new($bindIp, $Port)
try {
    $portProbe.Start()
} catch [System.Net.Sockets.SocketException] {
    Write-Error "El puerto $Port ya esta ocupado. Prueba con otro, por ejemplo: .\server.ps1 -Port 8081"
    exit 1
} finally {
    $portProbe.Stop()
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
}

if (-not $python) {
    Write-Error 'No se ha encontrado Python. Instala Python 3 o inicia otro servidor HTTP en esta carpeta.'
    exit 1
}

Set-Location -LiteralPath $root
$displayAddress = if ($BindAddress.Contains(':')) { "[$BindAddress]" } else { $BindAddress }
$url = if ($BindAddress -eq '0.0.0.0') { "http://127.0.0.1:$Port" } else { "http://${displayAddress}:$Port" }

Write-Host ''
Write-Host 'Calculo de decaimientos' -ForegroundColor Green
Write-Host "Abre la aplicacion en: $url"
Write-Host 'Servidor local de desarrollo: para distribuir la PWA utiliza HTTPS.' -ForegroundColor DarkGray
if ($BindAddress -eq '0.0.0.0') {
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress -Unique
    foreach ($address in $addresses) {
        Write-Host "Vista previa en la red local: http://${address}:$Port"
    }
    Write-Warning 'La instalacion PWA y el modo sin conexion en otros dispositivos requieren publicar la aplicacion mediante HTTPS.'
    Write-Warning 'La vista previa de red comparte los recursos publicos de la aplicacion con la red local.'
}
Write-Host 'Pulsa Ctrl+C para detener el servidor.' -ForegroundColor DarkGray
Write-Host ''

if ($python.Name -eq 'py.exe') {
    & $python.Source -3 "$root\dev_server.py" --port $Port --bind $BindAddress --directory $root
} else {
    & $python.Source "$root\dev_server.py" --port $Port --bind $BindAddress --directory $root
}
