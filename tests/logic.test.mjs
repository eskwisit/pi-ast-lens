import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import {
	extOf, globExts, normalizeLang, serverSpecFor, inferSgLang, dominantLang, findRoot, tsMajor,
	completeRule, parseFrames, frame, locate, normLocations, hoverText, formatSymbols, formatSgMatches,
	grepTargetsCode, readConfig, CODE_EXTS, planLaunch, shimTarget, cmdArg, installHint, isInside, pathKey, candidateFiles,
	showLine, limitOf, formatGrouped, parseGrepResult, grepIdentifier, formatGrepResult, declaresName, tagOf, textKindRules,
	symbolMatches, enclosing, flattenSymbols, formatFunctions, isTestFile, groupRssMb, kindsOf, symbolOnLine, rewriteGrep, TOOLS, _test, applyEdits, workspaceEdits, mayImport,
	indexEntry, indexLookup, mainDeclarations, formatIndexOutline, formatIndexDir, tsDroppedOptions,
} from "../extension/ast-lens.js";
import { debugKind, parseBreakpoint, urlPattern, formatSnapshot } from "../extension/debug.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-"));
const write = (dir, rel, text = "") => {
	const p = path.join(dir, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, text);
	return p;
};

test("extOf and globExts read extensions", () => {
	assert.equal(extOf("src/App.TSX"), "tsx");
	assert.equal(extOf(".gitignore"), "");
	assert.equal(extOf("Makefile"), "");
	assert.deepEqual(globExts("src/**/*.{ts, tsx}"), ["ts", "tsx"]);
	assert.deepEqual(globExts(["*.py", "!**/vendor/**"]), ["py"]);
});

test("normalizeLang maps aliases", () => {
	assert.equal(normalizeLang("TS"), "typescript");
	assert.equal(normalizeLang("golang"), "go");
	assert.equal(normalizeLang(""), "");
	assert.equal(normalizeLang("nim"), "nim");
});

test("serverSpecFor picks by extension and honours overrides", () => {
	assert.equal(serverSpecFor("py").name, "python");
	assert.equal(serverSpecFor("hpp").id("hpp"), "cpp");
	assert.equal(serverSpecFor("tsx").id("tsx"), "typescriptreact");
	assert.equal(serverSpecFor("xyz"), null);
	const o = serverSpecFor("py", { py: ["my-ls", "--stdio"] });
	assert.deepEqual(o.candidates, [{ cmd: "my-ls", args: ["--stdio"], install: "from your AST Lens config" }]);
	assert.equal(serverSpecFor("xyz", { ".xyz": ["x-ls"] }).candidates[0].cmd, "x-ls");
});

test("inferSgLang: explicit, file, glob, then dominant language", () => {
	const d = tmp();
	write(d, "a.py");
	write(d, "b.py");
	write(d, "c.go");
	write(d, "node_modules/x/many.js");
	const file = write(d, "x.rs");
	assert.equal(inferSgLang({ lang: "ts", target: d }).lang, "typescript");
	assert.equal(inferSgLang({ target: file }).lang, "rust");
	assert.equal(inferSgLang({ target: d, globs: ["**/*.go"] }).lang, "go");
	assert.equal(inferSgLang({ target: d }).lang, "python");
	assert.deepEqual(dominantLang(d).ranked[0], ["python", 2]);
	assert.equal(inferSgLang({ target: tmp() }).lang, "");
});

test("findRoot stops at the nearest marker, and at cwd", () => {
	const d = tmp();
	write(d, "pkg/go.mod");
	const f = write(d, "pkg/sub/main.go");
	assert.equal(findRoot(f, ["go.mod"], d), path.join(d, "pkg"));
	assert.equal(findRoot(f, ["Cargo.toml"], d), d);
	write(d, "proj/App.csproj");
	assert.equal(findRoot(write(d, "proj/a/b.cs"), ["*.csproj"], d), path.join(d, "proj"));
});

test("findRoot with outermost takes the highest marker up to cwd", () => {
	const d = tmp();
	write(d, "package.json", "{}");
	write(d, "libs/a/tsconfig.json", "{}");
	const f = write(d, "libs/a/src/x.ts");
	const markers = ["tsconfig.json", "package.json"];
	assert.equal(findRoot(f, markers, d), path.join(d, "libs", "a"));
	assert.equal(findRoot(f, markers, d, true), d);
	assert.equal(findRoot(f, markers, path.join(d, "libs"), true), path.join(d, "libs", "a"));
	const outside = tmp();
	write(outside, "tsconfig.json", "{}");
	const g = write(outside, "src/y.ts");
	assert.equal(findRoot(g, markers, d, true), outside, "a file outside cwd keeps the nearest marker");
});

test("candidateFiles finds whole-word uses in the server's files only", () => {
	const d = tmp();
	const a = write(d, "a.ts", "export function thing() {}\n");
	const b = write(d, "b/use.ts", "thing();\n");
	write(d, "b/other.ts", "something(); thingy();\n");
	write(d, "b/readme.md", "thing\n");
	write(d, "node_modules/x/index.ts", "thing();\n");
	write(d, ".cache/y.ts", "thing();\n");
	const found = candidateFiles(d, "thing", ["ts"], a).map((f) => path.relative(d, f));
	assert.deepEqual(found, [path.relative(d, b)]);
	assert.deepEqual(candidateFiles(d, "$x", ["ts"], ""), []);
	assert.deepEqual(candidateFiles(d, "a.b", ["ts"], ""), [], "only identifiers");
});

test("tsMajor reads the project's TypeScript version", () => {
	const d = tmp();
	assert.equal(tsMajor(d), 0);
	write(d, "node_modules/typescript/package.json", JSON.stringify({ version: "7.0.2" }));
	assert.equal(tsMajor(path.join(d, "src")), 7);
});

test("completeRule wraps a bare body and keeps a full rule", () => {
	assert.equal(completeRule("kind: call_expression", "go"), "id: ast-lens-query\nlanguage: go\nrule:\n  kind: call_expression");
	const full = "id: r\nlanguage: python\nrule:\n  pattern: print($$$)";
	assert.equal(completeRule(full, ""), full);
	assert.equal(completeRule("kind: x", ""), null);
});

test("parseFrames splits framed messages and keeps a partial rest", () => {
	const a = frame({ id: 1, result: "é" });
	const b = frame({ method: "x" });
	const all = Buffer.concat([a, b]);
	const cut = all.length - 3;
	const r1 = parseFrames(all.subarray(0, cut));
	assert.deepEqual(r1.messages, [{ id: 1, result: "é" }]);
	const r2 = parseFrames(Buffer.concat([r1.rest, all.subarray(cut)]));
	assert.deepEqual(r2.messages, [{ method: "x" }]);
	assert.equal(r2.rest.length, 0);
});

test("locate finds a symbol near the line, or uses line and column", () => {
	const text = "const fooBar = 1;\nfoo(fooBar);\n\n\nlet x = foo;";
	assert.deepEqual(locate(text, { line: 2, symbol: "foo" }), { line: 1, character: 0 });
	assert.deepEqual(locate(text, { line: 2, symbol: "fooBar" }), { line: 1, character: 4 });
	assert.deepEqual(locate(text, { line: 1, symbol: "foo" }), { line: 1, character: 0 });
	assert.deepEqual(locate(text, { symbol: "x" }), { line: 4, character: 4 });
	assert.deepEqual(locate(text, { line: 2, column: 5 }), { line: 1, character: 4 });
	assert.deepEqual(locate("  bar()", { line: 1 }), { line: 0, character: 2 });
	assert.throws(() => locate(text, { line: 1, symbol: "nope" }), /not on/);
	assert.throws(() => locate(text, { line: 9 }), /has 5 lines/);
	assert.throws(() => locate(text, {}), /Give `line`/);
});

test("normLocations accepts Location, Location[] and LocationLink[], deduplicated", () => {
	const d = tmp();
	const a = fs.realpathSync.native(write(d, "a.ts"));
	const b = fs.realpathSync.native(write(d, "b.ts"));
	const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } };
	const uri = (p) => url.pathToFileURL(p).href;
	assert.deepEqual(normLocations({ uri: uri(a), range }), [{ file: a, line: 2, character: 4 }]);
	assert.deepEqual(normLocations([{ targetUri: uri(b), targetRange: range, targetSelectionRange: { start: { line: 3, character: 1 } } }]), [{ file: b, line: 3, character: 1 }]);
	assert.equal(normLocations([{ uri: uri(a), range }, { uri: uri(path.join(d, ".", "a.ts")), range }]).length, 1);
	assert.deepEqual(normLocations(null), []);
});

test("hoverText handles every hover shape", () => {
	assert.equal(hoverText({ contents: { kind: "markdown", value: "**x**" } }), "**x**");
	assert.equal(hoverText({ contents: [{ language: "ts", value: "let x" }, "doc"] }), "```ts\nlet x\n```\n\ndoc");
	assert.equal(hoverText(null), "");
});

test("formatSymbols prints a tree for DocumentSymbol[]", () => {
	const r = { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } };
	const out = formatSymbols([{ name: "A", kind: 5, range: r, selectionRange: r, children: [{ name: "m", kind: 6, range: r }] }], "/");
	assert.equal(out, "class A  L1-10\n  method m  L1-10");
	assert.equal(formatSymbols([], "/"), "");
});

test("formatSgMatches prints locations, captures and rewrites", () => {
	const m = {
		file: "src/a.js", text: "add(1, 2)", lines: "x = add(1, 2)", replacement: "sum(1, 2)",
		range: { start: { line: 4, column: 4 } },
		metaVariables: { single: { A: { text: "1" } }, multi: { R: [{ text: "a" }, { text: "," }, { text: "b" }] } },
	};
	assert.equal(formatSgMatches([m], "/w", { rewrite: true }), "src/a.js\n5:5: x = add(1, 2)\n  $A=1  $$$R=[a, b]\n  - add(1, 2)\n  + sum(1, 2)");
	assert.equal(formatSgMatches([m, { ...m, file: "src/b.js" }], "/w", { output: "count" }), "src/a.js: 1\nsrc/b.js: 1");
});

test("grepTargetsCode flags code searches only", () => {
	for (const input of [
		{ pattern: "handleRequest" },
		{ pattern: "\\bUserService\\b", include: "*.ts" },
		{ pattern: "function parseArgs" },
		{ pattern: "fetchUser\\(" },
		{ pattern: "os.path.join", path: "src/x.py" },
		{ pattern: "class Foo" },
	]) assert.equal(grepTargetsCode(input), true, JSON.stringify(input));
	for (const input of [
		{ pattern: "connection refused" },
		{ pattern: "TODO" },
		{ pattern: "handleRequest", include: "*.md" },
		{ pattern: "version", path: "package.json" },
		{ pattern: "import foo from 'bar'" },
		{ pattern: "" },
		{ pattern: "ab" },
	]) assert.equal(grepTargetsCode(input), false, JSON.stringify(input));
});

test("CODE_EXTS has code and not data formats", () => {
	for (const e of ["ts", "py", "go", "rs", "swift", "vue"]) assert.ok(CODE_EXTS.has(e), e);
	for (const e of ["json", "yaml", "md", "css", "html"]) assert.ok(!CODE_EXTS.has(e), e);
});

test("readConfig falls back to steer on a missing or bad file", () => {
	const d = tmp();
	assert.deepEqual(readConfig(path.join(d, "none.json")), { mode: "steer", servers: {}, maxRssMb: 0, prewarm: true });
	const f = write(d, "c.json", JSON.stringify({ mode: "off", servers: { py: ["x"] }, maxRssMb: 1500, prewarm: false }));
	assert.deepEqual(readConfig(f), { mode: "off", servers: { py: ["x"] }, maxRssMb: 1500, prewarm: false });
	assert.equal(readConfig(write(d, "strict.json", JSON.stringify({ mode: "strict" }))).mode, "steer", "strict (0.3) is gone: Grep is never blocked");
	assert.equal(readConfig(write(d, "bad.json", JSON.stringify({ mode: "loud", maxRssMb: -3 }))).maxRssMb, 0);
});

// Windows launching is pure logic, so it is tested on every platform.
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\typescript-language-server\\lib\\cli.mjs" %*
`;
const PNPM_SHIM = `@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\pyright\\langserver.index.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\pyright\\langserver.index.js" %*\r\n)\r\n`;
const EXE_SHIM = `@ECHO off\r\n"%~dp0\\node_modules\\@ast-grep\\cli\\ast-grep.exe"   %*\r\n`;
const NPM = "C:\\Users\\u\\AppData\\Roaming\\npm";

test("shimTarget finds the program an npm, pnpm or native shim wraps", () => {
	assert.equal(shimTarget(`${NPM}\\typescript-language-server.cmd`, NPM_SHIM), `${NPM}\\node_modules\\typescript-language-server\\lib\\cli.mjs`);
	assert.equal(shimTarget("C:\\p\\.bin\\pyright-langserver.cmd", PNPM_SHIM), "C:\\p\\pyright\\langserver.index.js");
	assert.equal(shimTarget(`${NPM}\\ast-grep.cmd`, EXE_SHIM), `${NPM}\\node_modules\\@ast-grep\\cli\\ast-grep.exe`);
	assert.equal(shimTarget("C:\\x\\run.bat", "@echo off\r\njava -jar server.jar %*"), null);
});

test("planLaunch on Windows runs shims without a shell", () => {
	const files = { [`${NPM}\\typescript-language-server.cmd`]: NPM_SHIM, [`${NPM}\\ast-grep.cmd`]: EXE_SHIM };
	const o = { platform: "win32", node: "C:\\node\\node.exe", execPath: "C:\\PI\\PI.exe", comspec: "C:\\Windows\\cmd.exe", head: (f) => files[f] ?? "", exists: () => true };
	assert.deepEqual(planLaunch(`${NPM}\\typescript-language-server.cmd`, ["--stdio"], o), {
		file: "C:\\node\\node.exe", args: [`${NPM}\\node_modules\\typescript-language-server\\lib\\cli.mjs`, "--stdio"], env: {},
	});
	// No node installed: PI-Desktop's own runtime runs the script.
	const viaPi = planLaunch(`${NPM}\\typescript-language-server.cmd`, ["--stdio"], { ...o, node: null });
	assert.equal(viaPi.file, "C:\\PI\\PI.exe");
	assert.deepEqual(viaPi.env, { ELECTRON_RUN_AS_NODE: "1" });
	// A native binary behind the shim gets the pattern as one untouched argument.
	const pattern = 'foo($A) | bar("%x%") & $$$';
	assert.deepEqual(planLaunch(`${NPM}\\ast-grep.cmd`, ["run", "--pattern", pattern], o), {
		file: `${NPM}\\node_modules\\@ast-grep\\cli\\ast-grep.exe`, args: ["run", "--pattern", pattern], env: {},
	});
	assert.deepEqual(planLaunch("C:\\bin\\gopls.exe", [], o), { file: "C:\\bin\\gopls.exe", args: [], env: {} });
});

test("planLaunch on Windows sends other batch files through cmd.exe, escaped", () => {
	const o = { platform: "win32", node: null, execPath: "x", comspec: "C:\\Windows\\cmd.exe", head: () => "@echo off", exists: () => false };
	const p = planLaunch("C:\\elixir-ls\\language_server.bat", ["a b", 'q"&|'], o);
	assert.equal(p.file, "C:\\Windows\\cmd.exe");
	assert.equal(p.verbatim, true);
	assert.deepEqual(p.args.slice(0, 3), ["/d", "/s", "/c"]);
	assert.equal(p.args[3], `"C:\\elixir-ls\\language_server.bat ${cmdArg("a b")} ${cmdArg('q"&|')}"`);
	assert.equal(cmdArg("a&b"), '^^^"a^^^&b^^^"');
	assert.equal(cmdArg('say "hi"'), '^^^"say^^^ \\^^^"hi\\^^^"^^^"');
});

test("planLaunch on macOS and Linux runs binaries directly, node scripts with a node", () => {
	const o = { platform: "linux", node: null, execPath: "/opt/PI/pi", head: (f) => (f.endsWith("tls") ? "#!/usr/bin/env node\n" : "\x7fELF"), exists: () => true };
	assert.deepEqual(planLaunch("/usr/bin/clangd", ["--x"], o), { file: "/usr/bin/clangd", args: ["--x"], env: {} });
	assert.deepEqual(planLaunch("/home/u/bin/tls", ["--stdio"], o), { file: "/opt/PI/pi", args: ["/home/u/bin/tls", "--stdio"], env: { ELECTRON_RUN_AS_NODE: "1" } });
	assert.deepEqual(planLaunch("/home/u/bin/tls", ["--stdio"], { ...o, node: "/usr/bin/node", platform: "darwin" }), { file: "/home/u/bin/tls", args: ["--stdio"], env: {} });
});

test("installHint picks the platform's line", () => {
	const h = { darwin: "brew", win32: "winget", any: "release" };
	assert.equal(installHint(h, "darwin"), "brew");
	assert.equal(installHint(h, "win32"), "winget");
	assert.equal(installHint(h, "linux"), "release");
	assert.equal(installHint("npm i -g x", "win32"), "npm i -g x");
});

test("isInside and pathKey compare paths on this platform", () => {
	const d = tmp();
	assert.equal(isInside(d, path.join(d, "a", "b")), true);
	assert.equal(isInside(d, d), true);
	assert.equal(isInside(d, path.join(d, "..", "other")), false);
	assert.equal(isInside(path.join(d, "a"), path.join(d, "a..b")), false);
	assert.equal(isInside(d, path.join(d, "..foo")), true);
	assert.equal(pathKey(path.join(d, ".", "x")), pathKey(path.join(d, "x")));
});

// Output format
// =============

test("showLine keeps a line up to 200 characters and cuts a longer one around the match", () => {
	assert.equal(showLine("\tconst x = 1;\r"), "const x = 1;");
	const long = `  ${"a".repeat(300)}NAME${"b".repeat(300)}`;
	const s = showLine(long, 302);
	assert.ok(s.includes("NAME") && s.startsWith("…") && s.endsWith("…"), s);
	assert.equal(s.length, 202);
	assert.equal(showLine("x".repeat(200)), "x".repeat(200));
});

test("limitOf takes 1 to 500, else the default", () => {
	assert.deepEqual([limitOf("7"), limitOf(0), limitOf(9999), limitOf(undefined), limitOf("x", 10)], [7, 50, 500, 50, 10]);
});

test("formatGrouped prints each path once, joins hits on one line, and counts the rest", () => {
	const hits = [
		{ path: "a.ts", line: 1, col: 2, text: "f(x)" },
		{ path: "a.ts", line: 1, col: 7, text: "f(x)" },
		{ path: "a.ts", line: 3, text: "g()", note: "in main" },
		{ path: "b.ts", line: 9, col: 1, text: "h()" },
	];
	assert.equal(formatGrouped(hits), "a.ts\n1:2,7: f(x)\n3: g()  in main\nb.ts\n9:1: h()");
	assert.equal(formatGrouped(hits, { limit: 3 }), "a.ts\n1:2,7: f(x)\n3: g()  in main\n[1 more in 1 file; raise limit or narrow the path]");
	assert.equal(formatGrouped(hits, { output: "count" }), "a.ts: 3\nb.ts: 1");
	assert.equal(formatGrouped(hits, { output: "files", limit: 1 }), "a.ts\n[1 more file; raise limit]");
});

// Grep results
// ============

test("grepIdentifier takes the identifier of a plain code search only", () => {
	assert.equal(grepIdentifier({ pattern: "\\bparseConfig\\b" }), "parseConfig");
	assert.equal(grepIdentifier({ pattern: "this.store.get" }), "get");
	for (const input of [{ pattern: "connection refused" }, { pattern: "TODO" }, { pattern: "x" }, { pattern: "foo", outputMode: "files_with_matches" }, { pattern: "foo", context: 2 }]) {
		assert.equal(grepIdentifier(input), "", JSON.stringify(input));
	}
});

test("parseGrepResult reads pi lines and PI-Desktop JSON, and leaves other shapes alone", () => {
	assert.deepEqual(parseGrepResult("src/a.ts:3: f(x)\nsrc/b.ts:9: y\n\n[Showing 2 of 9]"), {
		json: false, hits: [{ path: "src/a.ts", line: 3, text: "f(x)" }, { path: "src/b.ts", line: 9, text: "y" }], tags: {}, notes: ["[Showing 2 of 9]"],
	});
	const j = parseGrepResult(JSON.stringify({ matches: [{ path: "a.js", line: 2, text: "f()" }], tags: { "a.js": "1A2B" }, notice: "cut" }));
	assert.deepEqual(j, { json: true, hits: [{ path: "a.js", line: 2, text: "f()" }], tags: { "a.js": "1A2B" }, notes: ["cut"] });
	assert.equal(parseGrepResult("src/a.ts-3- context\nsrc/a.ts:4: y"), null, "context lines");
	assert.equal(parseGrepResult("src/a.ts\nsrc/b.ts"), null, "a file list");
	assert.equal(parseGrepResult("{ not json"), null);
});

test("declaresName spots declarations, not calls", () => {
	for (const [line, name] of [["export function foo(a) {", "foo"], ["static int add(int a, int b) {", "add"], ["class Foo extends Bar {", "Foo"], ["const foo = () => 1", "foo"], ["func (s *S) Foo(x int) error {", "Foo"], ["def foo(x):", "foo"], ["  async foo(x: number): Promise<void> {", "foo"], ["#define MAX 10", "MAX"]]) {
		assert.equal(declaresName(line, name), true, line);
	}
	for (const [line, name] of [["  foo(a);", "foo"], ["return add(1, 2);", "add"], ["if (foo(x)) {", "foo"], ["x = foo(y)", "foo"], ["new Foo()", "Foo"]]) {
		assert.equal(declaresName(line, name), false, line);
	}
});

test("tagOf takes the innermost comment, string or code-in-string around a position", () => {
	const spans = [{ tag: "string", a: [0, 5], b: [0, 20] }, { tag: "code", a: [0, 8], b: [0, 12] }, { tag: "comment", a: [2, 0], b: [4, 2] }];
	assert.equal(tagOf(spans, 0, 6), "string");
	assert.equal(tagOf(spans, 0, 9), "code", "a ${template} substitution is code");
	assert.equal(tagOf(spans, 0, 20), "code", "the end is exclusive");
	assert.equal(tagOf(spans, 3, 50), "comment", "a block comment over lines");
	assert.match(textKindRules(["c"]), /^id: comment-c\nlanguage: c\nrule:\n {2}any:\n {4}- kind: comment\n---\nid: string-c/);
});

test("formatGrepResult groups hits, collapses comment and string hits, and marks declarations", () => {
	const parsed = {
		hits: [
			{ path: "a.ts", line: 9, text: "  // add is fast", tag: "comment" },
			{ path: "a.ts", line: 2, text: "export function add(a, b) {", tag: "code" },
			{ path: "a.ts", line: 5, text: "  return add(1, 2);", tag: "code" },
			{ path: "b.ts", line: 1, text: 'log("add")', tag: "string" },
		],
		tags: { "a.ts": "AB12" },
		notes: ["[Showing 4 of 4]"],
	};
	assert.equal(formatGrepResult(parsed, "add", { tagged: true, pattern: "add" }), [
		"a.ts#AB12",
		"2: export function add(a, b) {  ← definition",
		"5: return add(1, 2);",
		"1 in comments/strings: line 9",
		"b.ts",
		"1 in comments/strings: line 1",
		'[Grep "add": 4 hits in 2 files; 2 in comments or strings shown as line numbers only (Read them for the text)]',
		"[Showing 4 of 4]",
	].join("\n"));
	const plain = formatGrepResult({ ...parsed, tags: {}, notes: [] }, "add", { tagged: false });
	assert.equal(plain, "a.ts\n2: export function add(a, b) {  ← definition\n5: return add(1, 2);\n9: // add is fast\nb.ts\n1: log(\"add\")", "untagged: no hit hidden, no footer");
});

test("rewriteGrep leaves text searches and results it cannot shrink alone", async () => {
	const d = tmp();
	const one = { toolName: "Grep", input: { pattern: "failed" }, content: [{ type: "text", text: "a.md:1: it failed" }] };
	const r = await rewriteGrep(one, d);
	assert.equal(r.content, null, "one hit: grouping only adds a line");
	assert.equal(await rewriteGrep({ ...one, input: { pattern: "connection refused" } }, d), null, "not an identifier");
	const many = { toolName: "Grep", input: { pattern: "run" }, content: [{ type: "text", text: [1, 2, 3].map((n) => `src/some/long/path/file.ts:${n}: run(${n})`).join("\n") }] };
	assert.equal((await rewriteGrep(many, d)).text, "src/some/long/path/file.ts\n1: run(1)\n2: run(2)\n3: run(3)");
});

// LSP output
// ==========

test("formatSymbols filters by kind and depth", () => {
	const r = (a, b) => ({ start: { line: a, character: 0 }, end: { line: b, character: 0 } });
	const tree = [{ name: "A", kind: 5, range: r(0, 9), selectionRange: r(0, 0), children: [{ name: "m", kind: 6, range: r(1, 2) }, { name: "p", kind: 7, range: r(3, 3) }] }, { name: "f", kind: 12, range: r(10, 12) }];
	assert.equal(formatSymbols(tree, "/", { depth: 0 }), "class A  L1-10\nfunction f  L11-13");
	assert.equal(formatSymbols(tree, "/", { kinds: kindsOf("method,function") }), "  method m  L2-3\nfunction f  L11-13");
	assert.equal(formatSymbols(tree, "/", { limit: 1 }), "class A  L1-10\n[3 more; raise limit, or filter with kind or depth]");
	assert.deepEqual(kindsOf(["Class", " function "]), ["class", "function"]);
	assert.equal(kindsOf(""), null);
});

test("enclosing finds the function around a use, not the declaration itself", () => {
	const r = (a, b) => ({ start: { line: a, character: 0 }, end: { line: b, character: 0 } });
	const syms = flattenSymbols([
		{ name: "C", kind: 5, range: r(0, 20), selectionRange: r(0, 0), children: [{ name: "run", kind: 6, range: r(2, 8), selectionRange: r(2, 2) }] },
		{ name: "helper", kind: 12, range: r(22, 25), selectionRange: r(22, 22) },
		{ name: "x", kind: 13, range: r(30, 30), selectionRange: r(30, 30) },
	]);
	assert.equal(enclosing(syms, 5, "foo").name, "C.run");
	assert.equal(enclosing(syms, 22, "helper"), null, "the declaration line of the name itself");
	assert.equal(enclosing(syms, 23, "foo").name, "helper");
	assert.equal(enclosing(syms, 30, "foo"), null, "a one-line variable is not a container");
	assert.equal(symbolOnLine([{ name: "C", kind: 5, range: r(0, 20), selectionRange: r(0, 0), children: [{ name: "run", kind: 6, range: r(2, 8), selectionRange: r(2, 2) }] }], 2).name, "run");
});

test("formatFunctions prints one line per enclosing symbol", () => {
	const hits = [
		{ path: "a.ts", line: 1, def: true },
		{ path: "a.ts", line: 4, sym: { kind: 12, name: "main", start: 2, end: 9 } },
		{ path: "a.ts", line: 4, sym: { kind: 12, name: "main", start: 2, end: 9 } },
		{ path: "a.ts", line: 7, sym: { kind: 12, name: "main", start: 2, end: 9 } },
		{ path: "b.ts", line: 3 },
	];
	assert.equal(formatFunctions(hits, 50), "a.ts\ndefinition: line 1\nfunction main L3-10: 3 uses (line 4, 7)\nb.ts\ntop level: 1 use (line 3)");
	assert.equal(formatFunctions(hits, 1), "a.ts\ndefinition: line 1\n[2 more; raise limit]");
});

test("symbolMatches takes the exact name, with or without its container", () => {
	assert.equal(symbolMatches({ name: "foo" }, "foo"), true);
	assert.equal(symbolMatches({ name: "foobar" }, "foo"), false);
	assert.equal(symbolMatches({ name: "foo(int)" }, "foo"), true);
	assert.equal(symbolMatches({ name: "foo", containerName: "A" }, "A.foo"), true);
	assert.equal(symbolMatches({ name: "foo", containerName: "B" }, "A.foo"), false);
});

test("isTestFile knows the usual test paths", () => {
	for (const p of ["src/a.test.ts", "tests/x.c", "src/__tests__/a.ts", "pkg/a_test.go", "test_a.py", "a.spec.js"]) assert.equal(isTestFile(p), true, p);
	for (const p of ["src/latest.ts", "src/contest/a.ts", "src/testing.ts"]) assert.equal(isTestFile(p), false, p);
});

test("groupRssMb adds the memory of a process group", () => {
	assert.deepEqual(groupRssMb("  100  2048\n 100 1024\n 200 512\n"), new Map([[100, 3], [200, 0.5]]));
});

// Fixed cost
// ==========

test("the tool definitions and the prompt section stay small", () => {
	const code = JSON.stringify({ ast_grep: TOOLS.ast_grep, lsp: TOOLS.lsp }).length;
	assert.ok(code <= 2200, `ast_grep and lsp definitions: ${code} characters`);
	const debug = JSON.stringify(TOOLS.debug).length;
	assert.ok(debug <= 800, `debug definition: ${debug} characters`);
	assert.ok(_test.systemSection(true).length <= 400, "prompt section");
});

test("applyEdits applies TextEdits bottom-up and drops duplicates and overlaps", () => {
	const r = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
	const text = "const a = f(1);\nf(a) + f(2);\n";
	const edits = [r(0, 10, 0, 11), r(1, 0, 1, 1), r(1, 7, 1, 8), r(1, 7, 1, 8), r(1, 0, 1, 3)].map((range) => ({ range, newText: "g" }));
	assert.deepEqual(applyEdits(text, edits), { text: "const a = g(1);\ng(a) + g(2);\n", applied: 3 });
	assert.deepEqual(applyEdits("x\r\ny", [{ range: r(1, 0, 1, 1), newText: "z" }]), { text: "x\r\nz", applied: 1 });
});

test("workspaceEdits reads changes and documentChanges, and skips file operations", () => {
	const e = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" };
	const a = url.pathToFileURL(path.join(os.tmpdir(), "a.ts")).href;
	const b = url.pathToFileURL(path.join(os.tmpdir(), "b.ts")).href;
	const m = workspaceEdits({ changes: { [a]: [e] }, documentChanges: [{ textDocument: { uri: b, version: 1 }, edits: [e, { bad: 1 }] }, { kind: "create", uri: b }] });
	assert.equal(m.size, 2);
	assert.deepEqual([...m.values()].map((x) => x.length), [1, 1]);
	assert.equal(workspaceEdits(null).size, 0);
});

test("mayImport: a module can use an export only through an import, a re-export or a whole-module import", () => {
	for (const t of ['import { a, run } from "./r";', 'import {\n  a,\n  run,\n} from "./r";', 'import type { run } from "x"', 'import run from "./r"', 'import * as r from "./r"; r.run()', 'const r = require("./r")', 'await import("./r")', 'export { run } from "./r"', 'export * from "./r"']) assert.equal(mayImport(t, "run"), true, t);
	for (const t of ["const o = { run: 1 }; function run() {}", 'import { runner } from "./r"; x.run()', 'import { a } from "./r";\nconst b = { run };']) assert.equal(mayImport(t, "run"), false, t);
});

const outlineOf = (p, items) => ({ path: p, language: "TypeScript", items });
const item = (symbolType, name, line, end, extra = {}) => ({ role: "item", symbolType, name, range: { start: { line: line - 1, column: 0 }, end: { line: end - 1, column: 1 } }, signature: `${name} sig`, isImport: false, isExported: false, ...extra });

test("indexEntry keeps declarations and members with 1-based lines, and drops imports and export *", () => {
	const d = tmp();
	write(d, "a.ts", "x\n");
	const e = indexEntry(outlineOf("./a.ts", [
		item("module", "'./b'", 1, 1, { isImport: true }),
		item("module", "'./c'", 2, 2, { signature: "export * from './c';", isExported: true }),
		item("class", "Store", 3, 9, { isExported: true, members: [item("method", "get", 4, 6)] }),
		item("function", "helper", 10, 12),
	]), d);
	assert.equal(e.path, path.join(d, "a.ts"));
	assert.deepEqual(e.syms.map((x) => [x.kind, x.name, x.line, x.end, x.container, x.exported]), [
		["class", "Store", 3, 9, "", true], ["method", "get", 4, 6, "Store", false], ["function", "helper", 10, 12, "", false],
	]);
	assert.equal(formatIndexOutline(e), "class Store  L3-9\n  method get  L4-6\nfunction helper  L10-12");
	assert.equal(formatIndexOutline(e, { depth: 0 }), "class Store  L3-9\nfunction helper  L10-12");
	assert.equal(formatIndexOutline(e, { kinds: ["function"] }), "function helper  L10-12");
	const ix = { files: new Map([[e.path, e]]) };
	assert.deepEqual(indexLookup(ix, "get").exact.map((h) => h.s.container), ["Store"]);
	assert.deepEqual(indexLookup(ix, "Store.get").exact.length, 1);
	assert.deepEqual(indexLookup(ix, "Other.get").exact.length, 0);
	assert.deepEqual(indexLookup(ix, "help").partial.map((h) => h.s.name), ["helper"]);
	assert.equal(formatIndexDir(ix, d, d).text, "a.ts\n3: Store sig");
});

test("mainDeclarations: the one exported top-level declaration a name alone means", () => {
	const h = (container, exported) => ({ sym: { container, exported } });
	const exp = h("", true);
	assert.deepEqual(mainDeclarations([exp, h("", false), h("Shop", false)]), [exp]);
	const top = h("", false);
	assert.deepEqual(mainDeclarations([top, h("Shop", false)]), [top]);
	const two = [h("A", false), h("B", false)];
	assert.deepEqual(mainDeclarations(two), two);
});

test("tsDroppedOptions finds the root tsconfig options TypeScript 7 removed, through extends", () => {
	const d = tmp();
	write(d, "tsconfig.json", '{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": true } }');
	write(d, "tsconfig.base.json", '{\n // a comment\n "compilerOptions": { "moduleResolution": "bundler", "paths": {} } }');
	assert.deepEqual(tsDroppedOptions(d), []);
	write(d, "tsconfig.base.json", '{ "compilerOptions": { "baseUrl": ".", "module": "amd" } }');
	assert.deepEqual(tsDroppedOptions(d).sort(), ["baseUrl", "module"]);
});

test("debug: the debugger from the program or lang, and breakpoints as file:line [if cond]", () => {
	assert.equal(debugKind("src/a.ts"), "node");
	assert.equal(debugKind("app.mjs"), "node");
	assert.equal(debugKind("main.py"), "python");
	assert.equal(debugKind("cmd/main.go"), "go");
	assert.equal(debugKind("build/app"), "lldb");
	assert.equal(debugKind("x.weird"), null);
	assert.equal(debugKind("x.weird", "rust"), "lldb");
	const cwd = path.resolve("/w");
	assert.deepEqual(parseBreakpoint("src/a.ts:12", cwd), { file: path.join(cwd, "src", "a.ts"), line: 12, condition: undefined });
	assert.deepEqual(parseBreakpoint("a.ts:3 if x > 2 && y", cwd).condition, "x > 2 && y");
	assert.throws(() => parseBreakpoint("a.ts", cwd), /file:line/);
});

test("debug: a breakpoint file matches its path and its file URL, also percent-encoded", () => {
	const re = new RegExp(urlPattern("/w/my app/a.ts"));
	for (const u of ["/w/my app/a.ts", "file:///w/my%20app/a.ts", "file:///w/my app/a.ts"]) assert.ok(re.test(u), u);
	assert.ok(!re.test("/w/my app/ab.ts"));
	const win = new RegExp(urlPattern(String.raw`C:\w\a.js`));
	for (const u of ["file:///C:/w/a.js", "file:///c:/w/a.js", String.raw`C:\w\a.js`]) assert.ok(win.test(u), u);
});

test("debug: the snapshot is short: frames on disk, 20 locals, secrets hidden, the first line of an exception", () => {
	const d = tmp();
	const f = write(d, "a.js", "one\ntwo\nthree\nfour\nfive\n");
	const locals = Array.from({ length: 25 }, (_, i) => ({ name: `v${i}`, value: "x".repeat(300) }));
	locals.unshift({ name: "apiToken", value: "s3cr3t" });
	const t = formatSnapshot({ kind: "node", state: "paused", reason: "exception", exception: "TypeError: boom\n    at f (a.js:3:1)", frames: [{ name: "f", file: f, line: 3 }, { name: "g", file: "node:internal/x", line: 1 }, { name: "h", file: f, line: 5 }], locals, evals: [{ expression: "1+1", value: "2" }], output: ["hi"], next: "n" }, d);
	assert.match(t, /^\[debug · node · paused: exception\]\nexception: TypeError: boom\nat a\.js:3 in f\n {5}1 \| one\n {5}2 \| two\n> {4}3 \| three\n/);
	assert.match(t, /\nstack: f \(a\.js:3\) ← h \(a\.js:5\)\n/);
	assert.match(t, /locals: apiToken = «hidden» · v0 = x{159}…/);
	assert.match(t, /\[6 more; use eval\]\neval 1\+1 = 2\noutput \(last 1 lines\):\n {2}hi\n\[n\]$/);
	assert.doesNotMatch(t, /s3cr3t/);
});
