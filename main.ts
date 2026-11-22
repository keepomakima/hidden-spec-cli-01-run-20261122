// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md:
// the command line, the output and exit codes, safe paths, format detection, line
// matching at three tiers, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON
// edits, and the all-or-nothing write. Node 22, the standard library alone; run it
// as `node main.ts [options] [PATCH]`. Written as plain JavaScript (no TypeScript-only
// syntax) so it runs as-is under any Node 22.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  constructor(line) {
    this.line = line;
  }
}
class Fail {
  constructor(code, path) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s) => s.trim() === '';

function patchLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p) {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  constructor() {
    this.orig = new Map();
    this.now = new Map();
  }
  original(p) {
    if (!this.orig.has(p)) {
      let v = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p);
  }
  get(p) {
    return this.now.has(p) ? this.now.get(p) : this.original(p);
  }
}

// --- Files and lines (SPEC section 3) ---

/** Split a file's text into its line break, its lines and whether it ends with a break. */
function splitFile(text) {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}

function joinFile(f) {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

function leading(s) {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// --- Matching lines (SPEC section 5) ---

function norm(line, tier) {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines, O, tier) {
  const out = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(lines[i + j], tier) !== norm(O[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict) {
  return strict ? [0] : [0, 1, 2];
}

/**
 * The first tier at which O occurs at-or-after `from`, with its occurrences.
 * An end-of-file chunk takes only an occurrence ending at the file's last line:
 * the tier is fixed by the first tier with any occurrence at-or-after the cursor,
 * and only an occurrence of that tier ending at the last line is taken; when there
 * is none the chunk fails.
 */
function findTier(lines, O, strict, from, eofOnly) {
  for (const t of tiers(strict)) {
    const occs = occurrences(lines, O, t).filter((i) => i >= from);
    if (occs.length === 0) continue;
    if (eofOnly) {
      const end = lines.length - O.length;
      if (end >= from && occs.includes(end)) return { tier: t, occs: [end] };
      return null;
    }
    return { tier: t, occs };
  }
  return null;
}

/**
 * The lines N writes when O is matched at `pos` at `tier`. N entries carry
 * ctx=true with oPos when the line is a context line: it is written as the file's
 * own matched line. At tier 2 every other line is re-indented from O's first line
 * to the file's first matched line.
 */
function buildN(fileLines, pos, O, N, tier) {
  const out = [];
  const P = O.length > 0 ? leading(O[0]) : '';
  const F = pos < fileLines.length ? leading(fileLines[pos]) : '';
  for (const n of N) {
    if (n.ctx) {
      out.push(fileLines[pos + n.oPos]);
      continue;
    }
    const t = n.text;
    if (tier === 2 && O.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(P)) out.push(F + t.slice(P.length));
    else out.push(t);
  }
  return out;
}

/** From hunk/chunk body lines, build O (context + old lines) and N (context + new lines). */
function bodyON(body) {
  const O = [];
  const N = [];
  for (const b of body) {
    if (b === '' || b[0] === ' ') {
      const text = b === '' ? '' : b.slice(1);
      O.push(text);
      N.push({ text, ctx: true, oPos: O.length - 1 });
    } else if (b[0] === '-') {
      O.push(b.slice(1));
    } else if (b[0] === '+') {
      N.push({ text: b.slice(1), ctx: false, oPos: -1 });
    }
    // '\' lines are not lines of O or N; the caller reads them for the final break.
  }
  return { O, N };
}

// --- Unified diffs (SPEC section 6) ---

function headerPath(line) {
  // The text after `--- ` / `+++ `, up to the first tab, surrounding spaces removed.
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = raw.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function noEolAfterLast(body) {
  let lastCtx = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k];
    if (b === '' || b[0] === ' ' || b[0] === '+') lastCtx = k;
  }
  return lastCtx >= 0 && body[lastCtx + 1] !== undefined && body[lastCtx + 1][0] === '\\';
}

/** Apply a section's hunks in order to a file's lines (SPEC section 6). */
function applyHunks(f, hunks, strict, path) {
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const at = Math.min(h.A + d, f.lines.length);
      const ins = N.map((x) => x.text);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...ins);
      if (atEnd && ins.length > 0) f.fin = !h.noEol;
      d += N.length;
    } else {
      const found = findTier(f.lines, O, strict, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.occs[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occs) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const runsToEnd = pos + O.length === f.lines.length;
      const rep = buildN(f.lines, pos, O, N, found.tier);
      f.lines.splice(pos, O.length, ...rep);
      if (runsToEnd) f.fin = !h.noEol;
      d += N.length - O.length;
    }
  }
}

function unifiedEdit(sec, strict, moves) {
  const oldP = sec.hasPair ? sec.pairOld : sec.renameFrom !== null ? sec.renameFrom : sec.diffOld;
  const newP = sec.hasPair ? sec.pairNew : sec.renameTo !== null ? sec.renameTo : sec.diffNew;
  return (tree) => {
    const isCreate = sec.newFile || oldP === null;
    const isDelete = !isCreate && (sec.delFile || newP === null);
    const named = [];
    if (oldP !== null) named.push(oldP);
    if (newP !== null && newP !== oldP) named.push(newP);
    for (const p of named) if (!safe(p)) throw new Fail('unsafe', p);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus = [];
      let lastPlusHunk = null;
      let lastPlus = -1;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k][0] === '+') {
            plus.push(h.body[k].slice(1));
            lastPlusHunk = h;
            lastPlus = k;
          }
        }
      }
      const noEol = lastPlusHunk !== null && lastPlusHunk.body[lastPlus + 1] !== undefined && lastPlusHunk.body[lastPlus + 1][0] === '\\';
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = splitFile(tree.get(oldP));
      applyHunks(f, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(f));
      moves.push([oldP, newP]);
      return;
    }
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    const f = splitFile(tree.get(oldP));
    applyHunks(f, sec.hunks, strict, oldP);
    tree.now.set(oldP, joinFile(f));
  };
}

function parseUnified(lines, strict, moves) {
  const sections = [];
  let cur = null;
  let inHeader = false;
  let seenPaths = false;
  let i = 0;
  const n = lines.length;
  const diffRe = /^diff --git a\/(.+) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  const startSection = (diffOld, diffNew) => ({
    diffOld,
    diffNew,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  });
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (!m) throw new Exit2('error: parse ' + (i + 1));
      // The regex already took the paths after `a/` and `b/`; do not strip again.
      cur = startSection(m[1], m[2]);
      sections.push(cur);
      inHeader = true;
      seenPaths = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !seenPaths) {
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]);
        cur.hasPair = true;
        seenPaths = true;
        i += 2;
        continue;
      }
      cur = startSection(null, null);
      cur.pairOld = headerPath(l);
      cur.pairNew = headerPath(lines[i + 1]);
      cur.hasPair = true;
      sections.push(cur);
      inHeader = true;
      seenPaths = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2('error: parse ' + (i + 1));
      const m = hunkRe.exec(l);
      if (!m) throw new Exit2('error: parse ' + (i + 1));
      const hunk = { A: Number(m[1]), body: [], noEol: false };
      cur.hunks.push(hunk);
      inHeader = false;
      i += 1;
      while (i < n) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      hunk.noEol = noEolAfterLast(hunk.body);
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2('error: parse ' + (i + 2));
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict, moves));
}

// --- SEARCH/REPLACE blocks (SPEC section 7) ---

function srEdit(path, oldLines, newLines, strict) {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    const f = splitFile(content);
    const found = findTier(f.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occs.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occs[0];
    const rep = buildN(
      f.lines,
      pos,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: false, oPos: -1 })),
      found.tier,
    );
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function parseSearchReplace(lines, strict) {
  const edits = [];
  let prevEnd = -1;
  let prevPath = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    let j = i + 1;
    while (j < n) {
      const t = lines[j].trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (eq === -1) throw new Exit2('error: parse ' + searchLine);
    let rep = -1;
    j = eq + 1;
    while (j < n) {
      const t = lines[j].trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (rep === -1) throw new Exit2('error: parse ' + searchLine);
    let path = null;
    for (let k = i - 1; k > prevEnd; k--) {
      const t = lines[k];
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2('error: parse ' + searchLine);
    }
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

// --- V4A patches (SPEC section 8) ---

/** Apply one V4A chunk to a file's lines; returns the cursor after the lines written. */
function applyV4aChunk(f, chunk, strict, path, cursor) {
  if (chunk.anchor !== null && chunk.anchor !== '') {
    const found = findTier(f.lines, [chunk.anchor], strict, cursor, false);
    if (found === null) throw new Fail('no-match', path);
    cursor = found.occs[0] + 1;
  }
  const { O, N } = bodyON(chunk.body);
  if (O.length === 0) {
    const at = chunk.eof ? f.lines.length : cursor;
    const ins = N.map((x) => x.text);
    f.lines.splice(at, 0, ...ins);
    return at + ins.length;
  }
  const found = findTier(f.lines, O, strict, cursor, chunk.eof);
  if (found === null) throw new Fail('no-match', path);
  const pos = found.occs[0];
  const rep = buildN(f.lines, pos, O, N, found.tier);
  f.lines.splice(pos, O.length, ...rep);
  return pos + rep.length;
}

function v4aEdit(sec, strict, moves) {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const content = tree.get(sec.path);
    if (content === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(content);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      cursor = applyV4aChunk(f, chunk, strict, sec.path, cursor);
    }
    const out = joinFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

function parseV4a(lines, strict, moves) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2('error: parse ' + (first + 1));
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last -= 1;
  if (last < 0 || lines[last].trim() !== '*** End Patch') throw new Exit2('error: parse ' + (lines.length + 1));
  const sections = [];
  let i = first + 1;
  const end = last;
  const isSectionStart = (l) => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    const l = lines[i];
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const sec = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), lines: [] };
      sections.push(sec);
      i += 1;
      const raw = [];
      while (i < end) {
        const x = lines[i];
        if (isSectionStart(x)) break;
        raw.push({ text: x, no: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1].text)) raw.pop();
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.lines.push(r.text.slice(1));
        else if (r.text === '') sec.lines.push('');
        else throw new Exit2('error: parse ' + r.no);
      }
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'delete', path: l.slice('*** Delete File: '.length).trim() });
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const sec = { kind: 'update', path: l.slice('*** Update File: '.length).trim(), moveTo: null, chunks: [] };
      sections.push(sec);
      const updateNo = i + 1;
      i += 1;
      if (i < end && lines[i].startsWith('*** Move to: ')) {
        sec.moveTo = lines[i].slice('*** Move to: '.length).trim();
        i += 1;
      }
      let cur = null;
      let started = false;
      const pushCur = () => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      while (i < end) {
        const x = lines[i];
        if (isSectionStart(x)) break;
        if (blank(x)) {
          if (cur !== null) {
            cur.body.push(x);
            i += 1;
            continue;
          }
          if (!started) {
            // The first chunk starts at a body line; a blank line is one.
            cur = { anchor: null, eof: false, body: [x] };
            started = true;
            i += 1;
            continue;
          }
          // Blank after a closed chunk (End of File): ignored.
          i += 1;
          continue;
        }
        if (x === '*** End of File') {
          if (cur === null) throw new Exit2('error: parse ' + (i + 1));
          cur.eof = true;
          sec.chunks.push(cur);
          cur = null;
          i += 1;
          continue;
        }
        if (x.startsWith('@@')) {
          pushCur();
          cur = { anchor: x.slice(2).trim(), eof: false, body: [] };
          started = true;
          i += 1;
          continue;
        }
        if (x === '' || x[0] === ' ' || x[0] === '-' || x[0] === '+') {
          if (cur === null) {
            // A body line starts only the first chunk; after a chunk closed
            // with `*** End of File` there is no open chunk for it.
            if (sec.chunks.length > 0) throw new Exit2('error: parse ' + (i + 1));
            cur = { anchor: null, eof: false, body: [] };
            started = true;
          }
          cur.body.push(x);
          i += 1;
          continue;
        }
        throw new Exit2('error: parse ' + (i + 1));
      }
      pushCur();
      if (sec.chunks.length > 0) {
        const lastChunk = sec.chunks[sec.chunks.length - 1];
        if (!lastChunk.eof) {
          while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1])) lastChunk.body.pop();
        }
        if (lastChunk.body.length === 0 && lastChunk.anchor === null && !lastChunk.eof) {
          // The chunk started at a body line that was only a trailing blank:
          // blank lines at the end of a section are not part of it, so the
          // chunk never started.
          sec.chunks.pop();
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2('error: parse ' + updateNo);
      continue;
    }
    throw new Exit2('error: parse ' + (i + 1));
  }
  return sections.map((sec) => v4aEdit(sec, strict, moves));
}

// --- JSON edits (SPEC section 9) ---

/** One JSON edit object (SPEC section 9), or a parse fault at `lineNo` when it is not one. */
function jsonEdit(v, lineNo) {
  const fault = () => {
    throw new Exit2('error: parse ' + lineNo);
  };
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fault();
  const p = v.path;
  if (typeof p !== 'string') fault();
  if (v.command === 'create' && typeof v.file_text === 'string') {
    const text = v.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (v.command === 'str_replace' && typeof v.old_str === 'string' && v.old_str !== '' && (v.new_str === undefined || typeof v.new_str === 'string')) {
    const oldStr = v.old_str;
    const newStr = v.new_str ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s) => (crlf ? s.replaceAll('\r\n', '\n') : s);
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
  if (v.command === 'insert' && typeof v.insert_line === 'number' && Number.isInteger(v.insert_line) && typeof v.new_str === 'string') {
    const line = v.insert_line;
    const add = patchLines(v.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
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
  fault();
}

function jsonEdits(text, lines) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2('error: parse ' + (first + 1));
    }
    if (!Array.isArray(v)) throw new Exit2('error: parse ' + (first + 1));
    for (const x of v) edits.push(jsonEdit(x, first + 1));
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let v;
    try {
      v = JSON.parse(l);
    } catch {
      throw new Exit2('error: parse ' + (i + 1));
    }
    edits.push(jsonEdit(v, i + 1));
  });
  return edits;
}

// --- Format detection (SPEC section 4) ---

function detect(lines) {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- The command line (SPEC sections 1, 2 and 10) ---

function run(args) {
  let format = null;
  let check = false;
  let strict = false;
  const pos = [];
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
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0];
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves = [];
  let edits;
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict, moves)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails = [];
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
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p);
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const movesByOld = new Map(moves.map(([o, nw]) => [o, nw]));
  const movedNews = new Map(moves.map(([o, nw]) => [nw, o]));
  const rowObjs = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p);
    if (was === now) continue;
    if (movesByOld.has(p)) continue; // its `D` line is replaced by the `R` line below
    if (movedNews.has(p)) rowObjs.push({ sortKey: p, line: `R ${movedNews.get(p)} -> ${p}` });
    else rowObjs.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowObjs.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const rows = rowObjs.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

// --- Trial hand-over ---
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts: keep that hand-over and runner.ts as they are.

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
