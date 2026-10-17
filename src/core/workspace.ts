import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface WorkspaceDirs {
  root: string;
  gitDir: string;
  svnDir: string;
}

const hashOf = (input: string): string => crypto.createHash('md5').update(input).digest('hex').slice(0, 12);

/** 工作副本按 仓库地址(+分支) 取哈希，避免不同项目互相覆盖 */
export function resolveWorkspace(
  workDir: string,
  gitUrl: string,
  gitBranch: string,
  svnUrl: string,
): WorkspaceDirs {
  const root = path.resolve(workDir);
  return {
    root,
    gitDir: path.join(root, 'git', hashOf(`${gitUrl}#${gitBranch}`)),
    svnDir: path.join(root, 'svn', hashOf(svnUrl)),
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(target: string): boolean {
  return fs.existsSync(target);
}

/** 清空目录内容，保留指定元数据目录（SVN 为 .svn，Git 为 .git） */
export function cleanDirectory(target: string, keep: string[] = ['.svn']): number {
  if (!fs.existsSync(target)) {
    ensureDir(target);
    return 0;
  }
  let removed = 0;
  for (const entry of fs.readdirSync(target)) {
    if (keep.includes(entry)) continue;
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** 复制文件树，默认跳过版本库元数据目录 */
export function copyTree(source: string, target: string, skip: string[] = ['.git', '.svn']): number {
  let copied = 0;
  for (const entry of fs.readdirSync(source)) {
    if (skip.includes(entry)) continue;
    fs.cpSync(path.join(source, entry), path.join(target, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    copied += 1;
  }
  return copied;
}
