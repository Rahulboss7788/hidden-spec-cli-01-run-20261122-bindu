// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Moves an edit recorded, in the patch's order, for the R output rows. */
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

/** A file's lines under section 3: its line break, its lines, and whether it ends with a break. */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const isBlankLine = (s: string): boolean => /^[ \t]*$/.test(s);

function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

/** Positions where O occurs in the file's lines at one tier; occurrences may overlap. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions; null when it occurs at no tier. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a fresh line. */
interface NewLine {
  text: string;
  oIndex: number | null;
}

/** Build N's replacement lines at a match: context lines come from the file, other lines are re-indented at tier 2. */
function buildReplacement(file: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && o.length > 0) {
    const f = leadWs(file[pos]!);
    const p = leadWs(o[0]!);
    for (const item of n) {
      if (item.oIndex !== null) {
        out.push(file[pos + item.oIndex]!);
        continue;
      }
      const t = item.text;
      if (!isBlankLine(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
    return out;
  }
  for (const item of n) out.push(item.oIndex !== null ? file[pos + item.oIndex]! : item.text);
  return out;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'slash';
  text: string;
}

/** Split body items into old lines O and new lines N (with each context line's index in O). */
function bodyOldNew(items: BodyItem[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, oIndex: o.length - 1 });
    } else if (it.kind === 'old') o.push(it.text);
    else if (it.kind === 'new') n.push({ text: it.text, oIndex: null });
  }
  return { o, n };
}

// ---- Unified diffs (section 6) ----

interface Hunk {
  a: number;
  items: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

interface UniBuilder {
  gitOld: string | null;
  gitNew: string | null;
  pairSet: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed, one a/ or b/ removed. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!;
  const p = raw.trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** A header path, with `/dev/null` meaning no file. */
function sectionPath(line: string): string | null {
  const p = headerPath(line);
  return p === '/dev/null' ? null : p;
}

function finalizeUni(b: UniBuilder): UniSection {
  const norm = (p: string | null): string | null => (p === '/dev/null' ? null : p);
  return {
    oldPath: norm(b.pairSet ? b.pairOld : b.renameOld ?? b.gitOld),
    newPath: norm(b.pairSet ? b.pairNew : b.renameNew ?? b.gitNew),
    newFile: b.newFile,
    deletedFile: b.deletedFile,
    hunks: b.hunks,
  };
}

/** A section's header: the lines before its first hunk. Returns the index it stopped at. */
function parseUniHeader(lines: string[], i: number, b: UniBuilder): number {
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('@@')) {
      if (!HUNK_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      return i;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (!b.pairSet) {
        b.pairSet = true;
        b.pairOld = sectionPath(line);
        b.pairNew = sectionPath(next);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (b.renameOld === null) b.renameOld = line.slice(12).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (b.renameNew === null) b.renameNew = line.slice(10).trim();
      i++;
      continue;
    }
    if (line === 'new file mode' || line.startsWith('new file mode ')) b.newFile = true;
    else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) b.deletedFile = true;
    i++;
  }
  return i;
}

function finishHunk(h: Hunk): void {
  let last = -1;
  for (let k = 0; k < h.items.length; k++) {
    if (h.items[k]!.kind === 'ctx' || h.items[k]!.kind === 'new') last = k;
  }
  h.noEol = last >= 0 && h.items[last + 1] !== undefined && h.items[last + 1]!.kind === 'slash';
}

/** A section's hunks. Returns the index it stopped at (the next section's start, or the end). */
function parseUniHunks(lines: string[], i: number, b: UniBuilder): number {
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      if (!GIT_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      return i;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const h: Hunk = { a: parseInt(m[1]!, 10), items: [], noEol: false };
      i++;
      const start = i;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          i++;
          continue;
        }
        break;
      }
      const body = lines.slice(start, i);
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      for (const bl of body) {
        if (bl === '') h.items.push({ kind: 'ctx', text: '' });
        else if (bl[0] === ' ') h.items.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') h.items.push({ kind: 'old', text: bl.slice(1) });
        else if (bl[0] === '+') h.items.push({ kind: 'new', text: bl.slice(1) });
        else h.items.push({ kind: 'slash', text: bl });
      }
      finishHunk(h);
      b.hunks.push(h);
      continue;
    }
    i++;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const b: UniBuilder = {
        gitOld: m[1]!,
        gitNew: m[2]!,
        pairSet: false,
        pairOld: null,
        pairNew: null,
        renameOld: null,
        renameNew: null,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      i = parseUniHeader(lines, i + 1, b);
      i = parseUniHunks(lines, i, b);
      sections.push(finalizeUni(b));
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const b: UniBuilder = {
        gitOld: null,
        gitNew: null,
        pairSet: true,
        pairOld: sectionPath(line),
        pairNew: sectionPath(lines[i + 1]!),
        renameOld: null,
        renameNew: null,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      i = parseUniHeader(lines, i + 2, b);
      i = parseUniHunks(lines, i, b);
      sections.push(finalizeUni(b));
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return sections.map((s) => uniEdit(s, strict));
}

/** Apply a section's hunks in order to a file's lines, tracking the offset d and the final break. */
function applyHunks(parts: FileParts, hunks: Hunk[], strict: boolean, path: string): FileParts {
  let lines = parts.lines;
  let final = parts.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = bodyOldNew(h.items);
    if (o.length === 0) {
      const oldLen = lines.length;
      const at = Math.min(Math.max(h.a + d, 0), oldLen);
      const ins = n.map((x) => x.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (at === oldLen) final = !h.noEol;
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const rep = buildReplacement(lines, best, o, n, found.tier);
    const touchesEnd = best + o.length === lines.length;
    lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
    if (touchesEnd) final = !h.noEol;
    d += n.length - o.length;
  }
  return { lines, br: parts.br, final };
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.items.length; k++) {
          if (h.items[k]!.kind === 'new') {
            plus.push(h.items[k]!.text);
            noEol = h.items[k + 1] !== undefined && h.items[k + 1]!.kind === 'slash';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', '/dev/null');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const op = oldP!;
    const np = newP!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
    const res = applyHunks(splitFile(before), sec.hunks, strict, op);
    const text = joinFile(res);
    if (op !== np) {
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, text);
    }
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findTier(parts.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, oIndex: null }));
    const rep = buildReplacement(parts.lines, pos, oldLines, n, found.tier);
    const out = [...parts.lines.slice(0, pos), ...rep, ...parts.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ lines: out, br: parts.br, final: parts.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (l.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, sep), lines.slice(sep + 1, end), strict));
    prevReplace = end;
    prevPath = path;
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (section 8) ----

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headLine: number;
  lines: { text: string; num: number }[];
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

/** The first line at or after the cursor equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = cursor; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, num } of sec.lines) {
      if (text.startsWith('+')) fileLines.push(text.slice(1));
      else if (text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${num}`);
    }
    const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, text);
    };
  }
  if (sec.kind === 'delete') {
    if (sec.lines.length > 0) throw new Exit2(`error: parse ${sec.lines[0]!.num}`);
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  let idx = 0;
  let moveTo: string | null = null;
  if (idx < sec.lines.length && sec.lines[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = sec.lines[idx]!.text.slice('*** Move to: '.length).trim();
    idx++;
  }
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; items: BodyItem[] } | null = null;
  let seenChunk = false;
  const finishChunk = (): void => {
    if (cur === null) return;
    const { o, n } = bodyOldNew(cur.items);
    chunks.push({ anchor: cur.anchor, eof: cur.eof, o, n });
    cur = null;
  };
  while (idx < sec.lines.length) {
    const { text, num } = sec.lines[idx]!;
    if (text.startsWith('@@')) {
      finishChunk();
      const anchorText = text.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
      seenChunk = true;
      idx++;
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      finishChunk();
      idx++;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (seenChunk) throw new Exit2(`error: parse ${num}`);
        cur = { anchor: null, eof: false, items: [] };
        seenChunk = true;
      }
      if (text === '') cur.items.push({ kind: 'ctx', text: '' });
      else if (text[0] === ' ') cur.items.push({ kind: 'ctx', text: text.slice(1) });
      else if (text[0] === '-') cur.items.push({ kind: 'old', text: text.slice(1) });
      else cur.items.push({ kind: 'new', text: text.slice(1) });
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  finishChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.headLine}`);
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    let lines = parts.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        const ins = chunk.n.map((x) => x.text);
        lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
        cursor = at + ins.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top; t++) {
        const occ = occurrences(lines, chunk.o, t).filter(
          (p) => p >= cursor && (!chunk.eof || p + chunk.o.length === lines.length),
        );
        if (occ.length > 0) {
          found = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const rep = buildReplacement(lines, found.pos, chunk.o, chunk.n, found.tier);
      lines = [...lines.slice(0, found.pos), ...rep, ...lines.slice(found.pos + chunk.o.length)];
      cursor = found.pos + rep.length;
    }
    const text = joinFile({ lines, br: parts.br, final: parts.final });
    if (moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([sec.path, moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  const close = (): void => {
    if (cur !== null) {
      while (cur.lines.length > 0 && blank(cur.lines[cur.lines.length - 1]!.text)) cur.lines.pop();
      sections.push(cur);
      cur = null;
    }
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let prefix = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      prefix = '*** Add File: ';
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      prefix = '*** Delete File: ';
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      prefix = '*** Update File: ';
    }
    if (kind !== null) {
      close();
      cur = { kind, path: line.slice(prefix.length).trim(), headLine: i + 1, lines: [] };
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.lines.push({ text: line, num: i + 1 });
  }
  close();
  return sections.map((s) => v4aEdit(s, strict));
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
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
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rowByPath = new Map<string, { key: string; text: string }>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rowByPath.set(p, { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const o = rowByPath.get(oldP);
    const n = rowByPath.get(newP);
    if (o !== undefined && n !== undefined && o.text.startsWith('D ') && n.text.startsWith('A ')) {
      rowByPath.delete(oldP);
      rowByPath.delete(newP);
      rowByPath.set(newP, { key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  const rows = [...rowByPath.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))
    .map((r) => r.text);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
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
