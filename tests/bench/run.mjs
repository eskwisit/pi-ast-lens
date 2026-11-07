// Scripted benchmark: what an agent reads to answer code questions with Grep + Read, and with AST
// Lens. Repos with ground truth are built in a temp folder (see fixtures.mjs); every task runs
// against the real ast-grep, clangd and typescript-language-server, and is skipped when its server
// is missing.
//
//   node tests/bench/run.mjs                 table for this build
//   node tests/bench/run.mjs --ref v0.3.2    the same tasks also on a git ref, to compare builds
//   node tests/bench/run.mjs --gate          exit 1 when a success criterion fails
//   node tests/bench/run.mjs --json out.json all numbers, for a later comparison
//
// Measured per task: characters the agent reads (tool output plus the Reads it needs after it),
// tokens as characters / 4 (an estimate: a real tokenizer gives more for paths and code), recall
// and precision against the ground truth, and wall time. Agent runs (tool choice, repeated runs)
// are not part of this script.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";
import { cRepo, tsMonorepo } from "./fixtures.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const GATE = argv.includes("--gate");
const REF = opt("--ref");
const JSON_OUT = opt("--json");

// Criteria from the council verdict (.llm-council run 20261106-200119).
const RATIO_MAX = 0.5; // code tasks: AST Lens reads at most half of Grep + Read
const DEFINITION_MAX = 755; // definition by name: no larger than `rg 'class X'`
const FOOTER = /\[\d+ verified in \d+ files?, \d+ unverified text match(es)?, \d+ files? unchecked/;

// Builds
// ======

async function loadBuild(label, file) {
	const mod = await import(url.pathToFileURL(file).href);
	const tools = {};
	const on = {};
	mod.default({ on: (e, h) => (on[e] = h), registerTool: (t) => (tools[t.name] = t), registerCommand: () => {} });
	return { label, mod, tools, on };
}

const builds = [await loadBuild("current", path.join(ROOT, "extension", "ast-lens.js"))];
if (REF) {
	// Before 0.4 the plugin was named Code Compass, with its extension in extension/code-compass.js.
	let src = spawnSync("git", ["show", `${REF}:extension/ast-lens.js`], { cwd: ROOT, encoding: "utf8" });
	if (src.status !== 0) src = spawnSync("git", ["show", `${REF}:extension/code-compass.js`], { cwd: ROOT, encoding: "utf8" });
	if (src.status !== 0) throw new Error(`git show ${REF}: ${src.stderr}`);
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-ref-")), "ast-lens.mjs");
	fs.writeFileSync(f, src.stdout);
	builds.push(await loadBuild(REF, f));
}

async function call(build, name, params, cwd) {
	const t0 = performance.now();
	try {
		if (!build.tools[name]) throw new Error(`no ${name} tool`);
		const r = await build.tools[name].execute("bench", params, undefined, undefined, { cwd });
		return { text: r.content.map((c) => c.text).join("\n"), ms: performance.now() - t0 };
	} catch (e) {
		return { text: `Error: ${e.message}`, ms: performance.now() - t0, error: true };
	}
}

// What the agent does without AST Lens
// ========================================

const SKIP = new Set(["node_modules", ".git", ".cache"]);

function walk(root) {
	const out = [];
	const go = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (SKIP.has(e.name)) continue;
			const p = path.join(d, e.name);
			if (e.isDirectory()) go(p);
			else out.push(p);
		}
	};
	go(root);
	return out;
}

/** Grep for name as a whole word (`rg -nw`), in Grep's `path:line: text` form. */
function grep(root, name) {
	const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`);
	const out = [];
	for (const f of walk(root)) {
		const lines = fs.readFileSync(f, "utf8").split("\n");
		lines.forEach((l, i) => re.test(l) && out.push(`${path.relative(root, f).split(path.sep).join("/")}:${i + 1}: ${l}`));
	}
	return out.join("\n");
}

/** A whole-file Read, with line numbers. */
const read = (root, rel) =>
	fs.readFileSync(path.join(root, rel), "utf8").replace(/\n$/, "").split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");

// Scoring
// =======

/** The `path:line` pairs a result shows: `path:line[:col]: text`, a path line then `line[:col]: text`, or `N in comments/strings: lines a, b`. */
function shown(text, files) {
	const known = new Set(files);
	const out = new Set();
	let cur = null;
	for (const raw of text.split("\n")) {
		const l = raw.replace(/#[0-9A-F]{4}$/, "");
		if (known.has(l.trim())) {
			cur = l.trim();
			continue;
		}
		const flat = l.match(/^(\S[^:]*?):(\d+)(?::\d+)?: /);
		if (flat && known.has(flat[1])) {
			out.add(`${flat[1]}:${flat[2]}`);
			continue;
		}
		const grouped = l.match(/^(\d+)(?::[\d,]+)?: /);
		if (grouped && cur) {
			out.add(`${cur}:${grouped[1]}`);
			continue;
		}
		const quiet = l.match(/^\d+ in comments\/strings: lines? ([\d, ]+)$/);
		if (quiet && cur) for (const n of quiet[1].split(",")) out.add(`${cur}:${n.trim()}`);
	}
	return out;
}

function score(text, truth, files) {
	const got = shown(text, files);
	const want = new Set(truth);
	const hit = [...got].filter((x) => want.has(x)).length;
	return { recall: want.size ? hit / want.size : 1, precision: got.size ? hit / got.size : 0, missed: [...want].filter((x) => !got.has(x)) };
}

const has = (text, expect) => expect.every((e) => text.includes(e));
const tokens = (chars) => Math.ceil(chars / 4);

// Tasks
// =====

/** The baseline (Grep + Read) and the AST Lens calls for one task, scored. */
async function runTask(repo, task, build) {
	const { root, files, truth } = repo;
	const symbol = task.name;
	const at = task.at;
	const r = { id: task.id, kind: task.kind, note: task.note ?? "" };
	const g = () => grep(root, symbol);
	let base;
	let cc;
	switch (task.kind) {
		case "uses": {
			base = g();
			cc = await call(build, "lsp", { operation: "references", file: at.file, line: at.line, symbol }, root);
			const want = truth[`use:${symbol}`];
			r.base = score(base, want, files);
			r.cc = score(cc.text, want, files);
			r.footer = FOOTER.test(cc.text);
			if (build.mod.rewriteGrep) {
				const ev = { toolName: "Grep", input: { pattern: symbol }, content: [{ type: "text", text: base }] };
				const rg = await build.mod.rewriteGrep(ev, root, 2000);
				r.grepViaLens = { chars: (rg?.text ?? base).length, ...score(rg?.text ?? base, want, files) };
			}
			break;
		}
		case "definition": {
			base = g();
			cc = await call(build, "lsp", { operation: "definition", symbol, lang: repo.lang }, root);
			if (cc.error) cc = await call(build, "lsp", { operation: "workspace_symbols", query: symbol, lang: repo.lang }, root);
			const want = truth[`def:${symbol}`];
			const one = (t) => ({ ...score(t, want, files), found: [...shown(t, files)].some((x) => want.includes(x)) });
			r.base = one(base);
			r.cc = one(cc.text);
			r.ok = r.cc.found && cc.text.length <= DEFINITION_MAX;
			break;
		}
		case "explain": {
			const def = truth[`def:${symbol}`][0].split(":")[0];
			base = `${g()}\n${read(root, def)}`;
			cc = await call(build, "lsp", { operation: "hover", file: at.file, line: at.line, symbol }, root);
			r.ok = has(cc.text, task.expect);
			break;
		}
		case "outline": {
			base = read(root, task.file);
			cc = await call(build, "lsp", { operation: "symbols", file: task.file }, root);
			r.ok = has(cc.text, task.expect);
			break;
		}
		case "body": {
			base = read(root, at.file);
			cc = await call(build, "lsp", { operation: "symbols", file: at.file, symbol, line: at.line, body: true }, root);
			r.ok = has(cc.text, task.expect);
			break;
		}
		case "callers": {
			// Grep gives the lines; the agent Reads each code file with a hit to see the function around it.
			const hits = g();
			const withHits = [...new Set(hits.split("\n").filter(Boolean).map((l) => l.split(":")[0]))].filter((f) => /\.(ts|c|h)$/.test(f));
			base = [hits, ...withHits.map((f) => read(root, f))].join("\n");
			cc = await call(build, "lsp", { operation: "references", file: at.file, line: at.line, symbol, output: "functions" }, root);
			r.ok = has(cc.text, task.expect);
			r.footer = FOOTER.test(cc.text);
			break;
		}
		case "text": {
			base = g();
			cc = { text: base, ms: 0 };
			if (build.mod.rewriteGrep) {
				const ev = { toolName: "Grep", input: { pattern: symbol }, content: [{ type: "text", text: base }] };
				cc.text = (await build.mod.rewriteGrep(ev, root, 2000))?.text ?? base;
			}
			// Text search: every line must stay readable, at no more cost than Grep.
			const lines = base.split("\n").map((l) => l.replace(/^[^:]+:\d+: /, "").trim());
			r.ok = lines.every((l) => cc.text.includes(l)) && cc.text.length <= base.length;
			break;
		}
	}
	r.baseChars = base.length;
	r.ccChars = cc.text.length;
	r.ms = Math.round(cc.ms);
	r.error = cc.error ? cc.text : undefined;
	r.output = cc.text;
	return r;
}

function serverFor(build, lang) {
	const ext = { typescript: "ts", c: "c" }[lang];
	const spec = build.mod.serverSpecFor(ext);
	return spec.candidates.some((c) => build.mod.which(c.cmd, ROOT));
}

// Run
// ===

const repos = [
	tsMonorepo(fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-bench-ts-"))),
	cRepo(fs.mkdtempSync(path.join(os.tmpdir(), "ast-lens-bench-c-"))),
];
// A text search: Grep's job. AST Lens must leave it as readable and no larger.
for (const repo of repos) repo.tasks.push({ id: `${repo.lang === "c" ? "c" : "ts"}-text-failed`, kind: "text", name: "failed" });

const pct = (a, b) => (b ? `${Math.round((a / b - 1) * 100)}%` : "-");
const rp = (s) => (s ? `${s.recall.toFixed(2)}/${s.precision.toFixed(2)}` : "");
const pad = (s, n, right) => (right ? String(s).padStart(n) : String(s).padEnd(n));

const results = {};
const failures = [];
for (const build of builds) {
	results[build.label] = {};
	for (const repo of repos) {
		if (!serverFor(build, repo.lang)) {
			console.log(`\n## ${repo.name} · ${build.label}: skipped, no ${repo.lang} language server installed`);
			continue;
		}
		const rows = [];
		for (const task of repo.tasks) rows.push(await runTask(repo, task, build));
		results[build.label][repo.name] = rows;

		console.log(`\n## ${repo.name} · ${build.label}`);
		console.log(`${pad("task", 26)} ${pad("Grep+Read", 9, 1)} ${pad("AST Lens", 8, 1)} ${pad("change", 7, 1)} ${pad("Grep→CC", 8, 1)}  ${pad("R/P grep", 9)} ${pad("R/P CC", 9)} ${pad("ms", 6, 1)}  check`);
		let sumBase = 0;
		let sumCc = 0;
		for (const r of rows) {
			const check = r.error ? `ERROR ${r.error.slice(0, 60)}` : [r.ok === undefined ? "" : r.ok ? "ok" : "WRONG", r.footer === false ? "NO FOOTER" : "", r.cc?.missed?.length && r.kind === "uses" ? `missed ${r.cc.missed.join(" ")}` : "", r.note].filter(Boolean).join(" · ");
			console.log(`${pad(r.id, 26)} ${pad(r.baseChars, 9, 1)} ${pad(r.ccChars, 8, 1)} ${pad(pct(r.ccChars, r.baseChars), 7, 1)} ${pad(r.grepViaLens?.chars ?? "", 8, 1)}  ${pad(rp(r.base), 9)} ${pad(rp(r.cc), 9)} ${pad(r.ms, 6, 1)}  ${check}`);
			if (r.kind !== "text") {
				sumBase += r.baseChars;
				sumCc += r.ccChars;
			}
			if (build.label !== "current") continue;
			if (r.error) failures.push(`${r.id}: ${r.error}`);
			else if (r.ok === false) failures.push(`${r.id}: wrong or too large answer`);
			if (r.footer === false) failures.push(`${r.id}: references without a coverage footer`);
			if (r.kind === "uses" && r.cc.recall < r.base.recall) failures.push(`${r.id}: recall ${r.cc.recall.toFixed(2)} < Grep ${r.base.recall.toFixed(2)} (missed ${r.cc.missed.join(", ")})`);
			if (r.grepViaLens && r.grepViaLens.recall < r.base.recall) failures.push(`${r.id}: the rewritten Grep result lost hits`);
		}
		const ratio = sumCc / sumBase;
		console.log(`code tasks: Grep+Read ${sumBase} chars (~${tokens(sumBase)} tok), AST Lens ${sumCc} chars (~${tokens(sumCc)} tok): ${(ratio * 100).toFixed(0)}% of the baseline (target ≤ ${RATIO_MAX * 100}%)`);
		if (build.label === "current" && ratio > RATIO_MAX) failures.push(`${repo.name}: AST Lens reads ${(ratio * 100).toFixed(0)}% of Grep + Read, above ${RATIO_MAX * 100}%`);
	}
	await build.mod._test.stopAll();
}

if (JSON_OUT) fs.writeFileSync(JSON_OUT, `${JSON.stringify(results, null, "\t")}\n`);
if (failures.length) {
	console.log(`\n${failures.length} criteria failed:\n- ${failures.join("\n- ")}`);
	if (GATE) process.exitCode = 1;
} else console.log("\nAll criteria met.");
