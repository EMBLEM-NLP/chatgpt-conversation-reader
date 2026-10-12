#!/usr/bin/env node
// Builds the release tarball and a SHA-256 manifest next to it (SPEC NFR-02: "independently verifiable SHA-256 release
// artifacts"), or verifies a manifest.
//
//   npm run release:checksums                       build, `npm pack`, write <out>/SHA256SUMS      (default <out> = ./release)
//   node scripts/release-checksums.mjs [--out <dir>]    same, without building (needs dist/ from `npm run build`)
//   node scripts/release-checksums.mjs --verify <dir>   re-hash every file named in <dir>/SHA256SUMS; exit 1 on any difference
//   node scripts/release-checksums.mjs --root <dir>     pack another package directory (the tests use a tiny fake one)
//   node scripts/release-checksums.mjs --twice          pack twice into temp directories and exit 1 unless both hashes agree
//                                                       (the reproducibility check CI runs: `npm pack` sets fixed file times)
//
// SHA256SUMS uses the format of `sha256sum` (`<64 hex>  <file name>`), so anyone can check an artifact WITHOUT this
// script: `cd release && sha256sum -c SHA256SUMS`. The manifest names the artifacts by base name only; there are no paths,
// no timestamps and no host details in it.
//
// What this does and does not give you: the tarball holds dist/, docs/, README.md and CHANGELOG.md. Because `npm pack`
// writes entries in sorted order with fixed times, the same commit built with the same toolchain (the pinned TypeScript and
// Node) gives the same bytes; a different compiler version may not. NOTHING here signs the artifact or publishes it:
// the checksum proves integrity of a copy against the manifest, not who made the manifest. Distribute SHA256SUMS over a
// channel separate from the tarball (or sign it) if that distinction matters to you.
//
// Build the artifact from a FRESH CLONE: `npm pack` records the permission bits of the files on disk, and git tracks only the
// executable bit. Two checkouts of one commit therefore have the same tarball hash only if their files have the same modes (found
// on 2026-10-12: docs/REPO_RUNBOOK.md was 0600 in a long-lived working tree and 0644 in a fresh clone, so the two hashes differed
// although `diff -r` of the extracted trees was empty). `--twice` packs the SAME tree twice and so cannot see this.
// Nothing here touches the network: `npm pack --ignore-scripts` reads local files only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { root: repoRoot, out: null, verify: null, twice: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--twice') opts.twice = true;
    else if (arg === '--out' || arg === '--verify' || arg === '--root') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) fail(2, `${arg} needs a directory`);
      opts[arg.slice(2)] = resolve(process.cwd(), value);
    } else fail(2, `unknown argument: ${arg}`);
  }
  opts.out ??= join(opts.root, 'release');
  return opts;
}

function fail(code, message) {
  process.stderr.write(`release-checksums: ${message}\n`);
  process.exit(code);
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** `npm pack` into `dir`; returns the tarball path. */
function pack(root, dir) {
  if (!existsSync(join(root, 'dist', 'cli', 'main.js'))) fail(2, 'dist/ is missing: run `npm run build` first');
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dir, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', npm_config_loglevel: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
  if (r.error !== undefined) fail(1, `could not run npm: ${r.error.message}`);
  if (r.status !== 0) fail(1, `npm pack failed (exit ${String(r.status)}): ${r.stderr.trim()}`);
  let filename;
  try {
    filename = JSON.parse(r.stdout)[0].filename;
  } catch {
    fail(1, 'npm pack printed no usable --json output');
  }
  if (typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.tgz')) fail(1, 'npm pack reported an unexpected file name');
  return join(dir, filename);
}

function verify(dir) {
  const manifest = join(dir, 'SHA256SUMS');
  if (!existsSync(manifest)) fail(1, `${manifest} does not exist`);
  const lines = readFileSync(manifest, 'utf8').split('\n').filter((l) => l !== '');
  if (lines.length === 0) fail(1, 'SHA256SUMS is empty');
  let bad = 0;
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) {2}([^/\\\0]+)$/.exec(line);
    if (m === null) fail(1, 'SHA256SUMS has a line that is not "<64 hex>  <file name>"');
    const [, want, name] = m;
    const file = join(dir, name);
    if (!existsSync(file)) {
      process.stdout.write(`${name}: MISSING\n`);
      bad++;
    } else if (sha256(file) !== want) {
      process.stdout.write(`${name}: FAILED\n`);
      bad++;
    } else process.stdout.write(`${name}: OK\n`);
  }
  if (bad > 0) fail(1, `${bad} file(s) do not match SHA256SUMS`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.verify !== null) {
    verify(opts.verify);
    return;
  }
  if (opts.twice) {
    const a = mkdtempSync(join(tmpdir(), 'gcr-release-a-'));
    const b = mkdtempSync(join(tmpdir(), 'gcr-release-b-'));
    try {
      const ha = sha256(pack(opts.root, a));
      const hb = sha256(pack(opts.root, b));
      if (ha !== hb) fail(1, `two packs of the same tree differ: ${ha} != ${hb}`);
      process.stdout.write(`release-checksums: two packs agree (${ha})\n`);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
    return;
  }
  const tarball = pack(opts.root, opts.out);
  const line = `${sha256(tarball)}  ${basename(tarball)}\n`;
  writeFileSync(join(opts.out, 'SHA256SUMS'), line);
  process.stdout.write(`release-checksums: wrote ${basename(tarball)} and SHA256SUMS\n${line}`);
}

main();
