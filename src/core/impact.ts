// Test impact analysis from the static import graph.
//
// For a lean pipeline we only run tests that can observe the change: tests
// that import a changed module directly or transitively, plus tests that were
// themselves edited. Anything we can't place in the graph (config files,
// unknown extensions) widens the selection to the full suite, so the shortcut
// never silently skips a test that matters.

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function normalize(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function resolveImport(from: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null; // packages and node: builtins are outside the graph
  const base = normalize(`${dirname(from)}/${spec}`);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((c) => known.has(c)) ?? null;
}

export function buildImportGraph(files: Record<string, string>): Map<string, Set<string>> {
  const known = new Set(Object.keys(files).map(normalize));
  const graph = new Map<string, Set<string>>();
  for (const [path, src] of Object.entries(files)) {
    const deps = new Set<string>();
    for (const m of src.matchAll(IMPORT_RE)) {
      const target = resolveImport(normalize(path), m[1] ?? m[2], known);
      if (target) deps.add(target);
    }
    graph.set(normalize(path), deps);
  }
  return graph;
}

export interface ImpactResult {
  mode: 'impacted' | 'all' | 'none';
  tests: string[];
  reason: string;
}

export function impactedTests(
  graph: Map<string, Set<string>>,
  changed: string[],
  isTest: (p: string) => boolean,
): ImpactResult {
  const changedNorm = changed.map(normalize);
  const code = changedNorm.filter((p) => /\.(ts|tsx|js|mjs)$/.test(p));
  const unknown = code.filter((p) => !graph.has(p));
  const config = changedNorm.filter((p) => /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json)$/.test(p));
  if (config.length > 0) return { mode: 'all', tests: [], reason: `Build configuration changed (${config.join(', ')})` };
  if (unknown.length > 0) return { mode: 'all', tests: [], reason: `Could not place ${unknown.join(', ')} in the import graph` };

  // Reverse edges: module -> modules that import it.
  const reverse = new Map<string, Set<string>>();
  for (const [from, deps] of graph) {
    for (const d of deps) {
      const s = reverse.get(d) ?? new Set();
      s.add(from);
      reverse.set(d, s);
    }
  }
  const seen = new Set<string>(code);
  const queue = [...code];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const parent of reverse.get(cur) ?? []) {
      if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
    }
  }
  const tests = [...seen].filter(isTest).sort();
  if (tests.length === 0) return { mode: 'none', tests: [], reason: 'No test observes the changed modules' };
  return { mode: 'impacted', tests, reason: `${tests.length} test file${tests.length === 1 ? '' : 's'} reach the changed modules` };
}
