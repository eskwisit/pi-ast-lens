import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

test("ships english and chinese texts and the apache-2.0 license", () => {
	for (const lang of ["en", "zh-CN"]) {
		for (const key of ["name", "description", "safetyNotes"]) assert.ok(manifest.i18n[lang][key], `${lang}.${key}`);
	}
	assert.equal(manifest.i18n.en.name, manifest.name);
	assert.equal(manifest.i18n.en.description, manifest.description);
	assert.equal(manifest.i18n.en.safetyNotes, manifest.safetyNotes);
	for (const name of ["ast_grep", "lsp", "/ast-lens", "agent.extension", "agent.prompt.inject"]) {
		for (const lang of ["en", "zh-CN"]) assert.ok(manifest.i18n[lang].safetyNotes.includes(name), `${lang}: ${name}`);
	}
	assert.equal(manifest.license, "Apache-2.0");
	assert.match(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
});

test("contributes files that exist, with the permissions they need", () => {
	for (const f of [manifest.main, ...manifest.contributes.agentExtensions, ...manifest.contributes.skills]) {
		assert.ok(fs.existsSync(path.join(ROOT, f)), f);
	}
	assert.deepEqual(manifest.permissions, ["agent.extension", "agent.prompt.inject"]);
	assert.equal(manifest.repository, "https://github.com/eskwisit/pi-ast-lens");
});
