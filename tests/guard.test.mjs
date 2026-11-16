// The sed/perl rename guard: the detector, and the tool_call hook on a fake pi host.
import { test } from "node:test";
import assert from "node:assert/strict";
import astLens, { sedRename, readConfig } from "../extension/ast-lens.js";

test("sedRename finds an identifier rename done with sed -i or perl -pi on code files", () => {
	assert.deepEqual(sedRename("sed -i '' 's/fooBar/bazQux/g' src/*.ts"), { from: "fooBar", to: "bazQux" });
	assert.deepEqual(sedRename("find . -name '*.py' | xargs sed -i 's/\\bold_name\\b/new_name/g'"), { from: "old_name", to: "new_name" });
	assert.deepEqual(sedRename("perl -pi -e 's/getUser/fetchUser/g' lib/a.js"), { from: "getUser", to: "fetchUser" });
	assert.deepEqual(sedRename("sed -i.bak -e 's/getUser/fetchUser/g' lib/a.js"), { from: "getUser", to: "fetchUser" });
	assert.deepEqual(sedRename("sed --in-place 's|getUser|fetchUser|' lib/a.js"), { from: "getUser", to: "fetchUser" });
	assert.deepEqual(sedRename('grep -rl getUser src --include=*.ts | xargs sed -i "" "s/getUser/fetchUser/g"'), { from: "getUser", to: "fetchUser" });
	assert.deepEqual(sedRename("cd src && sed -Ei 's/getUser/fetchUser/g' a.go b.go"), { from: "getUser", to: "fetchUser" });
});

test("sedRename leaves sed without -i, non-code files and non-identifier substitutions alone", () => {
	assert.equal(sedRename("sed -n 's/x/y/p' file.ts"), null, "no -i");
	assert.equal(sedRename("sed -n 's/getUser/fetchUser/p' file.ts"), null, "no -i, identifiers");
	assert.equal(sedRename("sed -i 's/foo bar/baz/' README.md"), null, "text file, phrase");
	assert.equal(sedRename("sed -i 's/getUser/fetchUser/g' README.md"), null, "text file");
	assert.equal(sedRename("sed -i 's/v1.2/v1.3/' package.json"), null, "json, version");
	assert.equal(sedRename("sed -i 's/a/b/' x.ts"), null, "too short");
	assert.equal(sedRename("sed -i 's/fooBar/baz.qux/g' a.ts"), null, "not an identifier");
	assert.equal(sedRename("sed -i 's/fooBar(/bazQux(/g' a.ts"), null, "not an identifier");
	assert.equal(sedRename("sed -i '/^import/d' a.ts"), null, "no substitution");
	assert.equal(sedRename("find . -type f | xargs sed -i 's/getUser/fetchUser/g'"), null, "no code file named");
	assert.equal(sedRename("ls src/*.ts && echo done"), null);
	assert.equal(sedRename("node --test tests/"), null);
	assert.equal(sedRename(""), null);
});

test("tool_call blocks a Bash rename with sed, and nothing else", { skip: readConfig().mode === "off" && "AST Lens mode is off" }, async () => {
	const on = {};
	astLens({ on: (e, h) => (on[e] = h), registerTool: () => {}, registerCommand: () => {} });
	assert.equal(typeof on.tool_call, "function");
	const blocked = await on.tool_call({ toolName: "Bash", input: { command: "sed -i '' 's/fooBar/bazQux/g' src/*.ts" } }, { cwd: process.cwd() });
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /^AST Lens: a text rename also hits look-alike names, comments and strings\. Use lsp rename \(symbol fooBar, new_name bazQux; preview first, then apply: true\)\.$/);
	assert.equal(await on.tool_call({ toolName: "Bash", input: { command: "node --test tests/" } }, { cwd: process.cwd() }), undefined);
	assert.equal(await on.tool_call({ toolName: "Bash", input: { command: "sed -i 's/v1.2/v1.3/' package.json" } }, { cwd: process.cwd() }), undefined);
	assert.equal(await on.tool_call({ toolName: "Grep", input: { pattern: "fooBar" } }, { cwd: process.cwd() }), undefined, "Grep is never blocked");
	assert.equal(await on.tool_call({ toolName: "Edit", input: {} }, { cwd: process.cwd() }), undefined);
});
