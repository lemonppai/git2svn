import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import inquirer from 'inquirer';
import { marked } from 'marked';
import chalk from 'chalk';
import ora from 'ora';
import type { Ora } from 'ora';
import logSymbols from 'log-symbols';
import appRootPath from 'app-root-path';

let spinner: Ora | null = null;

function md5(str: string) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function runCommand(cmd: string, cwd?: string, times: number = 1) {
  let err = null;
  // 多次重试
  for (let i = 0; i < times; i++) {
    try {
      // stdio: inherit | pipe
      return execSync(cmd, { cwd, stdio: 'pipe' }).toString().trim();
    } catch (error) {
      // console.error(`命令失败: ${cmd}`);
      // console.error(error.stderr?.toString() || error.message);
      err = error;
    }
  }

  throw err;
}

async function syncGitToSvn(GIT_REPO_URL: string, GIT_BRANCH: string, SVN_REPO_URL: string) {
  // 生成路径
  const GIT_WORK_DIR = 'dist/git/' + md5(`${GIT_REPO_URL}#${GIT_BRANCH}`);   // Git 工作副本路径
  const SVN_WORK_DIR = 'dist/svn/' + md5(`${SVN_REPO_URL}`);  // SVN 工作副本路径

  console.log(`${chalk.green(logSymbols.success)} Git 工作副本: ${chalk.cyan.bold(GIT_WORK_DIR)}`);
  console.log(`${chalk.green(logSymbols.success)} SVN 工作副本: ${chalk.cyan.bold(SVN_WORK_DIR)}`);


  // 1. 克隆 Git 仓库到工作副本
  spinner = ora('拉取 Git 仓库...').start();
  fs.rmSync(GIT_WORK_DIR, { recursive: true, force: true });
  runCommand(`git clone --depth 1 --branch ${GIT_BRANCH} ${GIT_REPO_URL} ${GIT_WORK_DIR}`);
  spinner.succeed('拉取 Git 仓库完成');

  // 2. 拉取 SVN 仓库到工作副本
  spinner = ora('拉取 SVN 仓库...').start();
  fs.rmSync(SVN_WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SVN_WORK_DIR, { recursive: true });
  runCommand(`svn checkout ${SVN_REPO_URL} .`, SVN_WORK_DIR);
  spinner.succeed('拉取 SVN 仓库完成');

  // 3. 清空 SVN 工作副本中的旧文件（保留 .svn 目录）
  spinner = ora('清理 SVN 工作副本...').start();
  const entries = fs.readdirSync(SVN_WORK_DIR);
  for (const entry of entries) {
    if (entry !== '.svn') {
      const fullPath = path.join(SVN_WORK_DIR, entry);
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
  spinner.succeed('清理 SVN 工作副本完成');

  // 4. 将 Git 代码复制到 SVN 工作副本（排除 .git 目录）
  spinner = ora('复制 Git 代码到 SVN 工作副本...').start();
  const gitEntries = fs.readdirSync(GIT_WORK_DIR);
  for (const entry of gitEntries) {
    if (entry !== '.git') {
      const src = path.join(GIT_WORK_DIR, entry);
      const dest = path.join(SVN_WORK_DIR, entry);
      fs.cpSync(src, dest, { recursive: true, force: true });
    }
  }
  spinner.succeed('复制 Git 代码到 SVN 工作副本完成');

  // 5. 处理 SVN 的新增、删除、修改
  spinner = ora('处理 SVN 变更...').start();
  // 5a. 标记所有未跟踪的文件为新增（包括修改过的文件会被自动覆盖）
  runCommand('svn add --force .', SVN_WORK_DIR);
  // 5b. 标记已删除的文件（在 Git 中删除但在 SVN 中仍存在的文件）
  let statusOutput = runCommand('svn status', SVN_WORK_DIR);
  let lines = statusOutput.split('\n').filter(l => l.startsWith('!'));
  for (const line of lines) {
    const file = line.substring(8).trim(); // 跳过 "!       "
    if (file) {
      runCommand(`svn delete --force "${file}"`, SVN_WORK_DIR);
    }
  }
  spinner.succeed('处理 SVN 变更完成');

  statusOutput = runCommand('svn status', SVN_WORK_DIR);
  lines = statusOutput.split('\n');

  let added = 0, deleted = 0, modified = 0;
  for (const line of lines) {
    if (line.startsWith('A')) {
      added++;
    } else if (line.startsWith('D')) {
      deleted++;
    } else if (line.startsWith('M')) {
      modified++;
    }
  }

  console.log(`${chalk.green(logSymbols.success)} 新增(A): ${chalk.blueBright.bold(added)} 修改(M): ${chalk.cyan.bold(modified)} 删除(D): ${chalk.red.bold(deleted)}`);

  // 6. 提交到 SVN
  const { commitMessage } = await inquirer.prompt([
    {
      type: 'input',
      name: 'commitMessage',
      message: 'SVN 提交信息',
      required: true
    },
  ]);

  spinner = ora('提交到 SVN...').start();

  runCommand(`svn commit -m "${commitMessage}"`, SVN_WORK_DIR, 5);
  spinner.succeed('提交到 SVN 完成');
}

async function run() {
  const md = fs.readFileSync(path.resolve(appRootPath.path, 'README.md'), 'utf-8');

  const tables: Record<string, any>[] = [];
  const columns: string[] = ['项目名', 'Git仓库地址', 'Git分支', 'Svn仓库地址'];

  marked.use({
    walkTokens(token) {
      if (token.type === 'table') {
        const headers = token.header.map((cell: Record<string, unknown>) => cell.text);

        if (headers.every((item: string) => columns.includes(item))) {
          const rows = token.rows.map((row: Record<string, any>[]) => row.map((cell: Record<string, unknown>) => cell.text));
          tables.push({ headers, rows });
        }
      }
    }
  });

  marked.parse(md);

  let gitRepoUrl = '';
  let gitBranch = '';
  let svnRepoUrl = '';

  const selectProjectAnswer = tables.length > 0 ?
    await inquirer.prompt([
      {
        type: 'select',
        name: 'selectProject',
        message: '请选择要同步的项目？',
        choices: tables[0].rows.map((row: Record<string, unknown>[]) => ({
          name: row[0],
          value: row
        })).concat([{ name: '其他项目', value: null }]),
      }
    ]) : { selectProject: null };

  if (!selectProjectAnswer['selectProject']) {
    const otherProjectAnswer = await inquirer.prompt([
      {
        type: 'input',
        name: 'gitRepoUrl',
        message: 'Git 仓库',
        validate(s: string) {
          if (/^https?:\/\/([\w.-]+)(:\d+)?\/[\w.\-~]+\/[\w.\-~]+(\.git)?(\/)?$/.test(s.trim())) {
            return true;
          }
          return '格式不正确';
        }
      },
      {
        type: 'input',
        name: 'gitBranch',
        message: 'Git 分支',
        validate(s: string) {
          if (/^[\w-]+$/.test(s.trim())) {
            return true;
          }
          return '格式不正确';
        }
      },
      {
        type: 'input',
        name: 'svnRepoUrl',
        message: 'SVN 仓库',
        validate(s: string) {
          if (/^svn(\+ssh)?:\/\/([\w.-]+@)?[\w.-]+(:\d+)?\/[\w.\-/~]+$/.test(s.trim())) {
            return true;
          }
          return '格式不正确';
        }
      }
    ]);

    gitRepoUrl = otherProjectAnswer['gitRepoUrl'].trim();
    gitBranch = otherProjectAnswer['gitBranch'].trim();
    svnRepoUrl = otherProjectAnswer['svnRepoUrl'].trim();
  }
  else {
    gitRepoUrl = selectProjectAnswer['selectProject'][1].trim();
    gitBranch = selectProjectAnswer['selectProject'][2].trim();
    svnRepoUrl = selectProjectAnswer['selectProject'][3].trim();

    console.log(`${chalk.green(logSymbols.success)} Git 仓库 ${chalk.cyan.bold(gitRepoUrl)}`);
    console.log(`${chalk.green(logSymbols.success)} Git 分支 ${chalk.cyan.bold(gitBranch)}`);
    console.log(`${chalk.green(logSymbols.success)} SVN 仓库 ${chalk.cyan.bold(svnRepoUrl)}`);
  }

  const confirmAnswer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'continue',
      message: '你确定要执行这个操作吗？',
    }
  ]);

  if (confirmAnswer['continue']) {
    syncGitToSvn(gitRepoUrl, gitBranch, svnRepoUrl).catch(err => {
      if (spinner) {
        spinner.fail();
      }

      console.error(err.message);
    }).finally(() => {
      // do something
    });
  }
}

export { run };

// 判断是否为主模块
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  run();
}

