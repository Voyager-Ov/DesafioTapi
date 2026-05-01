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

## Scripts de validacion
El repo ahora tiene un runner generico y dos wrappers chicos:
- `scripts/phase3-validate-slot.ps1`: runner parametrizable para una sola corrida sobre un `slot`
- `scripts/phase3-validate-100.ps1`: wrapper fijo para el smoke test de `100`
- `scripts/phase3-validate-10000.ps1`: wrapper fijo para una corrida de carga de `10000`

### Smoke test: 100 registros en un solo slot
Para una validacion rapida de Fase 3, el wrapper de `100`:
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

### Corrida grande: 10000 registros con generacion random
Para una prueba mas cercana a volumen, el wrapper de `10000`:
- genera `10000` registros en un loop, sin sembrarlos uno por uno
- usa `250` proveedores aleatorios por corrida para sostener paralelismo real por `MessageGroupId`
- reparte categorias con random ponderado:
  - `60%` hacia `200`
  - `20%` hacia `400`
  - `20%` hacia `503`
- mantiene el mismo `slotId = 149`
- valida cierre total en `pending`, `idempotency`, `results` y cola FIFO

```powershell
cd "C:\github desktop\tapi"
powershell -ExecutionPolicy Bypass -File .\scripts\phase3-validate-10000.ps1
```

Nota importante para la corrida grande:
- el endpoint externo de prueba (`httpbin`) no sostuvo una separacion perfecta entre `400` planeados y `5xx` reales bajo esta carga
- por eso, para `random-large`, el criterio correcto de aceptacion no es exigir el split exacto `400` vs `503`
- lo que se valida es:
  - `200` cerrados exactos
  - total de fallos exacto
  - `0` registros activos
  - `0` mensajes visibles/no visibles en la FIFO al cierre
  - `10000` rows finales en `tapi-results`

## Estado validado en AWS al 2026-05-01
La corrida limpia mas reciente del smoke test de `100` registros sobre el slot `149` dejo este resultado:
- cola `tapi-provider-queue.fifo`: `0` visibles, `0` no visibles al cierre
- `tapi-pending-records` para la seed fresca:
  - `COMPLETED = 60`
  - `FAILED = 40`
  - `PENDING = 0`
  - `IN_PROGRESS = 0`
  - `TOTAL = 100`
- `tapi-idempotency`:
  - `COMPLETED = 60`
  - `FAILED = 40`
  - `IN_PROGRESS = 0`
- `tapi-results`: `100` rows finales persistidas
  - `60` con `200`
  - `20` con `400`
  - `20` con `503`

Interpretacion operativa:
- el flujo end-to-end `producer -> SQS FIFO -> Pipe -> Step Functions Express -> consumer -> DynamoDB` quedo validado `100/100` para una seed limpia
- la nueva state machine cerro correctamente exito, fallo terminal y transitorio agotado
- la cola dreno por completo y no quedaron items activos en la corrida fresca

Lectura correcta del incidente anterior:
- el hallazgo previo de `93/100` con `7` rows en `IN_PROGRESS` correspondia a estado heredado de corridas rotas anteriores
- esa observacion sigue siendo util como aprendizaje operativo
- ya no representa el estado actual del runtime nuevo

Lectura correcta del estado actual:
- la nueva state machine quedo estable para `200`, `400` y `503`
- la arquitectura de Fase 3 ya corre end-to-end en AWS
- la mejora pendiente ya no es corregir routing o cierres basicos, sino endurecer tooling y, si se desea, definir una estrategia formal para stale state heredado

## Corrida de carga validada en AWS al 2026-05-01
La corrida grande mas reciente de `10000` registros sobre el mismo slot `149` dejo este resultado:
- seed random generada por loop con `250` proveedores
- cola `tapi-provider-queue.fifo`: `0` visibles, `0` no visibles al cierre
- `tapi-pending-records` para la seed fresca:
  - `COMPLETED = 5983`
  - `FAILED = 4017`
  - `PENDING = 0`
  - `IN_PROGRESS = 0`
  - `TOTAL = 10000`
- `tapi-idempotency`:
  - `COMPLETED = 5983`
  - `FAILED = 4017`
  - `IN_PROGRESS = 0`
- `tapi-results`: `10000` rows finales persistidas
  - `200 = 5983`
  - `400 = 1980`
  - `5xx = 2037`

Interpretacion correcta de la corrida grande:
- el pipeline end-to-end cerro `10000/10000`
- la distribucion `400` vs `5xx` no quedo identica al plan porque `httpbin` introdujo variacion en los fallos bajo carga
- eso no cambia la validacion principal del challenge:
  - todos los registros cerraron
  - no quedaron items activos
  - la FIFO dreno completa
  - `results` persistio una fila final por item
