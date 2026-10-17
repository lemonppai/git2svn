import fs from 'node:fs';
import path from 'node:path';
import { run, runOk, CommandError } from './exec';
import { ensureDir, exists } from './workspace';
import type { ChangeStats } from '../types';

export interface SvnOptions {
  /** 非交互环境：给所有 svn 命令加 --non-interactive，避免卡在密码输入 */
  nonInteractive?: boolean;
  debug?: boolean;
}

export interface StatusInfo extends ChangeStats {
  /** svn status 中标记为 ! 的路径（已删除但未 svn delete） */
  missing: string[];
}

const withGlobalArgs = (args: string[], options: SvnOptions): string[] =>
  options.nonInteractive ? ['--non-interactive', ...args] : args;

export function svnAvailable(): Promise<boolean> {
  return runOk('svn', ['--version', '--quiet']);
}

/**
 * 准备 SVN 工作副本：已存在则 revert + update（增量，避免整仓重复检出），否则 checkout。
 */
export async function prepareSvnCheckout(options: {
  url: string;
  dir: string;
  fresh?: boolean;
  nonInteractive?: boolean;
  debug?: boolean;
}): Promise<{ reused: boolean }> {
  const { url, dir, fresh = false, nonInteractive = false, debug = false } = options;
  const svn: SvnOptions = { nonInteractive, debug };

  if (!fresh && exists(path.join(dir, '.svn'))) {
    try {
      await run('svn', withGlobalArgs(['revert', '-R', '.'], svn), { cwd: dir, debug });
      await run('svn', withGlobalArgs(['update', '--accept', 'postpone', '.'], svn), { cwd: dir, debug });
      return { reused: true };
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  await run('svn', withGlobalArgs(['checkout', url, '.'], svn), { cwd: dir, debug });
  return { reused: false };
}

/** 解析 svn status 输出 */
export function parseStatus(output: string): StatusInfo {
  const info: StatusInfo = { added: 0, modified: 0, deleted: 0, replaced: 0, unversioned: 0, missing: [] };

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line.length < 9) continue;
    const contentFlag = line[0] ?? ' ';
    const propFlag = line[1] ?? ' ';
    const target = line.slice(8).trim();
    if (!target) continue;

    switch (contentFlag) {
      case 'A':
        info.added += 1;
        break;
      case 'D':
        info.deleted += 1;
        break;
      case 'R':
        info.replaced += 1;
        break;
      case 'M':
        info.modified += 1;
        break;
      case '!':
        // 磁盘上已不存在：计入删除，并记录待 svn delete
        info.deleted += 1;
        info.missing.push(target);
        break;
      case '?':
        info.unversioned += 1;
        break;
      default:
        if (propFlag === 'M') info.modified += 1;
        break;
    }
  }

  return info;
}

export async function svnStatus(cwd: string, options: SvnOptions = {}): Promise<StatusInfo> {
  const output = await run('svn', withGlobalArgs(['status', '.'], options), {
    cwd,
    debug: options.debug,
  });
  return parseStatus(output);
}

/** 读取工作副本当前版本号，用于 SVN → Git 的提交信息 */
export async function svnInfoRevision(cwd: string, options: SvnOptions = {}): Promise<string | null> {
  try {
    const output = await run('svn', withGlobalArgs(['info', '--show-item', 'revision', '.'], options), {
      cwd,
      debug: options.debug,
    });
    if (/^\d+$/.test(output.trim())) return output.trim();
  } catch {
    // svn < 1.9 不支持 --show-item，回退到解析 info 输出
  }

  try {
    const output = await run('svn', withGlobalArgs(['info', '.'], options), { cwd });
    const match = /^Revision:\s*(\d+)/m.exec(output);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** 把已删除的文件登记到 SVN */
export async function svnDeleteMissing(cwd: string, targets: string[], options: SvnOptions = {}): Promise<number> {
  let count = 0;
  for (const target of targets) {
    await run('svn', withGlobalArgs(['delete', '--force', target], options), {
      cwd,
      debug: options.debug,
    });
    count += 1;
  }
  return count;
}

/** 把未纳入版本控制的文件加入 SVN（已存在的不会重复添加） */
export async function svnAdd(cwd: string, target = '.', options: SvnOptions = {}): Promise<void> {
  await run('svn', withGlobalArgs(['add', '--force', target], options), {
    cwd,
    debug: options.debug,
  });
}

/**
 * 接受工作副本当前内容来解决遗留冲突。
 * 前面的镜像覆盖已经用 Git 内容替换了文件，如果不解除冲突标记，commit 会被拒绝。
 */
export async function svnResolveAll(cwd: string, options: SvnOptions = {}): Promise<void> {
  await runOk('svn', withGlobalArgs(['resolve', '--accept', 'working', '-R', '.'], options), {
    cwd,
    debug: options.debug,
  });
}

/** 与远端存在冲突时先 update 再重试提交 */
function isOutOfDate(error: unknown): boolean {
  if (!(error instanceof CommandError)) return false;
  return /out of date|E155011|E170004|non-existent in that revision/i.test(error.stderr);
}

export async function svnCommit(
  cwd: string,
  message: string,
  options: SvnOptions & { retries?: number } = {},
): Promise<string | null> {
  const retries = Math.max(1, options.retries ?? 3);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const output = await run(
        'svn',
        withGlobalArgs(['commit', '-m', message, '.'], options),
        { cwd, debug: options.debug },
      );
      const match = /Committed revision (\d+)/i.exec(output);
      return match ? match[1] ?? null : null;
    } catch (error) {
      // 他人已提交同一路径：拉取最新后重试，而不是盲目重试同一个提交
      if (attempt < retries && isOutOfDate(error)) {
        await run(
          'svn',
          withGlobalArgs(['update', '--accept', 'postpone', '.'], options),
          { cwd, debug: options.debug },
        );
        continue;
      }
      throw error;
    }
  }

  return null;
}
