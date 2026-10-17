import fs from 'node:fs';
import path from 'node:path';
import { run, runOk } from './exec';
import { isValidBranch } from './config';
import { ensureDir, exists } from './workspace';
import type { ChangeStats } from '../types';

export interface GitCheckoutOptions {
  url: string;
  branch: string;
  dir: string;
  fresh?: boolean;
  /** 非交互环境禁用凭据弹窗，避免卡住 */
  nonInteractive?: boolean;
  debug?: boolean;
}

export interface GitCheckoutResult {
  sha: string;
  subject: string;
  /** 是否复用了已存在的工作副本 */
  reused: boolean;
}

/** 非交互环境下让 git 直接报凭据错误，而不是等待输入 */
const gitEnv = (nonInteractive?: boolean): NodeJS.ProcessEnv | undefined =>
  nonInteractive ? { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' } : undefined;

/** 取远端默认分支，用于交互式输入的默认值 */
export async function detectDefaultBranch(url: string): Promise<string | null> {
  try {
    const output = await run('git', ['ls-remote', '--symref', url, 'HEAD'], { retries: 1 });
    const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(output);
    return match ? match[1] ?? null : null;
  } catch {
    return null;
  }
}

/**
 * 准备 Git 工作副本。
 * 已存在时先 fetch + 重置 + clean（比每次全量克隆快得多），失败再回退到全新克隆。
 * 复用路径会切到本地分支，保证 SVN → Git 之后可以直接 push。
 */
export async function prepareGitCheckout(options: GitCheckoutOptions): Promise<GitCheckoutResult> {
  const { url, branch, dir, fresh = false, nonInteractive, debug = false } = options;
  if (!isValidBranch(branch)) {
    throw new Error(`Git 分支名不合法：${branch}`);
  }

  const env = gitEnv(nonInteractive);
  ensureDir(path.dirname(dir));
  let reused = false;

  if (!fresh && exists(path.join(dir, '.git'))) {
    try {
      await run('git', ['fetch', '--depth', '1', 'origin', branch], { cwd: dir, env, debug });
      await run('git', ['checkout', '-f', '-B', branch, 'FETCH_HEAD'], { cwd: dir, env, debug });
      await run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: dir, env, debug });
      await run('git', ['clean', '-fdxq'], { cwd: dir, env, debug });
      reused = true;
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (!reused) {
    fs.rmSync(dir, { recursive: true, force: true });
    await run('git', ['clone', '--depth', '1', '--branch', branch, '--', url, dir], { env, debug });
    await run('git', ['checkout', '-f', '-B', branch], { cwd: dir, env, debug });
  }

  const sha = await run('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: dir, debug });
  const subject = await run('git', ['log', '-1', '--pretty=%s'], { cwd: dir, debug }).catch(() => '');

  return { sha, subject, reused };
}

/**
 * 解析 `git status --porcelain` 统计变更数量。
 * 格式：XY + 空格 + 路径（重命名会带 "old -> new"）
 */
export function parseGitStatus(output: string): ChangeStats {
  const stats: ChangeStats = { added: 0, modified: 0, deleted: 0, replaced: 0, unversioned: 0 };

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length < 3) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';

    if (x === '?' && y === '?') {
      stats.unversioned += 1;
      continue;
    }
    if (x === 'U' || y === 'U') {
      // 冲突文件：镜像覆盖后不应出现，保守计入修改
      stats.modified += 1;
      continue;
    }
    switch (x) {
      case 'A':
        stats.added += 1;
        break;
      case 'D':
        stats.deleted += 1;
        break;
      case 'R':
      case 'C':
        stats.replaced += 1;
        break;
      case 'M':
        stats.modified += 1;
        break;
      default:
        if (y === 'M' || y === 'D') stats.modified += 1;
        break;
    }
  }

  return stats;
}

/** 读取仓库级/全局的提交身份，未配置时返回 null */
export async function getGitIdentity(dir: string): Promise<{ name: string; email: string } | null> {
  try {
    const name = await run('git', ['config', '--get', 'user.name'], { cwd: dir });
    const email = await run('git', ['config', '--get', 'user.email'], { cwd: dir });
    if (!name.trim() || !email.trim()) return null;
    return { name: name.trim(), email: email.trim() };
  } catch {
    return null;
  }
}

/** 暂存全部变更（含删除），返回变更统计与原始状态 */
export async function stageAll(
  dir: string,
  options: { debug?: boolean } = {},
): Promise<{ stats: ChangeStats; dirty: boolean; status: string }> {
  await run('git', ['add', '-A'], { cwd: dir, debug: options.debug });
  const status = await run('git', ['status', '--porcelain'], { cwd: dir, debug: options.debug });
  return { stats: parseGitStatus(status), dirty: status.trim().length > 0, status };
}

/** 提交并返回新的短哈希 */
export async function commitAll(
  dir: string,
  message: string,
  options: { debug?: boolean } = {},
): Promise<string> {
  await run('git', ['commit', '-m', message], { cwd: dir, debug: options.debug });
  return run('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: dir, debug: options.debug });
}

/** 推送当前 HEAD 到远端同名分支 */
export async function pushBranch(
  dir: string,
  branch: string,
  options: { nonInteractive?: boolean; debug?: boolean } = {},
): Promise<void> {
  await run('git', ['push', 'origin', `HEAD:${branch}`], {
    cwd: dir,
    env: gitEnv(options.nonInteractive),
    debug: options.debug,
  });
}

/** 探测 git 是否可用 */
export function gitAvailable(): Promise<boolean> {
  return runOk('git', ['--version']);
}
