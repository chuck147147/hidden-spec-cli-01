// mend: apply an AI-written edit (unified diff, SEARCH/REPLACE, V4A, or JSON)
// to a tree of text files, all-or-nothing. Node 22, standard library only.
//
// When MAKEFUN_ENV_URL is set the process hands the trial to runner.ts;
// otherwise it runs as the CLI described in SPEC.md.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- utilities

class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

interface Failure {
  code: string;
  path: string;
}

/** The patch's lines: split at \n, one trailing \r removed from each, and no
 *  empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** Byte order (UTF-8) comparison for output sorting. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ------------------------------------------------------------- file model

interface FileModel {
  lines: string[];
  brk: string; // '\n' or '\r\n'
  end: boolean; // ends with a line break
}

function parseModel(text: string): FileModel {
  if (text === '') return { lines: [], brk: '\n', end: false };
  const firstLf = text.indexOf('\n');
  const brk = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  const end = text.endsWith(brk);
  if (end) parts.pop();
  return { lines: parts, brk, end };
}

function serializeModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.brk) + (m.end ? m.brk : '');
}

// ------------------------------------------------------- virtual file tree

class Tree {
  private virt = new Map<string, string | null>();
  private orig = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  private load(p: string): void {
    if (this.virt.has(p)) return;
    let content: string | null;
    try {
      content = readFileSync(p, 'utf8');
    } catch {
      content = null;
    }
    this.virt.set(p, content);
    this.orig.set(p, content);
  }

  exists(p: string): boolean {
    this.load(p);
    return this.virt.get(p) !== null;
  }

  read(p: string): string {
    this.load(p);
    return this.virt.get(p) as string;
  }

  write(p: string, content: string | null): void {
    this.load(p);
    this.virt.set(p, content);
  }

  /** Paths whose bytes differ between the start and now, with their kind. */
  changes(): Array<{ kind: 'A' | 'D' | 'M'; path: string; oldPath?: string }> {
    const out: Array<{ kind: 'A' | 'D' | 'M'; path: string; oldPath?: string }> = [];
    const byPath = new Map<string, { kind: 'A' | 'D' | 'M'; path: string }>();
    for (const p of this.virt.keys()) {
      const before = this.orig.get(p) ?? null;
      const after = this.virt.get(p) ?? null;
      if (before === after) continue;
      const kind = before === null ? 'A' : after === null ? 'D' : 'M';
      const entry = { kind: kind as 'A' | 'D' | 'M', path: p };
      byPath.set(p, entry);
      out.push(entry);
    }
    // A successful move whose old path vanished and new path appeared is
    // reported as one R line instead of the D/A pair.
    for (const [oldP, newP] of this.moves) {
      const d = byPath.get(oldP);
      const a = byPath.get(newP);
      if (d !== undefined && d.kind === 'D' && a !== undefined && a.kind === 'A') {
        byPath.delete(oldP);
        byPath.delete(newP);
        out.splice(out.indexOf(d), 1);
        out.splice(out.indexOf(a), 1);
        out.push({ kind: 'M', path: newP, oldPath: oldP });
      }
    }
    return out;
  }

  /** Write every change to disk. */
  flush(): void {
    for (const p of this.virt.keys()) {
      const before = this.orig.get(p) ?? null;
      const after = this.virt.get(p) ?? null;
      if (before === after) continue;
      if (after === null) {
        rmSync(p, { force: true });
      } else {
        const dir = dirname(p);
        if (dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(p, after);
      }
    }
  }
}

// ------------------------------------------------------------ line matching

const rstripST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingST = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineMatchesAtTier(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return rstripST(fileLine) === rstripST(patchLine);
  return trimST(fileLine) === trimST(patchLine);
}

interface TierHit {
  tier: number;
  positions: number[];
}

/** Occurrences of O in lines at the first tier that has any, at or after
 *  `from`, optionally filtered. Occurrences may overlap. */
function findTier(
  lines: string[],
  O: string[],
  strict: boolean,
  from = 0,
  filter?: (pos: number) => boolean,
): TierHit | null {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier += 1) {
    const positions: number[] = [];
    for (let i = from; i + O.length <= lines.length; i += 1) {
      if (filter !== undefined && !filter(i)) continue;
      let ok = true;
      for (let k = 0; k < O.length; k += 1) {
        if (!lineMatchesAtTier(lines[i + k], O[k], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line (oIdx >= 0, written as the file's own line)
 *  or a new line (oIdx === -1). */
interface NLine {
  text: string;
  oIdx: number;
  slash: boolean;
}

interface OLine {
  text: string;
  slash: boolean;
}

/** Build the replacement lines for a match of O at `pos`. */
function buildReplacement(fileLines: string[], pos: number, O: OLine[], nLines: NLine[], tier: number): string[] {
  const out: string[] = [];
  const P = O.length > 0 ? leadingST(O[0].text) : '';
  const F = leadingST(fileLines[pos] ?? '');
  for (const e of nLines) {
    if (e.oIdx >= 0) {
      out.push(fileLines[pos + e.oIdx]);
    } else if (tier === 2) {
      const line = e.text;
      if (line !== '' && trimST(line) !== '' && line.startsWith(P)) {
        out.push(F + line.slice(P.length));
      } else {
        out.push(line);
      }
    } else {
      out.push(e.text);
    }
  }
  return out;
}

// ------------------------------------------------------------ edit applying

interface EditOutcome {
  failure: Failure | null;
}

/** Check the paths an edit names, in order; returns the unsafe failure. */
function unsafeFailure(paths: string[]): Failure | null {
  for (const p of paths) {
    if (!isSafePath(p)) return { code: 'unsafe', path: p };
  }
  return null;
}

// ------------------------------------------------------------- unified diff

interface UHunk {
  a: number; // the A of @@ -A[,B] +C[,D] @@
  body: string[]; // raw body lines, trailing empty lines removed
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null | undefined; // undefined: no ---/+++ pair seen
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

function parseDiffGitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new ParseFault(lineNo);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new ParseFault(lineNo);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new ParseFault(lineNo);
  return [x, y];
}

function parseHeaderPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let hunk: UHunk | null = null;

  const closeHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const newSection = (): USection => {
    closeHunk();
    sec = {
      diffOld: null,
      diffNew: null,
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(sec);
    return sec;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNo = i + 1;

    if (hunk !== null) {
      // Inside a hunk body.
      if (line.startsWith('diff --git ')) {
        closeHunk();
        // fall through to section handling below
      } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        closeHunk();
        const s = newSection();
        s.pairOld = parseHeaderPath(line.slice(4));
        s.pairNew = parseHeaderPath(lines[i + 1].slice(4));
        i += 2;
        continue;
      } else if (line.startsWith('@@')) {
        closeHunk();
        // fall through to hunk handling below
      } else if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        hunk.body.push(line);
        i += 1;
        continue;
      } else {
        closeHunk();
        // fall through: the line is processed outside the body
      }
    }

    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGitPaths(line, lineNo);
      const s = newSection();
      s.diffOld = x;
      s.diffNew = y;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const inHeader = sec !== null && sec.hunks.length === 0 && hunk === null;
      const nextIsPlus = i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
      if (inHeader) {
        if (!nextIsPlus) throw new ParseFault(lineNo + 1);
        (sec as USection).pairOld = parseHeaderPath(line.slice(4));
        (sec as USection).pairNew = parseHeaderPath(lines[i + 1].slice(4));
        i += 2;
        continue;
      }
      if (nextIsPlus) {
        const s = newSection();
        s.pairOld = parseHeaderPath(line.slice(4));
        s.pairNew = parseHeaderPath(lines[i + 1].slice(4));
        i += 2;
        continue;
      }
      i += 1; // a stray --- line outside a header is ignored
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseFault(lineNo);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseFault(lineNo);
      hunk = { a: Number(m[1]), body: [] };
      i += 1;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // Section header lines, before the first hunk.
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
      // index, mode, similarity and any other lines are ignored.
    }
    i += 1;
  }
  closeHunk();
  return sections;
}

/** Split a hunk body into its O lines, N lines and slash flags. */
function hunkParts(body: string[]): { O: OLine[]; N: NLine[] } {
  const O: OLine[] = [];
  const N: NLine[] = [];
  let prev: { slash: boolean } | null = null;
  for (const raw of body) {
    if (raw.startsWith('\\')) {
      if (prev !== null) prev.slash = true;
      continue;
    }
    if (raw.startsWith('-')) {
      const e: OLine = { text: raw.slice(1), slash: false };
      O.push(e);
      prev = e;
    } else if (raw.startsWith('+')) {
      const e: NLine = { text: raw.slice(1), oIdx: -1, slash: false };
      N.push(e);
      prev = e;
    } else {
      // ' ' context, or an empty line (an empty context line)
      const text = raw.startsWith(' ') ? raw.slice(1) : '';
      const oe: OLine = { text, slash: false };
      O.push(oe);
      const ne: NLine = { text, oIdx: O.length - 1, slash: false };
      N.push(ne);
      prev = ne; // a \ line after a context line marks the N side
    }
  }
  return { O, N };
}

function applyUnifiedSection(tree: Tree, sec: USection, strict: boolean): EditOutcome {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const isCreate = sec.newFile || oldP === null;
  const isDelete = sec.deletedFile || newP === null;

  if (isCreate) {
    const target = (newP ?? oldP) as string;
    const bad = unsafeFailure([target]);
    if (bad !== null) return { failure: bad };
    if (tree.exists(target)) return { failure: { code: 'exists', path: target } };
    const lines: string[] = [];
    let lastAdd: NLine | null = null;
    for (const h of sec.hunks) {
      const { N } = hunkParts(h.body);
      for (const e of N) {
        if (e.oIdx < 0) {
          lines.push(e.text);
          lastAdd = e;
        }
      }
    }
    const model: FileModel = { lines, brk: '\n', end: lastAdd !== null && !lastAdd.slash };
    tree.write(target, serializeModel(model));
    return { failure: null };
  }

  if (isDelete) {
    const target = (oldP ?? newP) as string;
    const bad = unsafeFailure([target]);
    if (bad !== null) return { failure: bad };
    if (!tree.exists(target)) return { failure: { code: 'missing', path: target } };
    tree.write(target, null); // the hunks of a deletion are not read
    return { failure: null };
  }

  const from = oldP as string;
  const to = newP as string;
  const isMove = from !== to;
  const bad = unsafeFailure(isMove ? [from, to] : [from]);
  if (bad !== null) return { failure: bad };
  if (!tree.exists(from)) return { failure: { code: 'missing', path: from } };
  if (isMove && tree.exists(to)) return { failure: { code: 'exists', path: to } };

  const model = parseModel(tree.read(from));
  let d = 0;
  for (const h of sec.hunks) {
    const { O, N } = hunkParts(h.body);
    const oTexts = O.map((e) => e.text);
    if (O.length > 0) {
      const hit = findTier(model.lines, oTexts, strict);
      if (hit === null) return { failure: { code: 'no-match', path: from } };
      const target = h.a - 1 + d;
      let pos = hit.positions[0];
      for (const p of hit.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const touchesEnd = pos + O.length === model.lines.length;
      const replacement = buildReplacement(model.lines, pos, O, N, hit.tier);
      model.lines.splice(pos, O.length, ...replacement);
      if (touchesEnd) {
        const lastN = N.length > 0 ? N[N.length - 1] : null;
        model.end = lastN === null ? true : !lastN.slash;
      }
      d += N.length - O.length;
    } else {
      // Empty O: N is inserted after the first A + d lines. There is no
      // matched line, so no tier and no re-indenting: N is written as it is.
      const pos = Math.min(h.a + d, model.lines.length);
      const atEnd = pos === model.lines.length;
      const plain = N.map((e) => e.text);
      model.lines.splice(pos, 0, ...plain);
      if (atEnd) {
        const lastN = N.length > 0 ? N[N.length - 1] : null;
        model.end = lastN === null ? true : !lastN.slash;
      }
      d += N.length;
    }
  }

  if (isMove) {
    tree.write(to, serializeModel(model));
    tree.write(from, null);
    tree.moves.push([from, to]);
  } else {
    tree.write(from, serializeModel(model));
  }
  return { failure: null };
}

// ---------------------------------------------------------- SEARCH/REPLACE

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path: nearest line before, after the previous block, that is not
    // blank and does not (trimmed) start with three backticks.
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFault(searchIdx + 1);
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      const t = lines[j].trimEnd();
      if (eq < 0 && t === '=======') eq = j;
      else if (eq >= 0 && t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new ParseFault(searchIdx + 1);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks;
}

function applySRBlock(tree: Tree, block: SRBlock, strict: boolean): EditOutcome {
  const bad = unsafeFailure([block.path]);
  if (bad !== null) return { failure: bad };
  if (block.oldLines.length === 0) {
    if (tree.exists(block.path)) return { failure: { code: 'exists', path: block.path } };
    const model: FileModel = { lines: [...block.newLines], brk: '\n', end: block.newLines.length > 0 };
    tree.write(block.path, serializeModel(model));
    return { failure: null };
  }
  if (!tree.exists(block.path)) return { failure: { code: 'missing', path: block.path } };
  const model = parseModel(tree.read(block.path));
  const hit = findTier(model.lines, block.oldLines, strict);
  if (hit === null) return { failure: { code: 'no-match', path: block.path } };
  if (hit.positions.length !== 1) return { failure: { code: 'ambiguous', path: block.path } };
  const pos = hit.positions[0];
  const oLines: OLine[] = block.oldLines.map((text) => ({ text, slash: false }));
  const nLines: NLine[] = block.newLines.map((text) => ({ text, oIdx: -1, slash: false }));
  const replacement = buildReplacement(model.lines, pos, oLines, nLines, hit.tier);
  model.lines.splice(pos, block.oldLines.length, ...replacement);
  tree.write(block.path, serializeModel(model));
  return { failure: null };
}

// --------------------------------------------------------------------- V4A

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Array<{ kind: 'ctx' | 'del' | 'add'; text: string }>;
}

type VSection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[]; headerLine: number };

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function vSectionStart(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith(V_ADD)) return 'add';
  if (line.startsWith(V_DEL)) return 'delete';
  if (line.startsWith(V_UPD)) return 'update';
  return null;
}

function parseV4A(lines: string[]): VSection[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = vSectionStart(line);
    if (kind === null) throw new ParseFault(i + 1);
    const headerLine = i + 1;
    if (kind === 'add') {
      const path = line.slice(V_ADD.length).replace(/^ +| +$/g, '');
      const collected: Array<{ raw: string; lineNo: number }> = [];
      i += 1;
      while (i < last && vSectionStart(lines[i]) === null) {
        const l = lines[i];
        if (l.startsWith('*** ')) throw new ParseFault(i + 1);
        collected.push({ raw: l, lineNo: i + 1 });
        i += 1;
      }
      while (collected.length > 0 && isBlank(collected[collected.length - 1].raw)) collected.pop();
      const fileLines: string[] = [];
      for (const c of collected) {
        if (c.raw.startsWith('+')) fileLines.push(c.raw.slice(1));
        else if (c.raw === '') fileLines.push('');
        else throw new ParseFault(c.lineNo);
      }
      sections.push({ kind: 'add', path, fileLines });
    } else if (kind === 'delete') {
      const path = line.slice(V_DEL.length).replace(/^ +| +$/g, '');
      i += 1;
      while (i < last && vSectionStart(lines[i]) === null) {
        if (!isBlank(lines[i])) throw new ParseFault(i + 1);
        i += 1;
      }
      sections.push({ kind: 'delete', path });
    } else {
      const path = line.slice(V_UPD.length).replace(/^ +| +$/g, '');
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith(V_MOVE)) {
        moveTo = lines[i].slice(V_MOVE.length).replace(/^ +| +$/g, '');
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let closedByEof = false;
      while (i < last && vSectionStart(lines[i]) === null) {
        const l = lines[i];
        if (l.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, entries: [] };
            chunks.push(cur);
          }
          cur.eof = true;
          cur = null;
          closedByEof = true;
          i += 1;
          continue;
        }
        if (l.startsWith('*** ')) throw new ParseFault(i + 1);
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).replace(/^ +| +$/g, '');
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, entries: [] };
          chunks.push(cur);
          closedByEof = false;
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0 && !closedByEof) {
              cur = { anchor: null, eof: false, entries: [] };
              chunks.push(cur);
            } else {
              throw new ParseFault(i + 1);
            }
          }
          const entryKind = l.startsWith('-') ? 'del' : l.startsWith('+') ? 'add' : 'ctx';
          const text = l === '' ? '' : l.slice(1);
          cur.entries.push({ kind: entryKind, text });
          i += 1;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      // Blank lines at the end of the section are not part of it: drop
      // trailing empty context entries of the last chunk. A chunk closed by
      // *** End of File keeps its entries: blanks before that marker are
      // part of the chunk, not blank lines at the end of the section.
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        while (
          !lastChunk.eof &&
          lastChunk.entries.length > 0 &&
          lastChunk.entries[lastChunk.entries.length - 1].kind === 'ctx' &&
          lastChunk.entries[lastChunk.entries.length - 1].text === ''
        ) {
          lastChunk.entries.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(headerLine);
      sections.push({ kind: 'update', path, moveTo, chunks, headerLine });
    }
  }
  return sections;
}

function applyVSection(tree: Tree, sec: VSection, strict: boolean): EditOutcome {
  if (sec.kind === 'add') {
    const bad = unsafeFailure([sec.path]);
    if (bad !== null) return { failure: bad };
    if (tree.exists(sec.path)) return { failure: { code: 'exists', path: sec.path } };
    const model: FileModel = { lines: [...sec.fileLines], brk: '\n', end: sec.fileLines.length > 0 };
    tree.write(sec.path, serializeModel(model));
    return { failure: null };
  }
  if (sec.kind === 'delete') {
    const bad = unsafeFailure([sec.path]);
    if (bad !== null) return { failure: bad };
    if (!tree.exists(sec.path)) return { failure: { code: 'missing', path: sec.path } };
    tree.write(sec.path, null);
    return { failure: null };
  }
  // update
  const paths = sec.moveTo !== null ? [sec.path, sec.moveTo] : [sec.path];
  const bad = unsafeFailure(paths);
  if (bad !== null) return { failure: bad };
  if (!tree.exists(sec.path)) return { failure: { code: 'missing', path: sec.path } };
  if (sec.moveTo !== null && tree.exists(sec.moveTo)) return { failure: { code: 'exists', path: sec.moveTo } };
  const model = parseModel(tree.read(sec.path));
  let cursor = 0;
  for (const chunk of sec.chunks) {
    if (chunk.anchor !== null) {
      const tiers = strict ? [0] : [0, 1, 2];
      let found = -1;
      for (const tier of tiers) {
        for (let j = cursor; j < model.lines.length; j += 1) {
          if (lineMatchesAtTier(model.lines[j], chunk.anchor, tier)) {
            found = j;
            break;
          }
        }
        if (found >= 0) break;
      }
      if (found < 0) return { failure: { code: 'no-match', path: sec.path } };
      cursor = found + 1;
    }
    const O: OLine[] = [];
    const N: NLine[] = [];
    for (const e of chunk.entries) {
      if (e.kind === 'ctx') {
        O.push({ text: e.text, slash: false });
        N.push({ text: e.text, oIdx: O.length - 1, slash: false });
      } else if (e.kind === 'del') {
        O.push({ text: e.text, slash: false });
      } else {
        N.push({ text: e.text, oIdx: -1, slash: false });
      }
    }
    if (O.length === 0) {
      const pos = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
      const plain = N.map((e) => e.text);
      model.lines.splice(pos, 0, ...plain);
      cursor = pos + plain.length;
    } else {
      const oTexts = O.map((e) => e.text);
      const hit = findTier(model.lines, oTexts, strict, cursor, chunk.eof ? (p) => p + O.length === model.lines.length : undefined);
      if (hit === null) return { failure: { code: 'no-match', path: sec.path } };
      const pos = hit.positions[0];
      const replacement = buildReplacement(model.lines, pos, O, N, hit.tier);
      model.lines.splice(pos, O.length, ...replacement);
      cursor = pos + replacement.length;
    }
  }
  if (sec.moveTo !== null) {
    tree.write(sec.moveTo, serializeModel(model));
    tree.write(sec.path, null);
    tree.moves.push([sec.path, sec.moveTo]);
  } else {
    tree.write(sec.path, serializeModel(model));
  }
  return { failure: null };
}

// -------------------------------------------------------------------- JSON

type JEdit =
  | { command: 'create'; path: string; fileText: string }
  | { command: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { command: 'insert'; path: string; insertLine: number; newStr: string };

function validateJEdit(obj: unknown): JEdit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { command: 'str_replace', path: o.path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { command: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJSON(text: string, lines: string[]): JEdit[] {
  const firstNonWs = text.search(/\S/);
  if (firstNonWs >= 0 && text[firstNonWs] === '[') {
    const startLine = text.slice(0, firstNonWs).split('\n').length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFault(startLine);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(startLine);
    const edits: JEdit[] = [];
    for (const el of parsed) {
      const e = validateJEdit(el);
      if (e === null) throw new ParseFault(startLine);
      edits.push(e);
    }
    return edits;
  }
  const edits: JEdit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      throw new ParseFault(i + 1);
    }
    const e = validateJEdit(parsed);
    if (e === null) throw new ParseFault(i + 1);
    edits.push(e);
  }
  return edits;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    count += 1;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return count;
}

function applyJEdit(tree: Tree, edit: JEdit): EditOutcome {
  const bad = unsafeFailure([edit.path]);
  if (bad !== null) return { failure: bad };
  if (edit.command === 'create') {
    if (tree.exists(edit.path)) return { failure: { code: 'exists', path: edit.path } };
    tree.write(edit.path, edit.fileText);
    return { failure: null };
  }
  if (!tree.exists(edit.path)) return { failure: { code: 'missing', path: edit.path } };
  const content = tree.read(edit.path);
  if (edit.command === 'str_replace') {
    const model = parseModel(content);
    const crlf = model.brk === '\r\n';
    const norm = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
    const text = norm(content);
    const oldS = norm(edit.oldStr);
    const newS = norm(edit.newStr);
    const count = countOccurrences(text, oldS);
    if (count === 0) return { failure: { code: 'no-match', path: edit.path } };
    if (count > 1) return { failure: { code: 'ambiguous', path: edit.path } };
    const at = text.indexOf(oldS);
    let result = text.slice(0, at) + newS + text.slice(at + oldS.length);
    if (crlf) result = result.split('\n').join('\r\n');
    tree.write(edit.path, result);
    return { failure: null };
  }
  // insert
  const model = parseModel(content);
  if (edit.insertLine < 0 || edit.insertLine > model.lines.length) {
    return { failure: { code: 'no-match', path: edit.path } };
  }
  const newLines = patchLines(edit.newStr);
  model.lines.splice(edit.insertLine, 0, ...newLines);
  tree.write(edit.path, serializeModel(model));
  return { failure: null };
}

// --------------------------------------------------------- format detection

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): FormatName | null {
  let firstNonBlank: string | null = null;
  for (const l of lines) {
    if (!isBlank(l)) {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== null && firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  if (firstNonBlank !== null) {
    const t = firstNonBlank.trimStart();
    if (t.startsWith('[') || t.startsWith('{')) return 'json';
  }
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// -------------------------------------------------------------------- main

function fail2(line: string): number {
  process.stdout.write(`${line}\n`);
  return 2;
}

function main(argv: string[]): number {
  // ---- arguments (section 1)
  let format = 'auto';
  let formatSeen = false;
  let check = false;
  let strict = false;
  let positional: string[] = [];
  let afterDashDash = false;
  let usage = false;
  for (const arg of argv) {
    if (!afterDashDash) {
      if (arg === '--') {
        afterDashDash = true;
        continue;
      }
      if (arg === '--check') {
        if (check) usage = true;
        check = true;
        continue;
      }
      if (arg === '--strict') {
        if (strict) usage = true;
        strict = true;
        continue;
      }
      if (arg.startsWith('--format=')) {
        if (formatSeen) usage = true;
        formatSeen = true;
        format = arg.slice('--format='.length);
        if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(format)) usage = true;
        continue;
      }
      if (arg.startsWith('-') && arg !== '-') {
        usage = true;
        continue;
      }
    }
    positional.push(arg);
  }
  if (positional.length > 1) usage = true;
  if (usage) return fail2('error: usage');

  // ---- read the patch (section 2: no-patch)
  const patchArg = positional.length === 1 ? positional[0] : undefined;
  let patchText: string;
  if (patchArg === undefined || patchArg === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      return fail2('error: no-patch');
    }
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return fail2('error: no-patch');
    }
  }
  const lines = patchLines(patchText);

  // ---- format (section 4)
  let fmt: FormatName;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return fail2('error: format');
    fmt = detected;
  } else {
    fmt = format as FormatName;
  }

  // ---- parse into edits and apply them in order (sections 6-10)
  const tree = new Tree();
  const failures: Failure[] = [];
  let editCount = 0;
  try {
    if (fmt === 'unified') {
      const sections = parseUnified(lines);
      if (sections.length === 0) throw new ParseFault(1);
      editCount = sections.length;
      for (const sec of sections) {
        const r = applyUnifiedSection(tree, sec, strict);
        if (r.failure !== null) failures.push(r.failure);
      }
    } else if (fmt === 'search-replace') {
      const blocks = parseSearchReplace(lines);
      if (blocks.length === 0) throw new ParseFault(1);
      editCount = blocks.length;
      for (const b of blocks) {
        const r = applySRBlock(tree, b, strict);
        if (r.failure !== null) failures.push(r.failure);
      }
    } else if (fmt === 'v4a') {
      const sections = parseV4A(lines);
      if (sections.length === 0) throw new ParseFault(1);
      editCount = sections.length;
      for (const s of sections) {
        const r = applyVSection(tree, s, strict);
        if (r.failure !== null) failures.push(r.failure);
      }
    } else {
      const edits = parseJSON(patchText, lines);
      if (edits.length === 0) throw new ParseFault(1);
      editCount = edits.length;
      for (const e of edits) {
        const r = applyJEdit(tree, e);
        if (r.failure !== null) failures.push(r.failure);
      }
    }
  } catch (err) {
    if (err instanceof ParseFault) return fail2(`error: parse ${err.line}`);
    throw err;
  }

  // ---- report (section 2)
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${editCount} edits`);
    process.stdout.write(out.join('\n') + '\n');
    return 1;
  }
  const changes = tree.changes();
  changes.sort((x, y) => byteCompare(x.path, y.path));
  if (!check) tree.flush();
  const out: string[] = [];
  for (const c of changes) {
    if (c.oldPath !== undefined) out.push(`R ${c.oldPath} -> ${c.path}`);
    else out.push(`${c.kind} ${c.path}`);
  }
  out.push(changes.length === 1 ? 'ok: 1 file' : `ok: ${changes.length} files`);
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

// ---------------------------------------------------------------- entry point
// (At the end on purpose: main() uses the classes above, which are not
// hoisted, so the call must run after every declaration has been evaluated.)

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  process.exitCode = main(process.argv.slice(2));
}
