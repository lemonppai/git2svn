# git2svn

在 **Git** 与 **SVN** 之间双向镜像的命令行工具。

- **Git → SVN**：把 Git 分支内容镜像到 SVN 并提交（发布 / 归档）
- **SVN → Git**：把 SVN 内容镜像回 Git 分支，提交并推送（回流 / 迁移）

两个方向都是「整目录镜像」：源侧有什么，目标侧就是什么，多余文件会被删除。提交前统一展示新增 / 修改 / 删除统计，支持 `--dry-run` 预演。

## 功能特性

- 🔀 **双向同步**：`--direction git2svn`（默认）或 `svn2git`，交互式也会先问方向
- 📋 **项目清单**：解析项目 `README.md` 中的表格，菜单选项目，不用每次输入仓库地址
- ⚡ **增量工作副本**：Git 走 `fetch`、SVN 走 `update`，不再每次全量克隆；`--fresh` 可强制重建
- 🔍 **差异完整**：G→S 自动 `svn add/delete`，S→G 自动 `git add -A` 并生成提交
- 🎯 **限定范围**：`--svn-subdir` 只操作 SVN 仓库的某个子目录
- 🧪 **先看后提交**：`--dry-run` 只生成变更不提交，便于核对
- 🤖 **可脚本化**：全参数化 + `--yes`，可直接放进 CI；参数以数组传递，提交信息含引号也不会出错
- 🔁 **冲突自愈**：SVN 提交遇 out-of-date 自动 `update` 后重试；Ctrl+C 取消不会留下半截状态

## 环境要求

| 依赖 | 版本要求 |
| ---- | -------- |
| Node.js | >= 22 |
| git | 已安装并在 PATH 中 |
| svn | 已安装并在 PATH 中，且对目标仓库有读写权限 |

SVN → Git 需要 Git 已配置提交身份（`git config user.name` / `user.email`），并对目标分支有 push 权限。

## 安装

```bash
# 全局安装（推荐，获得 git2svn 命令）
npm install -g git2svn

# 或作为项目依赖
npm install -D git2svn
npx git2svn --help
```

## 快速开始

```bash
cd 你的项目
git2svn
```

交互流程：

1. 选择项目（读取当前目录 `README.md` 的项目表）或手动输入
2. **选择同步方向**：Git → SVN 或 SVN → Git
3. 填写缺失的 Git 仓库 / 分支 / SVN 仓库
4. 确认同步范围
5. 查看变更统计，输入提交信息

非交互：

```bash
# Git → SVN
git2svn --git https://github.com/user/demo.git --branch main \
        --svn svn://svn.example.com/trunk/demo -m "release 1.0.0" -y

# SVN → Git（提交并推送）
git2svn --direction svn2git \
        --git https://github.com/user/demo.git --branch main \
        --svn svn://svn.example.com/trunk/demo -m "sync from svn" -y
```

## 两种同步方向

### Git → SVN（默认）

```
Git 仓库 ──fetch/clone──▶ .git2svn/git/<hash>
                                │ 复制（排除 .git）
                                ▼
SVN 仓库 ──update/checkout──▶ .git2svn/svn/<hash>[/子目录]
                                │ svn add · svn delete
                                ▼
                          svn commit -m "…"
```

- SVN 目标目录整体镜像 Git 分支，Git 中不存在的文件会被 `svn delete`
- 成功后在结果中显示 `Committed revision N`

### SVN → Git

```
SVN 仓库 ──update/checkout──▶ .git2svn/svn/<hash>[/子目录]
                                │ 复制（排除 .svn）
                                ▼
Git 仓库 ──fetch/clone──▶ .git2svn/git/<hash>
                                │ git add -A
                                ▼
                    git commit -m "…" && git push
```

- Git 工作区除 `.git` 外整体清空后由 SVN 内容填充，分支上多余文件会被删除
- 无差异时不会产生空提交；成功后在结果中显示新提交哈希与推送状态
- 受 `.gitignore` 规则影响：被忽略的文件不会进入 Git 提交

### 子目录语义（`--svn-subdir`）

| 方向 | 含义 |
| ---- | ---- |
| Git → SVN | Git 仓库**根目录**内容写入 `SVN/<subdir>`，SVN 其他内容不动 |
| SVN → Git | 读取 `SVN/<subdir>` 内容写入 Git 仓库**根目录** |

两个方向互为逆操作，可安全往返。

## 项目表配置

在项目 `README.md` 里放一张表，`git2svn` 会自动识别（列顺序任意，表头大小写/空格/加粗不敏感）：

```markdown
| 项目名 | Git仓库地址 | Git分支 | Svn仓库地址 | SVN子目录 | 方向 |
| ------ | ----------- | ------- | ----------- | --------- | ---- |
| demo   | https://github.com/user/demo.git | main | svn://svn.example.com/trunk/demo | | git2svn |
| web    | git@github.com:user/web.git | release | svn://svn.example.com/trunk/web | dist | svn2git |
```

- 必需列：`项目名`、`Git仓库地址`、`Git分支`、`Svn仓库地址`
- 可选列：`SVN子目录`、`方向`（`git2svn` / `svn2git`，支持 `g2s`、`s2g`、`Git → SVN` 等写法）
- 表头别名可用：`项目/project`、`git地址`、`分支/branch`、`svn地址`、`子目录/subdir`、`同步方向/direction`
- 缺少必需列的行会被忽略；代码块内的表格不会被解析

## 命令行参数

```
    --direction <方向>    git2svn（Git → SVN，默认）或 svn2git（SVN → Git）
-p, --project <名称>      直接使用项目表中的项目（名称不区分大小写）
    --git <地址>          Git 仓库地址（覆盖项目表）
    --branch <分支>       Git 分支（覆盖项目表；缺省自动探测远端默认分支）
    --svn <地址>          SVN 仓库地址（覆盖项目表）
    --svn-subdir <路径>   SVN 侧相对子目录
-m, --message <文本>      提交信息（非交互模式必填；G→S 为 SVN，S→G 为 Git）
-c, --config <文件>       项目表来源，默认 ./README.md
-w, --work-dir <目录>     工作副本目录，默认 ./.git2svn
    --fresh               强制重新克隆 Git / 检出 SVN
    --dry-run             只生成变更不提交
-y, --yes                 跳过交互确认（需同时提供地址与提交信息）
-d, --debug               输出实际执行的命令
-h, --help                查看帮助
-v, --version             查看版本
```

`--direction` 也接受 `g2s`、`s2g`、`git->svn`、`SVN → Git` 等写法。

### 支持的仓库地址

| 类型 | 示例 |
| ---- | ---- |
| Git HTTPS | `https://github.com/user/repo.git` |
| Git SSH | `git@github.com:user/repo.git`、`ssh://git@host:22/user/repo.git` |
| SVN | `svn://host/path`、`svn+ssh://user@host/path`、`https://host/svn/path` |

## 工作目录

```
.git2svn/
├── git/<md5(仓库#分支)>   # Git 工作副本
└── svn/<md5(SVN 仓库)>    # SVN 工作副本（含 .svn 元数据）
```

- 目录名按仓库哈希拆分，多项目互不干扰，可加入 `.gitignore`
- 默认增量复用；怀疑副本不一致时用 `--fresh` 重建
- 整个目录可随时删除，不影响下次运行

## ⚠️ 覆盖行为

两个方向都是镜像同步，**目标侧多余的文件会被删除**：

- Git → SVN：默认覆盖 SVN 仓库根目录，建议给每个 Git 项目单独一个 SVN 路径，或用 `--svn-subdir` 限定范围
- SVN → Git：覆盖 Git 分支的工作区，删除会在提交中体现并推送到远端

不确定时先跑 `--dry-run`：只生成变更、不提交，结果里能看到 A/M/D 统计。

## 在代码中调用

```ts
import { sync } from 'git2svn';

const result = await sync({
  direction: 'svn2git',          // 缺省 git2svn
  gitUrl: 'https://github.com/user/demo.git',
  gitBranch: 'main',
  svnUrl: 'svn://svn.example.com/trunk/demo',
  svnSubdir: 'dist',             // 可选
  message: 'sync from svn',
  onEvent: (event) => console.log(event.stage, event.message),
});

console.log(result.stats, result.sha, result.pushed);
```

也可以直接调用 `syncGitToSvn` / `syncSvnToGit`。这些函数不打印任何内容，进度通过 `onEvent` 上报；不传 `message` 时可传 `promptMessage` 在提交前取值。

## 本地开发

```bash
npm install
npm run build     # 产物 dist/index.js
npm test          # 构建 + 单元测试
npm run typecheck # tsc --noEmit
npm start         # 构建后运行 bin/cli.js
```

目录结构：

```
src/
├── cli.ts          命令行参数 / 交互流程（含方向选择）
├── index.ts        对外导出 + 主模块入口
├── types.ts        类型定义
├── core/
│   ├── config.ts   项目表解析、地址/方向校验
│   ├── exec.ts     外部命令执行（参数数组，无 shell）
│   ├── git.ts      Git 工作副本、状态统计、提交与推送
│   ├── svn.ts      SVN 检出 / 状态 / 提交
│   ├── sync.ts     双向同步编排
│   └── workspace.ts 工作目录与文件复制
└── ui/             日志与交互提示
```

## License

[MIT](LICENSE)
