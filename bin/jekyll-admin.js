#!/usr/bin/env node
const path = require('path');
process.env.JEKYLL_SITE = process.argv[2] || process.cwd();
require(path.join(__dirname, '..', 'server.js'));
