# Tapi Challenge: Roadmap por Fases

## Objetivo
Reimplementar la solución del challenge con un enfoque `spec-driven`, usando el repo actual solo como insumo de auditoría. Cada fase debe cerrar alcance, diseño técnico y tareas antes de tocar código.

## Secuencia
1. `Fase 0 - Auditoría y diagnóstico`
2. `Fase 1 - Núcleo funcional end-to-end`
3. `Fase 2 - Resiliencia y control operacional`
4. `Fase 3 - Escalabilidad masiva y distribución`
5. `Fase 4 - Observabilidad y defensa técnica final`

## Regla de ejecución por fase
Cada fase se ejecuta en este orden:
1. Escaneo de contexto real del repo
2. `functional-spec.json`
3. Aprobación explícita
4. `technical-spec.json`
5. Aprobación explícita
6. `todos.json`
7. Aprobación explícita
8. Implementación
9. Validación

## Fases

### Fase 0
Objetivo:
Determinar qué partes del repo actual se conservan, cuáles se refactorizan y cuáles se descartan.

Entregables:
- mapa `conservar / refactorizar / descartar`
- lista de gaps contra `goal.txt`
- definición de arquitectura base a defender
- roadmap de implementación por fases

### Fase 1
Objetivo:
Tener el flujo mínimo correcto y defendible del challenge.

Incluye:
- trigger diario
- selección de pendientes por fecha
- enqueue de trabajo
- ejecución de llamada al proveedor
- persistencia de éxitos
- persistencia de fallos terminales
- serialización estricta por proveedor
- paralelismo entre proveedores

### Fase 2
Objetivo:
Cerrar garantías operacionales y de resiliencia.

Incluye:
- retries para errores transitorios
- failure path y DLQ
- idempotencia o estrategia equivalente explícita
- consistencia entre runtime y CDK
- cleanup de datos transitorios
- reglas de clasificación de errores

### Fase 3
Objetivo:
Resolver de forma defendible el requisito de escala 1M+.

Incluye:
- estrategia de procesamiento masivo
- evitar lectura monolítica
- segmentación, paginación o ejecución distribuida
- distribución temporal razonable
- decisión explícita sobre `shuffle-sharding`

### Fase 4
Objetivo:
Preparar la solución final para revisión técnica.

Incluye:
- logs estructurados
- señales y métricas relevantes
- trazabilidad `requisito -> componente -> test`
- narrativa de tradeoffs
- validación final de consistencia

## Criterios globales
- No se implementa una fase con specs incompletos.
- No se mezclan decisiones funcionales con técnicas.
- Cada fase debe dejar un resultado verificable.
- Si una fase cambia el alcance, primero se corrige su spec.
- La prioridad es `repo + defensa técnica`, no solo cobertura o complejidad.
