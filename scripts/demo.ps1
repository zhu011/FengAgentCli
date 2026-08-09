# demo.ps1 — 一键启动 FengAgent Demo (Windows PowerShell)
#
# 启动 WebUI 服务模式，自动打开浏览器。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/demo.ps1
#
# 环境变量：
#   FENG_MODEL              模型 ID（默认 claude-sonnet-4-20250514）
#   FENG_PROVIDER           LLM 提供商（anthropic / openai / openai-compatible / bedrock / google）
#   ANTHROPIC_API_KEY       Anthropic API Key（使用 Anthropic 时必填）
#   OPENAI_API_KEY          OpenAI API Key（使用 OpenAI 时必填）
#   FENG_SERVER_PORT        服务端口（默认 3000）
#   FENG_SERVER_HOST        服务监听地址（默认 127.0.0.1）

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Set-Location $ProjectRoot

function Check-ApiKey {
    $provider = if ($env:FENG_PROVIDER) { $env:FENG_PROVIDER } else { "anthropic" }
    switch ($provider) {
        "anthropic" {
            if (-not $env:ANTHROPIC_API_KEY) {
                Write-Host "ANTHROPIC_API_KEY is not set." -ForegroundColor Red
                Write-Host "   `$env:ANTHROPIC_API_KEY = 'sk-ant-...'"
                exit 1
            }
        }
        "openai" {
            if (-not $env:OPENAI_API_KEY) {
                Write-Host "OPENAI_API_KEY is not set." -ForegroundColor Red
                Write-Host "   `$env:OPENAI_API_KEY = 'sk-...'"
                exit 1
            }
        }
        "openai-compatible" {
            if (-not $env:OPENAI_COMPATIBLE_API_KEY) {
                Write-Host "OPENAI_COMPATIBLE_API_KEY is not set." -ForegroundColor Red
                Write-Host "   `$env:OPENAI_COMPATIBLE_API_KEY = '...'"
                Write-Host "   `$env:OPENAI_COMPATIBLE_BASE_URL = '...'"
                exit 1
            }
        }
    }
}

function Ensure-WebUiBuilt {
    $webUiDist = Join-Path $ProjectRoot "packages\web-ui\dist"
    if (-not (Test-Path $webUiDist) -or -not (Get-ChildItem $webUiDist -ErrorAction SilentlyContinue)) {
        Write-Host "Building web-ui (first time only)..." -ForegroundColor Yellow
        Push-Location (Join-Path $ProjectRoot "packages\web-ui")
        bun install
        bun run build
        Pop-Location
        Write-Host "web-ui built." -ForegroundColor Green
    }
}

function Open-Browser {
    $port = if ($env:FENG_SERVER_PORT) { $env:FENG_SERVER_PORT } else { "3000" }
    $host_ = if ($env:FENG_SERVER_HOST) { $env:FENG_SERVER_HOST } else { "127.0.0.1" }
    $url = "http://${host_}:${port}"

    Write-Host "Opening browser at $url" -ForegroundColor Cyan
    Start-Process $url
}

Write-Host "Starting FengAgent Demo..." -ForegroundColor Green

Check-ApiKey
Ensure-WebUiBuilt

# 延迟 2 秒后打开浏览器
Start-Job -ScriptBlock {
    param($url)
    Start-Sleep -Seconds 2
    Start-Process $url
} -ArgumentList "http://$(if ($env:FENG_SERVER_HOST) { $env:FENG_SERVER_HOST } else { '127.0.0.1' }):$(if ($env:FENG_SERVER_PORT) { $env:FENG_SERVER_PORT } else { '3000' })" | Out-Null

Write-Host "   Press Ctrl+C to stop."
Write-Host ""

bun run packages/server/src/entry.ts
