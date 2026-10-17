import path from 'node:path';
import { commitAll, getGitIdentity, prepareGitCheckout, pushBranch, stageAll } from './git';
import {
  prepareSvnCheckout,
  svnAdd,
  svnCommit,
  svnDeleteMissing,
  svnInfoRevision,
  svnResolveAll,
  svnStatus,
} from './svn';
import { cleanDirectory, copyTree, ensureDir, exists, resolveWorkspace } from './workspace';
import { isValidBranch, isValidSvnUrl } from './config';
import type { ChangeStats, SyncEvent, SyncOptions, SyncResult, SyncStage } from '../types';

function assertOptions(options: SyncOptions): void {
  if (!options.gitUrl?.trim()) throw new Error('缺少 Git 仓库地址');
  if (!options.gitBranch?.trim()) throw new Error('缺少 Git 分支');
  if (!options.svnUrl?.trim()) throw new Error('缺少 SVN 仓库地址');
  if (!isValidBranch(options.gitBranch)) throw new Error(`Git 分支名不合法：${options.gitBranch}`);
  if (!isValidSvnUrl(options.svnUrl)) throw new Error(`SVN 仓库地址不合法：${options.svnUrl}`);

  const subdir = options.svnSubdir?.trim();
  if (subdir) {
    const normalized = path.posix.normalize(subdir.replace(/\\/g, '/'));
    if (path.isAbsolute(subdir) || normalized.startsWith('..')) {
      throw new Error(`SVN 子目录必须是仓库内的相对路径：${subdir}`);
    }
  }
}

const normalizeSubdir = (subdir?: string | null): string =>
  subdir?.trim().replace(/\\/g, '/').replace(/^\.?\//, '') ?? '';

const emptyStats = (): ChangeStats => ({ added: 0, modified: 0, deleted: 0, replaced: 0, unversioned: 0 });

/** 把 Git 分支内容同步到 SVN 工作副本并提交 */
export async function syncGitToSvn(options: SyncOptions): Promise<SyncResult> {
  assertOptions(options);
  const startedAt = Date.now();
  const emit = (stage: SyncStage, message: string, status: SyncEvent['status']): void => {
    options.onEvent?.({ stage, message, status });
  };

  const { gitUrl, gitBranch, svnUrl, fresh = false, dryRun = false, debug = false } = options;
  const nonInteractive = options.nonInteractive ?? false;
  const svn = { nonInteractive, debug };
  const dirs = resolveWorkspace(options.workDir ?? '.git2svn', gitUrl, gitBranch, svnUrl);
  ensureDir(dirs.root);
  ensureDir(dirs.gitDir);
  ensureDir(dirs.svnDir);

  // 1. Git 工作副本
  emit('git', '拉取 Git 仓库…', 'start');
  const git = await prepareGitCheckout({
    url: gitUrl,
    branch: gitBranch,
    dir: dirs.gitDir,
    fresh,
    nonInteractive,
    debug,
  });
  emit('git', `Git 仓库就绪（${git.sha}${git.reused ? '，复用工作副本' : ''}）`, 'done');

  // 2. SVN 工作副本
  emit('svn', '准备好 SVN 工作副本…', 'start');
  const svnCheckout = await prepareSvnCheckout({
    url: svnUrl,
    dir: dirs.svnDir,
    fresh,
    nonInteractive,
    debug,
  });
  emit('svn', `SVN 工作副本就绪${svnCheckout.reused ? '（增量更新）' : ''}`, 'done');

  const subdir = normalizeSubdir(options.svnSubdir);
  const targetDir = subdir ? path.join(dirs.svnDir, subdir) : dirs.svnDir;

  // 3. 清空目标目录（保留 .svn 元数据）
  emit('clean', subdir ? `清理 SVN 子目录 ${subdir}…` : '清理 SVN 工作副本…', 'start');
  ensureDir(targetDir);
  const removed = cleanDirectory(targetDir);
  emit('clean', `已清理 ${removed} 个旧条目`, 'done');

  // 4. 复制 Git 代码
  emit('copy', '复制 Git 代码到 SVN 工作副本…', 'start');
  copyTree(dirs.gitDir, targetDir);
  emit('copy', '代码复制完成', 'done');

  // 5. 登记变更
  emit('diff', '识别 SVN 变更…', 'start');
  await svnResolveAll(targetDir, svn);
  if (subdir) await svnAdd(dirs.svnDir, subdir, svn);
  await svnAdd(targetDir, '.', svn);

  let status = await svnStatus(targetDir, svn);
  if (status.missing.length) {
    await svnDeleteMissing(targetDir, status.missing, svn);
    status = await svnStatus(targetDir, svn);
  }

  const stats: ChangeStats = {
    added: status.added,
    modified: status.modified,
    deleted: status.deleted,
    replaced: status.replaced,
    unversioned: status.unversioned,
  };
  emit('diff', `新增 ${stats.added} · 修改 ${stats.modified} · 删除 ${stats.deleted}`, 'done');

  if (stats.unversioned > 0) {
    emit('diff', `${stats.unversioned} 个文件未纳入版本控制（可能命中 svn:ignore），不会提交`, 'warn');
  }

  const result: SyncResult = {
    direction: 'git2svn',
    gitDir: dirs.gitDir,
    svnDir: dirs.svnDir,
    targetDir,
    sha: git.sha,
    svnRevision: null,
    committed: false,
    pushed: false,
    stats,
    durationMs: 0,
  };

  if (dryRun) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // 6. 提交
  const message =
    options.message?.trim() ||
    (options.promptMessage
      ? (await options.promptMessage({ direction: 'git2svn', sha: git.sha, svnRevision: null, stats })).trim()
      : '');
  if (!message) throw new Error('缺少 SVN 提交信息，请通过 --message 指定');

  emit('commit', '提交到 SVN…', 'start');
  const revision = await svnCommit(targetDir, message, { ...svn, retries: 3 });
  emit('commit', revision ? `提交完成（r${revision}）` : '提交完成', 'done');

  result.svnRevision = revision;
  result.committed = true;
  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * 把 SVN 内容镜像回 Git 分支并推送。
 * 覆盖范围：Git 工作副本除 .git 外的全部内容，与 SVN 侧完全一致。
 */
export async function syncSvnToGit(options: SyncOptions): Promise<SyncResult> {
  assertOptions(options);
  const startedAt = Date.now();
  const emit = (stage: SyncStage, message: string, status: SyncEvent['status']): void => {
    options.onEvent?.({ stage, message, status });
  };

  const { gitUrl, gitBranch, svnUrl, fresh = false, dryRun = false, debug = false } = options;
  const nonInteractive = options.nonInteractive ?? false;
  const svn = { nonInteractive, debug };
  const dirs = resolveWorkspace(options.workDir ?? '.git2svn', gitUrl, gitBranch, svnUrl);
  ensureDir(dirs.root);
  ensureDir(dirs.gitDir);
  ensureDir(dirs.svnDir);

  // 1. SVN 源
  emit('svn', '检出 SVN 仓库…', 'start');
  const checkout = await prepareSvnCheckout({
    url: svnUrl,
    dir: dirs.svnDir,
    fresh,
    nonInteractive,
    debug,
  });

  const subdir = normalizeSubdir(options.svnSubdir);
  const sourceDir = subdir ? path.join(dirs.svnDir, subdir) : dirs.svnDir;
  if (!exists(sourceDir)) {
    throw new Error(`SVN 子目录不存在：${subdir}`);
  }
  const svnRevision = await svnInfoRevision(sourceDir, svn);
  emit(
    'svn',
    `SVN 工作副本就绪${svnRevision ? `（r${svnRevision}）` : ''}${checkout.reused ? '，增量更新' : ''}`,
    'done',
  );

  // 2. Git 目标
  emit('git', '准备 Git 仓库…', 'start');
  const git = await prepareGitCheckout({
    url: gitUrl,
    branch: gitBranch,
    dir: dirs.gitDir,
    fresh,
    nonInteractive,
    debug,
  });
  emit('git', `Git 仓库就绪（${git.sha}）`, 'done');

  // 3. 清空 Git 工作区（保留 .git）
  emit('clean', '清理 Git 工作副本…', 'start');
  const removed = cleanDirectory(dirs.gitDir, ['.git']);
  emit('clean', `已清理 ${removed} 个旧条目`, 'done');

  // 4. 复制 SVN 内容
  emit('copy', '复制 SVN 内容到 Git 工作副本…', 'start');
  copyTree(sourceDir, dirs.gitDir, ['.svn']);
  emit('copy', '代码复制完成', 'done');

  // 5. 识别变更
  emit('diff', '识别 Git 变更…', 'start');
  const staged = await stageAll(dirs.gitDir, { debug });
  const stats = staged.stats;
  emit(
    'diff',
    staged.dirty
      ? `新增 ${stats.added} · 修改 ${stats.modified} · 删除 ${stats.deleted}${
          stats.replaced ? ` · 重命名/复制 ${stats.replaced}` : ''
        }`
      : '工作区与 Git 分支一致，无变更',
    'done',
  );
  if (stats.unversioned > 0) {
    emit('diff', `${stats.unversioned} 个文件被 .gitignore 忽略，未纳入提交`, 'warn');
  }

  const result: SyncResult = {
    direction: 'svn2git',
    gitDir: dirs.gitDir,
    svnDir: dirs.svnDir,
    targetDir: dirs.gitDir,
    sha: git.sha,
    svnRevision,
    committed: false,
    pushed: false,
    stats: staged.dirty ? stats : emptyStats(),
    durationMs: 0,
  };

  if (!staged.dirty || dryRun) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // 6. 提交并推送
  const identity = await getGitIdentity(dirs.gitDir);
  if (!identity) {
    throw new Error(
      'Git 未配置提交身份，请先执行：\n' +
        '  git config --global user.name "你的名字"\n' +
        '  git config --global user.email "you@example.com"',
    );
  }

  const message =
    options.message?.trim() ||
    (options.promptMessage
      ? (
          await options.promptMessage({
            direction: 'svn2git',
            sha: git.sha,
            svnRevision,
            stats,
          })
        ).trim()
      : '');
  if (!message) throw new Error('缺少 Git 提交信息，请通过 --message 指定');

  emit('commit', '提交并推送到 Git…', 'start');
  const sha = await commitAll(dirs.gitDir, message, { debug });
  await pushBranch(dirs.gitDir, gitBranch, { nonInteractive, debug });
  emit('commit', `已推送 ${gitBranch}（${sha}）`, 'done');

  result.sha = sha;
  result.committed = true;
  result.pushed = true;
  result.durationMs = Date.now() - startedAt;
  return result;
}

/** 按 direction 分派；缺省 Git → SVN */
export async function sync(options: SyncOptions): Promise<SyncResult> {
  return (options.direction ?? 'git2svn') === 'svn2git' ? syncSvnToGit(options) : syncGitToSvn(options);
}

/** 兼容旧调用：等价于 syncGitToSvn */
export const syncToSvn = syncGitToSvn;
/** SVN → Git 的显式入口 */
export const syncToGit = syncSvnToGit;
