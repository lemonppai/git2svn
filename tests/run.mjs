import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findProject,
  isValidBranch,
  isValidGitUrl,
  isValidSvnUrl,
  logger,
  parseArgs,
  parseDirection,
  parseGitStatus,
  parseProjectTable,
  parseStatus,
  resolveWorkspace,
} from '../dist/index.js';

/** 构造一行 svn status 输出（7 列状态 + 1 空格 + 路径） */
const svnLine = (flag, file) => `${flag.padEnd(7)} ${file}`;

test('parseProjectTable：解析标准项目表', () => {
  const markdown = `
# 项目

| 项目名 | Git仓库地址 | Git分支 | Svn仓库地址 |
| --- | --- | --- | --- |
| demo | https://github.com/user/demo.git | main | svn://svn.example.com/trunk/demo |
| site | git@github.com:user/site.git | dev | svn+ssh://user@svn.example.com/repo |
`;
  const projects = parseProjectTable(markdown);
  assert.equal(projects.length, 2);
  assert.deepEqual(projects[0], {
    name: 'demo',
    gitUrl: 'https://github.com/user/demo.git',
    gitBranch: 'main',
    svnUrl: 'svn://svn.example.com/trunk/demo',
    svnSubdir: undefined,
    direction: undefined,
  });
  assert.equal(projects[1].gitBranch, 'dev');
});

test('parseProjectTable：列顺序任意、表头忽略大小写与空格、支持可选子目录列', () => {
  const markdown = `
| **SVN 仓库地址** | 项目名 | subdir | git 分支 | GitHub 仓库地址 |
| --- | --- | --- | --- | --- |
| svn://svn.example.com/trunk/demo | demo | dist/web | main | https://github.com/user/demo.git |
`;
  // 存在未识别的列时不误读；该行缺少 Git 地址，整行跳过
  assert.equal(parseProjectTable(markdown).length, 0);

  const normalized = `
| SVN仓库地址 | 项目名 | svn子目录 | Git分支 | Git仓库地址 |
| --- | --- | --- | --- | --- |
| svn://svn.example.com/trunk/demo | demo | dist/web | main | https://github.com/user/demo.git |
`;
  const projects = parseProjectTable(normalized);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].svnSubdir, 'dist/web');
});

test('parseProjectTable：无关表格与缺列的行被忽略', () => {
  const markdown = `
| 名称 | 说明 |
| --- | --- |
| a | b |

| 项目名 | Git仓库地址 | Git分支 | Svn仓库地址 |
| --- | --- | --- | --- |
| demo | https://github.com/user/demo.git | main | svn://svn.example.com/trunk/demo |
| broken | https://github.com/user/broken.git | main |
`;
  const projects = parseProjectTable(markdown);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'demo');
});

test('parseProjectTable：可选方向列', () => {
  const markdown = `
| 项目名 | Git仓库地址 | Git分支 | Svn仓库地址 | 方向 |
| --- | --- | --- | --- | --- |
| demo | https://github.com/user/demo.git | main | svn://svn.example.com/trunk/demo | svn2git |
| site | https://github.com/user/site.git | dev | svn://svn.example.com/trunk/site | Git → SVN |
| other | https://github.com/user/other.git | dev | svn://svn.example.com/trunk/other | 未知写法 |
`;
  const projects = parseProjectTable(markdown);
  assert.equal(projects.length, 3);
  assert.equal(projects[0].direction, 'svn2git');
  assert.equal(projects[1].direction, 'git2svn');
  assert.equal(projects[2].direction, undefined);
});

test('parseDirection：兼容多种写法，非法值返回 undefined', () => {
  assert.equal(parseDirection('git2svn'), 'git2svn');
  assert.equal(parseDirection('G2S'), 'git2svn');
  assert.equal(parseDirection('git -> svn'), 'git2svn');
  assert.equal(parseDirection('svn2git'), 'svn2git');
  assert.equal(parseDirection('s2g'), 'svn2git');
  assert.equal(parseDirection('SVN → Git'), 'svn2git');
  assert.equal(parseDirection('其他'), undefined);
  assert.equal(parseDirection(undefined), undefined);
});

test('parseGitStatus：统计 git 工作区变更', () => {
  const output = [
    'A  added.txt',
    'M  modified.txt',
    ' M also-modified.txt',
    'D  deleted.txt',
    'R  old.txt -> new.txt',
    '?? untracked.txt',
  ].join('\n');

  const stats = parseGitStatus(output);
  assert.equal(stats.added, 1);
  assert.equal(stats.modified, 2);
  assert.equal(stats.deleted, 1);
  assert.equal(stats.replaced, 1);
  assert.equal(stats.unversioned, 1);
});

test('parseGitStatus：空输出安全', () => {
  assert.deepEqual(parseGitStatus(''), {
    added: 0,
    modified: 0,
    deleted: 0,
    replaced: 0,
    unversioned: 0,
  });
});

test('findProject：名称不区分大小写', () => {
  const projects = [
    { name: 'Demo', gitUrl: 'https://a/b.git', gitBranch: 'main', svnUrl: 'svn://h/r' },
  ];
  assert.equal(findProject(projects, 'demo')?.name, 'Demo');
  assert.equal(findProject(projects, 'missing'), undefined);
});

test('parseArgs：长参数、等号写法与布尔开关', () => {
  const options = parseArgs([
    '-p',
    'demo',
    '--git=https://github.com/user/demo.git',
    '--branch',
    'main',
    '--svn',
    'svn://svn.example.com/trunk/demo',
    '-m',
    'sync demo',
    '--fresh',
    '--dry-run',
    '-y',
  ]);
  assert.equal(options.project, 'demo');
  assert.equal(options.git, 'https://github.com/user/demo.git');
  assert.equal(options.branch, 'main');
  assert.equal(options.svn, 'svn://svn.example.com/trunk/demo');
  assert.equal(options.message, 'sync demo');
  assert.equal(options.config, 'README.md');
  assert.equal(options.workDir, '.git2svn');
  assert.equal(options.fresh, true);
  assert.equal(options.dryRun, true);
  assert.equal(options.yes, true);
});

test('parseArgs：未知参数直接报错', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});

test('parseArgs：--direction 支持别名与等号写法', () => {
  assert.equal(parseArgs(['--direction', 'svn2git']).direction, 'svn2git');
  assert.equal(parseArgs(['--direction=s2g']).direction, 'svn2git');
  assert.equal(parseArgs(['--direction', 'git->svn']).direction, 'git2svn');
  assert.equal(parseArgs([]).direction, undefined);
  assert.throws(() => parseArgs(['--direction', 'sideways']), /同步方向不合法/);
});

test('parseStatus：统计新增/修改/删除/未跟踪', () => {
  const output = [
    svnLine('A', 'new.txt'),
    svnLine('M', 'mod.txt'),
    svnLine('D', 'del.txt'),
    svnLine('!', 'gone.txt'),
    svnLine('?', 'untracked.txt'),
    svnLine(' M', 'props.txt'),
    svnLine('R', 'replaced.txt'),
  ].join('\n');

  const info = parseStatus(output);
  assert.equal(info.added, 1);
  assert.equal(info.modified, 2);
  assert.equal(info.deleted, 2);
  assert.equal(info.replaced, 1);
  assert.equal(info.unversioned, 1);
  assert.deepEqual(info.missing, ['gone.txt']);
});

test('parseStatus：空输出安全', () => {
  assert.deepEqual(parseStatus(''), {
    added: 0,
    modified: 0,
    deleted: 0,
    replaced: 0,
    unversioned: 0,
    missing: [],
  });
});

test('resolveWorkspace：同参数稳定、不同仓库隔离', () => {
  const a = resolveWorkspace('.git2svn', 'https://a/b.git', 'main', 'svn://h/r');
  const b = resolveWorkspace('.git2svn', 'https://a/b.git', 'main', 'svn://h/r');
  const c = resolveWorkspace('.git2svn', 'https://a/b.git', 'dev', 'svn://h/r');
  assert.equal(a.gitDir, b.gitDir);
  assert.notEqual(a.gitDir, c.gitDir);
  assert.ok(a.gitDir.startsWith(a.root));
});

test('地址与分支校验', () => {
  assert.ok(isValidGitUrl('https://github.com/user/repo.git'));
  assert.ok(isValidGitUrl('git@github.com:user/repo.git'));
  assert.ok(!isValidGitUrl('not a url'));

  assert.ok(isValidSvnUrl('svn://svn.example.com/trunk/repo'));
  assert.ok(isValidSvnUrl('svn+ssh://user@svn.example.com/repo'));
  assert.ok(!isValidSvnUrl('ftp://x/y'));

  assert.ok(isValidBranch('feature/login-2'));
  assert.ok(!isValidBranch('-bad'));
  assert.ok(!isValidBranch('a..b'));
});

test('logger.title 返回字符串，模板插值不会出现 undefined', () => {
  const text = logger.title('② 填写仓库信息');
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('填写仓库信息'));
  assert.ok(!`${text}`.includes('undefined'));
});
