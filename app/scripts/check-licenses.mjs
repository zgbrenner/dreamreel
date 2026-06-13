// Dependency license gate — the automated backstop for the commercial license policy.
// FAILS on any AGPL/GPL/LGPL-copyleft or "source-available" (SSPL/BUSL/Elastic/Commons
// Clause/Remotion) license in the *production* dependency tree, and on anything outside the
// ship-safe allowlist (MIT/BSD/Apache/Zlib/ISC/CC0/Unlicense/CC-BY/0BSD/Python-2.0).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const checker = require('license-checker-rseidelsohn');

const ALLOW = [
  /^MIT/i,
  /^MIT-0/i,
  /^ISC/i,
  /^0BSD/i,
  /^BSD(-2-Clause|-3-Clause|-4-Clause)?/i,
  /^Apache-?2/i,
  /^Zlib/i,
  /^CC0-1\.0/i,
  /^CC-BY-/i,
  /^Unlicense/i,
  /^Python-2\.0/i,
  /^OFL-1\.1/i, // SIL Open Font License — embedding fonts in a product is permitted
  /^BlueOak-1\.0\.0/i,
  /^WTFPL/i,
  /^Apache\*/i,
];

const FORBIDDEN = [
  /AGPL/i,
  /(^|[^L])GPL/i, // GPL but not as substring of e.g. "nonGPL"; LGPL caught below
  /\bGPL-\d/i,
  /LGPL/i,
  /SSPL/i,
  /BUSL/i,
  /Business Source/i,
  /Elastic-2/i,
  /Commons-Clause/i,
  /Remotion/i,
  /source-available/i,
];

function isForbidden(license) {
  return FORBIDDEN.some((re) => re.test(license));
}
function isAllowed(license) {
  // license can be "(MIT OR Apache-2.0)" — allow if every alternative is allowed.
  const parts = license
    .replace(/[()]/g, '')
    .split(/\s+OR\s+|\s+AND\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => ALLOW.some((re) => re.test(p)));
}

const packages = await new Promise((resolve, reject) => {
  checker.init({ start: process.cwd(), production: true, excludePrivatePackages: true }, (err, pkgs) =>
    err ? reject(err) : resolve(pkgs),
  );
});

const forbidden = [];
const unknown = [];
for (const [name, info] of Object.entries(packages)) {
  const license = String(info.licenses ?? 'UNKNOWN');
  if (isForbidden(license)) forbidden.push(`${name}: ${license}`);
  else if (!isAllowed(license)) unknown.push(`${name}: ${license}`);
}

if (forbidden.length) {
  console.error('\n✖ FORBIDDEN (copyleft / source-available) licenses in production deps:');
  for (const f of forbidden) console.error('  - ' + f);
}
if (unknown.length) {
  console.error('\n✖ Licenses outside the ship-safe allowlist (review or extend allowlist):');
  for (const u of unknown) console.error('  - ' + u);
}

if (forbidden.length || unknown.length) {
  console.error(`\nLicense check FAILED: ${forbidden.length} forbidden, ${unknown.length} unknown.`);
  process.exit(1);
}
console.log(`✓ License check passed: ${Object.keys(packages).length} production packages, all ship-safe.`);
