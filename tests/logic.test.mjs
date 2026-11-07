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
} from "../extension/ast-lens.js";

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
	assert.equal(formatSgMatches([m], "/w", { rewrite: true }), "src/a.js:5:5: x = add(1, 2)\n    $A=1  $$$R=[a, b]\n    - add(1, 2)\n    + sum(1, 2)");
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
	assert.deepEqual(readConfig(path.join(d, "none.json")), { mode: "steer", servers: {} });
	const f = write(d, "c.json", JSON.stringify({ mode: "strict", servers: { py: ["x"] } }));
	assert.deepEqual(readConfig(f), { mode: "strict", servers: { py: ["x"] } });
	assert.equal(readConfig(write(d, "bad.json", JSON.stringify({ mode: "loud" }))).mode, "steer");
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
