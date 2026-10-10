#!/usr/bin/env node
// Thin launcher for the privacy scanner. All logic lives in src/devtools/privacy-scan.ts (compiled to dist/ by
// `npm run build`); this file only owns process I/O so the library stays free of console/process output.
// Exit status: 0 clean, 1 findings, 2 usage or internal error.
let scanner;
try {
  scanner = await import('../dist/devtools/privacy-scan.js');
} catch {
  // The underlying error is not printed: module-resolution messages embed absolute paths.
  process.stderr.write('privacy-scan: cannot load dist/devtools/privacy-scan.js; run `npm run build` first.\n');
  process.exitCode = 2;
}

if (scanner !== undefined) {
  try {
    const result = await scanner.main(process.argv.slice(2));
    if (result.stdout !== '') process.stdout.write(result.stdout);
    if (result.stderr !== '') process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('privacy-scan: unexpected internal error\n');
    process.exitCode = 2;
  }
}
