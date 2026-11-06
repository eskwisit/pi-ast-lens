"use strict";

// Entry point for `node --test tests/`: pulls in every *.test.mjs next to it (Node 22+ loads this
// file for a directory argument). `node --test tests/*.test.mjs` works on every version.

const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");

(async () => {
	for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.mjs")).sort()) {
		await import(url.pathToFileURL(path.join(__dirname, file)).href);
	}
})();
