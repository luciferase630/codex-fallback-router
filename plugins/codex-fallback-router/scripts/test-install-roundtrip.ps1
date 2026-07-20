$ErrorActionPreference = 'Stop'

$realUserProfile = $env:USERPROFILE
$realLocalBin = Join-Path $realUserProfile '.local\bin'
$testRoot = Join-Path $env:TEMP ('codex-fallback-install-test-' + [guid]::NewGuid().ToString('N'))
$testLocal = Join-Path $testRoot 'LocalAppData'
$testHome = Join-Path $testRoot 'User'
$testCodex = Join-Path $testHome '.codex'
$oldLocal = $env:LOCALAPPDATA
$oldProfile = $env:USERPROFILE
$oldCodex = $env:CODEX_HOME
$oldPath = $env:PATH
$blocker = $null

try {
    New-Item -ItemType Directory -Path $testLocal, $testCodex | Out-Null
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $testPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $fixtureConfig = @'
model = "gpt-5.6-terra"
model_provider = "openai_http"

[model_providers.openai_http]
name = "OpenAI HTTP"
base_url = "https://chatgpt.com/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
'@
    [IO.File]::WriteAllText(
        (Join-Path $testCodex 'config.toml'),
        $fixtureConfig + [Environment]::NewLine,
        [Text.UTF8Encoding]::new($false)
    )
    $before = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $testCodex 'config.toml')).Hash

    $env:LOCALAPPDATA = $testLocal
    $env:USERPROFILE = $testHome
    $env:CODEX_HOME = $testCodex
    $env:PATH = $realLocalBin + ';' + $oldPath

    'placeholder-dpapi-credential-for-install-test' |
        node dist/cli.mjs config set --base-url https://example.invalid --api-key-stdin --upstream-proxy http://127.0.0.1:7890 --port $testPort
    if ($LASTEXITCODE -ne 0) { throw 'Initial configuration failed.' }

    node dist/cli.mjs install
    if ($LASTEXITCODE -ne 0) { throw 'Installation failed.' }
    $firstHealth = node dist/cli.mjs status | ConvertFrom-Json
    if (-not $firstHealth.ok) { throw 'Daemon did not become healthy.' }
    $runtimeNode = Join-Path $testLocal 'codex-fallback-router\bin\codex.exe'
    if (-not (Test-Path -LiteralPath $runtimeNode)) { throw 'Codex-named daemon runtime was not installed.' }
    $installedStatus = & (Join-Path $testHome '.local\bin\codex-fallback.cmd') status | ConvertFrom-Json
    if (-not $installedStatus.ok) { throw 'Installed command shim could not reach the daemon.' }

    'replacement-dpapi-credential-for-install-test' |
        node dist/cli.mjs config set --base-url https://fallback.example.invalid --api-key-stdin --port $testPort
    if ($LASTEXITCODE -ne 0) { throw 'Live configuration update failed.' }
    $secondHealth = node dist/cli.mjs status | ConvertFrom-Json
    if (-not $secondHealth.ok) { throw 'Daemon did not restart after configuration change.' }

    $secretFile = Join-Path $testLocal 'codex-fallback-router\secret.dpapi'
    if ((Get-Content -LiteralPath $secretFile -Raw) -match 'credential-for-install-test') {
        throw 'DPAPI file contains plaintext test credentials.'
    }

    node dist/cli.mjs uninstall
    if ($LASTEXITCODE -ne 0) { throw 'Uninstall failed.' }
    $after = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $testCodex 'config.toml')).Hash
    if ($before -ne $after) { throw 'Uninstall did not restore the original Codex config.' }
    if (Test-Path -LiteralPath $runtimeNode) { throw 'Uninstall left the Codex-named daemon runtime behind.' }

    'port-conflict-test-credential-value' |
        node dist/cli.mjs config set --base-url https://example.invalid --api-key-stdin
    if ($LASTEXITCODE -ne 0) { throw 'Port-conflict configuration failed.' }

    $blockerScript = Join-Path $testRoot 'port-blocker.cjs'
    [IO.File]::WriteAllText(
        $blockerScript,
        "require('http').createServer((request,response)=>{response.writeHead(409);response.end('occupied')}).listen(45831,'127.0.0.1')",
        [Text.UTF8Encoding]::new($false)
    )
    $blocker = Start-Process -FilePath (Get-Command node).Source -ArgumentList @($blockerScript) -PassThru -WindowStyle Hidden
    $portReady = $false
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
        try {
            $client = [Net.Sockets.TcpClient]::new()
            $client.Connect('127.0.0.1', 45831)
            $client.Dispose()
            $portReady = $true
            break
        }
        catch {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $portReady) { throw 'Port blocker did not start.' }

    $beforeConflict = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $testCodex 'config.toml')).Hash
    $ErrorActionPreference = 'SilentlyContinue'
    node dist/cli.mjs install 2>$null
    $conflictExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($conflictExitCode -eq 0) { throw 'Installation unexpectedly succeeded with an occupied port.' }
    $afterConflict = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $testCodex 'config.toml')).Hash
    if ($beforeConflict -ne $afterConflict) { throw 'Port-conflict rollback changed Codex config.' }
    if (Test-Path -LiteralPath (Join-Path $testLocal 'codex-fallback-router\install-state.json')) {
        throw 'Port-conflict rollback left installation state behind.'
    }
    if (Test-Path -LiteralPath (Join-Path $testHome '.local\bin\codex-fallback.cmd')) {
        throw 'Port-conflict rollback left the command shim behind.'
    }
    if (Test-Path -LiteralPath (Join-Path $testLocal 'codex-fallback-router\bin\cli.mjs')) {
        throw 'Port-conflict rollback left the runtime CLI behind.'
    }
    Stop-Process -Id $blocker.Id -Force -ErrorAction SilentlyContinue
    $blocker = $null

    [IO.File]::WriteAllText(
        (Join-Path $testLocal 'codex-fallback-router\config.json'),
        '{ invalid router configuration',
        [Text.UTF8Encoding]::new($false)
    )
    $beforeInvalid = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $testCodex 'config.toml')).Hash
    $ErrorActionPreference = 'SilentlyContinue'
    node dist/cli.mjs install 2>$null
    $invalidExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($invalidExitCode -eq 0) { throw 'Installation unexpectedly accepted invalid router configuration.' }
    $afterInvalid = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $testCodex 'config.toml')).Hash
    if ($beforeInvalid -ne $afterInvalid) { throw 'Invalid configuration changed Codex config.' }

    Write-Output 'Install, daemon, live reconfigure, uninstall, port-conflict rollback, and invalid-config checks passed.'
}
finally {
    if ($null -ne $blocker) {
        Stop-Process -Id $blocker.Id -Force -ErrorAction SilentlyContinue
    }
    try { node dist/cli.mjs stop 2>$null | Out-Null } catch {}
    $env:LOCALAPPDATA = $oldLocal
    $env:USERPROFILE = $oldProfile
    $env:PATH = $oldPath
    if ($null -eq $oldCodex) {
        Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    }
    else {
        $env:CODEX_HOME = $oldCodex
    }

    $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $resolvedTest = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTest.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force -ErrorAction SilentlyContinue
    }
}
