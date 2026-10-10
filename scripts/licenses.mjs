#!/usr/bin/env node
// Thin launcher for `npm run licenses` (ADR-0008). All logic lives in src/devtools/licenses.ts, compiled to
// dist/devtools/licenses.js by `npm run build`, so it is unit-tested; this file only wires arguments and exit codes.
//
//   node scripts/licenses.mjs [--json] [--root <dir>]
//
// Exit codes: 0 = no runtime package with an unknown or non-permissive license (dev-only packages are listed but
// never fail the run), 1 = at least one such runtime package, 2 = the tool could not run (bad arguments, no
// lockfile, no node_modules, project not built). The tool makes no network requests: it reads local files only.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node scripts/licenses.mjs [--json] [--root <dir>]\n';
const here = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  process.stderr.write(`licenses: ${message}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = { json: false, root: resolve(here, '..') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--root') {
      const value = argv[++i];
      if (value === undefined || value === '') return { error: '--root needs a directory' };
      options.root = resolve(process.cwd(), value);
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      return { error: `unknown argument ${JSON.stringify(arg)}` };
    }
  }
  return { options };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  process.stdout.write(USAGE);
} else if (parsed.error !== undefined) {
  fail(`${parsed.error}\n${USAGE.trimEnd()}`);
} else {
  let tool;
  try {
    tool = await import(new URL('../dist/devtools/licenses.js', import.meta.url).href);
  } catch (error) {
    // ERR_MODULE_NOT_FOUND is the expected case (not built yet); anything else is reported as-is.
    fail(
      error?.code === 'ERR_MODULE_NOT_FOUND'
        ? 'dist/devtools/licenses.js is missing. Run `npm run build` first.'
        : `could not load dist/devtools/licenses.js: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (tool !== undefined) {
    try {
      const result = await tool.collectLicenses(parsed.options.root);
      const blocking = tool.blockingPackages(result).map((p) => `${p.name}@${p.version}`);
      if (parsed.options.json) {
        process.stdout.write(`${JSON.stringify({ ...result, blocking }, null, 2)}\n`);
      } else {
        process.stdout.write(tool.formatLicenseReport(result));
      }
      if (blocking.length > 0) {
        process.stderr.write(`licenses: ${blocking.length} runtime package(s) with an unknown or non-permissive license: ${blocking.join(', ')}\n`);
        process.exitCode = 1;
      }
    } catch (error) {
      const remedy = typeof error?.remedy === 'string' ? ` ${error.remedy}` : '';
      fail(`${error instanceof Error ? error.message : String(error)}${remedy}`);
    }
  }
}
