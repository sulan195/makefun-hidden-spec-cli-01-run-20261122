// Edge-case suite for mend (main.ts), beyond the kit's 100 practice checks.
// Run: node dev/test_mend.mjs
// Each case runs `node main.ts` in a fresh temp dir and compares exit code,
// stdout and every resulting file exactly.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');

const cases = [
  {
    name: 'crlf-hunk-keeps-crlf',
    args: ['p.patch'],
    files: { 'a.txt': 'one\r\ntwo\r\nthree\r\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\r\nTWO\r\nthree\r\n' } },
  },
  {
    name: 'noeol-preserved',
    args: ['p.patch'],
    files: { 'a.txt': 'one\ntwo', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+TWO\n\\ No newline at end of file\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\nTWO' } },
  },
  {
    name: 'wrong-line-numbers-nearest',
    args: ['p.patch'],
    files: { 'a.txt': 'alpha\nbeta\ngamma\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -50,1 +50,1 @@\n-beta\n+BETA\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'alpha\nBETA\ngamma\n' } },
  },
  {
    name: 'duplicate-nearest-not-ambiguous',
    args: ['p.patch'],
    files: { 'a.txt': 'x\nsame\nx\nsame\ny\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -4,1 +4,1 @@\n-same\n+SAME\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'x\nsame\nx\nSAME\ny\n' } },
  },
  {
    name: 'sr-ambiguous-twice',
    args: ['p.patch'],
    files: { 'a.txt': 'foo\nbar\nfoo\n', 'p.patch': 'a.txt\n```\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n```\n' },
    expect: { code: 1, stdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'foo\nbar\nfoo\n' } },
  },
  {
    name: 'sr-overlap-counts',
    args: ['p.patch'],
    files: { 'a.txt': 'aa\naa\naa\n', 'p.patch': 'a.txt\n```\n<<<<<<< SEARCH\naa\naa\n=======\nb\n>>>>>>> REPLACE\n```\n' },
    expect: { code: 1, stdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'aa\naa\naa\n' } },
  },
  {
    name: 'tier1-trailing-ws',
    args: ['p.patch'],
    files: { 'a.txt': 'one   \ntwo\t\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one   \nTWO\n' } },
  },
  {
    name: 'tier2-reindent',
    args: ['p.patch'],
    files: { 'a.txt': '    indented\n    next\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n indented\n-next\n+    NEXT\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': '    indented\n        NEXT\n' } },
  },
  {
    name: 'strict-rejects-tier2',
    args: ['--strict', 'p.patch'],
    files: { 'a.txt': '    indented\n    next\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n indented\n-next\n+    NEXT\n' },
    expect: { code: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': '    indented\n    next\n' } },
  },
  {
    name: 'empty-o-insert-top-and-past-eof',
    args: ['p.patch'],
    files: { 'a.txt': 'one\ntwo\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+ZERO\n@@ -99,0 +3,1 @@\n+THREE\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'ZERO\none\ntwo\nTHREE\n' } },
  },
  {
    name: 'create-nested-dir',
    args: ['p.patch'],
    files: { 'p.patch': '--- /dev/null\n+++ b/deep/nest/new.txt\n@@ -0,0 +1,1 @@\n+hello\n' },
    expect: { code: 0, stdout: 'A deep/nest/new.txt\nok: 1 file\n', files: { 'deep/nest/new.txt': 'hello\n' } },
  },
  {
    name: 'delete-file',
    args: ['p.patch'],
    files: { 'a.txt': 'gone\n', 'p.patch': '--- a/a.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n' },
    expect: { code: 0, stdout: 'D a.txt\nok: 1 file\n', files: { 'a.txt': null } },
  },
  {
    name: 'rename-r-row',
    args: ['p.patch'],
    files: { 'old.txt': 'data\n', 'p.patch': 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n' },
    expect: { code: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', files: { 'old.txt': null, 'new.txt': 'data\n' } },
  },
  {
    name: 'unsafe-path',
    args: ['p.patch'],
    files: { 'p.patch': '--- a/../evil.txt\n+++ b/../evil.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n' },
    expect: { code: 1, stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', files: {} },
  },
  {
    name: 'prose-and-fence-wrapped',
    args: ['p.patch'],
    files: { 'a.txt': 'one\ntwo\n', 'p.patch': 'Here is the fix you asked for:\n\n```diff\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n```\n\nHope that helps!\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\nTWO\n' } },
  },
  {
    name: 'blank-context-line',
    args: ['p.patch'],
    files: { 'a.txt': 'one\n\nthree\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n\n-three\n+THREE\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\n\nTHREE\n' } },
  },
  {
    name: 'v4a-anchor-and-cursor',
    args: ['p.patch'],
    files: { 'a.txt': 'head\nmark one\ntail\nmark two\nend\n', 'p.patch': '*** Begin Patch\n*** Update File: a.txt\n@@ mark one\n tail\n+after tail\n@@ mark two\n end\n+after end\n*** End Patch\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'head\nmark one\ntail\nafter tail\nmark two\nend\nafter end\n' } },
  },
  {
    name: 'v4a-eof-chunk',
    args: ['p.patch'],
    files: { 'a.txt': 'one\ntwo\n', 'p.patch': '*** Begin Patch\n*** Update File: a.txt\n@@ two\n+three\n*** End of File\n*** End Patch\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\ntwo\nthree\n' } },
  },
  {
    name: 'v4a-move-to',
    args: ['p.patch'],
    files: { 'src.txt': 'data\n', 'p.patch': '*** Begin Patch\n*** Update File: src.txt\n*** Move to: dst.txt\n*** End Patch\n' },
    expect: { code: 0, stdout: 'R src.txt -> dst.txt\nok: 1 file\n', files: { 'src.txt': null, 'dst.txt': 'data\n' } },
  },
  {
    name: 'v4a-add-delete',
    args: ['p.patch'],
    files: { 'gone.txt': 'x\n', 'p.patch': '*** Begin Patch\n*** Add File: new.txt\n+fresh\n*** Delete File: gone.txt\n*** End Patch\n' },
    expect: { code: 0, stdout: 'D gone.txt\nA new.txt\nok: 2 files\n', files: { 'new.txt': 'fresh\n', 'gone.txt': null } },
  },
  {
    name: 'json-insert-bounds',
    args: [],
    stdin: '[{"path":"a.txt","command":"insert","insert_line":2,"new_str":"end"},{"path":"a.txt","command":"insert","insert_line":0,"new_str":"start"}]',
    files: { 'a.txt': 'one\ntwo\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'start\none\ntwo\nend\n' } },
  },
  {
    name: 'json-insert-out-of-bounds',
    args: [],
    stdin: '[{"path":"a.txt","command":"insert","insert_line":99,"new_str":"x"}]',
    files: { 'a.txt': 'one\n' },
    expect: { code: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'one\n' } },
  },
  {
    name: 'jsonl-bad-line-2',
    args: [],
    stdin: '{"path":"a.txt","command":"str_replace","old_str":"one","new_str":"1"}\n{"path":"a.txt","command":"bogus"}\n',
    files: { 'a.txt': 'one\n' },
    expect: { code: 2, stdout: 'error: parse 2\n', files: { 'a.txt': 'one\n' } },
  },
  {
    name: 'json-create-existing',
    args: [],
    stdin: '[{"path":"a.txt","command":"create","file_text":"new"}]',
    files: { 'a.txt': 'old\n' },
    expect: { code: 1, stdout: 'error: exists a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'old\n' } },
  },
  {
    name: 'check-writes-nothing',
    args: ['--check', 'p.patch'],
    files: { 'a.txt': 'one\ntwo\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\ntwo\n' } },
  },
  {
    name: 'multi-edit-atomicity',
    args: ['p.patch'],
    files: { 'a.txt': 'one\n', 'b.txt': 'two\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n--- a/missing.txt\n+++ b/missing.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n' },
    expect: { code: 1, stdout: 'error: missing missing.txt\nfailed: 1 of 2 edits\n', files: { 'a.txt': 'one\n', 'b.txt': 'two\n' } },
  },
  {
    name: 'sequential-edits-same-file',
    args: ['p.patch'],
    files: { 'a.txt': 'one\ntwo\nthree\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n--- a/a.txt\n+++ b/a.txt\n@@ -3,1 +3,1 @@\n-three\n+THREE\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'ONE\ntwo\nTHREE\n' } },
  },
  {
    name: 'empty-patch-auto',
    args: ['p.patch'],
    files: { 'p.patch': 'Just some prose, no patch here.\n' },
    expect: { code: 2, stdout: 'error: format\n', files: {} },
  },
  {
    name: 'empty-patch-forced-unified',
    args: ['--format=unified', 'p.patch'],
    files: { 'p.patch': 'Just some prose, no patch here.\n' },
    expect: { code: 2, stdout: 'error: parse 1\n', files: {} },
  },
  {
    name: 'json-empty-array',
    args: ['--format=json'],
    stdin: '[]',
    files: {},
    expect: { code: 2, stdout: 'error: parse 1\n', files: {} },
  },
  {
    name: 'unicode-byte-sort',
    args: ['p.patch'],
    files: { 'é.txt': 'e\n', 'z.txt': 'z\n', 'p.patch': '--- a/z.txt\n+++ b/z.txt\n@@ -1,1 +1,1 @@\n-z\n+Z\n--- a/é.txt\n+++ b/é.txt\n@@ -1,1 +1,1 @@\n-e\n+E\n' },
    expect: { code: 0, stdout: 'M z.txt\nM é.txt\nok: 2 files\n', files: { 'é.txt': 'E\n', 'z.txt': 'Z\n' } },
  },
  {
    name: 'context-only-hunk',
    args: ['p.patch'],
    files: { 'a.txt': 'one\ntwo\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n two\n' },
    expect: { code: 0, stdout: 'ok: 0 files\n', files: { 'a.txt': 'one\ntwo\n' } },
  },
  {
    name: 'backslash-after-del-eof',
    args: ['p.patch'],
    files: { 'a.txt': 'one\ntwo', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,1 @@\n one\n-two\n\\ No newline at end of file\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\n' } },
  },
  {
    name: 'sr-create-empty-old',
    args: ['p.patch'],
    files: { 'p.patch': 'new.txt\n```\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n```\n' },
    expect: { code: 0, stdout: 'A new.txt\nok: 1 file\n', files: { 'new.txt': 'hello\n' } },
  },
  {
    name: 'sr-missing-path-parse',
    args: ['p.patch'],
    files: { 'p.patch': '```\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n```\n' },
    expect: { code: 2, stdout: 'error: parse 2\n', files: {} },
  },
  {
    name: 'no-patch-file',
    args: ['does-not-exist.patch'],
    files: {},
    expect: { code: 2, stdout: 'error: no-patch\n', files: {} },
  },
  {
    name: 'usage-two-positionals',
    args: ['a.patch', 'b.patch'],
    files: {},
    expect: { code: 2, stdout: 'error: usage\n', files: {} },
  },
  {
    name: 'json-str-replace-second-nomatch',
    args: [],
    stdin: '[{"path":"a.txt","command":"str_replace","old_str":"foo","new_str":"bar"},{"path":"a.txt","command":"str_replace","old_str":"foo","new_str":"baz"}]',
    files: { 'a.txt': 'foo\n', 'p.patch': '' },
    expect: { code: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 2 edits\n', files: { 'a.txt': 'foo\n' } },
  },
  {
    name: 'create-empty-mode-number-only',
    args: ['p.patch'],
    files: { 'p.patch': 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n' },
    expect: { code: 0, stdout: 'A empty.txt\nok: 1 file\n', files: { 'empty.txt': '' } },
  },
  {
    name: 'delete-empty-mode-number-only',
    args: ['p.patch'],
    files: { 'gone.txt': 'x\n', 'p.patch': 'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n' },
    expect: { code: 0, stdout: 'D gone.txt\nok: 1 file\n', files: { 'gone.txt': null } },
  },
  {
    name: 'insert-after-negative-delta-clamped',
    args: ['p.patch'],
    files: { 'a.txt': 'a\nb\nc\nd\ne\nf\n', 'p.patch': '--- a/a.txt\n+++ b/a.txt\n@@ -1,5 +1,0 @@\n-a\n-b\n-c\n-d\n-e\n@@ -1,0 +1,1 @@\n+X\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'X\nf\n' } },
  },
  {
    name: 'nul-path-unsafe',
    args: ['p.patch'],
    files: { 'p.patch': '--- a/a\0b.txt\n+++ b/a\0b.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n' },
    expect: { code: 1, stdout: 'error: unsafe a\0b.txt\nfailed: 1 of 1 edits\n', files: {} },
  },
  {
    name: 'sr-crlf-preserved',
    args: ['p.patch'],
    files: { 'a.txt': 'one\r\ntwo\r\n', 'p.patch': 'a.txt\n```\n<<<<<<< SEARCH\ntwo\n=======\nTWO\n>>>>>>> REPLACE\n```\n' },
    expect: { code: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\r\nTWO\r\n' } },
  },
];

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(dir.length + 1)] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

let passed = 0;
const failures = [];
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-test-'));
  try {
    for (const [p, content] of Object.entries(c.files)) {
      const fp = join(dir, p);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, content, 'utf8');
    }
    const r = spawnSync('node', [MAIN, ...c.args], { cwd: dir, input: c.stdin ?? null, encoding: 'utf8' });
    const after = snapshot(dir);
    const problems = [];
    if (r.status !== c.expect.code) problems.push(`exit ${r.status}, expected ${c.expect.code}`);
    if ((r.stdout ?? '') !== c.expect.stdout) problems.push(`stdout ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(c.expect.stdout)}`);
    for (const [p, content] of Object.entries(c.expect.files)) {
      if (content === null) {
        if (p in after) problems.push(`${p} should not exist`);
      } else if (after[p] !== content) problems.push(`${p} = ${JSON.stringify(after[p])}, expected ${JSON.stringify(content)}`);
    }
    if (problems.length === 0) passed++;
    else failures.push(`${c.name}: ${problems.join('; ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`${passed} of ${cases.length} edge cases passed`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
