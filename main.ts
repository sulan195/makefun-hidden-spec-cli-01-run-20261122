// mend — one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md in full: section 1 (invocation), 2 (output and exit
// codes), 3 (files, lines and paths), 4 (format detection), 5 (three-tier
// line matching), 6 (unified diffs), 7 (SEARCH/REPLACE blocks), 8 (V4A
// patches), 9 (JSON edits) and 10 (order and atomicity).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are.

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
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** Moves recorded by edits that succeeded, for the `R old -> new` output line. */
let moves: { old: string; nw: string }[] = [];

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

// ---------------------------------------------------------------------------
// Files as lines (SPEC section 3) and three-tier matching (SPEC section 5)
// ---------------------------------------------------------------------------

type Br = '\n' | '\r\n';

interface FileState {
  lines: string[];
  br: Br;
  endsWithBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br: Br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(br);
  const core = endsWithBreak ? text.slice(0, -br.length) : text;
  return { lines: core.split(br), br, endsWithBreak };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endsWithBreak ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** All 0-based positions where O occurs in lines at the given tier (overlaps allowed). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2 — or 0 only when strict) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Build the replacement lines for an O -> N swap at `pos`, walking the
 * hunk/chunk body in order. A context line is written as the file's own
 * matched line, never the patch's; a deleted line consumes its O entry
 * without producing output; at tier 2 an added line is re-indented (P -> F).
 * `oIdx` counts entries of O, so context lines map to the right file lines
 * even when deleted lines sit between them.
 */
function buildReplacement(
  fileLines: string[],
  pos: number,
  o: string[],
  body: { kind: 'ctx' | 'del' | 'add'; text: string }[],
  tier: number,
): string[] {
  const out: string[] = [];
  let oIdx = 0;
  const P = o.length > 0 ? leadWs(o[0]!) : '';
  const F = o.length > 0 ? leadWs(fileLines[pos]!) : '';
  for (const it of body) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]!);
      oIdx++;
    } else if (it.kind === 'del') {
      oIdx++;
    } else if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(P)) {
      out.push(F + it.text.slice(P.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9) — as the kit's starter has them
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface HunkLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noEol: boolean;
}

interface Hunk {
  a: number;
  body: HunkLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Path after `--- `/`+++ `: text after the four characters, up to the first tab, spaces removed. */
function headerPath(l: string): string {
  const rest = l.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** `diff --git a/<X> b/<Y>`, or null when not of that form. */
function parseDiffGit(l: string): { x: string; y: string } | null {
  const rest = l.slice('diff --git '.length).trimEnd();
  if (!rest.startsWith('a/')) return null;
  const sep = rest.lastIndexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return { x, y };
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Parse one hunk body starting at `i`; returns the hunk and the next index. */
function parseHunkBody(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  const a = Number(m![1]);
  const body: HunkLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ')) { body.push({ kind: 'ctx', text: l.slice(1), noEol: false }); j++; }
    else if (l.startsWith('-')) { body.push({ kind: 'del', text: l.slice(1), noEol: false }); j++; }
    else if (l.startsWith('+')) { body.push({ kind: 'add', text: l.slice(1), noEol: false }); j++; }
    else if (l.startsWith('\\')) {
      if (body.length > 0) body[body.length - 1]!.noEol = true;
      j++;
    } else if (l === '') { body.push({ kind: 'ctx', text: '', noEol: false }); j++; }
    else break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  return { hunk: { a, body }, next: j };
}

/** Apply one hunk to a file; `d` is the length delta of this section's earlier hunks. */
function applyHunk(f: FileState, hunk: Hunk, d: number, strict: boolean, path: string): FileState {
  const o = hunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
  const lastCtxOrAdd = (): HunkLine | undefined => {
    for (let k = hunk.body.length - 1; k >= 0; k--) {
      const b = hunk.body[k]!;
      if (b.kind === 'ctx' || b.kind === 'add') return b;
    }
    return undefined;
  };
  if (o.length === 0) {
    const idx = Math.max(0, Math.min(hunk.a + d, f.lines.length));
    const n = buildReplacement(f.lines, idx, [], hunk.body, 0);
    const lines = [...f.lines.slice(0, idx), ...n, ...f.lines.slice(idx)];
    let endsWithBreak = f.endsWithBreak;
    if (idx === f.lines.length && n.length > 0) {
      const last = lastCtxOrAdd();
      endsWithBreak = !(last !== undefined && last.noEol);
    }
    return { lines, br: f.br, endsWithBreak };
  }
  const found = findTier(f.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) { best = p; bestDist = dist; }
  }
  const n = buildReplacement(f.lines, best, o, hunk.body, found.tier);
  const lines = [...f.lines.slice(0, best), ...n, ...f.lines.slice(best + o.length)];
  let endsWithBreak = f.endsWithBreak;
  if (best + o.length === f.lines.length) {
    const last = lastCtxOrAdd();
    endsWithBreak = !(last !== undefined && last.noEol);
  }
  return { lines, br: f.br, endsWithBreak };
}

function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = f;
  let d = 0;
  for (const h of hunks) {
    cur = applyHunk(cur, h, d, strict, path);
    const oLen = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').length;
    const nLen = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'add').length;
    d += nLen - oLen;
  }
  return cur;
}

/** One unified section as one edit (a hunk failure fails the whole section). */
function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.oldPath === null ? null : stripPrefix(s.oldPath);
  const newP = s.newPath === null ? null : stripPrefix(s.newPath);
  const devNull = (p: string | null): boolean => p === '/dev/null';
  const oldIsNull = oldP === null || devNull(oldP);
  const newIsNull = newP === null || devNull(newP);
  if (oldIsNull && newIsNull) return () => undefined;
  if (oldIsNull || s.newFile) {
    const np = newP!;
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastNoEol = false;
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === 'add') { plus.push(b.text); lastNoEol = b.noEol; }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastNoEol ? '' : '\n'));
    };
  }
  if (newIsNull || s.deletedFile) {
    const op = oldP!;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (oldP !== newP) {
    const op = oldP!;
    const np = newP!;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const done = applyHunks(parseFile(cur), s.hunks, strict, op);
      tree.now.set(np, serializeFile(done));
      tree.now.set(op, null);
      moves.push({ old: op, nw: np });
    };
  }
  const p = oldP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const done = applyHunks(parseFile(cur), s.hunks, strict, p);
    tree.now.set(p, serializeFile(done));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let hasDashPair = false;
  const newSection = (oldP: string | null, newP: string | null): UniSection => {
    const s: UniSection = { oldPath: oldP, newPath: newP, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    hasDashPair = false;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = parseDiffGit(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m.x, m.y);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasDashPair) {
        cur.oldPath = headerPath(l);
        cur.newPath = headerPath(lines[i + 1]!);
        hasDashPair = true;
      } else {
        newSection(headerPath(l), headerPath(lines[i + 1]!));
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.newPath = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.newFile = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => uniSectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevReplace = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevReplace; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = searchLine + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') { eq = k; break; }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({
      path,
      oldLines: lines.slice(searchLine + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  return blocks.map((b) => srBlockEdit(b, strict));
}

function srBlockEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const f = parseFile(cur);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length !== 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    const n = buildReplacement(f.lines, pos, b.oldLines, b.newLines.map((t) => ({ kind: 'add' as const, text: t })), found.tier);
    const lines = [...f.lines.slice(0, pos), ...n, ...f.lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, serializeFile({ lines, br: f.br, endsWithBreak: f.endsWithBreak }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  body: HunkLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) { kind = 'add'; path = l.slice('*** Add File: '.length).trim(); }
    else if (l.startsWith('*** Delete File: ')) { kind = 'delete'; path = l.slice('*** Delete File: '.length).trim(); }
    else if (l.startsWith('*** Update File: ')) { kind = 'update'; path = l.slice('*** Update File: '.length).trim(); }
    else throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind, path, moveTo: null, chunks: [] };
    sections.push(sec);
    i++;
    if (kind === 'add') {
      const raw: { text: string; wasBlank: boolean }[] = [];
      while (i < last) {
        const r = lines[i]!;
        if (r.startsWith('*** Add File: ') || r.startsWith('*** Delete File: ') || r.startsWith('*** Update File: ') || r.trim() === '*** End Patch') break;
        if (r === '') { raw.push({ text: '', wasBlank: true }); i++; continue; }
        if (!r.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        raw.push({ text: r.slice(1), wasBlank: false });
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1]!.wasBlank) raw.pop();
      sec.chunks = [{ anchor: null, body: raw.map((x) => ({ kind: 'add' as const, text: x.text, noEol: false })), eof: false }];
      continue;
    }
    if (kind === 'delete') {
      while (i < last && blank(lines[i]!)) i++;
      continue;
    }
    // update
    const updateLine = i - 1;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    let chunk: VChunk | null = null;
    let seenChunk = false;
    const closeChunk = (atSectionEnd: boolean): void => {
      if (chunk !== null) {
        if (atSectionEnd) {
          while (chunk.body.length > 0) {
            const b = chunk.body[chunk.body.length - 1]!;
            if (b.kind === 'ctx' && b.text === '') chunk.body.pop();
            else break;
          }
        }
        sec.chunks.push(chunk);
        chunk = null;
        seenChunk = true;
      }
    };
    while (i < last) {
      const r = lines[i]!;
      if (r.startsWith('*** Add File: ') || r.startsWith('*** Delete File: ') || r.startsWith('*** Update File: ') || r.trim() === '*** End Patch') break;
      if (r.startsWith('@@')) {
        closeChunk(false);
        chunk = { anchor: r.slice(2).trim(), body: [], eof: false };
        if (chunk.anchor === '') chunk.anchor = null;
        i++;
        continue;
      }
      if (r.trim() === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
        chunk.eof = true;
        closeChunk(false);
        i++;
        continue;
      }
      if (r.startsWith(' ') || r.startsWith('-') || r.startsWith('+') || r === '') {
        if (chunk === null) {
          if (seenChunk) throw new Exit2(`error: parse ${i + 1}`);
          chunk = { anchor: null, body: [], eof: false };
        }
        if (r === '') chunk.body.push({ kind: 'ctx', text: '', noEol: false });
        else if (r.startsWith(' ')) chunk.body.push({ kind: 'ctx', text: r.slice(1), noEol: false });
        else if (r.startsWith('-')) chunk.body.push({ kind: 'del', text: r.slice(1), noEol: false });
        else chunk.body.push({ kind: 'add', text: r.slice(1), noEol: false });
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    closeChunk(true);
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
  }
  return sections.map((s) => vSectionEdit(s, strict));
}

function applyVChunk(f: FileState, chunk: VChunk, cursor: number, strict: boolean, path: string): { f: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    let foundAt = -1;
    const maxTier = strict ? 0 : 2;
    for (let t = 0; t <= maxTier && foundAt < 0; t++) {
      for (let k = cur; k < f.lines.length; k++) {
        if (lineEq(f.lines[k]!, chunk.anchor, t)) { foundAt = k; break; }
      }
    }
    if (foundAt < 0) throw new Fail('no-match', path);
    cur = foundAt + 1;
  }
  const o = chunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
  if (o.length === 0) {
    const idx = chunk.eof ? f.lines.length : cur;
    const n = buildReplacement(f.lines, idx, [], chunk.body, 0);
    const lines = [...f.lines.slice(0, idx), ...n, ...f.lines.slice(idx)];
    return { f: { lines, br: f.br, endsWithBreak: f.endsWithBreak }, cursor: idx + n.length };
  }
  const maxTier = strict ? 0 : 2;
  let found: { tier: number; occ: number[] } | null = null;
  for (let t = 0; t <= maxTier; t++) {
    const occ = occurrences(f.lines, o, t).filter((p) => p >= cur && (!chunk.eof || p + o.length === f.lines.length));
    if (occ.length > 0) { found = { tier: t, occ }; break; }
  }
  if (found === null) throw new Fail('no-match', path);
  const pos = found.occ[0]!;
  const n = buildReplacement(f.lines, pos, o, chunk.body, found.tier);
  const lines = [...f.lines.slice(0, pos), ...n, ...f.lines.slice(pos + o.length)];
  return { f: { lines, br: f.br, endsWithBreak: f.endsWithBreak }, cursor: pos + n.length };
}

function vSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const body = s.chunks[0]!.body;
      const text = body.map((b) => b.text);
      tree.now.set(s.path, text.length === 0 ? '' : text.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    let target: string | null = null;
    if (s.moveTo !== null) {
      target = s.moveTo;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
    }
    let f = parseFile(cur);
    let cursor = 0;
    for (const chunk of s.chunks) {
      const r = applyVChunk(f, chunk, cursor, strict, s.path);
      f = r.f;
      cursor = r.cursor;
    }
    const out = serializeFile(f);
    if (target !== null) {
      tree.now.set(target, out);
      tree.now.set(s.path, null);
      moves.push({ old: s.path, nw: target });
    } else {
      tree.now.set(s.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  moves = [];
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
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
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows: { key: string; line: string }[] = [];
  const moveOld = new Set(moves.map((m) => m.old));
  const moveNew = new Map(moves.map((m) => [m.nw, m.old]));
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveOld.has(p) && was !== null && now === null) {
      const nw = moves.find((m) => m.old === p)!.nw;
      const nwNow = tree.now.has(nw) ? tree.now.get(nw)! : tree.original(nw);
      if (nwNow !== null && tree.original(nw) === null) continue;
    }
    if (moveNew.has(p) && was === null && now !== null) {
      const old = moveNew.get(p)!;
      if (tree.original(old) !== null && tree.now.get(old) === null) continue;
    }
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of moves) {
    const oldWas = tree.original(m.old);
    const oldNow = tree.now.has(m.old) ? tree.now.get(m.old)! : oldWas;
    const nwWas = tree.original(m.nw);
    const nwNow = tree.now.has(m.nw) ? tree.now.get(m.nw)! : nwWas;
    if (oldWas !== null && oldNow === null && nwWas === null && nwNow !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
