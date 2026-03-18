# 7 Bar Market Monitor — One-Click Deploy
# Usage: Right-click > Run with PowerShell
#        OR in terminal: .\deploy.ps1
#        OR with custom message: .\deploy.ps1 "your commit message"

param(
    [string]$Message = ""
)

$ProjectDir = $PSScriptRoot
Set-Location $ProjectDir

Write-Host "`n--- 7 Bar Market Monitor Deploy ---`n" -ForegroundColor Cyan

# 1. Pull latest master so we are in sync
Write-Host "Pulling latest from master..." -ForegroundColor Yellow
git checkout master 2>&1 | Out-Null
git pull origin master --no-rebase
if ($LASTEXITCODE -ne 0) {
    Write-Host "Pull failed. Fix conflicts and try again." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# 2. Stage all changes
Write-Host "`nStaging changes..." -ForegroundColor Yellow
git add server.js app.js styles.css index.html SUMMARY.md nifty500-symbols.json 2>&1
git add -u 2>&1  # also stage any other tracked modified files

# 3. Check if there is anything to commit
$status = git status --porcelain
if (-not $status) {
    Write-Host "`nNothing to commit. Already up to date." -ForegroundColor Green
    Read-Host "Press Enter to exit"
    exit 0
}

# 4. Build commit message
if (-not $Message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
    $Message = "Update dashboard — $timestamp"
}

# 5. Commit
Write-Host "`nCommitting: $Message" -ForegroundColor Yellow
git commit -m $Message
if ($LASTEXITCODE -ne 0) {
    Write-Host "Commit failed." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# 6. Push to master
Write-Host "`nPushing to master..." -ForegroundColor Yellow
git push origin master
if ($LASTEXITCODE -ne 0) {
    Write-Host "Push failed. Run: git pull origin master --no-rebase, then try again." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "`nDone! Render will auto-deploy in ~2-3 minutes." -ForegroundColor Green
Write-Host "Dashboard: https://your-render-url.onrender.com`n" -ForegroundColor Cyan
Start-Sleep -Seconds 2
