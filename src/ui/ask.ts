import inquirer from 'inquirer';

export interface ChoiceItem<T> {
  name: string;
  value: T;
}

export interface SeparatorItem {
  type: 'separator';
  separator?: string;
}

export type Choice<T> = ChoiceItem<T> | SeparatorItem;

export const separator = (text = '────────────'): SeparatorItem => ({ type: 'separator', separator: text });

export async function askInput(options: {
  message: string;
  default?: string;
  validate?: (value: string) => true | string;
}): Promise<string> {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'value',
      message: options.message,
      default: options.default,
      validate: options.validate,
    },
  ]);
  return String(answers.value ?? '');
}

export async function askConfirm(options: { message: string; default?: boolean }): Promise<boolean> {
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'value',
      message: options.message,
      default: options.default ?? false,
    },
  ]);
  return Boolean(answers.value);
}

export async function askSelect<T>(options: { message: string; choices: Choice<T>[] }): Promise<T> {
  const answers = await inquirer.prompt([
    {
      type: 'select',
      name: 'value',
      message: options.message,
      choices: options.choices,
      loop: false,
    },
  ]);
  return answers.value as T;
}
