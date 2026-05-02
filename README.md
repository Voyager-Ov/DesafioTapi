# Desafío Tapi

Documentación oficial en Notion:
- Hub: [README - Visión General y Formulación del Problema](https://app.notion.com/p/353693af57098158aebed629e2139abf)
- Detalle técnico: [Documentación técnica por etapas y servicios - Desafío Tapi](https://app.notion.com/p/353693af5709817cbcd2f6a4ebc6e766)

## Resumen
Este repositorio contiene la implementación serverless en AWS del desafío técnico Tapi. La solución procesa consultas diarias sobre una base masiva de registros, distribuye la carga durante el día, diferencia errores reintentables de terminales, persiste el cierre final de cada work item y garantiza que no exista concurrencia hacia un mismo proveedor.

El runtime final desplegado y validado es:
`EventBridge Scheduler (tapi-dispatch-slot-000 ... tapi-dispatch-slot-287) -> Lambda Producer (tapi-producer) -> SQS FIFO High Throughput (tapi-provider-queue.fifo) -> EventBridge Pipe (tapi-provider-pipe) -> Step Functions Express (tapi-consumer-state-machine-express) -> Lambda workflow bootstrap (tapi-workflow-bootstrap) -> Lambda Consumer (tapi-consumer) -> DynamoDB pending records (tapi-pending-records) / DynamoDB idempotency (tapi-idempotency) / DynamoDB results (tapi-results)`

## Cómo leer esta entrega
- `Notion` es la documentación principal: arquitectura, decisiones, validación y narrativa técnica.
- `GitHub` es la base de implementación y evidencia: código, CDK, tests, scripts y artefactos documentales del repo.

## Mapa rápido del repo
- `src/`: funciones Lambda, dominio, adapters y tipos compartidos.
- `cdk/`: infraestructura como código y definición del stack AWS.
- `test/`: pruebas unitarias y de infraestructura.
- `scripts/`: scripts operativos y validaciones end-to-end.
- `docs/phase3/`: guía técnica de la fase final y proof path de escala.

## Validación local
```bash
npm run build
npm test -- --runInBand
npm run lint
```

## Evidencia técnica en el repo
- `ARCHITECTURE.md`
- `docs/phase3/README.md`
- `docs/decisions/ADR-phase3-end-to-end-stabilization.md`
- `scripts/phase3-validate-100.ps1`

## Notas para revisión técnica
- La explicación larga no está duplicada en markdown dentro del repo; vive en Notion.
- El repo está pensado para que el revisor pueda inspeccionar implementación, tests, CDK y scripts sin perder la relación con la documentación oficial.
