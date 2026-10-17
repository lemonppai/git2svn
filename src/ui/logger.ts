import chalk from 'chalk';
import logSymbols from 'log-symbols';

export const ACCENT = '#00C2A8';

export const logger = {
  info(message: string): void {
    console.log(message);
  },
  success(message: string): void {
    console.log(`${chalk.green(logSymbols.success)} ${message}`);
  },
  warn(message: string): void {
    console.log(`${chalk.yellow(logSymbols.warning)} ${message}`);
  },
  error(message: string): void {
    console.error(`${chalk.red(logSymbols.error)} ${message}`);
  },
  title: (message: string): string => chalk.bold.cyan(message),
  dim: (message: string): string => chalk.gray(message),
  accent: (message: string): string => chalk.hex(ACCENT)(message),
  bold: (message: string): string => chalk.bold(message),
};

/** 按显示宽度补空格（中文按 2 列计算），保证表格对齐 */
export function pad(text: string, width: number): string {
  let length = 0;
  for (const char of text) {
    length += /[\u3000-\u303f\u4e00-\u9fa5\uff00-\uffef]/.test(char) ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(0, width - length));
}
