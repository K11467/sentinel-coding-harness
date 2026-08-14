import { type ChildProcess, spawn } from 'node:child_process';
import type { CommandRule } from '../domain/config.js';

/** The maximum combined stdout/stderr retained for a command result. */
export const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024;

const executableToken = /^[A-Za-z0-9._/-]+$/;
const forbiddenCommandCharacters = /[\u0000\r\n;|&<>`$()]/;

export interface TrustedCommand {
  command: string;
  args: string[];
}

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: { shell: false }
) => ChildProcess;

export type CommandToolErrorCode =
  | 'invalid_command'
  | 'invalid_arguments'
  | 'command_not_allowed'
  | 'spawn_error'
  | 'nonzero_exit'
  | 'timeout';

export interface CommandSuccess {
  ok: true;
  kind: 'command' | 'tests';
  exitCode: 0;
  output: string;
  truncated: boolean;
}

export interface CommandFailure {
  ok: false;
  kind: 'command' | 'tests';
  exitCode: number | null;
  output: string;
  truncated: boolean;
  errorCode: CommandToolErrorCode;
  timedOut?: true;
}

export type CommandResult = CommandSuccess | CommandFailure;

export interface CommandToolsOptions {
  allowedCommands: readonly CommandRule[];
  /** A configuration-owned command: no model action can override it. */
  testCommand: TrustedCommand;
  timeoutMs?: number;
  /** Injection point for deterministic tests; production uses node:child_process spawn. */
  spawnProcess?: SpawnProcess;
}

function nodeSpawn(command: string, args: readonly string[], options: { shell: false }): ChildProcess {
  return spawn(command, [...args], options);
}

function invalid(kind: 'command' | 'tests', errorCode: 'invalid_command' | 'invalid_arguments'): CommandFailure {
  return { ok: false, kind, exitCode: null, output: '', truncated: false, errorCode };
}

function safeUtf8Prefix(bytes: Buffer): { output: string; wasShortened: boolean } {
  for (let end = bytes.length; end >= 0; end -= 1) {
    try {
      return {
        output: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)),
        wasShortened: end !== bytes.length
      };
    } catch {
      // The 4 KiB boundary may divide a multibyte character. Back up to a valid prefix.
    }
  }
  return { output: '', wasShortened: bytes.length > 0 };
}

class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  private didTruncate = false;

  append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    const remaining = MAX_COMMAND_OUTPUT_BYTES - this.length;
    if (remaining <= 0) {
      this.didTruncate = this.didTruncate || bytes.length > 0;
      return;
    }

    const retained = bytes.subarray(0, remaining);
    this.chunks.push(retained);
    this.length += retained.length;
    this.didTruncate = this.didTruncate || retained.length !== bytes.length;
  }

  result(): { output: string; truncated: boolean } {
    const decoded = safeUtf8Prefix(Buffer.concat(this.chunks, this.length));
    return { output: decoded.output, truncated: this.didTruncate || decoded.wasShortened };
  }
}

/**
 * Executes only tokenized, allowlisted commands. It never delegates parsing to a shell.
 */
export class CommandTools {
  private readonly timeoutMs: number;
  private readonly spawnProcess: SpawnProcess;

  constructor(private readonly options: CommandToolsOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.spawnProcess = options.spawnProcess ?? nodeSpawn;
  }

  runCommand(command: unknown, args: unknown): Promise<CommandResult> {
    if (!isSafeCommand(command)) {
      return Promise.resolve(invalid('command', 'invalid_command'));
    }
    if (!isStringArray(args)) {
      return Promise.resolve(invalid('command', 'invalid_arguments'));
    }
    if (!matchesCommandRule(command, args, this.options.allowedCommands)) {
      return Promise.resolve({
        ok: false,
        kind: 'command',
        exitCode: null,
        output: '',
        truncated: false,
        errorCode: 'command_not_allowed'
      });
    }
    return this.execute('command', command, args);
  }

  /** Runs the configured test command only; it deliberately accepts no action-provided command. */
  runTests(): Promise<CommandResult> {
    const { command, args } = this.options.testCommand;
    if (!isSafeCommand(command)) {
      return Promise.resolve(invalid('tests', 'invalid_command'));
    }
    if (!isStringArray(args)) {
      return Promise.resolve(invalid('tests', 'invalid_arguments'));
    }
    return this.execute('tests', command, args);
  }

  private execute(kind: 'command' | 'tests', command: string, args: string[]): Promise<CommandResult> {
    const output = new OutputCollector();

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(command, args, { shell: false });
      } catch {
        const captured = output.result();
        resolve({
          ok: false,
          kind,
          exitCode: null,
          ...captured,
          errorCode: 'spawn_error'
        });
        return;
      }

      let settled = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // A concurrently exited child has already produced its structured result.
        }
      }, this.timeoutMs);

      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      child.stdout?.on('data', (chunk: Buffer | string) => output.append(chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => output.append(chunk));
      child.once('error', () => {
        const captured = output.result();
        finish({
          ok: false,
          kind,
          exitCode: null,
          ...captured,
          errorCode: 'spawn_error'
        });
      });
      child.once('close', (exitCode) => {
        const captured = output.result();
        if (timedOut) {
          finish({
            ok: false,
            kind,
            exitCode: null,
            ...captured,
            errorCode: 'timeout',
            timedOut: true
          });
          return;
        }
        if (exitCode === 0) {
          finish({ ok: true, kind, exitCode: 0, ...captured });
          return;
        }
        finish({
          ok: false,
          kind,
          exitCode,
          ...captured,
          errorCode: 'nonzero_exit'
        });
      });
    });
  }
}

/** Exact command plus args-prefix matching used by the configurable allowlist. */
export function matchesCommandRule(
  command: string,
  args: readonly string[],
  rules: readonly CommandRule[]
): boolean {
  return rules.some((rule) => rule.command === command && rule.argsPrefix.every((arg, index) => args[index] === arg));
}

function isSafeCommand(command: unknown): command is string {
  return typeof command === 'string'
    && command.length > 0
    && executableToken.test(command)
    && !forbiddenCommandCharacters.test(command)
    && !/\s/.test(command);
}

function isStringArray(args: unknown): args is string[] {
  return Array.isArray(args) && args.every((arg) => typeof arg === 'string');
}
