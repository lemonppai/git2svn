import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './cli';
import { logger } from './ui/logger';

export { run, parseArgs, HELP, VERSION } from './cli';
export type { CliOptions } from './cli';
export { sync, syncGitToSvn, syncSvnToGit, syncToGit, syncToSvn } from './core/sync';
export {
  commitAll,
  detectDefaultBranch,
  getGitIdentity,
  parseGitStatus,
  prepareGitCheckout,
  pushBranch,
  stageAll,
} from './core/git';
export { parseStatus, prepareSvnCheckout, svnInfoRevision, svnStatus } from './core/svn';
export {
  findProject,
  isValidBranch,
  isValidGitUrl,
  isValidSvnUrl,
  loadProjects,
  parseDirection,
  parseProjectTable,
} from './core/config';
export { resolveWorkspace } from './core/workspace';
export { CommandError, run as runCommand } from './core/exec';
export { logger } from './ui/logger';
export type * from './types';

/** 判断是否由 Node 直接执行本文件 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run().catch((error: unknown) => {
    const name = (error as Error)?.name;
    if (name === 'ExitPromptError' || name === 'AbortPromptError') {
      console.log(`\n${logger.dim('已取消操作')}`);
      process.exit(0);
    }
    const hint = (error as { hint?: string })?.hint;
    logger.error(hint ?? (error as Error)?.message ?? String(error));
    process.exit(1);
  });
}
