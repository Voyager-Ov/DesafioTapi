import { spawn } from 'node:child_process';

export interface CommandExecutionResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCommand(command: string, cwd: string): Promise<CommandExecutionResult> {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';

  return await new Promise<CommandExecutionResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true,
    });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('close', (exitCode) => {
      resolve({
        command,
        cwd,
        exitCode: exitCode ?? -1,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });

    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      resolve({
        command,
        cwd,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
  });
}