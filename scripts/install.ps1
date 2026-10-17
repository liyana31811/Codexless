[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Codexless"),
  [switch]$Repair,
  [switch]$ExistingOnly,
  [switch]$Recommended,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$SourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$StateRoot = Join-Path $HOME ".config\codexless"
$BootstrapRoot = if ($env:CODEXLESS_BOOTSTRAP_ROOT) { [System.IO.Path]::GetFullPath($env:CODEXLESS_BOOTSTRAP_ROOT) } else { Join-Path $StateRoot "bootstrap" }
$ParentDir = Split-Path -Parent $InstallDir
$StageDir = Join-Path $ParentDir ("Codexless-stage-" + [guid]::NewGuid().ToString("N"))
$PreviousBackupDir = Join-Path $ParentDir "Codexless-previous"
$PreviousBackupStashDir = $null
$BackupDir = $null
$Installed = $false
$HadExistingInstall = $false
$RollbackPerformed = $false
$StateSchemaCompatible = $false
$LifecycleMode = if ($Repair) { "repair" } else { "install" }
$LifecycleAction = if ($Repair) { "repair-failed" } else { "install-failed" }
$ErrorStage = "preflight"
$ErrorCode = "INSTALL_FAILED"
$node = $null
$SuccessReceipt = $null
$ActivationLock = $null
$BootstrapPrepared = $null
$MarkerWritten = $false
$PreviousMarker = $null
$TransactionCommitted = $false
$SkillTransactionId = $null
$SkillFinalizeWarning = $null
$RuntimeModeRequested = if ($ExistingOnly) { "existing" } elseif ($Recommended) { "recommended" } else { $null }
$RuntimeModeEffective = $null
$RuntimePreferenceSnapshot = $null
$RuntimePreferenceChanged = $false
$ManagedProvisioning = $null
$ManagedOnboardingRequired = $false
$ManagedOnboardingCommand = $null

function Invoke-Checked {
  param(
    [Parameter(Mandatory=$true)][string]$Command,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
  )

  # Native npm stderr notices are not installer failures; the exit code is authoritative.
  $ErrorActionPreference = "Continue"
  if ($Json) {
    $captured = (& $Command @Arguments 2>&1 | Out-String).Trim()
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      $detail = if ($captured) { "`n$captured" } else { "" }
      throw "Command failed ($exitCode): $Command $($Arguments -join ' ')$detail"
    }
    return
  }

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
  }
}

function Read-JsonCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Command,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
  )
  $text = (& $Command @Arguments | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    try { return ($text | ConvertFrom-Json) } catch { throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')`n$text" }
  }
  return ($text | ConvertFrom-Json)
}

function Get-RequiredCommand {
  param([Parameter(Mandatory=$true)][string[]]$Names, [Parameter(Mandatory=$true)][string]$Label)
  foreach ($name in $Names) {
    $found = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
  }
  throw "$Label was not found on PATH."
}

function Assert-Node22 {
  param([Parameter(Mandatory=$true)][string]$Node)
  $version = (& $Node -p "process.versions.node").Trim()
  if ($LASTEXITCODE -ne 0 -or -not $version) { throw "Unable to read Node.js version." }
  $major = [int]($version.Split('.')[0])
  if ($major -lt 22) { throw "Codexless requires Node.js 22+. Current: v$version" }
  return $version
}

function Copy-ReleaseTree {
  param([Parameter(Mandatory=$true)][string]$From, [Parameter(Mandatory=$true)][string]$To)
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  $entries = @(
    "src", "config", "scripts", "skills", "bin",
    "package.json",
    "README.md", "README.zh-CN.md", "README.linux.md", "README.linux-tunnel.zh-CN.md", "SECURITY.md", "EXPORT_SYNC.md",
    "THIRD_PARTY_NOTICES.md", "LICENSE"
  )
  foreach ($entry in $entries) {
    $source = Join-Path $From $entry
    if (-not (Test-Path -LiteralPath $source)) { throw "Release source is missing required entry: $entry" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $To $entry) -Recurse -Force
  }

  $shrinkwrap = Join-Path $From "npm-shrinkwrap.json"
  $packageLock = Join-Path $From "package-lock.json"
  $selfDeletingBatchWrapper = Join-Path $To "bin\codexless-uninstall.cmd"
  if (Test-Path -LiteralPath $selfDeletingBatchWrapper) {
    Remove-Item -LiteralPath $selfDeletingBatchWrapper -Force
  }

  if (Test-Path -LiteralPath $shrinkwrap) {
    Copy-Item -LiteralPath $shrinkwrap -Destination (Join-Path $To "npm-shrinkwrap.json") -Force
  } elseif (Test-Path -LiteralPath $packageLock) {
    Copy-Item -LiteralPath $packageLock -Destination (Join-Path $To "package-lock.json") -Force
  } else {
    throw "Release source is missing a frozen npm lockfile: npm-shrinkwrap.json or package-lock.json"
  }
}

function Run-DoctorJson {
  param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Node)
  $doctor = Join-Path $Root "scripts\doctor.mjs"
  $text = (& $Node $doctor --json | Out-String).Trim()
  $exit = $LASTEXITCODE
  if (-not $text) { throw "Codexless doctor returned no output." }
  $parsed = $text | ConvertFrom-Json
  if ($exit -ne 0 -or $parsed.status -eq "error") {
    throw "Codexless doctor failed in $Root.`n$text"
  }
  return $parsed
}

function Release-ActivationLock {
  if (-not $ActivationLock) { return }
  $release = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "lock-release" "--state-root" $StateRoot "--nonce" ([string]$ActivationLock.nonce) "--owner-pid" ([string]$PID)
  if (-not $release.ok) { throw ([string]$release.error) }
  $script:ActivationLock = $null
}

function Get-BootstrapPreparedArgs {
  if (-not $BootstrapPrepared) { throw "Bootstrap prepared generation is unavailable." }
  $args = @(
    "--bootstrap-root", $BootstrapRoot,
    "--build-id", ([string]$BootstrapPrepared.buildId),
    "--reused", ($(if ($BootstrapPrepared.reused) { "true" } else { "false" }))
  )
  if (-not $BootstrapPrepared.reused) { $args += @("--pending-dir", ([string]$BootstrapPrepared.pendingDir)) }
  return $args
}

function Discard-BootstrapPrepared {
  if (-not $BootstrapPrepared) { return }
  $args = @((Join-Path $SourceRoot "scripts\materialize-bootstrap.mjs"), "discard") + (Get-BootstrapPreparedArgs)
  $result = Read-JsonCommand $node @args
  if (-not $result.ok) { throw ([string]$result.error) }
  $script:BootstrapPrepared = $null
}

function Restore-OwnershipMarker {
  if (-not $MarkerWritten) { return }
  if ($null -ne $PreviousMarker) {
    $restore = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "marker-restore" "--state-root" $StateRoot "--install-dir" $InstallDir "--build-id" ([string]$PreviousMarker.lastKnownBuildId) "--version" ([string]$PreviousMarker.lastKnownVersion) "--created-at" ([string]$PreviousMarker.createdAt) "--updated-at" ([string]$PreviousMarker.updatedAt)
  } else {
    $restore = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "marker-delete" "--state-root" $StateRoot "--install-dir" $InstallDir
  }
  if (-not $restore.ok) { throw ([string]$restore.error) }
  $script:MarkerWritten = $false
}

function Restore-PreviousBackupStash {
  if (-not $PreviousBackupStashDir) { return }
  if (-not (Test-Path -LiteralPath $PreviousBackupStashDir)) { throw "Previous backup rollback stash is missing." }
  if (Test-Path -LiteralPath $PreviousBackupDir) { throw "Previous backup path is occupied during rollback restore." }
  Move-Item -LiteralPath $PreviousBackupStashDir -Destination $PreviousBackupDir
  $script:PreviousBackupStashDir = $null
}

function Prepare-BrowserRepairSkillTransaction {
  $script = Join-Path $SourceRoot "scripts\sync-codex-skills.mjs"
  $source = Join-Path $SourceRoot "skills\codexless-browser-repair"
  $prepared = Read-JsonCommand $node $script "prepare" "--target-lane" "existing" "--source-dir" $source
  if (-not $prepared.ok) { throw ([string]$prepared.error) }
  $script:SkillTransactionId = if ($prepared.transactionId) { [string]$prepared.transactionId } else { $null }
  return $prepared
}

function Rollback-BrowserRepairSkillTransaction {
  if (-not $SkillTransactionId) { return }
  $rolledBack = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\sync-codex-skills.mjs") "rollback" "--target-lane" "existing" "--transaction-id" ([string]$SkillTransactionId)
  if (-not $rolledBack.ok) { throw ([string]$rolledBack.error) }
  $script:SkillTransactionId = $null
}

function Finalize-BrowserRepairSkillTransaction {
  if (-not $SkillTransactionId) { return }
  $finalized = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\sync-codex-skills.mjs") "finalize" "--target-lane" "existing" "--transaction-id" ([string]$SkillTransactionId)
  if (-not $finalized.ok) { throw ([string]$finalized.error) }
  $script:SkillTransactionId = $null
}

function Get-RuntimeInstallStatus {
  $status = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\runtime-install-state.mjs") "status" "--state-root" $StateRoot
  if (-not $status.ok) { throw ([string]$status.error) }
  return $status
}

function Set-RuntimeModePreference {
  param([Parameter(Mandatory=$true)][string]$Mode)
  $result = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\runtime-install-state.mjs") "set-mode" "--mode" $Mode "--state-root" $StateRoot
  if (-not $result.ok) { throw ([string]$result.error) }
}

function Restore-RuntimeModePreference {
  if (-not $RuntimePreferenceChanged) { return }
  if ($RuntimePreferenceSnapshot -and $RuntimePreferenceSnapshot.persisted) {
    Set-RuntimeModePreference -Mode ([string]$RuntimePreferenceSnapshot.mode)
  } else {
    $cleared = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\runtime-install-state.mjs") "clear-mode" "--state-root" $StateRoot
    if (-not $cleared.ok) { throw ([string]$cleared.error) }
  }
  $script:RuntimePreferenceChanged = $false
}

try {
  if ($env:OS -ne "Windows_NT") { throw "Codexless Technical Preview installer currently supports Windows only." }
  if ($ExistingOnly -and $Recommended) { throw "Choose at most one Advanced runtime mode: -ExistingOnly or -Recommended. Managed-only is not an installer option." }

  $ErrorStage = "prerequisite"
  $ErrorCode = "PREREQUISITE_FAILED"
  $node = Get-RequiredCommand -Names @("node.exe", "node") -Label "Node.js"
  $npm = Get-RequiredCommand -Names @("npm.cmd", "npm") -Label "npm"
  $nodeVersion = Assert-Node22 -Node $node

  $LockAction = if ($Repair) { "repair" } elseif (Test-Path -LiteralPath $InstallDir) { "update" } else { "install" }
  $ErrorStage = "activation-lock"
  $ErrorCode = "INSTALLER_BUSY"
  $ActivationLock = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "lock-acquire" "--state-root" $StateRoot "--install-dir" $InstallDir "--action" $LockAction "--owner-pid" ([string]$PID)
  if (-not $ActivationLock.ok) {
    if ($Json) { $ActivationLock | ConvertTo-Json -Depth 6 }
    else { Write-Error ([string]$ActivationLock.error) }
    exit 1
  }

  $HadExistingInstall = Test-Path -LiteralPath $InstallDir
  if (-not $Repair) {
    $LifecycleMode = if ($HadExistingInstall) { "update" } else { "install" }
    $LifecycleAction = if ($HadExistingInstall) { "update-failed" } else { "install-failed" }
  }

  $RuntimePreferenceSnapshot = (Get-RuntimeInstallStatus).preference
  $RuntimeModeEffective = if ($RuntimeModeRequested) { $RuntimeModeRequested } elseif ($RuntimePreferenceSnapshot.persisted) { [string]$RuntimePreferenceSnapshot.mode } else { "recommended" }
  if ($RuntimeModeRequested) {
    $ErrorStage = "runtime-mode-preference"
    $ErrorCode = "RUNTIME_MODE_PREFERENCE_FAILED"
    Set-RuntimeModePreference -Mode $RuntimeModeRequested
    $RuntimePreferenceChanged = $true
  }

  $ErrorStage = "prerequisite"
  $ErrorCode = "PREREQUISITE_FAILED"
  $codexResolution = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\resolve-codex.mjs")
  if (-not $codexResolution.ok -or -not $codexResolution.path) {
    throw ("Codex prerequisite check failed: " + $codexResolution.error)
  }
  $env:CODEX_BIN = [string]$codexResolution.path

  $ErrorStage = "staging"
  $ErrorCode = "STAGING_FAILED"
  New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null
  Copy-ReleaseTree -From $SourceRoot -To $StageDir

  Push-Location $StageDir
  try {
    $ErrorStage = "dependency-install"
    $ErrorCode = "DEPENDENCY_INSTALL_FAILED"
    Invoke-Checked $npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($RuntimeModeEffective -eq "recommended") {
      $ErrorStage = "managed-provision"
      $ErrorCode = "MANAGED_RUNTIME_PROVISION_FAILED"
      $ManagedProvisioning = Read-JsonCommand $node (Join-Path $StageDir "scripts\runtime-install-state.mjs") "verify-managed" "--state-root" $StateRoot
      if (-not $ManagedProvisioning.ok) { throw ([string]$ManagedProvisioning.error) }
      $ManagedOnboardingRequired = -not [bool]$ManagedProvisioning.managedReady
    }
    $ErrorStage = "staging-doctor"
    $ErrorCode = "STAGING_DOCTOR_FAILED"
    $stageDoctor = Run-DoctorJson -Root $StageDir -Node $node
  } finally {
    Pop-Location
  }

  $ErrorStage = "state-compatibility"
  $ErrorCode = "STATE_INCOMPATIBLE"
  $lifecycleArgs = @(
    (Join-Path $SourceRoot "scripts\lifecycle.mjs"), "preflight",
    "--target-root", $StageDir,
    "--mode", $LifecycleMode,
    "--install-dir", $InstallDir,
    "--state-root", $StateRoot
  )
  if ($HadExistingInstall) { $lifecycleArgs += @("--installed-root", $InstallDir) }
  $lifecyclePlan = Read-JsonCommand $node @lifecycleArgs
  if (-not $lifecyclePlan.ok) {
    $ErrorStage = [string]$lifecyclePlan.errorStage
    $ErrorCode = [string]$lifecyclePlan.errorCode
    throw [string]$lifecyclePlan.error
  }
  $StateSchemaCompatible = $true

  $ErrorStage = "bootstrap-prepare"
  $ErrorCode = "BOOTSTRAP_GENERATION_PREPARE_FAILED"
  $handoffBuild = [string]$env:CODEXLESS_BOOTSTRAP_PREPARED_BUILD_ID
  $handoffReused = [string]$env:CODEXLESS_BOOTSTRAP_PREPARED_REUSED
  $handoffPending = [string]$env:CODEXLESS_BOOTSTRAP_PREPARED_PENDING_DIR
  $handoffPresent = (-not [string]::IsNullOrWhiteSpace($handoffBuild)) -or (-not [string]::IsNullOrWhiteSpace($handoffReused)) -or (-not [string]::IsNullOrWhiteSpace($handoffPending))
  if ($handoffPresent) {
    if ([string]::IsNullOrWhiteSpace($handoffBuild) -or ($handoffReused -ne "true" -and $handoffReused -ne "false")) { throw "External bootstrap handoff is incomplete or invalid." }
    if ($handoffBuild -ne [string]$lifecyclePlan.artifactBuildId) { throw "External bootstrap handoff build does not match staged target build." }
    if ($handoffReused -eq "false" -and [string]::IsNullOrWhiteSpace($handoffPending)) { throw "External bootstrap handoff is missing its pending generation." }
    if ($handoffReused -eq "true" -and -not [string]::IsNullOrWhiteSpace($handoffPending)) { throw "External bootstrap handoff reused generation must not include a pending path." }
    $bootstrapArgs = @(
      (Join-Path $SourceRoot "scripts\materialize-bootstrap.mjs"), "validate",
      "--bootstrap-root", $BootstrapRoot,
      "--build-id", $handoffBuild,
      "--reused", $handoffReused
    )
    if ($handoffReused -eq "false") { $bootstrapArgs += @("--pending-dir", $handoffPending) }
    $bootstrapValidation = Read-JsonCommand $node @bootstrapArgs
    if (-not $bootstrapValidation.ok) { throw ([string]$bootstrapValidation.error) }
    $BootstrapPrepared = $bootstrapValidation.prepared
  } else {
    $bootstrapPrepare = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\materialize-bootstrap.mjs") "prepare" "--source-root" $StageDir "--bootstrap-root" $BootstrapRoot "--build-id" ([string]$lifecyclePlan.artifactBuildId)
    if (-not $bootstrapPrepare.ok) { throw ([string]$bootstrapPrepare.error) }
    $BootstrapPrepared = $bootstrapPrepare.prepared
  }

  $ErrorStage = "ownership-marker-snapshot"
  $ErrorCode = "OWNERSHIP_MARKER_SNAPSHOT_FAILED"
  $markerSnapshot = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "marker-read-optional" "--state-root" $StateRoot "--install-dir" $InstallDir
  if (-not $markerSnapshot.ok) { throw ([string]$markerSnapshot.error) }
  $PreviousMarker = $markerSnapshot.marker

  $ErrorStage = "skill-prepare"
  $ErrorCode = "SKILL_SYNC_PREPARE_FAILED"
  $skillPrepared = Prepare-BrowserRepairSkillTransaction

  if ($HadExistingInstall) {
    $ErrorStage = "backup"
    $ErrorCode = "BACKUP_FAILED"
    $BackupDir = Join-Path $ParentDir ("Codexless-backup-" + [guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $InstallDir -Destination $BackupDir
  }

  try {
    $ErrorStage = "activate"
    $ErrorCode = "ACTIVATE_FAILED"
    Move-Item -LiteralPath $StageDir -Destination $InstallDir
    $Installed = $true

    $ErrorStage = "installed-doctor"
    $ErrorCode = "INSTALLED_DOCTOR_FAILED"
    $installedDoctor = Run-DoctorJson -Root $InstallDir -Node $node

    $ErrorStage = "receipt"
    $ErrorCode = "RECEIPT_FAILED"
    $receiptArgs = @(
      (Join-Path $SourceRoot "scripts\lifecycle.mjs"), "receipt",
      "--target-root", $InstallDir,
      "--install-dir", $InstallDir,
      "--doctor-status", [string]$installedDoctor.status,
      "--mode", $LifecycleMode,
      "--state-root", $StateRoot
    )
    if ($HadExistingInstall) {
      $receiptArgs += @("--previous-root", $BackupDir, "--backup-retained", "true", "--backup-path", $PreviousBackupDir)
    }
    $SuccessReceipt = Read-JsonCommand $node @receiptArgs
    if (-not $SuccessReceipt.ok) {
      $ErrorStage = [string]$SuccessReceipt.errorStage
      $ErrorCode = [string]$SuccessReceipt.errorCode
      throw [string]$SuccessReceipt.error
    }

    if ($HadExistingInstall) {
      if (Test-Path -LiteralPath $PreviousBackupDir) {
        $ErrorStage = "previous-stash"
        $ErrorCode = "PREVIOUS_STASH_FAILED"
        $stashCandidate = Join-Path $ParentDir ("Codexless-previous.rollback-" + [string]$ActivationLock.nonce)
        if (Test-Path -LiteralPath $stashCandidate) { throw "Previous backup rollback stash already exists." }
        Move-Item -LiteralPath $PreviousBackupDir -Destination $stashCandidate
        $PreviousBackupStashDir = $stashCandidate
      }
      $ErrorStage = "backup-retention"
      $ErrorCode = "BACKUP_RETENTION_FAILED"
      Move-Item -LiteralPath $BackupDir -Destination $PreviousBackupDir
      $BackupDir = $PreviousBackupDir
    }

    $ErrorStage = "ownership-marker"
    $ErrorCode = "OWNERSHIP_MARKER_WRITE_FAILED"
    $marker = Read-JsonCommand $node (Join-Path $SourceRoot "scripts\lifecycle.mjs") "marker-write" "--state-root" $StateRoot "--install-dir" $InstallDir "--build-id" ([string]$SuccessReceipt.artifactBuildId) "--version" ([string]$SuccessReceipt.to.version)
    if (-not $marker.ok) {
      $ErrorStage = [string]$marker.errorStage
      $ErrorCode = [string]$marker.errorCode
      throw [string]$marker.error
    }
    $MarkerWritten = $true

    $ErrorStage = "bootstrap-commit"
    $ErrorCode = "BOOTSTRAP_GENERATION_COMMIT_FAILED"
    $bootstrapCommitArgs = @((Join-Path $SourceRoot "scripts\materialize-bootstrap.mjs"), "commit") + (Get-BootstrapPreparedArgs)
    $bootstrapCommit = Read-JsonCommand $node @bootstrapCommitArgs
    if (-not $bootstrapCommit.ok) {
      if ($bootstrapCommit.errorCode) { $ErrorCode = [string]$bootstrapCommit.errorCode }
      throw ([string]$bootstrapCommit.error)
    }
    if ([string]$bootstrapCommit.buildId -ne [string]$SuccessReceipt.artifactBuildId) { throw "Bootstrap commit did not activate the installed build." }

    $BootstrapPrepared = $null
    $MarkerWritten = $false
    $PreviousMarker = $null
    $BackupDir = $null
    $Installed = $false
    $TransactionCommitted = $true
    $RuntimePreferenceChanged = $false

    if ($SkillTransactionId) {
      try {
        $ErrorStage = "skill-finalize"
        $ErrorCode = "SKILL_SYNC_FINALIZE_FAILED"
        Finalize-BrowserRepairSkillTransaction
      } catch {
        $SkillFinalizeWarning = $_.Exception.Message
      }
    }

    if ($PreviousBackupStashDir) {
      $ErrorStage = "previous-stash-cleanup"
      $ErrorCode = "PREVIOUS_STASH_CLEANUP_FAILED"
      Remove-Item -LiteralPath $PreviousBackupStashDir -Recurse -Force
      $PreviousBackupStashDir = $null
    }
  } catch {
    $transactionFailure = $_.Exception.Message
    if (-not $TransactionCommitted) {
      if ($Installed -and (Test-Path -LiteralPath $InstallDir)) {
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        $Installed = $false
      }
      if ($BackupDir -and (Test-Path -LiteralPath $BackupDir) -and -not (Test-Path -LiteralPath $InstallDir)) {
        Move-Item -LiteralPath $BackupDir -Destination $InstallDir
        $BackupDir = $null
        $RollbackPerformed = $true
      }
      if ($PreviousBackupStashDir) {
        try { Restore-PreviousBackupStash } catch {
          $ErrorStage = "previous-restore"
          $ErrorCode = "PREVIOUS_STASH_RESTORE_FAILED"
          $transactionFailure = "Lifecycle rollback could not restore the retained previous install."
        }
      }
      if ($MarkerWritten) {
        try { Restore-OwnershipMarker } catch {
          if ($ErrorCode -ne "PREVIOUS_STASH_RESTORE_FAILED") {
            $ErrorStage = "ownership-marker"
            $ErrorCode = "OWNERSHIP_MARKER_ROLLBACK_FAILED"
            $transactionFailure = "Lifecycle rollback could not restore the previous ownership marker."
          }
        }
      }
      if ($BootstrapPrepared) {
        try { Discard-BootstrapPrepared } catch {
          if ($ErrorCode -ne "PREVIOUS_STASH_RESTORE_FAILED") {
            $ErrorStage = "bootstrap-discard"
            $ErrorCode = "BOOTSTRAP_GENERATION_DISCARD_FAILED"
            $transactionFailure = "Lifecycle rollback could not discard the prepared bootstrap generation."
          }
        }
      }
      if ($RuntimePreferenceChanged) {
        try { Restore-RuntimeModePreference } catch {
          $ErrorStage = "runtime-mode-preference-rollback"
          $ErrorCode = "RUNTIME_MODE_PREFERENCE_ROLLBACK_FAILED"
          $transactionFailure = "Lifecycle rollback could not restore the previous runtime mode preference."
        }
      }
      if ($SkillTransactionId) {
        try { Rollback-BrowserRepairSkillTransaction } catch {
          $ErrorStage = "skill-rollback"
          $ErrorCode = "SKILL_SYNC_ROLLBACK_FAILED"
          $transactionFailure = "Lifecycle rollback could not restore the previous Browser Repair Skill state."
        }
      }
    }
    throw $transactionFailure
  }

  $ErrorStage = "activation-lock-release"
  $ErrorCode = "INSTALLER_LOCK_RELEASE_FAILED"
  Release-ActivationLock

  $ManagedOnboardingCommand = if ($ManagedOnboardingRequired) { 'node "' + (Join-Path $InstallDir "scripts\managed-codex-login.mjs") + '"' } else { $null }
  $runtimeInstall = [ordered]@{
    mode = $RuntimeModeEffective
    requestedMode = $RuntimeModeRequested
    recommendedDualInsurance = ($RuntimeModeEffective -eq "recommended")
    managedProvisioned = ($null -ne $ManagedProvisioning)
    managedActivation = if ($ManagedProvisioning) { [string]$ManagedProvisioning.activation } else { $null }
    managedOnboardingRequired = $ManagedOnboardingRequired
    managedOnboardingCommand = $ManagedOnboardingCommand
    noSilentFallback = $true
  }
  $SuccessReceipt | Add-Member -NotePropertyName runtimeInstall -NotePropertyValue $runtimeInstall -Force
  if ($SkillFinalizeWarning) { $SuccessReceipt | Add-Member -NotePropertyName skillFinalizeWarning -NotePropertyValue $SkillFinalizeWarning -Force }

  if ($Json) { $SuccessReceipt | ConvertTo-Json -Depth 8 }
  else {
    Write-Host "Codexless $($SuccessReceipt.action): $($SuccessReceipt.to.version)"
    Write-Host "Location: $InstallDir"
    Write-Host "Doctor: $(Join-Path $InstallDir 'bin\codexless-doctor.cmd')"
    Write-Host "HTTP:   $(Join-Path $InstallDir 'bin\codexless-http.cmd')"
    if ($SuccessReceipt.rollback.backupRetained) { Write-Host "Previous build retained: $($SuccessReceipt.rollback.backupPath)" }
    Write-Host "Runtime mode: $RuntimeModeEffective"
    if ($ManagedProvisioning) { Write-Host "Managed runtime: provisioned $($ManagedProvisioning.managed.packageName)@$($ManagedProvisioning.managed.packageVersion) + $($ManagedProvisioning.managed.platformPackageName)@$($ManagedProvisioning.managed.platformPackageVersion); activation=$($ManagedProvisioning.activation)" }
    else { Write-Host "Managed runtime: skipped by Advanced Existing-only mode." }
    if ($ManagedOnboardingRequired) {
      Write-Host ""
      Write-Host "NEXT ACTION: Managed ChatGPT login is required before dual activation."
      Write-Host "Run: $ManagedOnboardingCommand"
    }
    if ($SkillFinalizeWarning) { Write-Warning "Browser Repair Skill transaction cleanup remains pending: $SkillFinalizeWarning" }
    Write-Host "No PATH, service, Browser, or Tunnel settings were changed."
  }
} catch {
  $failureMessage = $_.Exception.Message
  if (-not $TransactionCommitted) {
    if (Test-Path -LiteralPath $StageDir) { Remove-Item -LiteralPath $StageDir -Recurse -Force -ErrorAction SilentlyContinue }
    if ($BackupDir -and (Test-Path -LiteralPath $BackupDir) -and -not (Test-Path -LiteralPath $InstallDir)) {
      Move-Item -LiteralPath $BackupDir -Destination $InstallDir -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $InstallDir) { $BackupDir = $null; $RollbackPerformed = $true }
    }
    if ($PreviousBackupStashDir) {
      try { Restore-PreviousBackupStash } catch {
        $ErrorStage = "previous-restore"
        $ErrorCode = "PREVIOUS_STASH_RESTORE_FAILED"
        $failureMessage = "Lifecycle rollback could not restore the retained previous install."
      }
    }
    if ($MarkerWritten) {
      try { Restore-OwnershipMarker } catch {
        if ($ErrorCode -ne "PREVIOUS_STASH_RESTORE_FAILED") {
          $ErrorStage = "ownership-marker"
          $ErrorCode = "OWNERSHIP_MARKER_ROLLBACK_FAILED"
          $failureMessage = "Lifecycle rollback could not restore the previous ownership marker."
        }
      }
    }
    if ($BootstrapPrepared) {
      try { Discard-BootstrapPrepared } catch {
        if ($ErrorCode -ne "PREVIOUS_STASH_RESTORE_FAILED") {
          $ErrorStage = "bootstrap-discard"
          $ErrorCode = "BOOTSTRAP_GENERATION_DISCARD_FAILED"
          $failureMessage = "Lifecycle rollback could not discard the prepared bootstrap generation."
        }
      }
    }
    if ($RuntimePreferenceChanged) {
      try { Restore-RuntimeModePreference } catch {
        $ErrorStage = "runtime-mode-preference-rollback"
        $ErrorCode = "RUNTIME_MODE_PREFERENCE_ROLLBACK_FAILED"
        $failureMessage = "Lifecycle rollback could not restore the previous runtime mode preference."
      }
    }
    if ($SkillTransactionId) {
      try { Rollback-BrowserRepairSkillTransaction } catch {
        $ErrorStage = "skill-rollback"
        $ErrorCode = "SKILL_SYNC_ROLLBACK_FAILED"
        $failureMessage = "Lifecycle rollback could not restore the previous Browser Repair Skill state."
      }
    }
  }
  if ($ActivationLock) {
    try { Release-ActivationLock } catch {}
  }
  if ($Json) {
    $failureOutput = $null
    if ($node -and (Test-Path -LiteralPath (Join-Path $SourceRoot "scripts\lifecycle.mjs"))) {
      try {
        $rollbackText = if ($RollbackPerformed) { "true" } else { "false" }
        $schemaText = if ($StateSchemaCompatible) { "true" } else { "false" }
        $failureMessageLimit = 65536
        $failureSuffix = "`n...[failure detail truncated at $failureMessageLimit characters]"
        if ($failureMessage.Length -gt $failureMessageLimit) {
          $failureMessage = $failureMessage.Substring(0, $failureMessageLimit - $failureSuffix.Length) + $failureSuffix
        }
        $failurePayload = [ordered]@{
          lifecycle = Join-Path $SourceRoot "scripts\lifecycle.mjs"
          action = $LifecycleAction
          installDir = $InstallDir
          errorStage = $ErrorStage
          errorCode = $ErrorCode
          error = $failureMessage
          rollbackPerformed = $rollbackText
          stateSchemaCompatible = $schemaText
        } | ConvertTo-Json -Compress
        $failurePayloadBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($failurePayload))
        $failureBridgeTemplateBase64 = "aW1wb3J0e3BhdGhUb0ZpbGVVUkx9ZnJvbSJub2RlOnVybCI7Y29uc3QgcD1KU09OLnBhcnNlKEJ1ZmZlci5mcm9tKCJfX1BBWUxPQURfXyIsImJhc2U2NCIpLnRvU3RyaW5nKCJ1dGY4IikpO2xldCBvPSIiO2NvbnN0IHc9cHJvY2Vzcy5zdGRvdXQud3JpdGUuYmluZChwcm9jZXNzLnN0ZG91dCk7cHJvY2Vzcy5zdGRvdXQud3JpdGU9KGMpPT57bys9QnVmZmVyLmlzQnVmZmVyKGMpP2MudG9TdHJpbmcoInV0ZjgiKTpTdHJpbmcoYyk7cmV0dXJuIHRydWV9O3Byb2Nlc3MuYXJndj1bcHJvY2Vzcy5leGVjUGF0aCxwLmxpZmVjeWNsZSwiZmFpbHVyZSIsIi0tYWN0aW9uIixwLmFjdGlvbiwiLS1pbnN0YWxsLWRpciIscC5pbnN0YWxsRGlyLCItLWVycm9yLXN0YWdlIixwLmVycm9yU3RhZ2UsIi0tZXJyb3ItY29kZSIscC5lcnJvckNvZGUsIi0tZXJyb3IiLHAuZXJyb3IsIi0tcm9sbGJhY2stcGVyZm9ybWVkIixwLnJvbGxiYWNrUGVyZm9ybWVkLCItLXN0YXRlLXNjaGVtYS1jb21wYXRpYmxlIixwLnN0YXRlU2NoZW1hQ29tcGF0aWJsZV07dHJ5e2F3YWl0IGltcG9ydChwYXRoVG9GaWxlVVJMKHAubGlmZWN5Y2xlKS5ocmVmKX1maW5hbGx5e3Byb2Nlc3Muc3Rkb3V0LndyaXRlPXc7dyhCdWZmZXIuZnJvbShvLCJ1dGY4IikudG9TdHJpbmcoImJhc2U2NCIpKX0="
        $failureBridge = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($failureBridgeTemplateBase64)).Replace("__PAYLOAD__", $failurePayloadBase64)
        $failureOutputBase64 = ($failureBridge | & $node --input-type=module | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $failureOutputBase64) {
          $failureOutput = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($failureOutputBase64)).Trim()
        }
      } catch {}
    }
    if ($failureOutput) { Write-Output $failureOutput }
    else {
      [ordered]@{
        ok = $false; receiptVersion = 1; action = $LifecycleAction; installDir = $InstallDir
        from = $null; to = $null; artifactBuildId = $null; doctorStatus = $null
        state = [ordered]@{ preserved = $true; schemaCompatible = $StateSchemaCompatible; migrated = $false }
        rollback = [ordered]@{ performed = $RollbackPerformed; backupRetained = $false; backupPath = $null }
        requiresRuntimeRestart = $false; requiresHostRefresh = $false
        errorStage = $ErrorStage; errorCode = $ErrorCode; error = $failureMessage
      } | ConvertTo-Json -Depth 6
    }
  } else {
    Write-Error $failureMessage
  }
  exit 1
}
