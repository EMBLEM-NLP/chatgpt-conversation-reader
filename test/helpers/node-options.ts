/**
 * NODE_OPTIONS values for tests that preload a script into a child process.
 *
 * NODE_OPTIONS is split on whitespace like a command line, so `--require /tmp/some dir/preload.cjs` is read as a module named
 * `/tmp/some` plus a stray argument. A test that builds the option from a path it does not control (a temp directory under a
 * TMPDIR with a space, a checkout in "My Projects/gcr", a non-ASCII user name) must quote the value: Node accepts double quotes
 * with a backslash escape for `"` and `\` inside them. Paths without any special character are left as they are.
 */
export function quoteNodeOptionValue(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/["\\]/g, '\\$&')}"` : value;
}

/** `--require=<file>` for NODE_OPTIONS, quoted when the path needs it. */
export function requireOption(file: string): string {
  return `--require=${quoteNodeOptionValue(file)}`;
}
