/** 同步方向：Git → SVN 或 SVN → Git */
export type SyncDirection = 'git2svn' | 'svn2git';

/** 项目配置：来自 README 表格或命令行参数 */
export interface ProjectConfig {
  name: string;
  gitUrl: string;
  gitBranch: string;
  svnUrl: string;
  /** 可选：SVN 侧子目录（Git → SVN 为写入目标，SVN → Git 为读取来源） */
  svnSubdir?: string;
  /** 可选：该项目的默认同步方向 */
  direction?: SyncDirection;
}

export type SyncStage = 'git' | 'svn' | 'clean' | 'copy' | 'diff' | 'commit';

export interface SyncEvent {
  stage: SyncStage;
  message: string;
  status: 'start' | 'done' | 'warn';
}

export interface ChangeStats {
  added: number;
  modified: number;
  deleted: number;
  replaced: number;
  unversioned: number;
}

export interface MessageContext {
  direction: SyncDirection;
  sha: string;
  svnRevision: string | null;
  stats: ChangeStats;
}

export interface SyncOptions {
  /** 缺省 git2svn */
  direction?: SyncDirection;
  gitUrl: string;
  gitBranch: string;
  svnUrl: string;
  /** SVN 侧子目录：Git → SVN 写入该目录，SVN → Git 读取该目录 */
  svnSubdir?: string | null;
  /** 工作副本根目录，默认 ./.git2svn */
  workDir?: string;
  /** 提交信息（Git → SVN 为 SVN 提交，SVN → Git 为 Git 提交） */
  message?: string;
  promptMessage?: (context: MessageContext) => Promise<string>;
  /** 强制重新克隆 / 检出 */
  fresh?: boolean;
  /** 只生成变更不提交 */
  dryRun?: boolean;
  /** 非交互环境：SVN 加 --non-interactive，Git 禁用凭据交互 */
  nonInteractive?: boolean;
  debug?: boolean;
  onEvent?: (event: SyncEvent) => void;
}

export interface SyncResult {
  direction: SyncDirection;
  gitDir: string;
  svnDir: string;
  targetDir: string;
  /** 同步后的 Git HEAD（短哈希） */
  sha: string;
  /** SVN 侧版本：Git → SVN 为提交后的 rN；SVN → Git 为读取到的源版本 */
  svnRevision: string | null;
  /** 是否产生了提交 */
  committed: boolean;
  /** SVN → Git 时是否已推送 */
  pushed: boolean;
  stats: ChangeStats;
  durationMs: number;
}
