import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml, YamlError } from '../src/core/yaml.ts';

test('parses nested maps, sequences and scalars', () => {
  const doc = parseYaml(`
# comment
version: 1
autonomy:
  autonomous:
    max_risk: 0.35   # inline comment
    min_trust: .55
  names: [a, "b c", 'd''e']
flags: { on: true, off: false, nothing: null }
sectors:
  - name: governance
    paths:
      - ".clearance/**"
      - CODEOWNERS
    protected: true
  - name: docs
    paths: ["docs/**", "*.md"]
list:
- 1
- two
url: https://example.com/a#b
`);
  assert.deepEqual(doc, {
    version: 1,
    autonomy: { autonomous: { max_risk: 0.35, min_trust: 0.55 }, names: ['a', 'b c', "d'e"] },
    flags: { on: true, off: false, nothing: null },
    sectors: [
      { name: 'governance', paths: ['.clearance/**', 'CODEOWNERS'], protected: true },
      { name: 'docs', paths: ['docs/**', '*.md'] },
    ],
    list: [1, 'two'],
    url: 'https://example.com/a#b',
  });
});

test('parses block scalars', () => {
  const doc = parseYaml(`script: |\n  echo one\n  echo two\nnext: x\n`) as Record<string, unknown>;
  assert.equal(doc.script, 'echo one\necho two\n');
  assert.equal(doc.next, 'x');
});

test('rejects anchors and duplicate keys with line numbers', () => {
  assert.throws(() => parseYaml('a: &x 1\nb: *x\n'), YamlError);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /line 2/);
});

test('stringify round-trips', () => {
  const value = {
    stages: ['verify'],
    'test:unit': { stage: 'verify', script: ['node --test test/', 'echo "done: yes"'], artifacts: { reports: { junit: 'junit.xml' } } },
    empty: [],
    flag: true,
    text: 'true',
    multi: 'line one\nline two\n',
  };
  assert.deepEqual(parseYaml(stringifyYaml(value)), value);
});
