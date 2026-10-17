import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import type { Tokens } from 'marked';
import type { ProjectConfig, SyncDirection } from '../types';

/** 表头别名（归一化后比较，见 normalizeHeader） */
const COLUMN_ALIASES: Record<keyof ProjectConfig, string[]> = {
  name: ['项目名', '项目', 'name', 'project'],
  gitUrl: ['git仓库地址', 'git地址', 'git仓库', 'giturl', 'repository'],
  gitBranch: ['git分支', '分支', 'gitbranch', 'branch'],
  svnUrl: ['svn仓库地址', 'svn地址', 'svn仓库', 'svnurl'],
  svnSubdir: ['svn子目录', 'svn目录', '子目录', 'svnsubdir', 'subdir'],
  direction: ['方向', '同步方向', 'direction'],
};

function normalizeHeader(value: string): string {
  return value
    .replace(/[*_`~]/g, '')
    .replace(/[\s\u3000]/g, '')
    .toLowerCase();
}

function cleanCell(value: string): string {
  return value.replace(/[*_`]/g, '').trim();
}

function columnRole(header: string): keyof ProjectConfig | null {
  const normalized = normalizeHeader(header);
  for (const [role, aliases] of Object.entries(COLUMN_ALIASES) as [keyof ProjectConfig, string[]][]) {
    if (aliases.includes(normalized)) return role;
  }
  return null;
}

export function isValidGitUrl(value: string): boolean {
  const url = value.trim();
  // https://host/path、git://、ssh:// 以及 scp 风格 git@host:path
  return /^(https?|git|ssh):\/\/[^\s]+$/.test(url) || /^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(url);
}

export function isValidSvnUrl(value: string): boolean {
  const url = value.trim();
  return /^svn(\+ssh)?:\/\/[^\s]+$/.test(url) || /^https?:\/\/[^\s]+$/.test(url) || /^file:\/\/[^\s]+$/.test(url);
}

export function isValidBranch(value: string): boolean {
  const branch = value.trim();
  return /^[\w][\w./-]*$/.test(branch) && !branch.endsWith('/') && !branch.includes('..');
}

/** 归一化同步方向，支持 g2s / s2g / git->svn 等写法 */
export function parseDirection(value: string | undefined | null): SyncDirection | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '').replace(/=>/g, '->').replace(/→/g, '->');
  if (['git2svn', 'g2s', 'git->svn', 'git-svn'].includes(normalized)) return 'git2svn';
  if (['svn2git', 's2g', 'svn->git', 'svn-git'].includes(normalized)) return 'svn2git';
  return undefined;
}

/**
 * 解析 Markdown 中的项目表（表头需包含 项目名 / Git仓库地址 / Git分支 / SVN仓库地址）。
 * 表头大小写、空格、加粗符号都会忽略；列顺序任意。
 */
export function parseProjectTable(markdown: string): ProjectConfig[] {
  const projects: ProjectConfig[] = [];

  for (const token of marked.lexer(markdown)) {
    if (token.type !== 'table') continue;
    const table = token as Tokens.Table;
    const roles = table.header.map((cell) => columnRole(cleanCell(cell.text)));
    if (!roles.includes('name') || !roles.includes('gitUrl') || !roles.includes('gitBranch') || !roles.includes('svnUrl')) {
      continue;
    }

    for (const row of table.rows) {
      const record: Record<string, string> = {};
      roles.forEach((role, index) => {
        if (!role) return;
        const value = cleanCell(row[index]?.text ?? '');
        if (value) record[role] = value;
      });

      if (!record.name || !record.gitUrl || !record.gitBranch || !record.svnUrl) continue;
      projects.push({
        name: record.name,
        gitUrl: record.gitUrl,
        gitBranch: record.gitBranch,
        svnUrl: record.svnUrl,
        svnSubdir: record.svnSubdir,
        direction: parseDirection(record.direction),
      });
    }
  }

  return projects;
}

/** 读取配置来源（默认项目根目录的 README.md），文件不存在返回空列表 */
export function loadProjects(configPath: string): ProjectConfig[] {
  const absolute = path.resolve(configPath);
  if (!fs.existsSync(absolute)) return [];
  return parseProjectTable(fs.readFileSync(absolute, 'utf8'));
}

export function findProject(projects: ProjectConfig[], name: string): ProjectConfig | undefined {
  const target = name.trim().toLowerCase();
  return projects.find((project) => project.name.toLowerCase() === target);
}
