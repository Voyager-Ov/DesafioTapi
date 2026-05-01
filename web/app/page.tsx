'use client';

import { useMemo, useState } from 'react';
import {
  automatedFlowSteps,
  manualAwsProofCommands,
  type FlowStepStatus,
} from '@/lib/flow-steps';

interface StepRunResult {
  readonly stepId: string;
  readonly title: string;
  readonly command: string;
  readonly cwd: string;
  readonly purpose: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: 'passed' | 'failed';
}

interface ValidationResponse {
  readonly repositoryRoot: string;
  readonly finishedAt: string;
  readonly results: StepRunResult[];
}

const initialStatuses = automatedFlowSteps.reduce<Record<string, FlowStepStatus>>((accumulator, step) => {
  accumulator[step.id] = 'pending';
  return accumulator;
}, {});

export default function HomePage() {
  const [isRunning, setIsRunning] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, FlowStepStatus>>(initialStatuses);
  const [runResult, setRunResult] = useState<ValidationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => {
    if (!runResult) {
      return 'Todavía no ejecutaste la secuencia.';
    }

    const failedStep = runResult.results.find((step) => step.status === 'failed');
    if (failedStep) {
      return `Se detuvo en ${failedStep.title}.`;
    }

    return 'La secuencia local pasó completa.';
  }, [runResult]);

  async function runValidation() {
    setIsRunning(true);
    setError(null);
    setRunResult(null);
    setStatuses(initialStatuses);

    try {
      const response = await fetch('/api/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`No se pudo iniciar la validación: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as ValidationResponse;
      setRunResult(data);

      const nextStatuses: Record<string, FlowStepStatus> = { ...initialStatuses };
      for (const step of data.results) {
        nextStatuses[step.stepId] = step.status;
      }

      setStatuses(nextStatuses);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : 'Error desconocido');
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <p className="eyebrow">Tapi Flow Lab</p>
        <h1 className="title">Ver, en orden, qué se ejecuta y qué logs devuelve.</h1>
        <p className="subtitle">
          Esta pantalla no reemplaza AWS. Sirve para correr la validación local en el orden correcto,
          ver stdout y stderr por paso, y tener a mano el runbook AWS para cuando quieras probar el flujo real.
        </p>
        <div className="hero-actions">
          <button className="button button-primary" onClick={runValidation} disabled={isRunning}>
            {isRunning ? 'Ejecutando...' : 'Correr validación local'}
          </button>
          <a className="button button-secondary" href="#aws-runbook">
            Ver runbook AWS
          </a>
        </div>
      </section>

      <section className="layout">
        <div className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Secuencia local</h2>
            <span className="badge" data-status={isRunning ? 'running' : runResult ? 'passed' : 'pending'}>
              {isRunning ? 'RUNNING' : runResult ? 'READY' : 'IDLE'}
            </span>
          </div>

          <div className="panel-body">
            <div className="steps">
              {automatedFlowSteps.map((step) => {
                const status = statuses[step.id] ?? 'pending';
                const stepResult = runResult?.results.find((result) => result.stepId === step.id);

                return (
                  <article className="step" key={step.id}>
                    <div className="step-top">
                      <h3 className="step-name">{step.title}</h3>
                      <span className="badge" data-status={status}>{status.toUpperCase()}</span>
                    </div>
                    <p className="step-command">{step.command}</p>
                    <div className="step-meta">
                      <span>cwd: {step.cwd}</span>
                      <span>propósito: {step.purpose}</span>
                      {stepResult ? <span>duración: {Math.max(stepResult.durationMs, 1)} ms</span> : null}
                    </div>
                    {stepResult ? (
                      <div className="logbox" aria-label={`logs-${step.id}`}>
                        {stepResult.stdout ? <pre className="log-line">{stepResult.stdout.trimEnd()}</pre> : null}
                        {stepResult.stderr ? (
                          <pre className="log-line" style={{ color: 'var(--danger)' }}>{stepResult.stderr.trimEnd()}</pre>
                        ) : null}
                        {!stepResult.stdout && !stepResult.stderr ? (
                          <p className="log-line">Sin salida.</p>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>

            <p className="footer-note">{summary}</p>
            {error ? <p className="footer-note" style={{ color: 'var(--danger)' }}>{error}</p> : null}
          </div>
        </div>

        <aside className="grid-cards">
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Qué valida primero</h2>
            </div>
            <div className="panel-body">
              <div className="info-card">
                <h3>Orden recomendado</h3>
                <ol className="info-list">
                  <li>Los tests confirman que la lógica del producer, consumer y CDK todavía coincide con el diseño.</li>
                  <li>El build descubre errores de TypeScript o imports rotos antes de synth.</li>
                  <li>CDK synth y diff muestran si la infraestructura sigue siendo coherente.</li>
                </ol>
              </div>
            </div>
          </div>

          <div className="panel" id="aws-runbook">
            <div className="panel-header">
              <h2 className="panel-title">Runbook AWS</h2>
            </div>
            <div className="panel-body">
              <div className="command-list">
                {manualAwsProofCommands.map((command) => (
                  <div className="command-chip" key={command.label}>
                    <strong>{command.label}</strong>
                    <pre>{command.command}</pre>
                    <p>{command.note}</p>
                  </div>
                ))}
              </div>
              <p className="footer-note">
                Esos comandos siguen el orden de validación operacional del repo. La UI corre solo la parte local para no disparar despliegues o efectos laterales desde el navegador.
              </p>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Lectura rápida del flujo</h2>
            </div>
            <div className="panel-body">
              <div className="info-card">
                <p>
                  Producer {'->'} SQS FIFO {'->'} Pipe {'->'} Step Functions {'->'} Consumer {'->'} DynamoDB.
                </p>
                <p style={{ marginTop: 10 }}>
                  Si la validación local pasa pero el flujo AWS falla, el problema ya no es de build ni de contratos internos: está en infraestructura, credenciales o datos de prueba.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}