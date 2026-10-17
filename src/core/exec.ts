import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export interface RunOptions {
  cwd?: string;
  /** 追加/覆盖的环境变量 */
  env?: NodeJS.ProcessEnv;
  /** 失败重试次数（含首次），默认 1 */
  retries?: number;
  /** 重试间隔（毫秒） */
  retryDelay?: number;
  timeout?: number;
  debug?: boolean;
}

export class CommandError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly missingBinary: boolean;

  constructor(command: string, args: string[], stderr: string, exitCode: number | null, missingBinary = false) {
    super(stderr || `${command} 执行失败`);
    this.name = 'CommandError';
    this.command = command;
    this.args = args;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.missingBinary = missingBinary;
  }

  /** 面向用户的单行说明 */
  get hint(): string {
    if (this.missingBinary) {
      return `未找到命令 ${this.command}，请先安装并确认其在 PATH 中`;
    }
    const detail = this.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
    return `${this.command} ${this.args[0] ?? ''} 执行失败${detail ? `：\n${detail}` : ''}`;
  }
}

function execFileAsync(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const missing = code === 'ENOENT';
          const exitCode = typeof error.code === 'number' ? error.code : null;
          reject(new CommandError(command, args, String(stderr ?? '').trim(), exitCode, missing));
          return;
        }
        resolve(String(stdout ?? '').trim());
      },
    );
  });
}

/**
 * 执行外部命令。
 * 使用 execFile + 参数数组，不经过 shell，避免 URL / 提交信息中的特殊字符被解释或注入。
 */
export async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const retries = Math.max(1, options.retries ?? 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (options.debug) {
        console.error(`[exec] ${command} ${args.join(' ')}${options.cwd ? ` (cwd: ${options.cwd})` : ''}`);
      }
      return await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: options.timeout,
        env: options.env,
      });
    } catch (error) {
      lastError = error;
      // 命令不存在时重试没有意义
      if (error instanceof CommandError && error.missingBinary) break;
      if (attempt < retries) await delay(options.retryDelay ?? 1500);
    }
  }

  throw lastError;
}

/** 成功返回 true，失败返回 false（用于可选的探测类命令） */
export async function runOk(command: string, args: string[], options: RunOptions = {}): Promise<boolean> {
  try {
    await run(command, args, options);
    return true;
  } catch {
    return false;
  }
}
