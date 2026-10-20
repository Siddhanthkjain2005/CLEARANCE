// Path globbing with the semantics people expect from CODEOWNERS files:
//   *        any characters except "/"
//   **       any characters including "/" (zero or more directories)
//   ?        one character except "/"
//   {a,b}    alternatives
// A pattern without "/" matches the file name at any depth ("*.md").

const cache = new Map<string, RegExp>();

function escapeRe(c: string): string {
  return /[.+^$()|[\]\\]/.test(c) ? '\\' + c : c;
}

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let p = pattern.trim();
  if (p.startsWith('/')) p = p.slice(1);
  const anyDepth = !p.includes('/');
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const slashAfter = p[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      const alts = p.slice(i + 1, end).split(',').map((a) => a.split('').map(escapeRe).join(''));
      re += `(?:${alts.join('|')})`;
      i = end;
    } else re += escapeRe(c);
  }
  const full = new RegExp(anyDepth ? `^(?:.*/)?${re}$` : `^${re}$`);
  cache.set(pattern, full);
  return full;
}

export function matchGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path.replace(/^\.\//, ''));
}

export function matchAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(path, p));
}
