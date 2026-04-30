# Fase 0: Auditoría del Repo Actual

## Resumen ejecutivo
El repositorio actual compila y sus tests unitarios pasan, pero no debe considerarse una solución confiable del challenge. La base tiene dirección técnica razonable en varios módulos, especialmente en separación por dominio y adapters, pero todavía está lejos de probar las garantías sistémicas que el challenge exige.

Diagnóstico general:
- La estructura `producer / consumer / orchestrator / cdk` es rescatable.
- El diseño hexagonal está intentado y es utilizable como punto de partida.
- La implementación actual está mejor resuelta en piezas locales que en garantías de sistema.
- El repo contiene señales de evolución desordenada, con duplicidad de entrypoints y diferencias entre comentarios, objetivo teórico y comportamiento real.

## Clasificación `conservar / refactorizar / descartar`

### Conservar
- `src/shared/types`
  - Motivo: provee contratos base útiles para el dominio y no acopla a AWS.
- `producer/domain/use-cases/dispatch-records.use-case.ts`
  - Motivo: el caso de uso es simple, entendible y mantiene separación razonable entre dominio y cola.
- `consumer/domain/use-cases/process-record.use-case.ts`
  - Motivo: la distinción entre éxito, error transitorio y error terminal está bien orientada.
- tests unitarios de dominio y adapters
  - Motivo: no prueban el challenge completo, pero sirven como red de seguridad al rehacer.

### Refactorizar
- `cdk/lib/stacks/tapi-stack.ts`
  - Motivo: modela servicios correctos, pero mezcla decisiones defendibles con huecos importantes de escalabilidad, throughput, idempotencia y wiring.
- `producer` adapters y handler
  - Motivo: la base sirve, pero hoy la lectura por fecha concentra demasiado peso en una sola partición y en una sola ejecución lógica.
- `consumer` adapters y wiring
  - Motivo: el flujo local está bien encaminado, pero falta cerrar semántica de persistencia, observabilidad y estrategia de idempotencia.
- `orchestrator/handler.ts`
  - Motivo: resuelve el arranque de Step Functions, pero todavía es una pieza delgada sin garantías adicionales ni trazabilidad fuerte.

### Descartar
- Asumir que el repo actual ya resuelve el challenge
  - Motivo: sería una conclusión falsa basada en tests locales y comentarios aspiracionales.
- Tratar comentarios de arquitectura como evidencia suficiente
  - Motivo: hay casos donde el comentario promete más de lo que el código configura realmente.
- Mantener ambos entrypoints de consumer como si fueran el diseño final
  - Motivo: la coexistencia de `handler.ts` y `handler.sqs.ts` sugiere una transición incompleta y complica la narrativa técnica.

## Gaps contra `goal.txt`

### 1. Automatización distribuida
Estado: `PARCIAL`

Evidencia actual:
- Hay `EventBridge Scheduler`.
- Hay una ventana flexible de 60 minutos.

Gap:
- La distribución temporal hoy se limita al inicio del job diario.
- No hay una estrategia cerrada para distribuir granularmente la ejecución masiva más allá de FIFO por proveedor.

Impacto:
- La solución es defendible como punto inicial, pero no como respuesta completa a “distribución temporal” a gran escala.

### 2. Persistencia íntegra y de alto rendimiento
Estado: `PARCIAL`

Evidencia actual:
- Existe tabla de resultados con TTL y PITR.
- Se persisten éxitos y fallos terminales.

Gap:
- La tabla comenta write sharding, pero la implementación real usa `PK = PROVIDER#<providerId>` sin shard.
- Para proveedores de altísimo volumen, la estrategia actual puede generar particiones calientes.

Impacto:
- La persistencia existe, pero la historia de escalabilidad está incompleta.

### 3. Orquestación de fallos
Estado: `PARCIAL`

Evidencia actual:
- Hay clasificación de errores transitorios y terminales.
- Step Functions reintenta `TransientApiError`.
- La cola tiene DLQ.

Gap:
- Falta una estrategia explícita de idempotencia persistida.
- El failure path está orientado, pero todavía no queda cerrado como historia operacional fuerte.

Impacto:
- La lógica de errores es buena base, pero todavía no alcanza el nivel de robustez que el challenge describe.

### 4. Control de concurrencia por proveedor
Estado: `PARCIAL A FUERTE`

Evidencia actual:
- SQS FIFO usa `MessageGroupId` por proveedor.
- El event source de la cola procesa con `batchSize: 1`, lo que ayuda a preservar el flujo.

Gap:
- La garantía principal está bien encaminada, pero falta validarla dentro de una solución completa y consistente.

Impacto:
- Este es uno de los aspectos más rescatables del repo actual.

### 5. Escalabilidad 1M+ y lectura masiva
Estado: `DÉBIL`

Evidencia actual:
- El producer hace query por fecha y pagina resultados.

Gap:
- El patrón sigue dependiendo de una única ejecución lógica que obtiene todos los pendientes del día.
- La `pendingRecordsTable` particiona por fecha, lo que concentra todo el volumen diario en una sola PK.
- No hay `Distributed Map`, segmentación por shard o estrategia equivalente implementada.

Impacto:
- Este es el gap técnico más importante del repo actual.

### 6. Shuffle-sharding
Estado: `AUSENTE`

Evidencia actual:
- Se menciona en `goal.txt`.

Gap:
- No existe implementación real del patrón ni un sustituto explícito.

Impacto:
- Debe decidirse si se implementa en Fase 3 o si se descarta con una justificación fuerte.

### 7. Observabilidad avanzada
Estado: `DÉBIL`

Evidencia actual:
- Hay logs estructurados básicos.

Gap:
- No hay métricas orientadas a edad de eventos, eventos descartados, throughput real, ni trazabilidad fuerte para revisión.

Impacto:
- La defensa técnica final hoy sería frágil.

## Evaluación del valor real de los tests
- `npm run build` pasa.
- `npm test -- --runInBand` pasa.
- Los tests actuales demuestran consistencia local de varios módulos.
- Los tests actuales no prueban escalabilidad real, idempotencia, trazabilidad operacional ni el cumplimiento sistémico del challenge.

Conclusión:
Los tests se conservan como base, pero no como evidencia de cierre del challenge.

## Arquitectura base a defender en la reimplementación
- Mantener TypeScript + AWS CDK.
- Mantener separación por `producer`, `orchestrator`, `consumer`.
- Mantener puertos de dominio y adapters.
- Unificar el diseño de entrypoints para eliminar duplicidad conceptual.
- Rehacer la estrategia de carga masiva de pendientes.
- Hacer explícita la historia de resiliencia e idempotencia.
- Posponer patrones avanzados de escalado fino a una fase específica en vez de dejarlos mezclados con el núcleo funcional.

## Conclusión
El repo actual no debe continuarse de forma incremental ciega. Sí contiene piezas reutilizables, pero necesita una reimplementación guiada por fases. La base más valiosa a conservar es el intento de arquitectura hexagonal y la idea de serialización por proveedor con SQS FIFO. Los mayores problemas están en la historia de escala masiva, la ausencia de idempotencia explícita, la observabilidad débil y la mezcla de narrativa aspiracional con garantías no implementadas.
