// mend: deterministic, transactional text edits (SPEC.md). Node 22 standard library only.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Context records retain their original position in O so matching never rewrites context whitespace.
type Body = { kind: string; text: string; noBreak?: boolean }[];
type Chunk = { body: Body; a?: number; anchor?: string; eof?: boolean };
function parseError(n: number): never { throw new Exit2(`error: parse ${n}`); }
function fileLines(text: string) {
  const i = text.indexOf('\n');
  const br = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function serialize(f: { lines: string[]; br: string; final: boolean }): string {
  return f.lines.length ? f.lines.join(f.br) + (f.final ? f.br : '') : '';
}
function normalize(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
}
// Restrict the search domain before choosing a tier (especially V4A cursors and EOF anchors).
function matches(lines: string[], old: string[], strict: boolean, from = 0, eof = false): { positions: number[]; tier: number } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const positions: number[] = [];
    for (let i = from; i + old.length <= lines.length; i++) {
      if (eof && i + old.length !== lines.length) continue;
      if (old.every((s, j) => normalize(s, tier) === normalize(lines[i + j], tier))) positions.push(i);
    }
    if (positions.length) return { positions, tier };
  }
  return { positions: [], tier: 0 };
}
function replacement(body: Body, lines: string[], at: number, tier: number): string[] {
  const old = body.filter(b => b.kind !== '+');
  const p = old[0]?.text.match(/^[ \t]*/)?.[0] ?? '';
  const f = lines[at]?.match(/^[ \t]*/)?.[0] ?? '';
  let offset = 0;
  const result: string[] = [];
  for (const b of body) {
    if (b.kind === ' ') result.push(lines[at + offset]);
    if (b.kind !== '+') offset++;
    if (b.kind === '+') result.push(tier === 2 && /[^\s]/.test(b.text) && b.text.startsWith(p) ? f + b.text.slice(p.length) : b.text);
  }
  return result;
}
function pathsSafe(...paths: string[]) { for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p); }
function requireFile(tree: Tree, p: string): string { const t = tree.get(p); if (t === null) throw new Fail('missing', p); return t; }
function requireAbsent(tree: Tree, p: string) { if (tree.get(p) !== null) throw new Fail('exists', p); }
// Sections are evaluated locally; only a completely successful section enters the staged tree.
function applyChunks(text: string, chunks: Chunk[], p: string, strict: boolean, unified: boolean): string {
  const f = fileLines(text);
  let cursor = 0, delta = 0;
  for (const c of chunks) {
    if (!unified && c.anchor) {
      const m = matches(f.lines, [c.anchor], strict, cursor);
      if (!m.positions.length) throw new Fail('no-match', p);
      cursor = m.positions[0] + 1;
    }
    const old = c.body.filter(b => b.kind !== '+').map(b => b.text);
    let at: number, tier = 0;
    if (old.length) {
      const m = matches(f.lines, old, strict, unified ? 0 : cursor, !unified && c.eof);
      if (!m.positions.length) throw new Fail('no-match', p);
      tier = m.tier;
      at = m.positions[0];
      if (unified) for (const i of m.positions) if (Math.abs(i - (c.a! - 1 + delta)) < Math.abs(at - (c.a! - 1 + delta))) at = i;
    } else at = unified ? Math.max(0, Math.min(f.lines.length, c.a! + delta)) : c.eof ? f.lines.length : cursor;
    const added = replacement(c.body, f.lines, at, tier);
    if (unified && at + old.length === f.lines.length) {
      const last = c.body.filter(b => b.kind !== '-').at(-1);
      f.final = !last?.noBreak;
    }
    f.lines.splice(at, old.length, ...added);
    delta += added.length - old.length;
    cursor = at + added.length;
  }
  return serialize(f);
}
function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previous = '', boundary = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') continue;
    const start = i;
    let p = previous;
    for (let j = i - 1; j >= boundary; j--) if (!blank(lines[j]) && !lines[j].trim().startsWith('```')) { p = lines[j].trim(); break; }
    if (!p) parseError(start + 1);
    const old: string[] = [], added: string[] = [];
    i++;
    while (i < lines.length && lines[i].trimEnd() !== '=======') old.push(lines[i++]);
    if (i === lines.length) parseError(start + 1);
    i++;
    while (i < lines.length && lines[i].trimEnd() !== '>>>>>>> REPLACE') added.push(lines[i++]);
    if (i === lines.length) parseError(start + 1);
    previous = p; boundary = i + 1;
    edits.push(tree => {
      pathsSafe(p);
      if (!old.length) { requireAbsent(tree, p); tree.now.set(p, serialize({lines: added, br: '\n', final: true})); return; }
      const f = fileLines(requireFile(tree, p));
      const m = matches(f.lines, old, strict);
      if (!m.positions.length) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const body: Body = [...old.map(text => ({kind: '-', text})), ...added.map(text => ({kind: '+', text}))];
      f.lines.splice(m.positions[0], old.length, ...replacement(body, f.lines, m.positions[0], m.tier));
      tree.now.set(p, serialize(f));
    });
  }
  return edits;
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex(l => !blank(l));
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') parseError(first < 0 ? 1 : first + 1);
  let end = lines.length - 1;
  while (end >= 0 && blank(lines[end])) end--;
  if (lines[end].trim() !== '*** End Patch') parseError(lines.length + 1);
  const edits: Edit[] = [];
  const section = (s: string) => /^\*\*\* (Add|Delete|Update) File: /.exec(s);
  for (let i = first + 1; i < end;) {
    if (blank(lines[i])) { i++; continue; }
    const header = section(lines[i]);
    if (!header) parseError(i + 1);
    const start = i, kind = header[1], p = lines[i].slice(header[0].length).trim();
    let stop = ++i;
    while (stop < end && !section(lines[stop])) stop++;
    let bodyEnd = stop;
    while (bodyEnd > i && blank(lines[bodyEnd - 1])) bodyEnd--;
    let dest: string | undefined;
    const added: string[] = [], chunks: Chunk[] = [];
    if (kind === 'Add') {
      for (; i < bodyEnd; i++) {
        if (lines[i] !== '' && !lines[i].startsWith('+')) parseError(i + 1);
        added.push(lines[i] === '' ? '' : lines[i].slice(1));
      }
    } else if (kind === 'Delete') {
      if (i < bodyEnd) parseError(i + 1);
    } else {
      if (i < bodyEnd && lines[i].startsWith('*** Move to: ')) dest = lines[i++].slice(13).trim();
      let chunk: Chunk | undefined;
      for (; i < bodyEnd; i++) {
        const l = lines[i];
        if (l.startsWith('@@')) { chunk = { body: [], anchor: l.slice(2).trim() }; chunks.push(chunk); }
        else if (l === '*** End of File') {
          if (!chunk) parseError(i + 1);
          chunk.eof = true; chunk = undefined;
        } else if (l === '' || /^[ +\-]/.test(l)) {
          if (!chunk) {
            if (chunks.length) parseError(i + 1);
            chunk = { body: [] }; chunks.push(chunk);
          }
          chunk.body.push({ kind: l === '' ? ' ' : l[0], text: l.slice(1) });
        } else parseError(i + 1);
      }
      if (!chunks.length && dest === undefined) parseError(start + 1);
    }
    edits.push(tree => {
      pathsSafe(p, ...(dest === undefined ? [] : [dest]));
      if (kind === 'Add') { requireAbsent(tree, p); tree.now.set(p, serialize({lines: added, br: '\n', final: true})); }
      else {
        const text = requireFile(tree, p);
        if (kind === 'Delete') tree.now.set(p, null);
        else {
          if (dest !== undefined) requireAbsent(tree, dest);
          const out = applyChunks(text, chunks, p, strict, false);
          tree.now.set(dest ?? p, out);
          if (dest !== undefined) { tree.now.set(p, null); tree.moves.push([p, dest]); }
        }
      }
    });
    i = stop;
  }
  return edits;
}
// Parse every section before evaluating any edit, preserving parse-error precedence.
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  type Section = { old: string; next: string; create: boolean; remove: boolean; pair: boolean; chunks: Chunk[] };
  const sections: Section[] = [];
  let s: Section | undefined;
  const pairAt = (i: number) => lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
  const path = (l: string) => { const p = l.slice(4).split('\t')[0].trim(); return p === '/dev/null' ? p : p.replace(/^[ab]\//, ''); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) parseError(i + 1);
      s = {old: m[1], next: m[2], create: false, remove: false, pair: false, chunks: []}; sections.push(s);
    } else if (pairAt(i)) {
      if (!s || s.pair || s.chunks.length) { s = {old: '', next: '', create: false, remove: false, pair: false, chunks: []}; sections.push(s); }
      s.old = path(l); s.next = path(lines[++i]); s.pair = true;
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(l);
      if (!m || !s) parseError(i + 1);
      const c: Chunk = {body: [], a: Number(m[1])}; s.chunks.push(c);
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('diff --git ') && !pairAt(j) && (lines[j] === '' || /^[ +\-\\]/.test(lines[j]))) j++;
      let bodyEnd = j;
      while (bodyEnd > i + 1 && lines[bodyEnd - 1] === '') bodyEnd--;
      for (let k = i + 1; k < bodyEnd; k++) {
        const b = lines[k];
        if (b.startsWith('\\')) { if (c.body.length) c.body[c.body.length - 1].noBreak = true; }
        else c.body.push({kind: b === '' ? ' ' : b[0], text: b.slice(1)});
      }
      i = j - 1;
    } else if (s && !s.chunks.length) {
      if (l.startsWith('--- ')) parseError(i + 2);
      if (!s.pair && l.startsWith('rename from ')) s.old = l.slice(12);
      if (!s.pair && l.startsWith('rename to ')) s.next = l.slice(10);
      if (l.startsWith('new file mode')) s.create = true;
      if (l.startsWith('deleted file mode')) s.remove = true;
    }
  }
  return sections.map(s => tree => {
    const create = s.create || s.old === '/dev/null', remove = s.remove || s.next === '/dev/null';
    pathsSafe(...[s.old, s.next].filter(p => p !== '/dev/null'));
    if (create) {
      requireAbsent(tree, s.next);
      const added = s.chunks.flatMap(c => c.body.filter(b => b.kind === '+'));
      tree.now.set(s.next, serialize({lines: added.map(b => b.text), br: '\n', final: !added.at(-1)?.noBreak}));
    } else {
      const text = requireFile(tree, s.old);
      if (remove) tree.now.set(s.old, null);
      else {
        if (s.old !== s.next) requireAbsent(tree, s.next);
        const out = applyChunks(text, s.chunks, s.old, strict, true);
        tree.now.set(s.next, out);
        if (s.old !== s.next) { tree.now.set(s.old, null); tree.moves.push([s.old, s.next]); }
      }
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : searchEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A rename is one output row, conditional on the original and final tree states.
  const changed = [...tree.now.keys()].filter(p => tree.original(p) !== tree.now.get(p));
  const rowsByPath = new Map(changed.map(p => [p, `${tree.original(p) === null ? 'A' : tree.now.get(p) === null ? 'D' : 'M'} ${p}`]));
  for (const [old, next] of tree.moves) {
    if (rowsByPath.get(old) === `D ${old}` && rowsByPath.get(next) === `A ${next}`) {
      rowsByPath.delete(old); rowsByPath.set(next, `R ${old} -> ${next}`);
    }
  }
  const rows = [...rowsByPath].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([, row]) => row);
  if (!check) {
    for (const p of changed) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
