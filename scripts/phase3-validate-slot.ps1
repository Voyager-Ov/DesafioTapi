param(
  [int]$RecordCount = 100,
  [ValidateSet('smoke-fixed', 'random-large')]
  [string]$SeedProfile = 'smoke-fixed',
  [int]$ProviderCount = 0,
  [int]$SlotId = 149,
  [int]$SlotsPerDay = 288,
  [string]$Region = 'us-east-1',
  [int]$TimeoutSeconds = 0,
  [string]$Root = 'C:\github desktop\tapi'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($SeedProfile -eq 'smoke-fixed' -and $RecordCount -ne 100) {
  throw "SeedProfile 'smoke-fixed' only supports RecordCount = 100."
}

if ($ProviderCount -le 0) {
  $ProviderCount = if ($SeedProfile -eq 'random-large') { 250 } else { 6 }
}

if ($TimeoutSeconds -le 0) {
  $TimeoutSeconds = if ($RecordCount -ge 10000) { 5400 } elseif ($RecordCount -ge 1000) { 1800 } else { 900 }
}

$EnableDetailedLogValidation = $RecordCount -le 1000
$PollIntervalSeconds = if ($RecordCount -ge 10000) { 15 } elseif ($RecordCount -ge 1000) { 10 } else { 5 }

$Now = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunFolderName = if ($SeedProfile -eq 'smoke-fixed') { '100-record-smoke' } else { "$RecordCount-record-$SeedProfile" }
$ArtifactsDir = Join-Path $Root "artifacts\phase3-validation\$RunFolderName\$Now"

$ProducerFunction = 'tapi-producer'
$PendingTable = 'tapi-pending-records'
$IdempotencyTable = 'tapi-idempotency'
$ResultsTable = 'tapi-results'
$QueueName = 'tapi-provider-queue.fifo'
$ScheduleName = 'tapi-dispatch-slot-000'
$ProducerLogGroup = '/aws/lambda/tapi-producer'
$BootstrapLogGroup = '/aws/lambda/tapi-workflow-bootstrap'
$ConsumerLogGroup = '/aws/lambda/tapi-consumer'
$StateMachineLogGroup = '/aws/vendedlogs/states/tapi-consumer-state-machine'
$StateMachineName = 'tapi-consumer-state-machine-express'
$TargetDate = (Get-Date).ToUniversalTime().AddDays(1).ToString('yyyy-MM-dd')
$ProviderRunTag = $Now.ToLowerInvariant()
$RecordPrefix = if ($SeedProfile -eq 'smoke-fixed') { "smoke100-$Now" } else { "load$RecordCount-$Now" }
$PendingPk = "DATE#$TargetDate"
$DispatchSlotPk = "DATE#$TargetDate#SLOT#$('{0:D3}' -f $SlotId)"
$SeedFile = Join-Path $ArtifactsDir 'phase3-slot-seed.json'
$PlanFile = Join-Path $ArtifactsDir 'phase3-slot-plan.json'
$PayloadFile = Join-Path $ArtifactsDir 'payload-slot.json'
$ProducerResponseFile = Join-Path $ArtifactsDir 'producer-response.json'
$SummaryFile = Join-Path $ArtifactsDir '99-summary.md'
$Failures = New-Object System.Collections.Generic.List[string]

$script:ExpectedStatusCounts = @{}
$script:ExpectedProviderCounts = @{}
$script:ExpectedResultStatusCounts = @{}

New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null

function Write-Section {
  param([string]$Message)
  Write-Host ''
  Write-Host "=== $Message ==="
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

function New-JsonArgFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [object]$Value
  )

  $path = Join-Path $ArtifactsDir $Name
  Write-JsonFile -Path $path -Value $Value
  return $path
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

function Invoke-And-Capture {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  $outFile = Join-Path $ArtifactsDir $Name
  Write-Host "[$Name] $Command"
  $output = Invoke-Expression $Command 2>&1
  $output | Tee-Object -FilePath $outFile
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command"
  }
}

function Add-Failure {
  param([string]$Message)
  $Failures.Add($Message) | Out-Null
}

function Assert-Equal {
  param(
    [string]$Label,
    $Expected,
    $Actual
  )

  if ([string]$Expected -ne [string]$Actual) {
    Add-Failure "$Label expected '$Expected' but got '$Actual'"
  }
}

function Assert-True {
  param(
    [string]$Label,
    [bool]$Condition
  )

  if (-not $Condition) {
    Add-Failure $Label
  }
}

function Convert-LogsInsightsRows {
  param([array]$Rows)

  $converted = @()
  foreach ($row in @($Rows)) {
    $entry = [ordered]@{}
    foreach ($column in @($row)) {
      $entry[$column.field] = $column.value
    }
    $converted += [pscustomobject]$entry
  }
  return $converted
}

function Invoke-LogsInsightsQuery {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$LogGroupName,
    [Parameter(Mandatory = $true)]
    [long]$StartTimeSeconds,
    [Parameter(Mandatory = $true)]
    [long]$EndTimeSeconds,
    [Parameter(Mandatory = $true)]
    [string]$QueryString
  )

  $startResponse = Invoke-AwsJson "aws logs start-query --region $Region --log-group-name `"$LogGroupName`" --start-time $StartTimeSeconds --end-time $EndTimeSeconds --query-string `"$QueryString`""
  $queryId = [string]$startResponse.queryId
  if (-not $queryId) {
    throw "CloudWatch Logs Insights did not return queryId for $Name"
  }

  $deadline = (Get-Date).AddMinutes(3)
  do {
    Start-Sleep -Seconds 2
    $result = Invoke-AwsJson "aws logs get-query-results --region $Region --query-id $queryId"
  } while ($result.status -in @('Running', 'Scheduled') -and (Get-Date) -lt $deadline)

  if ($result.status -ne 'Complete') {
    throw "Logs Insights query '$Name' did not complete. Status: $($result.status)"
  }

  Write-JsonFile -Path (Join-Path $ArtifactsDir $Name) -Value $result
  return (Convert-LogsInsightsRows -Rows $result.results)
}

function Convert-JsonLogRows {
  param([array]$Rows)

  $converted = @()
  foreach ($row in @($Rows)) {
    $message = $row.'@message'
    if (-not $message) {
      continue
    }

    try {
      $payload = $message | ConvertFrom-Json
      $converted += [pscustomobject]@{
        Timestamp = [datetime]$row.'@timestamp'
        Message = $payload
        RawMessage = $message
      }
    } catch {
      continue
    }
  }

  return $converted
}

function Get-StateMachineArn {
  $list = Invoke-AwsJson "aws stepfunctions list-state-machines --region $Region"
  $match = @($list.stateMachines | Where-Object { $_.name -eq $StateMachineName })
  if ($match.Count -ne 1) {
    throw "Expected exactly one state machine named $StateMachineName, found $($match.Count)"
  }
  return [string]$match[0].stateMachineArn
}

function Get-QueueUrl {
  $queueUrl = Invoke-AwsJson "aws sqs get-queue-url --region $Region --queue-name $QueueName"
  return [string]$queueUrl.QueueUrl
}

function Get-QueueAttributes {
  param([string]$QueueUrl)
  return Invoke-AwsJson "aws sqs get-queue-attributes --region $Region --queue-url $QueueUrl --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible"
}

function Get-FixedProviderPlans {
  return @(
    [pscustomobject]@{ ProviderId = "provider-A-$ProviderRunTag"; Success = 18; Terminal = 6; Transient = 6 },
    [pscustomobject]@{ ProviderId = "provider-B-$ProviderRunTag"; Success = 18; Terminal = 6; Transient = 6 },
    [pscustomobject]@{ ProviderId = "provider-C-$ProviderRunTag"; Success = 12; Terminal = 4; Transient = 4 },
    [pscustomobject]@{ ProviderId = "provider-D-$ProviderRunTag"; Success = 6; Terminal = 2; Transient = 2 },
    [pscustomobject]@{ ProviderId = "provider-E-$ProviderRunTag"; Success = 3; Terminal = 1; Transient = 1 },
    [pscustomobject]@{ ProviderId = "provider-F-$ProviderRunTag"; Success = 3; Terminal = 1; Transient = 1 }
  )
}

function Get-CategoryEndpoint {
  param([string]$Category)
  switch ($Category) {
    '200' { return 'https://httpbin.org/status/200' }
    '400' { return 'https://httpbin.org/status/400' }
    '503' { return 'https://httpbin.org/status/503' }
    default { throw "Unknown category: $Category" }
  }
}

function Get-RandomCategory {
  $roll = Get-Random -Minimum 1 -Maximum 101
  if ($roll -le 60) { return '200' }
  if ($roll -le 80) { return '400' }
  return '503'
}

function New-FixedRecordPlan {
  $records = New-Object System.Collections.Generic.List[object]
  $recordNumber = 1

  foreach ($plan in Get-FixedProviderPlans) {
    foreach ($category in @(
      [pscustomobject]@{ Name = '200'; Count = $plan.Success },
      [pscustomobject]@{ Name = '400'; Count = $plan.Terminal },
      [pscustomobject]@{ Name = '503'; Count = $plan.Transient }
    )) {
      for ($i = 1; $i -le $category.Count; $i++) {
        $providerSlug = $plan.ProviderId.ToLowerInvariant().Replace('-', '')
        $recordId = '{0}-{1}-{2:D3}' -f $RecordPrefix, $providerSlug, $recordNumber
        $records.Add([pscustomobject]@{
          RecordId = $recordId
          ProviderId = $plan.ProviderId
          Category = $category.Name
          Endpoint = Get-CategoryEndpoint -Category $category.Name
        }) | Out-Null
        $recordNumber++
      }
    }
  }

  return $records.ToArray()
}

function New-RandomLargeRecordPlan {
  $records = New-Object System.Collections.Generic.List[object]

  for ($i = 1; $i -le $RecordCount; $i++) {
    $providerOrdinal = Get-Random -Minimum 1 -Maximum ($ProviderCount + 1)
    $providerId = 'provider-{0:D3}-{1}' -f $providerOrdinal, $ProviderRunTag
    $providerSlug = $providerId.ToLowerInvariant().Replace('-', '')
    $category = Get-RandomCategory
    $recordId = '{0}-{1}-{2:D5}' -f $RecordPrefix, $providerSlug, $i
    $records.Add([pscustomobject]@{
      RecordId = $recordId
      ProviderId = $providerId
      Category = $category
      Endpoint = Get-CategoryEndpoint -Category $category
    }) | Out-Null
  }

  return $records.ToArray()
}

function Get-PlannedRecords {
  if ($SeedProfile -eq 'smoke-fixed') {
    return New-FixedRecordPlan
  }

  return New-RandomLargeRecordPlan
}

function Initialize-ExpectedCounts {
  param([array]$Records)

  $completed = @($Records | Where-Object { $_.Category -eq '200' }).Count
  $failed = @($Records | Where-Object { $_.Category -in @('400', '503') }).Count
  $providerMap = @{}
  $statusMap = @{
    COMPLETED = $completed
    FAILED = $failed
  }
  $resultStatusMap = @{
    '200' = $completed
    '400' = @($Records | Where-Object { $_.Category -eq '400' }).Count
    '503' = @($Records | Where-Object { $_.Category -eq '503' }).Count
  }

  foreach ($group in @($Records | Group-Object ProviderId)) {
    $providerMap[$group.Name] = $group.Count
  }

  $script:ExpectedStatusCounts = $statusMap
  $script:ExpectedProviderCounts = $providerMap
  $script:ExpectedResultStatusCounts = $resultStatusMap
}

function Convert-PlannedRecordsToSeedItems {
  param([array]$Records)

  $ttlDate = (Get-Date).ToUniversalTime().AddDays(30)
  $ttl = [int][Math]::Floor(($ttlDate - [datetime]'1970-01-01T00:00:00Z').TotalSeconds)
  $items = New-Object System.Collections.Generic.List[object]

  foreach ($record in @($Records)) {
    $items.Add(@{
      PutRequest = @{
        Item = @{
          PK = @{ S = $PendingPk }
          SK = @{ S = "RECORD#$($record.RecordId)" }
          recordId = @{ S = $record.RecordId }
          providerId = @{ S = $record.ProviderId }
          endpoint = @{ S = $record.Endpoint }
          httpMethod = @{ S = 'GET' }
          scheduledDate = @{ S = $TargetDate }
          status = @{ S = 'PENDING' }
          ttl = @{ N = [string]$ttl }
          dispatchDate = @{ S = $TargetDate }
          dispatchSlot = @{ N = [string]$SlotId }
          dispatchSlotPk = @{ S = $DispatchSlotPk }
          dispatchSortKey = @{ S = "PROVIDER#$($record.ProviderId)#RECORD#$($record.RecordId)" }
        }
      }
    }) | Out-Null
  }

  return $items.ToArray()
}

function Write-ValidationArtifacts {
  param([array]$Records)

  $requestItems = @{
    'tapi-pending-records' = Convert-PlannedRecordsToSeedItems -Records $Records
  }

  Write-JsonFile -Path $PlanFile -Value $Records
  Write-JsonFile -Path $SeedFile -Value $requestItems

  $payload = @{
    source = 'manual.phase3.validation'
    slotId = $SlotId
    slotsPerDay = $SlotsPerDay
    targetDateStrategy = 'manual-target-date'
    targetDate = $TargetDate
  }

  Write-JsonFile -Path $PayloadFile -Value $payload
}

function Invoke-DynamoQueryAll {
  param(
    [string]$TableName,
    [string]$KeyConditionExpression,
    [object]$ExpressionAttributeValues,
    [string]$IndexName = ''
  )

  $allItems = New-Object System.Collections.Generic.List[object]
  $page = 1
  $lastEvaluatedKey = $null

  do {
    $exprFile = New-JsonArgFile -Name ("tmp-query-values-{0:D4}.json" -f $page) -Value $ExpressionAttributeValues
    $parts = @(
      "aws dynamodb query --region $Region",
      "--table-name $TableName",
      "--key-condition-expression `"$KeyConditionExpression`"",
      "--expression-attribute-values `"file://$exprFile`""
    )

    if ($IndexName) {
      $parts += "--index-name $IndexName"
    }

    if ($lastEvaluatedKey) {
      $startKeyFile = New-JsonArgFile -Name ("tmp-query-start-key-{0:D4}.json" -f $page) -Value $lastEvaluatedKey
      $parts += "--exclusive-start-key `"file://$startKeyFile`""
    }

    $response = Invoke-AwsJson ($parts -join ' ')
    foreach ($item in @($response.Items)) {
      $allItems.Add($item) | Out-Null
    }

    $lastEvaluatedKey = if ($response.PSObject.Properties.Name -contains 'LastEvaluatedKey') { $response.LastEvaluatedKey } else { $null }
    $page++
  } while ($lastEvaluatedKey)

  return $allItems.ToArray()
}

function Invoke-DynamoScanAll {
  param(
    [string]$TableName,
    [string]$FilterExpression,
    [object]$ExpressionAttributeValues,
    [object]$ExpressionAttributeNames = $null
  )

  $allItems = New-Object System.Collections.Generic.List[object]
  $page = 1
  $lastEvaluatedKey = $null

  do {
    $exprFile = New-JsonArgFile -Name ("tmp-scan-values-{0:D4}.json" -f $page) -Value $ExpressionAttributeValues
    $parts = @(
      "aws dynamodb scan --region $Region",
      "--table-name $TableName",
      "--filter-expression `"$FilterExpression`"",
      "--expression-attribute-values `"file://$exprFile`""
    )

    if ($ExpressionAttributeNames) {
      $namesFile = New-JsonArgFile -Name ("tmp-scan-names-{0:D4}.json" -f $page) -Value $ExpressionAttributeNames
      $parts += "--expression-attribute-names `"file://$namesFile`""
    }

    if ($lastEvaluatedKey) {
      $startKeyFile = New-JsonArgFile -Name ("tmp-scan-start-key-{0:D4}.json" -f $page) -Value $lastEvaluatedKey
      $parts += "--exclusive-start-key `"file://$startKeyFile`""
    }

    $response = Invoke-AwsJson ($parts -join ' ')
    foreach ($item in @($response.Items)) {
      $allItems.Add($item) | Out-Null
    }

    $lastEvaluatedKey = if ($response.PSObject.Properties.Name -contains 'LastEvaluatedKey') { $response.LastEvaluatedKey } else { $null }
    $page++
  } while ($lastEvaluatedKey)

  return $allItems.ToArray()
}

function Get-TestPendingItems {
  return @(Invoke-DynamoQueryAll -TableName $PendingTable -KeyConditionExpression 'PK = :pk' -ExpressionAttributeValues @{
      ':pk' = @{ S = $PendingPk }
    } | Where-Object { $_.recordId.S -like "$RecordPrefix-*" })
}

function Get-TestPendingItemsForSlot {
  return @(Invoke-DynamoQueryAll -TableName $PendingTable -IndexName 'dispatch-slot-index' -KeyConditionExpression 'dispatchSlotPk = :dispatchSlotPk' -ExpressionAttributeValues @{
      ':dispatchSlotPk' = @{ S = $DispatchSlotPk }
    } | Where-Object { $_.recordId.S -like "$RecordPrefix-*" })
}

function Get-TestIdempotencyItems {
  return @(Invoke-DynamoScanAll -TableName $IdempotencyTable -FilterExpression 'begins_with(recordId, :prefix) AND scheduledDate = :date' -ExpressionAttributeValues @{
      ':prefix' = @{ S = "$RecordPrefix-" }
      ':date' = @{ S = $TargetDate }
    })
}

function Get-TestResultItems {
  return @(Invoke-DynamoScanAll -TableName $ResultsTable -FilterExpression 'begins_with(recordId, :prefix)' -ExpressionAttributeValues @{
      ':prefix' = @{ S = "$RecordPrefix-" }
    })
}

function Remove-TestPendingItems {
  $keyFile = Join-Path $ArtifactsDir 'tmp-pending-delete-key.json'
  foreach ($item in Get-TestPendingItems) {
    Write-JsonFile -Path $keyFile -Value @{
      PK = $item.PK
      SK = $item.SK
    }

    Invoke-Expression "aws dynamodb delete-item --region $Region --table-name $PendingTable --key `"file://$keyFile`"" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to delete pending item: $($item.recordId.S)"
    }
  }
}

function Remove-TestIdempotencyItems {
  $keyFile = Join-Path $ArtifactsDir 'tmp-idempotency-delete-key.json'
  foreach ($item in Get-TestIdempotencyItems) {
    Write-JsonFile -Path $keyFile -Value @{
      idempotencyKey = $item.idempotencyKey
    }

    Invoke-Expression "aws dynamodb delete-item --region $Region --table-name $IdempotencyTable --key `"file://$keyFile`"" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to delete idempotency item: $($item.recordId.S)"
    }
  }
}

function Remove-TestResultItems {
  $keyFile = Join-Path $ArtifactsDir 'tmp-results-delete-key.json'
  foreach ($item in Get-TestResultItems) {
    Write-JsonFile -Path $keyFile -Value @{
      PK = $item.PK
      SK = $item.SK
    }

    Invoke-Expression "aws dynamodb delete-item --region $Region --table-name $ResultsTable --key `"file://$keyFile`"" | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to delete result item: $($item.recordId.S)"
    }
  }
}

function Submit-SeedInBatches {
  param([array]$SeedItems)

  for ($offset = 0; $offset -lt $SeedItems.Count; $offset += 25) {
    $endIndex = [Math]::Min($offset + 24, $SeedItems.Count - 1)
    $batch = @{
      'tapi-pending-records' = @($SeedItems[$offset..$endIndex])
    }
    $batchNumber = [int]($offset / 25 + 1)
    $batchFile = Join-Path $ArtifactsDir ('seed-batch-{0:D4}.json' -f $batchNumber)
    Write-JsonFile -Path $batchFile -Value $batch
    Invoke-And-Capture -Name ('10-seed-batch-{0:D4}.json' -f $batchNumber) -Command "aws dynamodb batch-write-item --region $Region --request-items `"file://$batchFile`""
  }
}

function Wait-For-RecordsToSettle {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $activeCount = -1

  do {
    Start-Sleep -Seconds $PollIntervalSeconds
    $items = Get-TestPendingItems
    $pendingLike = @($items | Where-Object { $_.status.S -in @('PENDING', 'IN_PROGRESS') })
    $activeCount = $pendingLike.Count
    Write-Host "Active records remaining: $activeCount / $RecordCount"
  } while ($activeCount -gt 0 -and (Get-Date) -lt $deadline)

  if ($activeCount -gt 0) {
    throw "There are still $activeCount records in PENDING/IN_PROGRESS after $TimeoutSeconds seconds"
  }
}

function Get-GroupCountMap {
  param(
    [array]$Items,
    [scriptblock]$Selector
  )

  $map = @{}
  foreach ($group in @($Items | Group-Object $Selector)) {
    $map[$group.Name] = $group.Count
  }
  return $map
}

function Get-MapValueOrDefault {
  param(
    [hashtable]$Map,
    [string]$Key,
    $Default = 0
  )

  if ($null -ne $Map -and $Map.ContainsKey($Key)) {
    return $Map[$Key]
  }

  return $Default
}

function Get-ProducerLogData {
  param(
    [long]$StartTimeSeconds,
    [long]$EndTimeSeconds
  )

  $rows = Invoke-LogsInsightsQuery -Name '40-producer-logs-insights.json' -LogGroupName $ProducerLogGroup -StartTimeSeconds $StartTimeSeconds -EndTimeSeconds $EndTimeSeconds -QueryString "fields @timestamp, @message | filter @message like /Producer Lambda invoked|Dispatch complete|Unhandled error in Producer Lambda/ | sort @timestamp asc | limit 1000"
  return @(Convert-JsonLogRows -Rows $rows)
}

function Get-BootstrapLogData {
  param(
    [long]$StartTimeSeconds,
    [long]$EndTimeSeconds
  )

  $rows = Invoke-LogsInsightsQuery -Name '41-workflow-bootstrap-insights.json' -LogGroupName $BootstrapLogGroup -StartTimeSeconds $StartTimeSeconds -EndTimeSeconds $EndTimeSeconds -QueryString "fields @timestamp, @message | filter @message like /Workflow bootstrap complete/ | sort @timestamp asc | limit 1000"
  return @(Convert-JsonLogRows -Rows $rows)
}

function Get-ConsumerLogData {
  param(
    [long]$StartTimeSeconds,
    [long]$EndTimeSeconds
  )

  $rows = Invoke-LogsInsightsQuery -Name '42-consumer-logs-insights.json' -LogGroupName $ConsumerLogGroup -StartTimeSeconds $StartTimeSeconds -EndTimeSeconds $EndTimeSeconds -QueryString "fields @timestamp, @message | filter @message like /Consumer Lambda invoked|Consumer processing complete|Unhandled error in Consumer Lambda/ | sort @timestamp asc | limit 5000"
  return @(Convert-JsonLogRows -Rows $rows)
}

function Get-StateMachineLogData {
  param(
    [long]$StartTimeSeconds,
    [long]$EndTimeSeconds
  )

  $rows = Invoke-LogsInsightsQuery -Name '43-state-machine-insights.json' -LogGroupName $StateMachineLogGroup -StartTimeSeconds $StartTimeSeconds -EndTimeSeconds $EndTimeSeconds -QueryString "fields @timestamp, @message | filter @message like /PersistSuccessResult|PersistFailureResult|ExecutionSucceeded|ExecutionFailed/ | sort @timestamp asc | limit 5000"
  return @(Convert-JsonLogRows -Rows $rows)
}

function Analyze-ConsumerLogs {
  param([array]$Entries)

  $byRequest = @{}

  foreach ($entry in @($Entries)) {
    $message = $entry.Message
    $requestId = [string]$message.requestId
    if (-not $requestId) {
      continue
    }

    if (-not $byRequest.ContainsKey($requestId)) {
      $byRequest[$requestId] = [ordered]@{
        requestId = $requestId
        providerId = $null
        recordId = $null
        start = $null
        end = $null
        outcome = $null
        errorName = $null
        statusCode = $null
      }
    }

    $span = $byRequest[$requestId]
    switch ([string]$message.message) {
      'Consumer Lambda invoked' {
        $span.start = $entry.Timestamp
        $span.providerId = [string]$message.providerId
        $span.recordId = [string]$message.recordId
        $span.outcome = 'INVOKED'
      }
      'Consumer processing complete' {
        $span.end = $entry.Timestamp
        $span.providerId = [string]$message.providerId
        $span.recordId = [string]$message.recordId
        $span.statusCode = [int]$message.statusCode
        $span.outcome = 'SUCCESS'
      }
      'Unhandled error in Consumer Lambda' {
        $span.end = $entry.Timestamp
        $span.errorName = [string]$message.errorName
        $span.outcome = 'ERROR'
      }
    }
  }

  $spans = @()
  foreach ($span in $byRequest.Values) {
    if ($span.start -and $span.end -and $span.providerId) {
      $spans += [pscustomobject]$span
    }
  }

  $serialization = @()
  foreach ($group in @($spans | Group-Object providerId)) {
    $providerSpans = @($group.Group | Sort-Object start)
    $hasOverlap = $false
    for ($i = 1; $i -lt $providerSpans.Count; $i++) {
      if ($providerSpans[$i].start -lt $providerSpans[$i - 1].end) {
        $hasOverlap = $true
        break
      }
    }

    $serialization += [pscustomobject]@{
      providerId = $group.Name
      spanCount = $providerSpans.Count
      hasOverlap = $hasOverlap
    }
  }

  return [pscustomobject]@{
    spans = $spans
    invocationCount = @($Entries | Where-Object { $_.Message.message -eq 'Consumer Lambda invoked' }).Count
    completionCount = @($Entries | Where-Object { $_.Message.message -eq 'Consumer processing complete' }).Count
    errorCount = @($Entries | Where-Object { $_.Message.message -eq 'Unhandled error in Consumer Lambda' }).Count
    terminalErrors = @($Entries | Where-Object { $_.Message.message -eq 'Unhandled error in Consumer Lambda' -and $_.Message.errorName -eq 'TerminalApiError' }).Count
    transientErrors = @($Entries | Where-Object { $_.Message.message -eq 'Unhandled error in Consumer Lambda' -and $_.Message.errorName -eq 'TransientApiError' }).Count
    serialization = $serialization
  }
}

function Analyze-StateMachineLogs {
  param([array]$Entries)

  $persistSuccess = 0
  $persistFailure = 0
  $executionSucceeded = 0
  $executionFailed = 0

  foreach ($entry in @($Entries)) {
    $message = $entry.Message
    switch ([string]$message.type) {
      'TaskStateEntered' {
        switch ([string]$message.details.name) {
          'PersistSuccessResult' { $persistSuccess++ }
          'PersistFailureResult' { $persistFailure++ }
        }
      }
      'ExecutionSucceeded' { $executionSucceeded++ }
      'ExecutionFailed' { $executionFailed++ }
    }
  }

  return [pscustomobject]@{
    persistSuccess = $persistSuccess
    persistFailure = $persistFailure
    executionSucceeded = $executionSucceeded
    executionFailed = $executionFailed
  }
}

function Get-ProviderCountsFromItems {
  param([array]$Items)
  return (Get-GroupCountMap -Items $Items -Selector { $_.providerId.S })
}

function Get-ResultStatusCodeCounts {
  param([array]$Items)
  return (Get-GroupCountMap -Items $Items -Selector { $_.statusCode.N })
}

function Write-MarkdownTable {
  param(
    [System.Collections.Generic.List[string]]$Lines,
    [string]$HeaderLeft,
    [string]$HeaderRight,
    [hashtable]$Map
  )

  $Lines.Add("| $HeaderLeft | $HeaderRight |")
  $Lines.Add('| --- | --- |')
  foreach ($key in @($Map.Keys | Sort-Object)) {
    $Lines.Add("| $key | $($Map[$key]) |")
  }
  if ($Map.Count -eq 0) {
    $Lines.Add('| none | 0 |')
  }
}

function Build-Summary {
  param(
    [pscustomobject]$Preflight,
    [array]$PendingItems,
    [array]$PendingSlotItems,
    [array]$IdempotencyItems,
    [array]$ResultItems,
    [array]$ProducerLogs,
    [array]$BootstrapLogs,
    [pscustomobject]$ConsumerAnalysis,
    [pscustomobject]$StateMachineAnalysis,
    [pscustomobject]$QueueBefore,
    [pscustomobject]$QueueAfter
  )

  $pendingCounts = Get-GroupCountMap -Items $PendingItems -Selector { $_.status.S }
  $idempotencyCounts = Get-GroupCountMap -Items $IdempotencyItems -Selector { $_.status.S }
  $resultStatusCounts = Get-ResultStatusCodeCounts -Items $ResultItems
  $providerCounts = Get-ProviderCountsFromItems -Items $PendingItems
  $producerSummary = @($ProducerLogs | Where-Object { $_.Message.message -eq 'Dispatch complete' } | Select-Object -Last 1)
  $producerSummaryText = if ($producerSummary) { "queried=$($producerSummary.Message.queried), dispatched=$($producerSummary.Message.dispatched), skipped=$($producerSummary.Message.skipped)" } else { 'missing' }

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('# Phase 3 Validation Summary')
  $lines.Add('')
  $lines.Add('| Metric | Value |')
  $lines.Add('| --- | --- |')
  $lines.Add("| Seed profile | $SeedProfile |")
  $lines.Add("| Target date | $TargetDate |")
  $lines.Add("| Slot id | $SlotId |")
  $lines.Add("| Dispatch slot PK | $DispatchSlotPk |")
  $lines.Add("| Seeded records | $RecordCount |")
  $lines.Add("| Provider count | $ProviderCount |")
  $lines.Add("| Planned 200 responses | $(Get-MapValueOrDefault -Map $script:ExpectedResultStatusCounts -Key '200') |")
  $lines.Add("| Planned 400 responses | $(Get-MapValueOrDefault -Map $script:ExpectedResultStatusCounts -Key '400') |")
  $lines.Add("| Planned 503 responses | $(Get-MapValueOrDefault -Map $script:ExpectedResultStatusCounts -Key '503') |")
  $lines.Add("| Pending items in slot | $(@($PendingSlotItems).Count) |")
  $lines.Add("| Producer summary | $producerSummaryText |")
  $lines.Add("| Bootstrap logs | $(@($BootstrapLogs).Count) |")
  $lines.Add("| Consumer invocations | $($ConsumerAnalysis.invocationCount) |")
  $lines.Add("| Consumer completions | $($ConsumerAnalysis.completionCount) |")
  $lines.Add("| Consumer errors | $($ConsumerAnalysis.errorCount) |")
  $lines.Add("| StateMachine PersistSuccessResult | $($StateMachineAnalysis.persistSuccess) |")
  $lines.Add("| StateMachine PersistFailureResult | $($StateMachineAnalysis.persistFailure) |")
  $lines.Add("| Step Functions execution failures | $($StateMachineAnalysis.executionFailed) |")
  $lines.Add("| Queue visible before | $($QueueBefore.Attributes.ApproximateNumberOfMessages) |")
  $lines.Add("| Queue invisible before | $($QueueBefore.Attributes.ApproximateNumberOfMessagesNotVisible) |")
  $lines.Add("| Queue visible after | $($QueueAfter.Attributes.ApproximateNumberOfMessages) |")
  $lines.Add("| Queue invisible after | $($QueueAfter.Attributes.ApproximateNumberOfMessagesNotVisible) |")
  $lines.Add("| Scheduler enabled | $($Preflight.ScheduleEnabled) |")
  $lines.Add("| Pipe target | $($Preflight.PipeTarget) |")
  $lines.Add("| Event source mappings for old path | $($Preflight.LegacyMappingCount) |")
  $lines.Add("| Orchestrator function present | $($Preflight.OrchestratorPresent) |")
  $lines.Add('')
  $lines.Add('## Pending Status Counts')
  $lines.Add('')
  Write-MarkdownTable -Lines $lines -HeaderLeft 'Status' -HeaderRight 'Count' -Map $pendingCounts
  $lines.Add('')
  $lines.Add('## Idempotency Status Counts')
  $lines.Add('')
  Write-MarkdownTable -Lines $lines -HeaderLeft 'Status' -HeaderRight 'Count' -Map $idempotencyCounts
  $lines.Add('')
  $lines.Add('## Result Status Codes')
  $lines.Add('')
  Write-MarkdownTable -Lines $lines -HeaderLeft 'StatusCode' -HeaderRight 'Count' -Map $resultStatusCounts
  $lines.Add('')
  $lines.Add('## Provider Distribution')
  $lines.Add('')
  Write-MarkdownTable -Lines $lines -HeaderLeft 'Provider' -HeaderRight 'Count' -Map $providerCounts
  $lines.Add('')
  $lines.Add('## Acceptance')
  $lines.Add('')
  if ($Failures.Count -eq 0) {
    $lines.Add('- PASS: all acceptance checks passed.')
  } else {
    foreach ($failure in $Failures) {
      $lines.Add("- FAIL: $failure")
    }
  }

  Set-Content -Path $SummaryFile -Value $lines
}

Write-Section 'Preflight checks'
$StateMachineArn = Get-StateMachineArn
$QueueUrl = Get-QueueUrl
$QueueBefore = Get-QueueAttributes -QueueUrl $QueueUrl
$Schedule = Invoke-AwsJson "aws scheduler get-schedule --region $Region --group-name default --name $ScheduleName"
$PipeList = Invoke-AwsJson "aws pipes list-pipes --region $Region"
$Pipe = @($PipeList.Pipes | Where-Object { $_.Name -eq 'tapi-provider-pipe' } | Select-Object -First 1)
$EventSourceMappings = Invoke-AwsJson "aws lambda list-event-source-mappings --region $Region"
$Functions = Invoke-AwsJson "aws lambda list-functions --region $Region"
$OrchestratorPresent = @($Functions.Functions | Where-Object { $_.FunctionName -eq 'tapi-orchestrator' }).Count -gt 0
$LegacyMappings = @($EventSourceMappings.EventSourceMappings | Where-Object {
  ($_.FunctionArn -like '*tapi-orchestrator*') -or ($_.EventSourceArn -like '*tapi-provider-queue.fifo*')
})

Write-JsonFile -Path (Join-Path $ArtifactsDir '01-schedule-slot-000.json') -Value $Schedule
Write-JsonFile -Path (Join-Path $ArtifactsDir '02-state-machine.json') -Value (Invoke-AwsJson "aws stepfunctions describe-state-machine --region $Region --state-machine-arn $StateMachineArn")
Write-JsonFile -Path (Join-Path $ArtifactsDir '03-pipe.json') -Value $PipeList
Write-JsonFile -Path (Join-Path $ArtifactsDir '04-event-source-mappings.json') -Value $EventSourceMappings
Write-JsonFile -Path (Join-Path $ArtifactsDir '05-functions.json') -Value $Functions
Write-JsonFile -Path (Join-Path $ArtifactsDir '06-queue-before.json') -Value $QueueBefore

$Preflight = [pscustomobject]@{
  ScheduleEnabled = [string]$Schedule.State
  PipeTarget = if ($Pipe) { [string]$Pipe.Target } else { '' }
  LegacyMappingCount = @($LegacyMappings).Count
  OrchestratorPresent = $OrchestratorPresent
}

Write-Section 'Preparing seed and payload'
$PlannedRecords = Get-PlannedRecords
if (@($PlannedRecords).Count -ne $RecordCount) {
  throw "Seed generator created $(@($PlannedRecords).Count) records instead of $RecordCount."
}
Initialize-ExpectedCounts -Records $PlannedRecords
Write-ValidationArtifacts -Records $PlannedRecords
$SeedItems = Convert-PlannedRecordsToSeedItems -Records $PlannedRecords

Write-Section 'Resetting only the previous validation records'
Remove-TestPendingItems
Remove-TestIdempotencyItems
Remove-TestResultItems

Write-Section "Submitting the $RecordCount-record seed in 25-item batches"
Submit-SeedInBatches -SeedItems $SeedItems
$PendingSlotItemsAfterSeed = Get-TestPendingItemsForSlot
Write-JsonFile -Path (Join-Path $ArtifactsDir '20-pending-after-seed.json') -Value $PendingSlotItemsAfterSeed

Write-Section 'Invoking the producer for a single slot'
$BaselineUtc = [DateTimeOffset]::UtcNow
Invoke-And-Capture -Name '21-producer-response.json' -Command "aws lambda invoke --region $Region --function-name $ProducerFunction --cli-binary-format raw-in-base64-out --payload `"file://$PayloadFile`" `"$ProducerResponseFile`""

Write-Section 'Waiting for records to settle'
Wait-For-RecordsToSettle
Start-Sleep -Seconds 20
$EndUtc = [DateTimeOffset]::UtcNow

Write-Section 'Capturing logs and final snapshots'
$StartTimeSeconds = $BaselineUtc.ToUnixTimeSeconds()
$EndTimeSeconds = $EndUtc.ToUnixTimeSeconds()
$ProducerLogs = @(Get-ProducerLogData -StartTimeSeconds $StartTimeSeconds -EndTimeSeconds $EndTimeSeconds)
$BootstrapLogs = @()
$ConsumerLogs = @()
$StateMachineLogs = @()
$ConsumerAnalysis = [pscustomobject]@{
  spans = @()
  invocationCount = 0
  completionCount = 0
  errorCount = 0
  terminalErrors = 0
  transientErrors = 0
  serialization = @()
}
$StateMachineAnalysis = [pscustomobject]@{
  persistSuccess = 0
  persistFailure = 0
  executionSucceeded = 0
  executionFailed = 0
}

if ($EnableDetailedLogValidation) {
  $BootstrapLogs = @(Get-BootstrapLogData -StartTimeSeconds $StartTimeSeconds -EndTimeSeconds $EndTimeSeconds)
  $ConsumerLogs = @(Get-ConsumerLogData -StartTimeSeconds $StartTimeSeconds -EndTimeSeconds $EndTimeSeconds)
  $StateMachineLogs = @(Get-StateMachineLogData -StartTimeSeconds $StartTimeSeconds -EndTimeSeconds $EndTimeSeconds)
  $ConsumerAnalysis = Analyze-ConsumerLogs -Entries $ConsumerLogs
  $StateMachineAnalysis = Analyze-StateMachineLogs -Entries $StateMachineLogs
}

$PendingItemsFinal = Get-TestPendingItems
$PendingSlotItemsFinal = Get-TestPendingItemsForSlot
$IdempotencyItemsFinal = Get-TestIdempotencyItems
$ResultItemsFinal = Get-TestResultItems
$QueueAfter = Get-QueueAttributes -QueueUrl $QueueUrl

Write-JsonFile -Path (Join-Path $ArtifactsDir '50-pending-final.json') -Value $PendingItemsFinal
Write-JsonFile -Path (Join-Path $ArtifactsDir '51-pending-slot-final.json') -Value $PendingSlotItemsFinal
Write-JsonFile -Path (Join-Path $ArtifactsDir '52-idempotency-final.json') -Value $IdempotencyItemsFinal
Write-JsonFile -Path (Join-Path $ArtifactsDir '53-results-final.json') -Value $ResultItemsFinal
Write-JsonFile -Path (Join-Path $ArtifactsDir '54-producer-logs.json') -Value $ProducerLogs
Write-JsonFile -Path (Join-Path $ArtifactsDir '55-bootstrap-logs.json') -Value $BootstrapLogs
Write-JsonFile -Path (Join-Path $ArtifactsDir '56-consumer-logs.json') -Value $ConsumerLogs
Write-JsonFile -Path (Join-Path $ArtifactsDir '57-state-machine-logs.json') -Value $StateMachineLogs
Write-JsonFile -Path (Join-Path $ArtifactsDir '58-queue-after.json') -Value $QueueAfter

$PendingCounts = Get-GroupCountMap -Items $PendingItemsFinal -Selector { $_.status.S }
$IdempotencyCounts = Get-GroupCountMap -Items $IdempotencyItemsFinal -Selector { $_.status.S }
$ResultStatusCounts = Get-ResultStatusCodeCounts -Items $ResultItemsFinal
$ProducerSummary = @($ProducerLogs | Where-Object { $_.Message.message -eq 'Dispatch complete' } | Select-Object -Last 1)
$ExpectedCompleted = Get-MapValueOrDefault -Map $script:ExpectedStatusCounts -Key 'COMPLETED'
$ExpectedFailed = Get-MapValueOrDefault -Map $script:ExpectedStatusCounts -Key 'FAILED'
$Expected200 = Get-MapValueOrDefault -Map $script:ExpectedResultStatusCounts -Key '200'
$Expected400 = Get-MapValueOrDefault -Map $script:ExpectedResultStatusCounts -Key '400'
$Expected503 = Get-MapValueOrDefault -Map $script:ExpectedResultStatusCounts -Key '503'

Write-Section 'Validating acceptance criteria'
Assert-Equal -Label 'Scheduler state' -Expected 'ENABLED' -Actual $Preflight.ScheduleEnabled
Assert-True -Label 'Scheduler payload must include targetDateStrategy' -Condition ([string]$Schedule.Target.Input).Contains('"targetDateStrategy":"today-utc-by-default"')
Assert-Equal -Label 'Pending items in dispatch slot' -Expected $RecordCount -Actual @($PendingSlotItemsFinal).Count
Assert-Equal -Label 'Legacy event source mappings' -Expected 0 -Actual $Preflight.LegacyMappingCount
Assert-Equal -Label 'Orchestrator function present' -Expected 'False' -Actual $Preflight.OrchestratorPresent
Assert-True -Label 'Pipe must target the EXPRESS state machine' -Condition ($Preflight.PipeTarget -like "*$StateMachineName")
if ($ProducerSummary.Count -eq 1) {
  Assert-Equal -Label 'Producer queried count' -Expected $RecordCount -Actual $ProducerSummary.Message.queried
  Assert-Equal -Label 'Producer dispatched count' -Expected $RecordCount -Actual $ProducerSummary.Message.dispatched
  Assert-Equal -Label 'Producer skipped count' -Expected 0 -Actual $ProducerSummary.Message.skipped
}
Assert-Equal -Label 'Pending COMPLETED count' -Expected $ExpectedCompleted -Actual (Get-MapValueOrDefault -Map $PendingCounts -Key 'COMPLETED')
Assert-Equal -Label 'Pending FAILED count' -Expected $ExpectedFailed -Actual (Get-MapValueOrDefault -Map $PendingCounts -Key 'FAILED')
Assert-Equal -Label 'Pending active count' -Expected 0 -Actual ((Get-MapValueOrDefault -Map $PendingCounts -Key 'PENDING') + (Get-MapValueOrDefault -Map $PendingCounts -Key 'IN_PROGRESS'))
Assert-Equal -Label 'Idempotency COMPLETED count' -Expected $ExpectedCompleted -Actual (Get-MapValueOrDefault -Map $IdempotencyCounts -Key 'COMPLETED')
Assert-Equal -Label 'Idempotency FAILED count' -Expected $ExpectedFailed -Actual (Get-MapValueOrDefault -Map $IdempotencyCounts -Key 'FAILED')
Assert-Equal -Label 'Idempotency IN_PROGRESS count' -Expected 0 -Actual (Get-MapValueOrDefault -Map $IdempotencyCounts -Key 'IN_PROGRESS')
Assert-Equal -Label 'Results row count' -Expected $RecordCount -Actual @($ResultItemsFinal).Count
Assert-Equal -Label 'Results 200 count' -Expected $Expected200 -Actual (Get-MapValueOrDefault -Map $ResultStatusCounts -Key '200')
$fiveHundreds = (Get-MapValueOrDefault -Map $ResultStatusCounts -Key '500') + (Get-MapValueOrDefault -Map $ResultStatusCounts -Key '502') + (Get-MapValueOrDefault -Map $ResultStatusCounts -Key '503') + (Get-MapValueOrDefault -Map $ResultStatusCounts -Key '504')
if ($SeedProfile -eq 'smoke-fixed') {
  Assert-Equal -Label 'Results 400 count' -Expected $Expected400 -Actual (Get-MapValueOrDefault -Map $ResultStatusCounts -Key '400')
  Assert-Equal -Label 'Results transient 5xx count' -Expected $Expected503 -Actual $fiveHundreds
} else {
  Assert-Equal -Label 'Results failed family count' -Expected $ExpectedFailed -Actual ((Get-MapValueOrDefault -Map $ResultStatusCounts -Key '400') + $fiveHundreds)
}

if ($EnableDetailedLogValidation) {
  Assert-Equal -Label 'StateMachine PersistSuccessResult count' -Expected $ExpectedCompleted -Actual $StateMachineAnalysis.persistSuccess
  Assert-Equal -Label 'StateMachine ExecutionFailed count' -Expected 0 -Actual $StateMachineAnalysis.executionFailed
}

Write-Section 'Building summary'
Build-Summary -Preflight $Preflight -PendingItems $PendingItemsFinal -PendingSlotItems $PendingSlotItemsFinal -IdempotencyItems $IdempotencyItemsFinal -ResultItems $ResultItemsFinal -ProducerLogs $ProducerLogs -BootstrapLogs $BootstrapLogs -ConsumerAnalysis $ConsumerAnalysis -StateMachineAnalysis $StateMachineAnalysis -QueueBefore $QueueBefore -QueueAfter $QueueAfter

Write-Host ''
Write-Host "Phase 3 validation artifacts written to:"
Write-Host $ArtifactsDir

if ($Failures.Count -gt 0) {
  throw "Phase 3 validation failed. See $SummaryFile"
}
