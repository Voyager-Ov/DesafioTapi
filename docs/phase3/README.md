# Fase 3: Dispatch distribuido y proof path de escala

Esta fase cambia solo el modelo de dispatch. El flujo downstream de fase 2 se conserva:
- `tapi-producer` ahora procesa un solo `date-slot` por invocacion
- `EventBridge Pipe` consume el mismo contrato de mensaje SQS y lo entrega al workflow
- `tapi-consumer-state-machine` sigue siendo duena de idempotencia, retries y persistencia final
- `tapi-consumer` sigue sin cambios de contrato downstream

## Artefactos
- `phase3-pending-seed.json`: seed con metadata `dispatch-slot-*` ya calculada
- `payload-slot-017.json`: invocacion manual para el slot de `rec-203`
- `payload-slot-149.json`: invocacion manual para el slot de `rec-201`
- `payload-slot-156.json`: invocacion manual para el slot de `rec-202`
- `payload-slot-177.json`: invocacion manual para el slot de `rec-204`
- `query-slot-017-values.json`: valores para consultar una sola particion `date-slot`

## Build y synth
```powershell
cd "C:\github desktop\tapi"
npm run build
npm test -- --runInBand test/unit/producer/dynamodb-records.adapter.test.ts test/unit/producer/dispatch-records.test.ts test/unit/producer/dynamodb-pending-records.writer.test.ts test/unit/workflow-bootstrap/handler.test.ts test/unit/cdk/tapi-stack.phase3.test.ts test/unit/cdk/tapi-stack.state-machine.test.ts

cd .\cdk
npx cdk synth TapiStack
```

## Seed de prueba distribuida
```powershell
cd "C:\github desktop\tapi"
aws dynamodb batch-write-item `
  --region us-east-1 `
  --request-items file://docs/phase3/phase3-pending-seed.json
```

## Validacion 1: aislamiento de un solo date-slot
El objetivo es demostrar que una sola invocacion de `tapi-producer` consulta una unica particion del indice `dispatch-slot-index`.

Ejemplo con el slot `017`:
```powershell
aws lambda invoke `
  --region us-east-1 `
  --function-name tapi-producer `
  --cli-binary-format raw-in-base64-out `
  --payload file://docs/phase3/payload-slot-017.json `
  response-slot-017.json
```

Logs esperados en `/aws/lambda/tapi-producer`:
- `slotId: 17`
- `slotsPerDay: 288`
- resumen final con `queried: 1`, `dispatched: 1`, `skipped: 0`

Consulta puntual de la misma particion:
```powershell
aws dynamodb query `
  --region us-east-1 `
  --table-name tapi-pending-records `
  --index-name dispatch-slot-index `
  --key-condition-expression "dispatchSlotPk = :dispatchSlotPk" `
  --expression-attribute-values file://docs/phase3/query-slot-017-values.json
```

Prueba defendible:
- la Lambda recibe un `slotId` unico
- el adapter hace `Query` sobre `dispatch-slot-index`
- la key usada es `DATE#2026-04-30#SLOT#017`
- no hay `Scan` ni lectura del resto del dia

## Validacion 2: proteccion de fase 2
Despues de invocar un slot, el contrato downstream debe seguir intacto:
1. `SQS > tapi-provider-queue.fifo` recibe un mensaje con el mismo shape de fase 2
2. `EventBridge Pipe > tapi-provider-pipe` arranca una ejecucion sincronica de Step Functions Express
3. `Step Functions > tapi-consumer-state-machine` procesa sin cambios de contrato de work item

Prueba recomendada:
- Invocar `payload-slot-149.json`
- Confirmar en logs de `tapi-workflow-bootstrap` que el workflow recibe `workItem + workflow`
- Confirmar en logs de Step Functions que aparecen eventos del workflow `EXPRESS` para esa corrida

## Validacion 3: ruta completa de 4 caminos
Cada caso ahora se dispara con su slot correspondiente.

### Exito HTTP 200
```powershell
aws lambda invoke `
  --region us-east-1 `
  --function-name tapi-producer `
  --cli-binary-format raw-in-base64-out `
  --payload file://docs/phase3/payload-slot-149.json `
  response-slot-149.json

aws lambda invoke `
  --region us-east-1 `
  --function-name tapi-producer `
  --cli-binary-format raw-in-base64-out `
  --payload file://docs/phase3/payload-slot-156.json `
  response-slot-156.json
```

Esperado:
- `tapi-pending-records.status = COMPLETED`
- `tapi-idempotency.status = COMPLETED`
- row final en `tapi-results`

### Falla terminal HTTP 400
```powershell
aws lambda invoke `
  --region us-east-1 `
  --function-name tapi-producer `
  --cli-binary-format raw-in-base64-out `
  --payload file://docs/phase3/payload-slot-017.json `
  response-slot-017.json
```

Esperado:
- sin retry util en `InvokeConsumerLambda`
- `tapi-pending-records.status = FAILED`
- `tapi-idempotency.status = FAILED`
- row final terminal en `tapi-results`

### Falla transitoria agotada HTTP 503
```powershell
aws lambda invoke `
  --region us-east-1 `
  --function-name tapi-producer `
  --cli-binary-format raw-in-base64-out `
  --payload file://docs/phase3/payload-slot-177.json `
  response-slot-177.json
```

Esperado:
- retries con backoff y jitter en Step Functions
- `tapi-pending-records.status = FAILED`
- `tapi-idempotency.status = FAILED`
- row final con categoria `TRANSIENT_EXHAUSTED`

### Duplicado
Reutiliza el contrato de fase 2 porque la cola no cambio:
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

Esperado:
- la segunda ejecucion termina en `DuplicateWorkItem`
- no hay segunda invocacion efectiva del consumer
- no se escribe una nueva row en `tapi-results`

## Checklist final de proof path AWS
- `CloudFormation > TapiStack` sintetiza y despliega sin drift funcional
- una invocacion del producer consulta solo un `dispatch-slot-index` PK
- el mensaje publicado conserva `providerId`, `recordId`, `endpoint`, `httpMethod`, `scheduledDate`, `status`
- `MessageGroupId = PROVIDER#<providerId>`
- `MessageDeduplicationId = recordId`
- `tapi-provider-pipe` inicia Step Functions Express sin perder ordering por proveedor
- los cuatro caminos de fase 2 siguen cerrando bien bajo dispatch distribuido
- la narrativa de escala queda defendida: `288` particiones por dia + `SQS FIFO High Throughput`

## Smoke test: 100 registros en un solo slot
Para una validacion rapida de Fase 3, el repo incluye un script dedicado que:
- genera `100` registros `PENDING` en el mismo `dispatchSlot`
- concentra carga real sobre los mismos `providerId` para probar serializacion FIFO
- mezcla `60` respuestas `200`, `20` respuestas `400` y `20` respuestas `503`
- parte la seed en lotes de `25` para `BatchWriteItem`
- invoca una sola vez `tapi-producer`
- espera a que no queden registros en `PENDING` ni `IN_PROGRESS`
- captura logs, snapshots DynamoDB, schedules y metadata del workflow/pipe

```powershell
cd "C:\github desktop\tapi"
powershell -ExecutionPolicy Bypass -File .\scripts\phase3-validate-100.ps1
```

Defaults del smoke test:
- `slotId = 149`
- `slotsPerDay = 288`
- `recordCount = 100`
- distribucion fija:
  - `provider-A-<runId> = 30`
  - `provider-B-<runId> = 30`
  - `provider-C-<runId> = 20`
  - `provider-D-<runId> = 10`
  - `provider-E-<runId> = 5`
  - `provider-F-<runId> = 5`
- `targetDate = <manana en UTC>`

Artefactos esperados:
- logs de Lambda en:
  - `/aws/lambda/tapi-producer`
  - `/aws/lambda/tapi-workflow-bootstrap`
  - `/aws/lambda/tapi-consumer`
- logs de Step Functions en:
  - `/aws/vendedlogs/states/tapi-consumer-state-machine`
- snapshots y resumen en:
  - `artifacts\phase3-validation\100-record-smoke\<timestamp>\`

Notas operativas:
- la state machine activa es `tapi-consumer-state-machine-express`
- el log group de Step Functions sigue siendo `/aws/vendedlogs/states/tapi-consumer-state-machine`
- el smoke test usa `targetDate` explicito para no depender del schedule natural del dia
- la validacion de `EXPRESS` se hace con CloudWatch Logs Insights, no con `list-executions`
- la validacion de serializacion por proveedor se hace desde logs de `tapi-consumer`
- el primer estado del workflow normaliza un batch `SQS` de un elemento: la raiz efectiva llega como array, no como objeto plano
- `workflow-bootstrap` normaliza `payload` y `headers` para que `InvokeConsumerLambda` no falle por JSONPaths opcionales ausentes
- cada corrida usa `providerId` con sufijo `runId` para no contaminarse con mensajes viejos todavia presentes en la FIFO
- `scripts/phase2-validate.ps1` queda retirado porque modelaba el runtime viejo

## Estado validado en AWS al 2026-05-01
La validacion real mas reciente del smoke test de `100` registros sobre el slot `149` dejo este resultado:
- cola `tapi-provider-queue.fifo`: `0` visibles, `0` no visibles al cierre
- `tapi-pending-records` para `DATE#2026-05-02#SLOT#149`:
  - `COMPLETED = 53`
  - `FAILED = 40`
  - `IN_PROGRESS = 7`
  - `TOTAL = 100`
- `tapi-results`: `93` rows finales persistidas para la corrida validada

Interpretacion operativa:
- el flujo end-to-end `producer -> SQS FIFO -> Pipe -> Step Functions Express -> consumer -> DynamoDB` quedo probado para `93/100`
- los `53` exitos y `40` cierres por fallo llegaron a persistencia final
- la cola dreno por completo, asi que el problema residual ya no es de conexion entre servicios

Riesgo residual abierto:
- quedaron `7` items stale en `IN_PROGRESS`
- esos items no impiden validar el flujo nuevo, pero si impiden declarar cierre perfecto de la corrida
- la remediacion pendiente es una politica explicita para recovery de `pending`/`idempotency` stale, o bien una limpieza operativa controlada antes de repetir la prueba

Lectura correcta del estado actual:
- la nueva state machine quedo estable para `200`, `400` y `503`
- la arquitectura de Fase 3 ya corre end-to-end en AWS
- la deuda restante esta concentrada en recuperacion de estado intermedio viejo, no en routing ni persistencia final
