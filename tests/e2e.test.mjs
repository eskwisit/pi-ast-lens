// Runs the extension against a fake pi host with the real ast-grep and clangd (skipped when missing).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import codeCompass, { which, _test } from "../extension/code-compass.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-compass-e2e-"));
fs.writeFileSync(path.join(dir, "a.js"), "// add(9, 9) in a comment\nfunction add(a, b) { return a + b }\nconst x = add(1, 2)\nconsole.log(add(x, 3), 'add(0, 0)')\n");
fs.writeFileSync(path.join(dir, "m.c"), "static int add(int a, int b) { return a + b; }\nint main(void) {\n  int x = add(1, 2);\n  return add(x, nope);\n}\n");

const tools = {};
const on = {};
let command;
codeCompass({ on: (e, h) => (on[e] = h), registerTool: (t) => (tools[t.name] = t), registerCommand: (n, c) => (command = { n, c }) });
const ctx = { cwd: dir };
const call = async (name, params) => (await tools[name].execute("id", params, undefined, undefined, ctx)).content[0].text;
const hasSg = !!(which("ast-grep", dir) ?? which("sg", dir));
const hasClangd = !!which("clangd", dir);

after(() => _test.stopAll());

test("registers both tools, the command and the hooks", () => {
	assert.deepEqual(Object.keys(tools).sort(), ["ast_grep", "lsp"]);
	assert.equal(command.n, "code-compass");
	for (const e of ["before_agent_start", "tool_call", "tool_result", "session_shutdown"]) assert.equal(typeof on[e], "function", e);
});

test("before_agent_start adds the section once", async () => {
	const r = await on.before_agent_start({ systemPrompt: "BASE" }, ctx);
	assert.match(r.systemPrompt, /^BASE\n\n<!-- code-compass -->/);
	assert.equal(await on.before_agent_start({ systemPrompt: r.systemPrompt }, ctx), undefined);
});

test("tool_result hints on a code Grep, at most twice per prompt", async () => {
	await on.before_agent_start({ systemPrompt: "x" }, ctx);
	const ev = { toolName: "Grep", input: { pattern: "parseConfig" }, content: [{ type: "text", text: "hits" }] };
	const r1 = await on.tool_result(ev);
	assert.equal(r1.content.length, 2);
	assert.match(r1.content[1].text, /Code Compass/);
	assert.equal(await on.tool_result({ ...ev, input: { pattern: "no such file" } }), undefined);
	assert.ok(await on.tool_result(ev));
	assert.equal(await on.tool_result(ev), undefined);
	assert.equal(await on.tool_result({ ...ev, toolName: "Read" }), undefined);
});

test("ast_grep matches code, not comments or strings", { skip: !hasSg && "ast-grep not installed" }, async () => {
	const t = await call("ast_grep", { pattern: "add($A, $B)", path: "a.js" });
	assert.match(t, /javascript \(from \.js\)/);
	assert.match(t, /a\.js:3:11: const x = add\(1, 2\)/);
	assert.match(t, /a\.js:4:13:/);
	assert.match(t, /\[2 matches in 1 file\]/);
});

test("ast_grep infers the language of a directory, rewrites and rules", { skip: !hasSg && "ast-grep not installed" }, async () => {
	assert.match(await call("ast_grep", { pattern: "add($A, $B)", globs: ["*.c"] }), /m\.c:3:11/);
	const preview = await call("ast_grep", { pattern: "add($A, $B)", rewrite: "sum($A, $B)", path: "a.js" });
	assert.match(preview, /\+ sum\(1, 2\)/);
	assert.match(fs.readFileSync(path.join(dir, "a.js"), "utf8"), /add\(1, 2\)/, "preview must not write");
	assert.match(await call("ast_grep", { rule: "kind: return_statement", path: "m.c" }), /m\.c:1:/);
	assert.match(await call("ast_grep", { pattern: "zzz($A)", path: "a.js" }), /No matches/);
	await assert.rejects(call("ast_grep", { path: "a.js" }), /Give a `pattern`/);
	await assert.rejects(call("ast_grep", { pattern: "x", path: "missing" }), /No such path/);
});

test("ast_grep apply writes the rewrite", { skip: !hasSg && "ast-grep not installed" }, async () => {
	const f = path.join(dir, "w.js");
	fs.writeFileSync(f, "old(1)\nold(2)\n");
	await call("ast_grep", { pattern: "old($A)", rewrite: "neu($A)", path: "w.js", apply: true });
	assert.equal(fs.readFileSync(f, "utf8"), "neu(1)\nneu(2)\n");
});

test("lsp with clangd: definition, references, hover, symbols, diagnostics", { skip: !hasClangd && "clangd not installed", timeout: 90000 }, async () => {
	assert.match(await call("lsp", { operation: "definition", file: "m.c", line: 3, symbol: "add" }), /m\.c:1:12: static int add/);
	assert.match(await call("lsp", { operation: "references", file: "m.c", line: 1, symbol: "add" }), /\[3 locations in 1 file\]/);
	assert.match(await call("lsp", { operation: "hover", file: "m.c", line: 1, symbol: "add" }), /int add\(int a, int b\)/);
	assert.match(await call("lsp", { operation: "symbols", file: "m.c" }), /function add[\s\S]*function main/);
	assert.match(await call("lsp", { operation: "diagnostics", file: "m.c" }), /m\.c:4:\d+: error .*nope/);
});

test("lsp sees edits to an open file", { skip: !hasClangd && "clangd not installed", timeout: 60000 }, async () => {
	const f = path.join(dir, "m.c");
	fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("nope", "1"));
	assert.match(await call("lsp", { operation: "diagnostics", file: "m.c" }), /No problems/);
});

test("lsp explains missing servers and bad input", async () => {
	fs.writeFileSync(path.join(dir, "x.unknownext"), "");
	await assert.rejects(call("lsp", { operation: "symbols", file: "x.unknownext" }), /no language server for \.unknownext/);
	await assert.rejects(call("lsp", { operation: "fly", file: "m.c" }), /operation must be one of/);
	await assert.rejects(call("lsp", { operation: "hover" }), /Give `file`/);
	await assert.rejects(call("lsp", { operation: "hover", file: "gone.c", line: 1 }), /No such file/);
});

test("ast_grep passes shell metacharacters through unchanged", { skip: !hasSg && "ast-grep not installed" }, async () => {
	// On Windows ast-grep from npm is a .cmd shim: a shell would eat & | ^ % and the quotes.
	fs.writeFileSync(path.join(dir, "meta.js"), 'log("a & b | c ^ %PATH% !x")\nlog("plain")\n');
	const t = await call("ast_grep", { pattern: 'log("a & b | c ^ %PATH% !x")', path: "meta.js" });
	assert.match(t, /meta\.js:1:1:/);
	assert.match(t, /\[1 match in 1 file\]/);
});

const hasTls = !!which("typescript-language-server", dir);
test("lsp with typescript-language-server (npm shim on Windows)", { skip: !hasTls && "typescript-language-server not installed", timeout: 120000 }, async () => {
	const ts = fs.mkdtempSync(path.join(os.tmpdir(), "code-compass-ts-"));
	fs.mkdirSync(path.join(ts, "src"));
	fs.writeFileSync(path.join(ts, "tsconfig.json"), '{ "compilerOptions": { "strict": true } }\n');
	fs.writeFileSync(path.join(ts, "src", "a.ts"), "export function greet(name: string): string {\n  return name;\n}\n");
	fs.writeFileSync(path.join(ts, "src", "b.ts"), 'import { greet } from "./a";\nconst s: number = greet("x");\nconsole.log(greet("y"), s);\n');
	const tctx = { cwd: ts };
	const run = async (p) => (await tools.lsp.execute("id", p, undefined, undefined, tctx)).content[0].text;
	assert.match(await run({ operation: "references", file: "src/a.ts", line: 1, symbol: "greet" }), /\[4 locations in 2 files\]/);
	assert.match(await run({ operation: "definition", file: "src/b.ts", line: 3, symbol: "greet" }), /src\/a\.ts:1:17/);
	assert.match(await run({ operation: "diagnostics", file: "src/b.ts" }), /src\/b\.ts:2:7: error .*2322/);
});
