import path from 'node:path';
import { NextResponse } from 'next/server';
import { automatedFlowSteps } from '@/lib/flow-steps';
import { runCommand } from '@/lib/run-command';

export const runtime = 'nodejs';

export async function POST() {
  const repoRoot = path.resolve(process.cwd(), '..');
  const results: Array<{
    stepId: string;
    title: string;
    command: string;
    cwd: string;
    purpose: string;
    exitCode: number;
    durationMs: number;
    stdout: string;
    stderr: string;
    status: 'passed' | 'failed';
  }> = [];

  for (const step of automatedFlowSteps) {
    const execution = await runCommand(step.command, path.resolve(repoRoot, step.cwd));
    const status = execution.exitCode === 0 ? 'passed' : 'failed';

    results.push({
      stepId: step.id,
      title: step.title,
      command: step.command,
      cwd: path.resolve(repoRoot, step.cwd),
      purpose: step.purpose,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      stdout: execution.stdout,
      stderr: execution.stderr,
      status,
    });

    if (execution.exitCode !== 0) {
      break;
    }
  }

  return NextResponse.json({
    repositoryRoot: repoRoot,
    finishedAt: new Date().toISOString(),
    results,
  });
}