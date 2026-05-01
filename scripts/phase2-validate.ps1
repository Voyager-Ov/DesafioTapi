Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Region = 'us-east-1'
$Root = 'C:\github desktop\tapi'
$CdkDir = Join-Path $Root 'cdk'
$Now = Get-Date -Format 'yyyyMMdd-HHmmss'
$ArtifactsDir = Join-Path $Root "artifacts\phase2-validation\$Now"

$StateMachineArn = 'arn:aws:states:us-east-1:782208973822:stateMachine:tapi-consumer-state-machine'
$ProducerFunction = 'tapi-producer'
$QueueName = 'tapi-provider-queue.fifo'
$PendingTable = 'tapi-pending-records'
$IdempotencyTable = 'tapi-idempotency'
$ResultsTable = 'tapi-results'
$TestDate = '2026-04-30'
$PendingPk = "DATE#$TestDate"
$SeedFile = Join-Path $Root 'docs\phase2\phase2-pending-seed.json'
$ProducerPayloadFile = Join-Path $Root 'docs\phase2\payload-phase2.json'
$DuplicateMessageFile = Join-Path $Root 'docs\phase2\duplicate-record.json'
$ProducerResponseFile = Join-Path $Root 'response-phase2.json'
$RecordsOfInterest = @('rec-201', 'rec-202', 'rec-203', 'rec-204', 'rec-999')

New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null

function Write-Section {
  param([string]$Message)
  Write-Host ''
  Write-Host "=== $Message ==="
}

function Invoke-And-Capture {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Command,
    [Parameter(Mandatory = $true)]
    [string]$Workdir
  )

  $outFile = Join-Path $ArtifactsDir $Name
  Write-Host "[$Name] $Command"

  Push-Location $Workdir
  try {
    $output = Invoke-Expression $Command 2>&1
    $output | Tee-Object -FilePath $outFile
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed with exit code ${LASTEXITCODE}: $Command"
    }
  } finally {
    Pop-Location
  }
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [object]$Value
  )

  $Value | ConvertTo-Json -Depth 100 | Set-Content -Path $Path
}

function Invoke-AwsJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  $raw = Invoke-Expression $Command 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "AWS command failed: $Command`n$($raw | Out-String)"
  }

  if ($raw -is [System.Array]) {
    $raw = ($raw -join [Environment]::NewLine)
  }

  if ([string]::IsNullOrWhiteSpace([string]$raw)) {
    return $null
  }

  return ($raw | ConvertFrom-Json)
}

function Get-Executions {
  Invoke-AwsJson "aws stepfunctions list-executions --region $Region --state-machine-arn $StateMachineArn --max-results 50"
}

function Get-PendingSnapshot {
  $expr = "{`":pk`":{`"S`":`"$PendingPk`"}}"
  Invoke-AwsJson "aws dynamodb query --region $Region --table-name $PendingTable --key-condition-expression `"PK = :pk`" --expression-attribute-values '$expr'"
}

function Get-IdempotencySnapshot {
  Invoke-AwsJson "aws dynamodb scan --region $Region --table-name $IdempotencyTable"
}

function Get-ResultsSnapshot {
  Invoke-AwsJson "aws dynamodb scan --region $Region --table-name $ResultsTable"
}

function Remove-IdempotencyItems {
  $scan = Get-IdempotencySnapshot
  if (-not $scan -or -not $scan.Items) {
    return
  }

  foreach ($item in $scan.Items) {
    $key = @{
      idempotencyKey = $item.idempotencyKey
    }
    $json = $key | ConvertTo-Json -Compress -Depth 10
    Invoke-Expression "aws dynamodb delete-item --region $Region --table-name $IdempotencyTable --key '$json'" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to delete idempotency item: $json"
    }
  }
}

function Remove-PendingItemsForDate {
  $query = Get-PendingSnapshot
  if (-not $query -or -not $query.Items) {
    return
  }

  foreach ($item in $query.Items) {
    $key = @{
      PK = $item.PK
      SK = $item.SK
    }
    $json = $key | ConvertTo-Json -Compress -Depth 10
    Invoke-Expression "aws dynamodb delete-item --region $Region --table-name $PendingTable --key '$json'" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to delete pending item: $json"
    }
  }
}

function Wait-For-StateMachineSettled {
  param([int]$TimeoutSeconds = 300)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Seconds 5
    $executions = Get-Executions
    $running = @($executions.executions | Where-Object { $_.status -eq 'RUNNING' }).Count
  } while ($running -gt 0 -and (Get-Date) -lt $deadline)

  if ($running -gt 0) {
    throw "State machine still has RUNNING executions after $TimeoutSeconds seconds"
  }
}

function Wait-For-NewExecutions {
  param(
    [Parameter(Mandatory = $true)]
    [datetime]$StartedAfterUtc,
    [int]$ExpectedCount = 4,
    [int]$TimeoutSeconds = 300
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Seconds 5
    $executions = Get-Executions
    $recent = @(
      $executions.executions | Where-Object {
        ([datetime]$_.startDate).ToUniversalTime() -ge $StartedAfterUtc
      }
    )
  } while ($recent.Count -lt $ExpectedCount -and (Get-Date) -lt $deadline)

  if ($recent.Count -lt $ExpectedCount) {
    throw "Expected at least $ExpectedCount executions after $StartedAfterUtc, found $($recent.Count)"
  }

  return $recent
}

function Export-ExecutionHistories {
  param(
    [Parameter(Mandatory = $true)]
    [array]$Executions
  )

  Write-JsonFile -Path (Join-Path $ArtifactsDir '11-executions.json') -Value $Executions

  foreach ($execution in $Executions) {
    $safeName = $execution.name
    $history = Invoke-AwsJson "aws stepfunctions get-execution-history --region $Region --execution-arn $($execution.executionArn) --max-results 200"
    Write-JsonFile -Path (Join-Path $ArtifactsDir "execution-$safeName-history.json") -Value $history
  }
}

function Export-Logs {
  Invoke-And-Capture -Name '20-producer-logs.txt' -Command "aws logs tail /aws/lambda/tapi-producer --region $Region --since 1h" -Workdir $Root
  Invoke-And-Capture -Name '21-orchestrator-logs.txt' -Command "aws logs tail /aws/lambda/tapi-orchestrator --region $Region --since 1h" -Workdir $Root
  Invoke-And-Capture -Name '22-consumer-logs.txt' -Command "aws logs tail /aws/lambda/tapi-consumer --region $Region --since 1h" -Workdir $Root
  Invoke-And-Capture -Name '23-state-machine-logs.txt' -Command "aws logs tail /aws/vendedlogs/states/tapi-consumer-state-machine --region $Region --since 1h" -Workdir $Root
}

function Get-QueueUrl {
  $queueUrl = Invoke-Expression "aws sqs get-queue-url --region $Region --queue-name $QueueName --query QueueUrl --output text"
  if ($LASTEXITCODE -ne 0) {
    throw 'Failed to resolve queue URL'
  }
  return [string]$queueUrl
}

function Send-DuplicateMessages {
  $queueUrl = Get-QueueUrl
  $commands = @(
    "aws sqs send-message --region $Region --queue-url $queueUrl --message-body file://$DuplicateMessageFile --message-group-id `"PROVIDER#prov-D`" --message-deduplication-id `"dup-test-1`"",
    "aws sqs send-message --region $Region --queue-url $queueUrl --message-body file://$DuplicateMessageFile --message-group-id `"PROVIDER#prov-D`" --message-deduplication-id `"dup-test-2`""
  )

  $outFile = Join-Path $ArtifactsDir '12-duplicate-send.txt'
  foreach ($command in $commands) {
    Write-Host "[12-duplicate-send.txt] $command"
    $result = Invoke-Expression $command 2>&1
    $result | Tee-Object -FilePath $outFile -Append
    if ($LASTEXITCODE -ne 0) {
      throw "Failed duplicate send: $command"
    }
  }
}

function Get-ExecutionScenario {
  param([object]$Execution)

  $name = [string]$Execution.name
  $historyPath = Join-Path $ArtifactsDir "execution-$name-history.json"
  if (-not (Test-Path $historyPath)) {
    return 'UNKNOWN'
  }

  $history = Get-Content -Raw $historyPath | ConvertFrom-Json
  $text = $history | ConvertTo-Json -Depth 50

  if ($text -match 'DuplicateWorkItem') { return 'DUPLICATE' }
  if ($text -match 'PersistExhaustedTransientFailure') { return 'TRANSIENT_EXHAUSTED' }
  if ($text -match 'PersistTerminalFailureResult') { return 'TERMINAL' }
  if ($text -match 'PersistSuccessResult') { return 'SUCCESS' }
  return 'UNKNOWN'
}

function Build-Summary {
  $pending = Get-Content -Raw (Join-Path $ArtifactsDir '30-pending-final.json') | ConvertFrom-Json
  $idempotency = Get-Content -Raw (Join-Path $ArtifactsDir '31-idempotency-final.json') | ConvertFrom-Json
  $results = Get-Content -Raw (Join-Path $ArtifactsDir '32-results-final.json') | ConvertFrom-Json
  $executions = Get-Content -Raw (Join-Path $ArtifactsDir '11-executions.json') | ConvertFrom-Json

  $pendingByRecord = @{}
  foreach ($item in @($pending.Items)) {
    $pendingByRecord[$item.recordId.S] = $item.status.S
  }

  $idempotencyByRecord = @{}
  foreach ($item in @($idempotency.Items)) {
    $idempotencyByRecord[$item.recordId.S] = $item.status.S
  }

  $resultsByRecord = @{}
  foreach ($item in @($results.Items)) {
    $recordId = $item.recordId.S
    if (-not $resultsByRecord.ContainsKey($recordId)) {
      $resultsByRecord[$recordId] = @()
    }
    $resultsByRecord[$recordId] += ,$item
  }

  $recentExecutions = @($executions | Where-Object { $_.name })
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('# Phase 2 Validation Summary')
  $lines.Add('')
  $lines.Add("Artifacts: `$ArtifactsDir = $ArtifactsDir`")
  $lines.Add('')
  $lines.Add('| Record | Pending | Idempotency | Results Rows | Expected | Status |')
  $lines.Add('| --- | --- | --- | --- | --- | --- |')

  foreach ($recordId in $RecordsOfInterest) {
    $pendingStatus = if ($pendingByRecord.ContainsKey($recordId)) { $pendingByRecord[$recordId] } else { 'MISSING' }
    $idempotencyStatus = if ($idempotencyByRecord.ContainsKey($recordId)) { $idempotencyByRecord[$recordId] } else { 'MISSING' }
    $resultRows = if ($resultsByRecord.ContainsKey($recordId)) { $resultsByRecord[$recordId].Count } else { 0 }

    switch ($recordId) {
      'rec-201' { $expected = 'COMPLETED' }
      'rec-202' { $expected = 'COMPLETED' }
      'rec-203' { $expected = 'FAILED_TERMINAL' }
      'rec-204' { $expected = 'FAILED_TRANSIENT_EXHAUSTED' }
      'rec-999' { $expected = 'DUPLICATE_NO_NEW_RESULT' }
      default { $expected = 'UNKNOWN' }
    }

    $status = 'CHECK'
    if ($recordId -in @('rec-201', 'rec-202')) {
      if ($pendingStatus -eq 'COMPLETED' -and $idempotencyStatus -eq 'COMPLETED' -and $resultRows -ge 1) {
        $status = 'PASS'
      } else {
        $status = 'FAIL'
      }
    } elseif ($recordId -eq 'rec-203') {
      if ($pendingStatus -eq 'FAILED' -and $idempotencyStatus -eq 'FAILED' -and $resultRows -ge 1) {
        $status = 'PASS'
      } else {
        $status = 'FAIL'
      }
    } elseif ($recordId -eq 'rec-204') {
      if ($pendingStatus -eq 'FAILED' -and $idempotencyStatus -eq 'FAILED' -and $resultRows -ge 1) {
        $status = 'PASS'
      } else {
        $status = 'FAIL'
      }
    } elseif ($recordId -eq 'rec-999') {
      if ($resultRows -le 1) {
        $status = 'PASS'
      } else {
        $status = 'FAIL'
      }
    }

    $lines.Add(('| {0} | {1} | {2} | {3} | {4} | {5} |' -f $recordId, $pendingStatus, $idempotencyStatus, $resultRows, $expected, $status))
  }

  $lines.Add('')
  $lines.Add('## Executions')
  $lines.Add('')
  foreach ($execution in $recentExecutions) {
    $scenario = Get-ExecutionScenario -Execution $execution
    $lines.Add(('- {0} | {1} | {2} | {3}' -f $execution.name, $execution.status, $scenario, $execution.startDate))
  }

  $lines.Add('')
  $lines.Add('## Closing Criteria')
  $lines.Add('')
  $lines.Add('- `rec-201` and `rec-202` must be COMPLETED with final result rows.')
  $lines.Add('- `rec-203` must fail through terminal path.')
  $lines.Add('- `rec-204` must fail through exhausted transient path.')
  $lines.Add('- Duplicate path must not create extra final results for `rec-999`.')
  $lines.Add('- No idempotency rows should remain stuck in `IN_PROGRESS`.')

  Set-Content -Path (Join-Path $ArtifactsDir '99-summary.md') -Value $lines
}

Write-Section 'Phase 2 validation started'
Invoke-And-Capture -Name '01-build.txt' -Command 'npm run build' -Workdir $Root
Invoke-And-Capture -Name '02-test.txt' -Command 'npm test -- --runInBand' -Workdir $Root
Invoke-And-Capture -Name '03-synth.txt' -Command 'npx cdk synth TapiStack' -Workdir $CdkDir
Invoke-And-Capture -Name '04-cdk-diff.txt' -Command 'npx cdk diff TapiStack' -Workdir $CdkDir
Invoke-And-Capture -Name '05-cdk-deploy.txt' -Command 'npx cdk deploy TapiStack --require-approval never' -Workdir $CdkDir

Write-Section 'Capturing pre-reset snapshots'
Write-JsonFile -Path (Join-Path $ArtifactsDir '06-pending-before-reset.json') -Value (Get-PendingSnapshot)
Write-JsonFile -Path (Join-Path $ArtifactsDir '07-idempotency-before-reset.json') -Value (Get-IdempotencySnapshot)

Write-Section 'Resetting operational state'
$resetLog = Join-Path $ArtifactsDir '08-reset-log.txt'
"Reset started at $(Get-Date -Format o)" | Set-Content $resetLog
Remove-IdempotencyItems
Remove-PendingItemsForDate
"Reset finished at $(Get-Date -Format o)" | Add-Content $resetLog
Write-JsonFile -Path (Join-Path $ArtifactsDir '08b-pending-after-reset.json') -Value (Get-PendingSnapshot)
Write-JsonFile -Path (Join-Path $ArtifactsDir '08c-idempotency-after-reset.json') -Value (Get-IdempotencySnapshot)

Write-Section 'Seeding pending records'
Invoke-And-Capture -Name '09-seed-output.json' -Command "aws dynamodb batch-write-item --region $Region --request-items file://$SeedFile" -Workdir $Root

Write-Section 'Invoking producer'
$baselineUtc = (Get-Date).ToUniversalTime()
Invoke-And-Capture -Name '10-producer-response.json' -Command "aws lambda invoke --region $Region --function-name $ProducerFunction --cli-binary-format raw-in-base64-out --payload file://$ProducerPayloadFile $ProducerResponseFile" -Workdir $Root

Write-Section 'Waiting for primary executions'
$primaryExecutions = Wait-For-NewExecutions -StartedAfterUtc $baselineUtc -ExpectedCount 4
Wait-For-StateMachineSettled
Export-ExecutionHistories -Executions $primaryExecutions

Write-Section 'Sending duplicate messages'
$duplicateBaselineUtc = (Get-Date).ToUniversalTime()
Send-DuplicateMessages
Start-Sleep -Seconds 5
$allExecutions = Get-Executions
$duplicateExecutions = @(
  $allExecutions.executions | Where-Object {
    ([datetime]$_.startDate).ToUniversalTime() -ge $duplicateBaselineUtc
  }
)
Wait-For-StateMachineSettled
Export-ExecutionHistories -Executions ($primaryExecutions + $duplicateExecutions | Sort-Object name -Unique)

Write-Section 'Capturing logs and final snapshots'
Export-Logs
Write-JsonFile -Path (Join-Path $ArtifactsDir '30-pending-final.json') -Value (Get-PendingSnapshot)
Write-JsonFile -Path (Join-Path $ArtifactsDir '31-idempotency-final.json') -Value (Get-IdempotencySnapshot)
Write-JsonFile -Path (Join-Path $ArtifactsDir '32-results-final.json') -Value (Get-ResultsSnapshot)

Write-Section 'Building summary'
Build-Summary

Write-Host ''
Write-Host "Phase 2 validation artifacts written to:"
Write-Host $ArtifactsDir
