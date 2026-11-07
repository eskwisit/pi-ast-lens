// Benchmark repos with ground truth. Each line can carry marks: "use:NAME" (a real use of the
// symbol the task is about, the declaration included), "def:NAME" (its declaration). Lines that only
// hold the name as text (comments, strings, another symbol with the same name) carry no mark.
import fs from "node:fs";
import path from "node:path";

class Repo {
	constructor(root) {
		this.root = root;
		this.files = new Map(); // rel -> lines
		this.truth = {}; // mark -> ["rel:line"]
	}

	/** A file builder: line(text, ...marks), filler(n, prefix, lang). */
	file(rel) {
		const lines = [];
		this.files.set(rel, lines);
		const b = {
			line: (text, ...marks) => {
				lines.push(text);
				for (const m of marks) (this.truth[m] ??= []).push(`${rel}:${lines.length}`);
				return b;
			},
			// Code that has nothing to do with the tasks, so a Read costs what it costs in a real file.
			filler: (n, prefix, lang) => {
				for (let i = 0; i < n; i++) {
					const f = `${prefix}${i}`;
					if (lang === "c") {
						b.line(`/* Scales v for slot ${i}. */`).line(`static int ${f}(int v) {`).line(`\tint scaled = v * ${i + 2} + 1;`).line(`\treturn scaled > 100 ? scaled - 100 : scaled;`).line("}").line("");
					} else {
						b.line(`/** Scales the input for slot ${i}. */`).line(`export function ${f}(input: number): number {`).line(`  const scaled = input * ${i + 2} + 1;`).line(`  return scaled > 100 ? scaled - 100 : scaled;`).line("}").line("");
					}
				}
				return b;
			},
		};
		return b;
	}

	/** Where the task points lsp: the declaration of name (in `inFile` when given). */
	at(name, inFile) {
		const all = this.truth[`def:${name}`].map((d) => d.split(":"));
		const [file, line] = all.find(([f]) => f === inFile) ?? all[0];
		return { file, line: Number(line) };
	}

	write() {
		for (const [rel, lines] of this.files) {
			const p = path.join(this.root, rel);
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.writeFileSync(p, `${lines.join("\n")}\n`);
		}
		return this;
	}
}

/**
 * A TypeScript monorepo: three tsconfig projects joined by a path alias, a test file, a script in
 * no project, a second `parseConfig` and many `get` and `id` that are other symbols.
 */
export function tsMonorepo(root) {
	const r = new Repo(root);
	r.file("package.json").line('{ "name": "mono", "private": true }');
	r.file("tsconfig.base.json").line('{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler", "baseUrl": ".", "paths": { "@mono/core": ["libs/core/src/index.ts"] } } }');
	for (const lib of ["core", "app", "web"]) r.file(`libs/${lib}/tsconfig.json`).line('{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts"] }');

	r.file("libs/core/src/config.ts")
		.line("/** Settings read from a config file. */")
		.line("export interface Config {", "def:Config", "use:Config")
		.line("  name: string;")
		.line("  size: number;")
		.line("}")
		.line("")
		.filler(8, "coreHelper", "ts")
		.line("/** Parses a config file. parseConfig never throws. */")
		.line("export function parseConfig(text: string): Config {", "def:parseConfig", "use:parseConfig", "use:Config")
		.line('  const [name, size] = text.split(":");')
		.line("  return { name, size: Number(size) };")
		.line("}")
		.line("")
		.filler(8, "coreMore", "ts")
		.line("/** Configs by name. */")
		.line("export class Store {", "def:Store", "use:Store")
		.line("  private items = new Map<string, Config>();", "use:Config")
		.line("  get(id: string): Config | undefined {", "def:get", "use:get", "use:Config")
		.line("    return this.items.get(id);")
		.line("  }")
		.line("  set(id: string, value: Config): void {", "use:Config")
		.line("    this.items.set(id, value);")
		.line("  }")
		.line("}");
	r.file("libs/core/src/index.ts")
		.line('export { parseConfig, Store } from "./config";', "use:parseConfig", "use:Store")
		.line('export type { Config } from "./config";', "use:Config");

	r.file("libs/app/src/main.ts")
		.line('import { parseConfig, Store } from "@mono/core";', "use:parseConfig", "use:Store")
		.line("")
		.filler(6, "appHelper", "ts")
		.line("// parseConfig is called once per text.")
		.line("export function loadAll(texts: string[]): Store {", "use:Store")
		.line("  const store = new Store();", "use:Store")
		.line("  for (const t of texts) {")
		.line("    const c = parseConfig(t);", "use:parseConfig")
		.line("    store.set(c.name, c);")
		.line("  }")
		.line("  return store;")
		.line("}")
		.line("")
		.line("export function first(store: Store, key: string) {", "use:Store")
		.line("  const cache = new Map<string, number>();")
		.line("  cache.get(key);")
		.line("  return store.get(key);", "use:get")
		.line("}")
		.line("")
		.line('export const label = "parseConfig failed";')
		.line("")
		.filler(6, "appMore", "ts")
		.line("export function renderWidgetTree(depth: number): string {", "def:renderWidgetTree", "use:renderWidgetTree")
		.line('  return depth > 0 ? renderWidgetTree(depth - 1) + "." : "";', "use:renderWidgetTree")
		.line("}");
	r.file("libs/app/src/main.test.ts")
		.line('import { parseConfig } from "@mono/core";', "use:parseConfig")
		.line('import { renderWidgetTree } from "./main";', "use:renderWidgetTree")
		.line("")
		.line('export const checks = [parseConfig("a:1"), parseConfig("b:2"), renderWidgetTree(2)];', "use:parseConfig", "use:renderWidgetTree");

	r.file("libs/web/src/view.ts")
		.line("/** A different parseConfig: it only trims. */")
		.line("function parseConfig(s: string): string {")
		.line("  return s.trim();")
		.line("}")
		.line("")
		.line("const api = {")
		.line("  get(url: string, id: number): string {")
		.line("    return `${url}/${id}`;")
		.line("  },")
		.line("};")
		.line("")
		.filler(6, "webHelper", "ts")
		.line('export const view = parseConfig(api.get("/x", 1));');

	r.file("scripts/tool.ts")
		.line('import { parseConfig } from "../libs/core/src/config";', "use:parseConfig")
		.line('console.log(parseConfig("x:1"));', "use:parseConfig");

	r.write();
	const at = r.at.bind(r);
	return {
		name: "typescript monorepo",
		lang: "typescript",
		root,
		files: [...r.files.keys()],
		truth: r.truth,
		tasks: [
			{ id: "ts-uses-parseConfig", kind: "uses", name: "parseConfig", at: at("parseConfig") },
			{ id: "ts-uses-get", kind: "uses", name: "get", at: at("get"), note: "common name" },
			{ id: "ts-uses-Store", kind: "uses", name: "Store", at: at("Store") },
			{ id: "ts-uses-Config", kind: "uses", name: "Config", at: at("Config") },
			{ id: "ts-uses-renderWidgetTree", kind: "uses", name: "renderWidgetTree", at: at("renderWidgetTree"), note: "rare name" },
			{ id: "ts-def-parseConfig", kind: "definition", name: "parseConfig" },
			{ id: "ts-def-Store", kind: "definition", name: "Store" },
			{ id: "ts-type-Config", kind: "explain", name: "Config", at: at("Config"), expect: ["name: string", "size: number"] },
			{ id: "ts-type-parseConfig", kind: "explain", name: "parseConfig", at: at("parseConfig"), expect: ["text: string", "Config"] },
			{ id: "ts-outline-config", kind: "outline", file: "libs/core/src/config.ts", expect: ["parseConfig", "Store", "get", "set", "Config"] },
			{ id: "ts-body-parseConfig", kind: "body", name: "parseConfig", at: at("parseConfig"), expect: ['text.split(":")'] },
			{ id: "ts-callers-parseConfig", kind: "callers", name: "parseConfig", at: at("parseConfig"), expect: ["loadAll"] },
		],
	};
}

/** A C project with a compile_commands.json, a header, and a `static int add` in two files. */
export function cRepo(root) {
	const r = new Repo(root);
	r.file("src/list.h")
		.line("#pragma once")
		.line("/* A growable list of ints. list_push appends. */")
		.line("struct list {", "def:list", "use:list")
		.line("\tint *items;")
		.line("\tint len;")
		.line("\tint cap;")
		.line("};")
		.line("void list_push(struct list *l, int v);", "def:list_push", "use:list_push", "use:list")
		.line("int list_get(const struct list *l, int i);", "def:list_get", "use:list_get", "use:list");
	r.file("src/list.c")
		.line('#include "list.h"')
		.line("#include <stdlib.h>")
		.line("")
		.filler(6, "list_helper", "c")
		.line("/* Doubles the room; called by list_push. */")
		.line("static void grow(struct list *l) {", "use:list")
		.line("\tl->cap = l->cap ? l->cap * 2 : 4;")
		.line("\tl->items = realloc(l->items, sizeof(int) * l->cap);")
		.line("}")
		.line("")
		.line("void list_push(struct list *l, int v) {", "def:list_push", "use:list_push", "use:list")
		.line("\tif (l->len == l->cap) grow(l);")
		.line("\tl->items[l->len++] = v;")
		.line("}")
		.line("")
		.line("int list_get(const struct list *l, int i) {", "def:list_get", "use:list_get", "use:list")
		.line("\treturn l->items[i];")
		.line("}");
	r.file("src/main.c")
		.line('#include <stdio.h>')
		.line('#include "list.h"')
		.line("")
		.line("static int add(int a, int b) {", "def:add", "use:add")
		.line("\treturn a + b;")
		.line("}")
		.line("")
		.filler(4, "main_helper", "c")
		.line("int main(void) {")
		.line("\tstruct list l = {0};", "use:list")
		.line("\tlist_push(&l, 1);", "use:list_push")
		.line("\tlist_push(&l, add(2, 3));", "use:list_push", "use:add")
		.line("\tlist_push(&l, add(list_get(&l, 0), 4));", "use:list_push", "use:add", "use:list_get")
		.line('\tif (l.len != 3) puts("list_push failed");')
		.line('\tprintf("%d\\n", list_get(&l, 2));', "use:list_get")
		.line("\treturn 0;")
		.line("}");
	r.file("src/other.c")
		.line("/* Its own add, not the one in main.c. */")
		.line("static int add(int a, int b) {")
		.line("\treturn a - b;")
		.line("}")
		.line("int other(void) {")
		.line("\treturn add(1, 2);")
		.line("}");
	r.write();
	const cc = ["list.c", "main.c", "other.c"].map((f) => ({ directory: path.join(root, "src"), file: path.join(root, "src", f), arguments: ["cc", "-c", f, "-I."] }));
	fs.writeFileSync(path.join(root, "compile_commands.json"), JSON.stringify(cc, null, 2));
	const at = r.at.bind(r);
	return {
		name: "c project",
		lang: "c",
		root,
		files: [...r.files.keys()],
		truth: r.truth,
		tasks: [
			{ id: "c-uses-list_push", kind: "uses", name: "list_push", at: at("list_push") },
			{ id: "c-uses-list_get", kind: "uses", name: "list_get", at: at("list_get") },
			{ id: "c-uses-add", kind: "uses", name: "add", at: at("add"), note: "short name, two symbols" },
			{ id: "c-def-list_get", kind: "definition", name: "list_get" },
			{ id: "c-type-list", kind: "explain", name: "list", at: at("list"), expect: ["struct list"] },
			{ id: "c-outline-list", kind: "outline", file: "src/list.c", expect: ["list_push", "list_get", "grow"] },
			{ id: "c-body-list_push", kind: "body", name: "list_push", at: at("list_push", "src/list.c"), expect: ["grow(l)"] },
			{ id: "c-callers-list_push", kind: "callers", name: "list_push", at: at("list_push"), expect: ["main"] },
		],
	};
}
