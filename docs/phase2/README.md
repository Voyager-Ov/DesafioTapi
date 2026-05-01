# Fase 2: Deploy y prueba operacional

Runtime final:
- `tapi-producer` publica un mensaje FIFO por work item
- `tapi-orchestrator` consume SQS y dispara una ejecucion de Step Functions
- `tapi-consumer-state-machine` es duena de idempotencia, retries, lifecycle y persistencia final
- `tapi-consumer` solo ejecuta la llamada al proveedor y devuelve o lanza errores clasificados

## Archivos
- `phase2-pending-seed.json`: lote base para sembrar `tapi-pending-records`
- `payload-phase2.json`: payload para invocar `tapi-producer`
- `duplicate-record.json`: mensaje para validar idempotencia
- `query-values.json`: atributos para consultar pendientes por fecha

## Deploy
```powershell
cd "C:\github desktop\tapi"
npm run build

cd .\cdk
npx cdk synth TapiStack
npx cdk diff TapiStack
npx cdk deploy TapiStack --require-approval never
```

## Seed del lote base
```powershell
cd "C:\github desktop\tapi"
aws dynamodb batch-write-item `
  --region us-east-1 `
  --request-items file://docs/phase2/phase2-pending-seed.json
```

## Invocar producer
```powershell
aws lambda invoke `
  --region us-east-1 `
  --function-name tapi-producer `
  --cli-binary-format raw-in-base64-out `
  --payload file://docs/phase2/payload-phase2.json `
  response-phase2.json
```

## Verificaciones por escenario

### Exito
- Confirmar que la ejecucion llegue a `PersistSuccessResult`
- Verificar una row en `tapi-results`
- Verificar `tapi-pending-records.status = COMPLETED`
- Verificar `tapi-idempotency.status = COMPLETED`

### Falla terminal
- Usar un registro que provoque HTTP 4xx
- Confirmar que no haya retry en `InvokeConsumerLambda`
- Verificar una row final en `tapi-results`
- Verificar `tapi-pending-records.status = FAILED`
- Verificar `tapi-idempotency.status = FAILED`

### Falla transitoria agotada
- Usar un registro que provoque HTTP 503 persistente
- Confirmar retries con backoff exponencial y jitter
- Verificar una row final en `tapi-results` con categoria `TRANSIENT_EXHAUSTED`
- Verificar `tapi-pending-records.status = FAILED`
- Verificar `tapi-idempotency.status = FAILED`

## Duplicado manual para probar idempotencia
```powershell
$queueUrl = aws sqs get-queue-url --region us-east-1 --queue-name tapi-provider-queue.fifo --query QueueUrl --output text

aws sqs send-message `
  --region us-east-1 `
  --queue-url $queueUrl `
  --message-body file://docs/phase2/duplicate-record.json `
  --message-group-id "PROVIDER#prov-D" `
  --message-deduplication-id "dup-test-1"

aws sqs send-message `
  --region us-east-1 `
  --queue-url $queueUrl `
  --message-body file://docs/phase2/duplicate-record.json `
  --message-group-id "PROVIDER#prov-D" `
  --message-deduplication-id "dup-test-2"
```

Validacion esperada:
- La segunda ejecucion debe terminar en `DuplicateWorkItem`
- No debe existir una segunda invocacion efectiva del consumer
- No debe escribirse una nueva row en `tapi-results`

## Consulta de pendientes
```powershell
aws dynamodb query `
  --region us-east-1 `
  --table-name tapi-pending-records `
  --key-condition-expression "PK = :pk AND begins_with(SK, :sk)" `
  --expression-attribute-values file://docs/phase2/query-values.json
```
