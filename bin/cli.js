#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import cfonts from 'cfonts';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'dist', 'index.js');

if (!fs.existsSync(entry)) {
  console.error('未找到构建产物 dist/index.js，请先在包目录执行 `npm run build`。');
  process.exit(1);
}

cfonts.say('Git To Svn', {
  font: 'simple',
  colors: ['#00C2A8'],
  space: false,
});

// Windows 下动态 import 必须使用 file:// URL
const { run } = await import(pathToFileURL(entry).href);

try {
  await run(process.argv.slice(2));
} catch (error) {
  const name = error?.name;
  if (name === 'ExitPromptError' || name === 'AbortPromptError') {
    console.log('\n已取消操作');
    process.exit(0);
  }
  console.error(error?.hint ?? error?.message ?? String(error));
  process.exit(1);
}
