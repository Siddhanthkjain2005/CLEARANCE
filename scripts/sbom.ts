// Writes a CycloneDX 1.5 SBOM for the Tower to stdout, from package-lock.json
// when present (exact versions and hashes) or package.json otherwise.
// The Tower has no runtime dependencies; the SBOM lists the build toolchain
// that produced the console bundle, marked with scope "excluded".

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

interface LockPkg { version?: string; resolved?: string; integrity?: string; license?: string; dev?: boolean }

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = existsSync('package-lock.json') ? JSON.parse(readFileSync('package-lock.json', 'utf8')) : null;

function purl(name: string, version: string) {
  const [scope, base] = name.startsWith('@') ? name.split('/') : [null, name];
  return scope ? `pkg:npm/${encodeURIComponent(scope)}/${base}@${version}` : `pkg:npm/${base}@${version}`;
}

function hashes(integrity?: string) {
  if (!integrity) return undefined;
  return integrity.split(' ').map((i) => {
    const [alg, b64] = i.split('-');
    const map: Record<string, string> = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' };
    return { alg: map[alg] ?? alg.toUpperCase(), content: Buffer.from(b64, 'base64').toString('hex') };
  });
}

const components: Record<string, unknown>[] = [];
if (lock?.packages) {
  for (const [path, p] of Object.entries(lock.packages as Record<string, LockPkg>)) {
    if (!path || !p.version) continue;
    const name = path.split('node_modules/').pop()!;
    components.push({
      type: 'library',
      'bom-ref': purl(name, p.version),
      name,
      version: p.version,
      purl: purl(name, p.version),
      scope: p.dev ? 'excluded' : 'required',
      ...(p.license ? { licenses: [{ license: { id: p.license } }] } : {}),
      ...(hashes(p.integrity) ? { hashes: hashes(p.integrity) } : {}),
      ...(p.resolved ? { externalReferences: [{ type: 'distribution', url: p.resolved }] } : {}),
    });
  }
} else {
  for (const [deps, scope] of [[pkg.dependencies ?? {}, 'required'], [pkg.devDependencies ?? {}, 'excluded']] as const) {
    for (const [name, range] of Object.entries(deps as Record<string, string>)) {
      const version = String(range).replace(/^[\^~>=<\s]+/, '');
      components.push({ type: 'library', 'bom-ref': purl(name, version), name, version, purl: purl(name, version), scope });
    }
  }
}

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'clearance-sbom', version: pkg.version }] },
    component: {
      type: 'application',
      'bom-ref': `pkg:generic/clearance@${pkg.version}`,
      name: 'clearance',
      version: process.env.CI_COMMIT_SHORT_SHA ?? pkg.version,
      licenses: [{ license: { id: 'MIT' } }],
    },
    properties: [{ name: 'clearance:runtime-dependencies', value: String(Object.keys(pkg.dependencies ?? {}).length) }],
  },
  components,
};

process.stdout.write(JSON.stringify(bom, null, 2) + '\n');
