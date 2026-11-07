// Runs the extension against a fake pi host with the real ast-grep, clangd and typescript-language-server (skipped when missing).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import astLens, { which, _test } from "../extension/ast-lens.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-e2e-"));
fs.writeFileSync(path.join(dir, "a.js"), "// add(9, 9) in a comment\nfunction add(a, b) { return a + b }\nconst x = add(1, 2)\nconsole.log(add(x, 3), 'add(0, 0)')\n");
fs.writeFileSync(path.join(dir, "m.c"), "static int add(int a, int b) { return a + b; }\nint main(void) {\n  int x = add(1, 2);\n  return add(x, nope);\n}\n");

const tools = {};
const on = {};
let command;
astLens({ on: (e, h) => (on[e] = h), registerTool: (t) => (tools[t.name] = t), registerCommand: (n, c) => (command = { n, c }) });
const ctx = { cwd: dir };
const call = async (name, params, c = ctx) => (await tools[name].execute("id", params, undefined, undefined, c)).content[0].text;
const hasSg = !!(which("ast-grep", dir) ?? which("sg", dir));
const hasClangd = !!which("clangd", dir);
const hasTls = !!which("typescript-language-server", dir);
const hasLldb = !!(which("lldb-dap", dir) ?? which("lldb-vscode", dir) ?? (process.platform === "darwin" && spawnSync("xcrun", ["-f", "lldb-dap"]).status === 0 ? "xcrun" : null));
const cc = which("cc", dir) ?? which("clang", dir) ?? which("gcc", dir);
const nodeMajor = Number(process.versions.node.split(".")[0]);

after(() => _test.stopAll());

test("registers the tools it can run, the command and the hooks", () => {
	assert.deepEqual(Object.keys(tools).sort(), hasSg ? ["ast_grep", "debug", "lsp"] : ["debug", "lsp"]);
	assert.equal(command.n, "ast-lens");
	for (const e of ["before_agent_start", "tool_result", "session_shutdown"]) assert.equal(typeof on[e], "function", e);
	assert.equal(on.tool_call, undefined, "strict mode is gone: Grep is never blocked");
});

test("before_agent_start adds the same short section once", async () => {
	const r = await on.before_agent_start({ systemPrompt: "BASE" }, ctx);
	assert.match(r.systemPrompt, /^BASE\n\n<!-- ast-lens -->/);
	assert.ok(r.systemPrompt.length - "BASE\n\n".length <= 400, "the section is at most 400 characters");
	assert.equal(await on.before_agent_start({ systemPrompt: r.systemPrompt }, ctx), undefined);
	assert.equal((await on.before_agent_start({ systemPrompt: "BASE" }, ctx)).systemPrompt, r.systemPrompt, "stable across turns");
});

test("tool_result groups a code Grep and hints at most twice per prompt", async () => {
	await on.before_agent_start({ systemPrompt: "x" }, ctx);
	const ev = { toolName: "grep", input: { pattern: "parseConfig" }, content: [{ type: "text", text: "src/a.ts:3: parseConfig(x)\nsrc/a.ts:9: return parseConfig(y)" }] };
	const r1 = await on.tool_result(ev, ctx);
	assert.equal(r1.content.length, 2);
	assert.equal(r1.content[0].text.split("\n")[0], "src/a.ts");
	assert.match(r1.content[1].text, /AST Lens/);
	assert.equal(await on.tool_result({ ...ev, input: { pattern: "no such file" } }, ctx), undefined);
	assert.equal((await on.tool_result(ev, ctx)).content.length, 2);
	assert.equal((await on.tool_result(ev, ctx)).content.length, 1, "no third hint, still grouped");
	assert.equal(await on.tool_result({ ...ev, toolName: "Read" }, ctx), undefined);
	const py = { toolName: "grep", input: { pattern: "parse_config" }, content: [{ type: "text", text: "src/a.py:3: parse_config(x)" }] };
	await on.before_agent_start({ systemPrompt: "x" }, ctx);
	assert.equal(await on.tool_result(py, ctx), undefined, "one hit stays as it is, and no lsp hint for an experimental language");
});

test("tool_result collapses comment and string hits with ast-grep, and marks the definition", { skip: !hasSg && "ast-grep not installed" }, async () => {
	await on.before_agent_start({ systemPrompt: "x" }, ctx);
	const matches = [1, 2, 3, 4].map((line) => ({ line, path: "a.js", text: fs.readFileSync(path.join(dir, "a.js"), "utf8").split("\n")[line - 1] }));
	const host = { toolName: "Grep", input: { pattern: "\\badd\\b" }, content: [{ type: "text", text: JSON.stringify({ count: 4, files: 0, matches, tags: { "a.js": "1A2B" } }) }] };
	const t = (await on.tool_result(host, ctx)).content[0].text;
	assert.equal(t.split("\n").slice(0, 5).join("\n"), [
		"a.js#1A2B",
		"2: function add(a, b) { return a + b }  ← definition",
		"3: const x = add(1, 2)",
		"4: console.log(add(x, 3), 'add(0, 0)')",
		"1 in comments/strings: line 1",
	].join("\n"));
	assert.match(t, /\[Grep "\\\\badd\\\\b": 4 hits in 1 file; 1 in comments or strings/);
	// Every hit in a comment or a string: a text search, Grep's job. No rewrite, no hint.
	const text = { ...host, content: [{ type: "text", text: JSON.stringify({ count: 1, files: 0, matches: matches.slice(0, 1) }) }] };
	assert.equal(await on.tool_result(text, ctx), undefined);
});

test("ast_grep groups matches by file", { skip: !hasSg && "ast-grep not installed" }, async () => {
	const t = await call("ast_grep", { pattern: "add($A, $B)", path: "a.js" });
	assert.equal(t, [
		"[ast-grep · javascript (from .js)]",
		"a.js",
		"3:11: const x = add(1, 2)",
		"  $A=1  $B=2",
		"4:13: console.log(add(x, 3), 'add(0, 0)')",
		"  $A=x  $B=3",
		"[2 matches in 1 file]",
	].join("\n").replace("$A=1  $B=2", t.includes("$B=2  $A=1") ? "$B=2  $A=1" : "$A=1  $B=2").replace("$A=x  $B=3", t.includes("$B=3  $A=x") ? "$B=3  $A=x" : "$A=x  $B=3"));
	assert.equal(await call("ast_grep", { pattern: "add($A, $B)", path: "a.js", output: "count" }), "[ast-grep · javascript (from .js)]\na.js: 2\n[2 matches in 1 file]");
	assert.match(await call("ast_grep", { pattern: "add($A, $B)", path: "a.js", output: "files" }), /^\[ast-grep[^\n]*\]\na\.js\n\[2 matches/);
	assert.match(await call("ast_grep", { pattern: "add($A, $B)", path: "a.js", limit: 1 }), /\n\[1 more in 1 file; raise limit or narrow the path\]\n\[2 matches in 1 file\]$/);
});

test("ast_grep infers the language of a directory, rewrites and rules", { skip: !hasSg && "ast-grep not installed" }, async () => {
	assert.match(await call("ast_grep", { pattern: "add($A, $B)", globs: ["*.c"] }), /\nm\.c\n3:11:/);
	const preview = await call("ast_grep", { pattern: "add($A, $B)", rewrite: "sum($A, $B)", path: "a.js" });
	assert.match(preview, /\n {2}\+ sum\(1, 2\)/);
	assert.match(fs.readFileSync(path.join(dir, "a.js"), "utf8"), /add\(1, 2\)/, "preview must not write");
	assert.match(await call("ast_grep", { rule: "kind: return_statement", path: "m.c" }), /\nm\.c\n1:/);
	assert.match(await call("ast_grep", { pattern: "zzz($A)", path: "a.js" }), /No matches/);
	await assert.rejects(call("ast_grep", { path: "a.js" }), /Give a `pattern`/);
	await assert.rejects(call("ast_grep", { pattern: "x", path: "missing" }), /No such path/);
});

test("ast_grep keeps 45 `new X(…)` matches under 6,000 characters", { skip: !hasSg && "ast-grep not installed" }, async () => {
	const many = fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-many-"));
	fs.mkdirSync(path.join(many, "src", "widgets"), { recursive: true });
	for (let f = 0; f < 15; f++) {
		const body = [0, 1, 2].map((i) => `export function build${f}${i}(config: Config) {\n  const widget = new Widget(config.name, { size: ${i}, color: "red", parent: config.root });\n  return widget;\n}`).join("\n");
		fs.writeFileSync(path.join(many, "src", "widgets", `widget-factory-${f}.ts`), `import { Widget, Config } from "../widget";\n${body}\n`);
	}
	const t = await call("ast_grep", { pattern: "new Widget($$$)", path: "src" }, { cwd: many });
	assert.match(t, /\[45 matches in 15 files\]/);
	assert.ok(t.length <= 6000, `${t.length} characters`);
});

test("ast_grep apply writes the rewrite", { skip: !hasSg && "ast-grep not installed" }, async () => {
	const f = path.join(dir, "w.js");
	fs.writeFileSync(f, "old(1)\nold(2)\n");
	await call("ast_grep", { pattern: "old($A)", rewrite: "neu($A)", path: "w.js", apply: true });
	assert.equal(fs.readFileSync(f, "utf8"), "neu(1)\nneu(2)\n");
});

test("lsp with clangd: definition, references, hover, symbols, diagnostics", { skip: !hasClangd && "clangd not installed", timeout: 90000 }, async () => {
	const def = await call("lsp", { operation: "definition", file: "m.c", line: 3, symbol: "add" });
	assert.match(def, /server started in [\d.]+s\]/, "the first call says it started the server");
	assert.match(def, /\nm\.c\n1:12: static int add/);
	const refs = await call("lsp", { operation: "references", file: "m.c", line: 1, symbol: "add" });
	assert.match(refs, /\n1:12: static int add\(int a, int b\) \{ return a \+ b; \}  definition\n3:11: int x = add\(1, 2\);  in main\n/);
	assert.match(refs, /\[3 verified in 1 file, 0 unverified text matches, 0 files unchecked\]$/);
	assert.match(await call("lsp", { operation: "references", file: "m.c", line: 1, symbol: "add", output: "functions" }), /\nfunction main L2-5: 2 uses \(line 3, 4\)\n/);
	assert.match(await call("lsp", { operation: "hover", file: "m.c", line: 1, symbol: "add" }), /int add\(int a, int b\)/);
	assert.match(await call("lsp", { operation: "symbols", file: "m.c" }), /function add[\s\S]*function main/);
	assert.doesNotMatch(await call("lsp", { operation: "symbols", file: "m.c", kind: "struct" }), /function/);
	assert.match(await call("lsp", { operation: "symbols", file: "m.c", symbol: "main", body: true }), /function main L2-5\n2: int main\(void\) \{\n3: {3}int x = add\(1, 2\);\n4: {3}return add\(x, nope\);\n5: \}$/);
	assert.match(await call("lsp", { operation: "diagnostics", file: "m.c" }), /m\.c:4:\d+: error .*nope/);
	const byName = await call("lsp", { operation: "definition", symbol: "main", lang: "c" });
	assert.match(byName, /\nm\.c\n2:5: int main\(void\) \{  function\n\[1 declaration named main\]$/);
	assert.ok(byName.length <= 755, `definition by name: ${byName.length} characters`);
});

test("lsp sees edits to open files, also after an Edit tool call", { skip: !hasClangd && "clangd not installed", timeout: 60000 }, async () => {
	const f = path.join(dir, "m.c");
	fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("nope", "1"));
	assert.match(await call("lsp", { operation: "diagnostics", file: "m.c" }), /No problems/);
	fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("  return add(x, 1);", "  x = add(x, x);\n  return add(x, 1);"));
	await on.tool_result({ toolName: "Edit", input: { path: "m.c" }, content: [{ type: "text", text: "ok" }] }, ctx);
	// The definition, add(1, 2), the new add(x, x) and add(x, 1): 4, one more than before the edit.
	assert.match(await call("lsp", { operation: "references", file: "m.c", line: 1, symbol: "add" }), /\n4:7: x = add\(x, x\);  in main\n5:10: return add\(x, 1\);  in main\n\[4 verified in 1 file/);
});

test("lsp stops a server over maxRssMb and says so on the next call", { skip: !hasClangd && "clangd not installed", timeout: 60000 }, async () => {
	await call("lsp", { operation: "hover", file: "m.c", line: 1, symbol: "add" });
	const pids = [];
	for (const p of _test.clients.values()) pids.push((await p).child.pid);
	await _test.reap({ maxRssMb: 100 }, new Map(pids.map((pid) => [pid, 5000])));
	assert.equal(_test.clients.size, 0);
	assert.match(await call("lsp", { operation: "hover", file: "m.c", line: 1, symbol: "add" }), /used 5000 MB \(maxRssMb 100\) and was stopped/);
});

test("lsp explains missing servers and bad input", async () => {
	fs.writeFileSync(path.join(dir, "x.unknownext"), "");
	await assert.rejects(call("lsp", { operation: "symbols", file: "x.unknownext" }), /no language server for \.unknownext/);
	await assert.rejects(call("lsp", { operation: "fly", file: "m.c" }), /operation must be one of/);
	await assert.rejects(call("lsp", { operation: "hover" }), /Give `file`/);
	await assert.rejects(call("lsp", { operation: "definition" }), /or `symbol` alone/);
	await assert.rejects(call("lsp", { operation: "hover", file: "gone.c", line: 1 }), /No such file/);
});

test("ast_grep passes shell metacharacters through unchanged", { skip: !hasSg && "ast-grep not installed" }, async () => {
	// On Windows ast-grep from npm is a .cmd shim: a shell would eat & | ^ % and the quotes.
	fs.writeFileSync(path.join(dir, "meta.js"), 'log("a & b | c ^ %PATH% !x")\nlog("plain")\n');
	const t = await call("ast_grep", { pattern: 'log("a & b | c ^ %PATH% !x")', path: "meta.js" });
	assert.match(t, /\nmeta\.js\n1:1:/);
	assert.match(t, /\[1 match in 1 file\]/);
});

test("lsp with typescript-language-server (npm shim on Windows)", { skip: !hasTls && "typescript-language-server not installed", timeout: 120000 }, async () => {
	const ts = fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-ts-"));
	fs.mkdirSync(path.join(ts, "src"));
	fs.writeFileSync(path.join(ts, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }\n');
	fs.writeFileSync(path.join(ts, "src", "a.ts"), "export function greet(name: string): string {\n  return name;\n}\n");
	fs.writeFileSync(path.join(ts, "src", "b.ts"), 'import { greet } from "./a";\nconst s: number = greet("x");\nconsole.log(greet("y"), s);\n');
	fs.writeFileSync(path.join(ts, "src", "b.test.ts"), 'import { greet } from "./a";\ngreet("t");\n');
	const tctx = { cwd: ts };
	const run = async (p) => (await tools.lsp.execute("id", p, undefined, undefined, tctx)).content[0].text;
	assert.match(await run({ operation: "references", file: "src/a.ts", line: 1, symbol: "greet" }), /\[6 verified in 3 files/);
	assert.match(await run({ operation: "references", file: "src/a.ts", line: 1, symbol: "greet", exclude_tests: true }), /\[4 verified in 2 files, .*, 2 in tests hidden\]/);
	assert.match(await run({ operation: "definition", file: "src/b.ts", line: 3, symbol: "greet" }), /\nsrc\/a\.ts\n1:17: export function greet/);
	assert.match(await run({ operation: "diagnostics", file: "src/b.ts" }), /src\/b\.ts:2:7: error .*2322/);
	const ws = await run({ operation: "workspace_symbols", query: "greet" });
	assert.match(ws, /\nsrc\/a\.ts\n1:17: export function greet\(name: string\): string \{  function\n\[1 exact, 0 partial\]$/);
});

test("lsp references cross tsconfig projects with one server, and report what they cannot verify", { skip: !hasTls && "typescript-language-server not installed", timeout: 120000 }, async () => {
	await _test.stopAll(); // count only this test's servers
	// A monorepo: every lib has its own tsconfig.json, joined by a path alias. tsserver answers
	// references only from the projects it has loaded, so a plain request misses lib b. A script in
	// no project cannot resolve its import: its uses must show as unverified, never vanish.
	const mono = fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-mono-"));
	const put = (rel, text) => {
		fs.mkdirSync(path.dirname(path.join(mono, rel)), { recursive: true });
		fs.writeFileSync(path.join(mono, rel), text);
	};
	put("package.json", '{ "name": "mono", "private": true }\n');
	put("tsconfig.json", '{ "files": [] }\n');
	put("tsconfig.base.json", '{ "compilerOptions": { "strict": true, "baseUrl": ".", "paths": { "@mono/a": ["libs/a/src/index.ts"] } } }\n');
	for (const lib of ["a", "b", "c"]) put(`libs/${lib}/tsconfig.json`, '{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts"] }\n');
	put("libs/a/src/index.ts", "export function makeThing(n: number): number {\n  return n;\n}\n");
	put("libs/b/src/use.ts", 'import { makeThing } from "@mono/a";\n\nexport const one = makeThing(1);\nexport function two() {\n  return makeThing(2); // makeThing in a comment\n}\n');
	put("libs/c/src/other.ts", 'export const makeThing = "a different symbol with the same name";\nexport const label = "makeThing";\n');
	put("scripts/tool.ts", 'import { makeThing } from "../libs/a/src/missing";\nmakeThing(3);\n');
	const mctx = { cwd: mono };
	const run = async (p) => (await tools.lsp.execute("id", p, undefined, undefined, mctx)).content[0].text;
	const t = await run({ operation: "references", file: "libs/a/src/index.ts", line: 1, symbol: "makeThing" });
	assert.match(t, /\nlibs\/a\/src\/index\.ts\n1:17: export function makeThing\(n: number\): number \{  definition\n/);
	assert.match(t, /\nlibs\/b\/src\/use\.ts\n1:10: import \{ makeThing \} from "@mono\/a";\n3:20: export const one = makeThing\(1\);\n5:10: return makeThing\(2\); \/\/ makeThing in a comment  in two\n/);
	assert.doesNotMatch(t, /libs\/c\//, "a same-named other symbol is not a reference");
	assert.match(t, /\nunverified: [^\n]*\nscripts\/tool\.ts\n1:10: [^\n]*\n2:1: makeThing\(3\);\n/);
	assert.match(t, /\[4 verified in 2 files, 2 unverified text matches, 0 files unchecked, 1 file with another makeThing skipped\]$/);
	assert.match(await run({ operation: "references", file: "libs/a/src/index.ts", line: 1, symbol: "makeThing", output: "functions" }), /\nlibs\/b\/src\/use\.ts\ntop level: 2 uses \(line 1, 3\)\nfunction two L4-6: 1 use \(line 5\)\n/);
	// Definition by name only, as small as a precise Grep. tsserver lists the symbols of one project;
	// the same-named constant of lib c, in another project, must be found too.
	const def = await run({ operation: "definition", symbol: "makeThing" });
	assert.match(def, /\nlibs\/a\/src\/index\.ts\n1:17: export function makeThing\(n: number\): number \{  function\nlibs\/c\/src\/other\.ts\n1:14: export const makeThing = [^\n]*  constant\n\[2 declarations named makeThing\]$/);
	assert.ok(def.length <= 755, `definition by name: ${def.length} characters`);
	// With ast-grep, a definition by name, an outline and a directory overview come from the AST index: no server.
	if (hasSg) {
		assert.match(def, /^\[index · ast-grep · \d+ files\] definition makeThing\n/);
		assert.match(await run({ operation: "symbols", file: "libs/b/src/use.ts" }), /^\[index · ast-grep[^\n]*\] symbols libs\/b\/src\/use\.ts\nconstant one  L3-3\nfunction two  L4-6$/);
		assert.match(await run({ operation: "symbols", file: "libs" }), /\(exported declarations per file\)\nlibs\/a\/src\/index\.ts\n1: export function makeThing\(n: number\): number \{\nlibs\/b\/src\/use\.ts\n3: export const one/);
		assert.match(await run({ operation: "workspace_symbols", query: "Thing" }), /\[0 exact, 2 partial\]$/);
	}
	// A name alone works for the operations that need a file too: they resolve it like definition.
	assert.match(await run({ operation: "references", symbol: "two" }), /references libs\/b\/src\/use\.ts:4:17\n[\s\S]*\[1 verified in 1 file/);
	assert.match(await run({ operation: "symbols", symbol: "two", body: true }), /symbols libs\/b\/src\/use\.ts function two L4-6\n4: export function two\(\) \{\n/);
	assert.match(await run({ operation: "references", symbol: "makeThing" }), /\[2 declarations named makeThing: give `file` and `line`/);
	// A file the search opened, changed on disk (an Edit or a Bash command): the next answer sees it.
	put("libs/b/src/use.ts", `${fs.readFileSync(path.join(mono, "libs/b/src/use.ts"), "utf8")}export const three = makeThing(3);\n`);
	assert.match(await run({ operation: "references", file: "libs/a/src/index.ts", line: 1, symbol: "makeThing" }), /\n7:22: export const three = makeThing\(3\);\n[\s\S]*\[5 verified in 2 files/);
	// One server for the whole workspace, not one per tsconfig.
	await run({ operation: "hover", file: "libs/b/src/use.ts", line: 3, symbol: "makeThing" });
	await run({ operation: "hover", file: "libs/c/src/other.ts", line: 1, symbol: "makeThing" });
	let status = "";
	await command.c.handler("", { cwd: mono, ui: { notify: (m) => (status = m) } });
	assert.match(status, /running servers: 1\b/);
	assert.match(status, /typescript \(verified\)/);
	// rename: every verified use across the projects; preview first, then written. The same-named
	// other symbol, the comment and the script in no project stay as they are.
	const before = fs.readFileSync(path.join(mono, "libs/b/src/use.ts"), "utf8");
	// A name alone with two declarations: rename asks which one, and writes nothing.
	assert.match(await run({ operation: "rename", symbol: "makeThing", new_name: "buildThing", apply: true }), /\[2 declarations named makeThing: give `file` and `line` of the one you mean\]$/);
	assert.equal(fs.readFileSync(path.join(mono, "libs/b/src/use.ts"), "utf8"), before);
	const preview = await run({ operation: "rename", file: "libs/a/src/index.ts", line: 1, symbol: "makeThing", new_name: "buildThing" });
	assert.match(preview, /rename libs\/a\/src\/index\.ts:1:17 makeThing → buildThing\n/);
	assert.match(preview, /\nlibs\/b\/src\/use\.ts\n1: import \{ buildThing \} from "@mono\/a";\n/);
	assert.match(preview, /\[5 edits in 2 files, 2 text matches not changed\]\n\[preview only/);
	assert.equal(fs.readFileSync(path.join(mono, "libs/b/src/use.ts"), "utf8"), before, "a preview writes nothing");
	const done = await run({ operation: "rename", file: "libs/a/src/index.ts", line: 1, symbol: "makeThing", new_name: "buildThing", apply: true });
	assert.match(done, /\nlibs\/b\/src\/use\.ts: 4\n[\s\S]*\[written: makeThing → buildThing\]$/);
	assert.equal(fs.readFileSync(path.join(mono, "libs/b/src/use.ts"), "utf8"), before.replace(/makeThing\(/g, "buildThing(").replace("{ makeThing }", "{ buildThing }"));
	assert.match(fs.readFileSync(path.join(mono, "libs/a/src/index.ts"), "utf8"), /^export function buildThing\(/);
	assert.match(fs.readFileSync(path.join(mono, "libs/c/src/other.ts"), "utf8"), /^export const makeThing = /);
	assert.match(fs.readFileSync(path.join(mono, "scripts/tool.ts"), "utf8"), /^import \{ makeThing \}/);
	// The server sees the written files: the new name has the same 5 verified uses.
	assert.match(await run({ operation: "references", symbol: "buildThing" }), /\[5 verified in 2 files/);
});

test("debug probe on Node: runs to the breakpoint, shows locals and evals, then stops", { timeout: 60000 }, async () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-dbg-"));
	fs.writeFileSync(path.join(d, "cart.js"), "function total(items, discount) {\n  let sum = 0;\n  for (const it of items) sum += it.price * it.qty;\n  const result = sum * (1 - discount);\n  return result;\n}\nconsole.log('total', total([{ price: 300, qty: 1 }, { price: 80, qty: 2 }], 0.1));\n");
	const dctx = { cwd: d };
	const t = await call("debug", { operation: "probe", program: "cart.js", breakpoints: ["cart.js:4"], eval: ["sum / 2"] }, dctx);
	assert.match(t, /^\[debug · node \(inspector\) · paused: breakpoint\]\nat cart\.js:4 in total\n/);
	assert.match(t, /locals: [^\n]*sum = 460/);
	assert.match(t, /\neval sum \/ 2 = 230\n/);
	// A live session: a conditional breakpoint, a step, then the end of the program.
	assert.match(await call("debug", { operation: "start", program: "cart.js", breakpoints: ["cart.js:4 if sum > 400"] }, dctx), /session open/);
	assert.match(await call("debug", { operation: "step" }, dctx), /paused: step\]\nat cart\.js:5 in total/);
	assert.match(await call("debug", { operation: "continue" }, dctx), /exited[\s\S]*total 414/);
	// An uncaught exception stops where it is thrown.
	fs.writeFileSync(path.join(d, "boom.js"), "const parse = (s) => JSON.parse(s).value.toUpperCase();\nparse('{}');\n");
	assert.match(await call("debug", { operation: "probe", program: "boom.js" }, dctx), /paused: exception\]\nexception: TypeError: [^\n]*toUpperCase[^\n]*\nat boom\.js:1/);
	if (nodeMajor >= 23) {
		fs.writeFileSync(path.join(d, "t.ts"), "const n: number = 2;\nconst m: number = n * 21;\nconsole.log(m);\n");
		assert.match(await call("debug", { operation: "probe", program: "t.ts", breakpoints: ["t.ts:3"] }, dctx), /at t\.ts:3[\s\S]*m = 42/);
	}
});

test("debug probe on C with lldb-dap", { skip: !(hasLldb && cc) && "lldb-dap or a C compiler not installed", timeout: 60000 }, async () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-dbg-c-"));
	fs.writeFileSync(path.join(d, "m.c"), "#include <stdio.h>\nstatic int add(int a, int b) { int s = a + b; return s; }\nint main(void) {\n  printf(\"%d\\n\", add(1, 2));\n  return 0;\n}\n");
	assert.equal(spawnSync(cc, ["-g", "-O0", "-o", path.join(d, "m"), path.join(d, "m.c")]).status, 0);
	const t = await call("debug", { operation: "probe", program: "m", breakpoints: ["m.c:2"], eval: ["a*100"] }, { cwd: d });
	assert.match(t, /^\[debug · lldb-dap · paused: breakpoint\]\nat m\.c:2 in add/);
	assert.match(t, /locals: a = 1 · b = 2/);
	assert.match(t, /eval a\*100 = [^\n]*100/);
});
