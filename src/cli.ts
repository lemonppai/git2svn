import path from 'node:path';
import ora from 'ora';
import type { Ora } from 'ora';
import pkg from '../package.json';
import {
  findProject,
  isValidBranch,
  isValidGitUrl,
  isValidSvnUrl,
  loadProjects,
  parseDirection,
} from './core/config';
import { detectDefaultBranch, gitAvailable } from './core/git';
import { sync } from './core/sync';
import { svnAvailable } from './core/svn';
import { askConfirm, askInput, askSelect, separator, type Choice } from './ui/ask';
import { logger, pad } from './ui/logger';
import type { ProjectConfig, SyncDirection, SyncEvent, SyncResult } from './types';

export const VERSION: string = pkg.version;

export interface CliOptions {
  direction?: SyncDirection;
  project?: string;
  git?: string;
  branch?: string;
  svn?: string;
  svnSubdir?: string;
  message?: string;
  config: string;
  workDir: string;
  fresh: boolean;
  dryRun: boolean;
  yes: boolean;
  debug: boolean;
  help: boolean;
  version: boolean;
}

const DEFAULT_CONFIG = 'README.md';
const DEFAULT_WORK_DIR = '.git2svn';

/** 解析命令行参数，支持 --key=value 与 --key value 两种写法 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    config: DEFAULT_CONFIG,
    workDir: DEFAULT_WORK_DIR,
    fresh: false,
    dryRun: false,
    yes: false,
    debug: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] ?? '';
    let inline: string | undefined;

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > -1) {
        inline = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
    }
    const next = (): string => (inline !== undefined ? inline : (argv[++i] ?? ''));

    switch (arg) {
      case '--direction': {
        const raw = next();
        const direction = parseDirection(raw);
        if (!direction) throw new Error(`同步方向不合法：${raw}（可选 git2svn / svn2git）`);
        options.direction = direction;
        break;
      }
      case '-p':
      case '--project':
        options.project = next();
        break;
      case '--git':
        options.git = next();
        break;
      case '--branch':
        options.branch = next();
        break;
      case '--svn':
        options.svn = next();
        break;
      case '--svn-subdir':
        options.svnSubdir = next();
        break;
      case '-m':
      case '--message':
        options.message = next();
        break;
      case '-c':
      case '--config':
        options.config = next() || DEFAULT_CONFIG;
        break;
      case '-w':
      case '--work-dir':
        options.workDir = next() || DEFAULT_WORK_DIR;
        break;
      case '--fresh':
        options.fresh = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '-y':
      case '--yes':
        options.yes = true;
        break;
      case '-d':
      case '--debug':
        options.debug = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        throw new Error(`未知参数：${arg}（使用 --help 查看用法）`);
    }
  }

  return options;
}

export const HELP = `
git2svn — Git 与 SVN 双向同步

用法：
  git2svn                                          # 交互式引导（推荐）
  git2svn -p demo -m "sync demo"                   # 使用 README 表格中的项目
  git2svn --direction svn2git -p demo -m "hotfix"  # SVN → Git
  git2svn --git <url> --branch main --svn <url> -m "sync" -y

默认从当前目录的 README.md 读取项目表，表头需包含：
  项目名 | Git仓库地址 | Git分支 | Svn仓库地址 [| SVN子目录] [| 方向]

参数：
      --direction <方向>    git2svn（Git → SVN，默认）或 svn2git（SVN → Git）
  -p, --project <名称>      直接使用项目表中的项目（名称不区分大小写）
      --git <地址>          Git 仓库地址（覆盖项目表）
      --branch <分支>       Git 分支（覆盖项目表；缺省时自动探测远端默认分支）
      --svn <地址>          SVN 仓库地址（覆盖项目表）
      --svn-subdir <路径>   SVN 侧相对子目录：
                            Git → SVN 写入该目录；SVN → Git 读取该目录
  -m, --message <文本>      提交信息（非交互模式必填；G→S 为 SVN，S→G 为 Git）
  -c, --config <文件>       项目表来源，默认 ./README.md
  -w, --work-dir <目录>     工作副本目录，默认 ./.git2svn
      --fresh               强制重新克隆 Git / 检出 SVN（缺省增量复用）
      --dry-run             只生成变更不提交，便于先核对差异
  -y, --yes                 跳过交互确认（需同时提供地址与提交信息）
  -d, --debug               输出执行的命令
  -h, --help                查看帮助
  -v, --version             查看版本

示例：
  # Git → SVN
  git2svn --git https://github.com/user/demo.git --branch main \\
          --svn svn://svn.example.com/trunk/demo -m "release 1.0.0" -y

  # SVN → Git（提交并推送）
  git2svn --direction svn2git --git https://github.com/user/demo.git \\
          --branch main --svn svn://svn.example.com/trunk/demo -m "sync from svn" -y
`.trim();

const askRequired = async (message: string, validate: (value: string) => true | string): Promise<string> => {
  const value = await askInput({
    message,
    validate: (input) => {
      const trimmed = input.trim();
      if (!trimmed) return '不能为空';
      return validate(trimmed);
    },
  });
  return value.trim();
};

async function ensureTools(): Promise<void> {
  if (!(await gitAvailable())) throw new Error('未找到 git 命令，请先安装 Git 并加入 PATH');
  if (!(await svnAvailable())) throw new Error('未找到 svn 命令，请先安装 Subversion 并加入 PATH');
}

async function selectProject(projects: ProjectConfig[]): Promise<ProjectConfig | null> {
  const choices: Choice<string>[] = projects.map((project) => ({
    name: `${project.name}  ${logger.dim(`${project.gitBranch} → ${project.svnUrl}`)}`,
    value: project.name,
  }));
  choices.push(separator(), { name: '➕ 其他项目（手动输入）', value: '__other__' });

  const picked = await askSelect<string>({ message: '请选择要同步的项目', choices });
  return picked === '__other__' ? null : (findProject(projects, picked) ?? null);
}

/** 选择同步方向，项目表里配置的方向排在第一位作为默认项 */
async function selectDirection(preferred?: SyncDirection): Promise<SyncDirection> {
  const toSvn: Choice<SyncDirection> = {
    name: `Git → SVN  ${logger.dim('把 Git 分支镜像到 SVN 并提交')}`,
    value: 'git2svn',
  };
  const toGit: Choice<SyncDirection> = {
    name: `SVN → Git  ${logger.dim('把 SVN 内容提交回 Git 并推送')}`,
    value: 'svn2git',
  };
  const choices = preferred === 'svn2git' ? [toGit, toSvn] : [toSvn, toGit];
  return askSelect<SyncDirection>({ message: '选择同步方向', choices });
}

const directionLabel = (direction: SyncDirection): string =>
  direction === 'svn2git' ? 'SVN → Git' : 'Git → SVN';

const svnTargetOf = (svnUrl: string, subdir: string | null): string =>
  subdir ? `${svnUrl.replace(/\/+$/, '')}/${subdir}` : svnUrl;

function printPlan(values: {
  direction: SyncDirection;
  gitUrl: string;
  gitBranch: string;
  svnUrl: string;
  svnSubdir: string | null;
  workDir: string;
}): void {
  const toGit = values.direction === 'svn2git';
  console.log('');
  console.log(`   ${pad('同步方向', 12)} ${logger.accent(directionLabel(values.direction))}`);
  if (toGit) {
    console.log(`   ${pad('SVN 来源', 12)} ${logger.accent(svnTargetOf(values.svnUrl, values.svnSubdir))}`);
    console.log(`   ${pad('Git 目标', 12)} ${logger.accent(`${values.gitUrl} #${values.gitBranch}`)}`);
  } else {
    console.log(`   ${pad('Git 来源', 12)} ${logger.accent(`${values.gitUrl} #${values.gitBranch}`)}`);
    console.log(`   ${pad('SVN 目标', 12)} ${logger.accent(svnTargetOf(values.svnUrl, values.svnSubdir))}`);
  }
  console.log(
    `   ${pad('覆盖范围', 12)} ${logger.dim(
      toGit
        ? 'Git 分支整体镜像（提交并推送）'
        : values.svnSubdir
          ? 'SVN 仅该子目录'
          : 'SVN 仓库根目录（整体镜像）',
    )}`,
  );
  console.log(`   ${pad('工作目录', 12)} ${logger.dim(path.resolve(values.workDir))}`);
  console.log('');
}

function printResult(
  result: SyncResult,
  context: { svnUrl: string; svnSubdir: string | null; gitUrl: string; gitBranch: string },
): void {
  const toGit = result.direction === 'svn2git';
  console.log('');
  logger.success(result.committed ? '同步并提交完成' : '同步完成（未提交）');
  console.log('');
  console.log(`   ${pad('同步方向', 12)} ${directionLabel(result.direction)}`);

  if (toGit) {
    const pushState = result.pushed
      ? logger.dim(`已推送 ${context.gitBranch}`)
      : result.committed
        ? logger.dim('未推送')
        : logger.dim('无新提交');
    console.log(`   ${pad('Git 提交', 12)} ${result.sha}  ${pushState}`);
    if (result.svnRevision) {
      console.log(`   ${pad('SVN 来源版本', 12)} r${result.svnRevision}`);
    }
    console.log(`   ${pad('Git 目标', 12)} ${context.gitUrl} #${context.gitBranch}`);
  } else {
    console.log(
      `   ${pad('SVN 版本', 12)} ${
        result.committed
          ? result.svnRevision
            ? `r${result.svnRevision}`
            : '无变更'
          : logger.dim('dry-run，未提交')
      }`,
    );
    console.log(`   ${pad('Git 来源', 12)} ${result.sha}`);
    console.log(`   ${pad('SVN 目标', 12)} ${svnTargetOf(context.svnUrl, context.svnSubdir)}`);
  }

  console.log(
    `   ${pad('变更统计', 12)} 新增 ${result.stats.added} · 修改 ${result.stats.modified} · 删除 ${result.stats.deleted}` +
      (result.stats.replaced ? ` · 替换 ${result.stats.replaced}` : ''),
  );
  console.log(`   ${pad('本地副本', 12)} ${logger.dim(result.targetDir)}`);
  console.log(`   ${pad('耗时', 12)} ${(result.durationMs / 1000).toFixed(2)} s`);
  console.log('');
}

/** CLI 入口：交互式引导 + 命令行参数双通道 */
export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseArgs(argv);
  if (cli.help) {
    console.log(HELP);
    return;
  }
  if (cli.version) {
    console.log(VERSION);
    return;
  }

  const interactive = !cli.yes;
  if (interactive && !process.stdin.isTTY) {
    throw new Error(
      '当前环境不是交互式终端，无法进行选择操作。请改用非交互模式，例如：\n' +
        '  git2svn --git <url> --branch main --svn <url> -m "sync" -y',
    );
  }

  const configPath = path.resolve(cli.config);
  const projects = loadProjects(configPath);
  // 只在确实需要项目表时提示，纯参数调用不打扰
  if (!projects.length && (cli.project || (interactive && !cli.git))) {
    logger.warn(`未在 ${configPath} 找到项目表，将转为手动输入`);
  }

  const marks = ['①', '②', '③', '④', '⑤', '⑥'];
  let step = 0;
  const heading = (text: string): void => {
    console.log(`\n${logger.title(`${marks[step++] ?? '•'} ${text}`)}`);
  };

  // ① 选择项目
  let project: ProjectConfig | null = null;
  if (cli.project) {
    project = findProject(projects, cli.project) ?? null;
    if (!project) {
      const available = projects.map((item) => item.name).join('、');
      throw new Error(
        `未找到项目「${cli.project}」${available ? `，可选：${available}` : '（配置文件中没有项目表）'}`,
      );
    }
  } else if (interactive && projects.length && !cli.git) {
    heading('选择项目');
    project = await selectProject(projects);
  }

  // ② 选择同步方向：命令行 > 项目表 > 交互选择
  let direction = cli.direction ?? project?.direction;
  if (!direction) {
    if (interactive) {
      heading('选择同步方向');
      direction = await selectDirection(project?.direction);
    } else {
      direction = 'git2svn';
    }
  }

  // ③ 补齐仓库信息
  let gitUrl = (cli.git ?? project?.gitUrl ?? '').trim();
  let gitBranch = (cli.branch ?? project?.gitBranch ?? '').trim();
  let svnUrl = (cli.svn ?? project?.svnUrl ?? '').trim();
  const svnSubdir = (cli.svnSubdir ?? project?.svnSubdir ?? '').trim() || null;

  if (interactive && (!gitUrl || !gitBranch || !svnUrl)) {
    heading('填写仓库信息');
  }

  if (!gitUrl) {
    if (!interactive) throw new Error('缺少 Git 仓库地址（--git）');
    gitUrl = await askRequired('Git 仓库地址', (value) =>
      isValidGitUrl(value) ? true : '格式不正确，示例：https://github.com/user/repo.git',
    );
  }

  if (!gitBranch) {
    const detected = await detectDefaultBranch(gitUrl);
    if (!interactive) {
      if (!detected) throw new Error('缺少 Git 分支（--branch）');
      gitBranch = detected;
    } else {
      const value = await askInput({
        message: 'Git 分支',
        default: detected ?? 'main',
        validate: (input) => (isValidBranch(input.trim()) ? true : '格式不正确，示例：main'),
      });
      gitBranch = value.trim() || detected || 'main';
    }
  }

  if (!svnUrl) {
    if (!interactive) throw new Error('缺少 SVN 仓库地址（--svn）');
    svnUrl = await askRequired('SVN 仓库地址', (value) =>
      isValidSvnUrl(value) ? true : '格式不正确，示例：svn://svn.example.com/trunk/repo',
    );
  }

  if (!isValidGitUrl(gitUrl)) throw new Error(`Git 仓库地址不合法：${gitUrl}`);
  if (!isValidBranch(gitBranch)) throw new Error(`Git 分支名不合法：${gitBranch}`);
  if (!isValidSvnUrl(svnUrl)) throw new Error(`SVN 仓库地址不合法：${svnUrl}`);

  // 参数齐备后再检查外部命令，避免还没输完就报环境错误
  await ensureTools();

  // ④ 确认
  printPlan({ direction, gitUrl, gitBranch, svnUrl, svnSubdir, workDir: cli.workDir });
  if (!cli.dryRun) {
    if (direction === 'svn2git') {
      logger.warn(`将把 SVN 内容镜像到 Git 分支「${gitBranch}」并提交推送，分支上多余的文件会被删除`);
    } else {
      logger.warn(
        svnSubdir
          ? `将把 Git 内容镜像到 SVN 子目录「${svnSubdir}」，该目录原有内容会被整体覆盖`
          : '将把 Git 内容镜像到 SVN 仓库根目录，仓库原有内容会被整体覆盖',
      );
    }
  }

  if (interactive) {
    const ok = await askConfirm({ message: '确认开始同步？', default: true });
    if (!ok) {
      logger.warn('已取消');
      return;
    }
  } else if (!cli.dryRun && !cli.message?.trim()) {
    throw new Error('非交互模式需要通过 --message 指定提交信息');
  }

  // ⑤ 执行
  heading('执行同步');

  let spinner: Ora | null = null;
  const onEvent = (event: SyncEvent): void => {
    if (event.status === 'start') {
      spinner?.stop();
      spinner = ora(event.message).start();
      return;
    }
    if (event.status === 'done') {
      if (spinner) {
        spinner.succeed(event.message);
        spinner = null;
      } else {
        logger.success(event.message);
      }
      return;
    }
    if (spinner) {
      spinner.warn(event.message);
      spinner = null;
    } else {
      logger.warn(event.message);
    }
  };

  try {
    const result = await sync({
      direction,
      gitUrl,
      gitBranch,
      svnUrl,
      svnSubdir,
      workDir: cli.workDir,
      fresh: cli.fresh,
      dryRun: cli.dryRun,
      nonInteractive: !interactive,
      debug: cli.debug,
      message: cli.message,
      promptMessage: interactive
        ? async ({ sha, svnRevision }) => {
            spinner?.stop();
            spinner = null;
            const isToGit = direction === 'svn2git';
            const fallback = isToGit
              ? `sync(${gitBranch}): svn${svnRevision ? ` r${svnRevision}` : ''}`
              : `sync(${gitBranch}): ${sha}`;
            const value = await askInput({
              message: isToGit ? 'Git 提交信息' : 'SVN 提交信息',
              default: fallback,
              validate: (input) => (input.trim() ? true : '提交信息不能为空'),
            });
            return value.trim() || fallback;
          }
        : undefined,
      onEvent,
    });

    printResult(result, { svnUrl, svnSubdir, gitUrl, gitBranch });
    const changes =
      result.stats.added + result.stats.modified + result.stats.deleted + result.stats.replaced;
    if (!cli.dryRun && changes === 0) {
      logger.warn(
        direction === 'svn2git'
          ? `Git 分支「${gitBranch}」已与 SVN 一致，未产生新提交`
          : '没有检测到变更，SVN 未产生新版本',
      );
    }
  } catch (error) {
    const active = spinner as Ora | null;
    if (active) {
      active.fail('同步失败');
      spinner = null;
    }
    throw error;
  }
}
