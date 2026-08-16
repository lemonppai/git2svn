#!/usr/bin/env node

import chalk from 'chalk';
import cfonts from 'cfonts';
import { run } from '../dist/index.js';

cfonts.say('Git To Svn', {
  font: 'simple',
  // colors: ['#409EFF']
});

run();
