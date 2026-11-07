// AST Lens: the agent reads code as syntax (ast-grep) and symbols (LSP) instead of grepping text.
//
//   ast_grep  structural search (and optional rewrite) with ast-grep; the language comes from the
//             file extension, the globs, or the most common code language under the path
//   lsp       definition (also by name), references (with a coverage footer), hover, implementation,
//             type definition, symbols, workspace symbols and diagnostics; the language server is
//             picked by the file extension, started on first use and kept running until it is idle
//   Grep      a Grep result for an identifier is grouped by file; with ast-grep, hits in comments and
//             strings collapse to their line numbers and the definition is marked (mode "steer");
//             mode "off" leaves Grep alone. Set it with /ast-lens mode <steer|off>.
//   debug     run a program to a breakpoint: stack, locals and expressions (extension/debug.js)
//
// All results share one format: the path once, then `line:col: text`, at most `limit` hits, and a
// footer that counts the rest.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { debugTool, stopDebug, DEBUG_OPS } from "./debug.js";

const MARKER = "<!-- ast-lens -->";
const OUTPUT_LIMIT = 40000;
const LINE_MAX = 200; // a longer source line is cut to a window around the match
const LIMIT_DEFAULT = 50;
const SYMBOLS_LIMIT_DEFAULT = 10; // workspace_symbols
const SG_TIMEOUT_MS = 60000;
const SG_COLLECT_MAX = 2000;
const LSP_REQUEST_MS = 30000;
const REFS_BUDGET_MS = 5000; // references: check files for this long, then return what is known
const REFS_CONTINUE_MS = 30000; // references with continue: true
const NOTES_BUDGET_MS = 2000; // enclosing-symbol notes on references
const TAG_BUDGET_MS = 150; // ast-grep tagging of a Grep result; skipped when slower
const CANDIDATE_FILES_MAX = 300;
const CANDIDATE_BYTES_MAX = 64 * 1024 * 1024;
const LSP_START_MS = 45000;
const LSP_IDLE_MS = 10 * 60 * 1000;
const REAPER_MS = 30000;
const DIAG_WAIT_MS = 8000;
const DIAG_SETTLE_MS = 400;
const READY_MAX_MS = 30000; // wait for a fresh server's startup work at most this long after it started
const READY_OPEN_MS = 600; // pause after opening a file in a young server
const READY_QUIET_MS = 250; // no progress for this long counts as idle
const READY_LOAD_START_MS = 150; // tsserver: time for a project load to report itself after a file is opened
const sleep = (ms, signal) =>
	new Promise((resolve) => {
		const done = () => {
			clearTimeout(t);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const t = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
const WALK_BUDGET = 6000;
const HINTS_PER_PROMPT = 2;
const MODES = ["steer", "off"];
/** Language servers tested end to end. The others are experimental: no Grep steering to them. */
export const VERIFIED = new Set(["typescript", "c/c++"]);
const CONFIG_FILE = process.platform === "win32"
	? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ast-lens", "config.json")
	: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ast-lens", "config.json");
// The plugin was named Code Compass before 0.4: its config is read when there is no new one.
const LEGACY_CONFIG_FILE = path.join(path.dirname(path.dirname(CONFIG_FILE)), "code-compass", "config.json");
const SKIP_DIRS = new Set([
	"node_modules", "dist", "build", "out", "coverage", "target", "vendor", "venv", "__pycache__",
	"bower_components", "site-packages", "Pods", "DerivedData", ".build", "bin", "obj",
]);

// Languages
// =========

/** File extension (no dot, lower case) -> ast-grep language. */
export const SG_LANGS = {
	ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
	js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
	py: "python", pyi: "python", go: "go", rs: "rust",
	c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
	cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", sc: "scala",
	swift: "swift", rb: "ruby", php: "php", lua: "lua", sh: "bash", bash: "bash", zsh: "bash",
	ex: "elixir", exs: "elixir", hs: "haskell", css: "css", html: "html", htm: "html",
	json: "json", yaml: "yaml", yml: "yaml", nix: "nix", sol: "solidity", tf: "hcl", hcl: "hcl",
};

/** Names an agent may give for a language -> ast-grep language. */
const LANG_ALIASES = {
	ts: "typescript", typescript: "typescript", tsx: "tsx", js: "javascript", jsx: "javascript",
	javascript: "javascript", py: "python", python: "python", go: "go", golang: "go", rs: "rust",
	rust: "rust", c: "c", cpp: "cpp", "c++": "cpp", cs: "csharp", csharp: "csharp", "c#": "csharp",
	java: "java", kt: "kotlin", kotlin: "kotlin", scala: "scala", swift: "swift", rb: "ruby",
	ruby: "ruby", php: "php", lua: "lua", sh: "bash", bash: "bash", shell: "bash", ex: "elixir",
	elixir: "elixir", hs: "haskell", haskell: "haskell", css: "css", html: "html", json: "json",
	yaml: "yaml", yml: "yaml", nix: "nix", sol: "solidity", solidity: "solidity", hcl: "hcl",
	terraform: "hcl",
};

/**
 * Language servers by file extension. The first candidate whose command is installed is used.
 * `id` names the LSP languageId for an extension; `markers` find the project root.
 */
export const SERVERS = [
	{
		name: "typescript", exts: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
		id: (e) => ({ ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact", jsx: "javascriptreact" })[e] ?? "javascript",
		markers: ["tsconfig.json", "jsconfig.json", "package.json"],
		root: "outermost", // tsserver serves every tsconfig project below it: one server per workspace
		crossProject: true, // it answers references only from loaded projects
		candidates: [
			// TypeScript 7 (the native port) is its own language server; typescript-language-server cannot load it.
			{ cmd: "tsc", args: ["--lsp", "--stdio"], local: true, when: (root) => tsMajor(root) >= 7, install: "TypeScript 7 in the project" },
			// tsgo answers 4 to 8 times faster than tsserver; it also serves TypeScript 5 and 6 projects whose
			// root tsconfig uses no option TypeScript 7 dropped.
			{ cmd: "tsgo", args: ["--lsp", "--stdio"], when: (root) => tsMajor(root) === 0 || tsMajor(root) >= 7 || !tsDroppedOptions(root).length, install: "npm i -g @typescript/native-preview" },
			{ cmd: "typescript-language-server", args: ["--stdio"], init: { disableAutomaticTypingAcquisition: true }, when: (root) => tsMajor(root) < 7, install: "npm i -g typescript typescript-language-server" },
			{ cmd: "vtsls", args: ["--stdio"], when: (root) => tsMajor(root) < 7, install: "npm i -g @vtsls/language-server" },
		],
	},
	{
		name: "python", exts: ["py", "pyi"], id: () => "python",
		markers: ["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json", "requirements.txt"],
		candidates: [
			{ cmd: "basedpyright-langserver", args: ["--stdio"], install: "pip install basedpyright" },
			{ cmd: "pyright-langserver", args: ["--stdio"], install: "npm i -g pyright" },
			{ cmd: "pylsp", args: [], install: "pip install python-lsp-server" },
			{ cmd: "jedi-language-server", args: [], install: "pip install jedi-language-server" },
		],
	},
	{
		name: "go", exts: ["go"], id: () => "go", markers: ["go.work", "go.mod"],
		candidates: [{ cmd: "gopls", args: [], install: "go install golang.org/x/tools/gopls@latest" }],
	},
	{
		name: "rust", exts: ["rs"], id: () => "rust", markers: ["Cargo.toml"],
		candidates: [{ cmd: "rust-analyzer", args: [], install: "rustup component add rust-analyzer" }],
	},
	{
		name: "c/c++", exts: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm"],
		id: (e) => ({ c: "c", h: "c", m: "objective-c", mm: "objective-cpp" })[e] ?? "cpp",
		markers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", "Makefile"],
		candidates: [{ cmd: "clangd", args: [], install: { darwin: "brew install llvm, or xcode-select --install", linux: "apt install clangd, or dnf install clang-tools-extra", win32: "winget install LLVM.LLVM" } }],
	},
	{
		name: "swift", exts: ["swift"], id: () => "swift", markers: ["Package.swift"],
		candidates: [{ cmd: "sourcekit-lsp", args: [], install: { darwin: "comes with Xcode", any: "comes with the Swift toolchain (swift.org/install)" } }],
	},
	{
		name: "java", exts: ["java"], id: () => "java", markers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
		candidates: [{ cmd: "jdtls", args: [], install: { darwin: "brew install jdtls", any: "Eclipse JDT LS from github.com/eclipse-jdtls/eclipse.jdt.ls" } }],
	},
	{
		name: "kotlin", exts: ["kt", "kts"], id: () => "kotlin", markers: ["build.gradle.kts", "build.gradle", "settings.gradle.kts"],
		candidates: [{ cmd: "kotlin-language-server", args: [], install: { darwin: "brew install kotlin-language-server", any: "a release from github.com/fwcd/kotlin-language-server" } }],
	},
	{
		name: "csharp", exts: ["cs"], id: () => "csharp", markers: ["*.sln", "*.csproj"],
		candidates: [
			{ cmd: "csharp-ls", args: [], install: "dotnet tool install -g csharp-ls" },
			{ cmd: "OmniSharp", args: ["-lsp"], install: "a release from github.com/OmniSharp/omnisharp-roslyn" },
		],
	},
	{
		name: "ruby", exts: ["rb"], id: () => "ruby", markers: ["Gemfile"],
		candidates: [
			{ cmd: "ruby-lsp", args: [], install: "gem install ruby-lsp" },
			{ cmd: "solargraph", args: ["stdio"], install: "gem install solargraph" },
		],
	},
	{
		name: "php", exts: ["php"], id: () => "php", markers: ["composer.json"],
		candidates: [
			{ cmd: "intelephense", args: ["--stdio"], install: "npm i -g intelephense" },
			{ cmd: "phpactor", args: ["language-server"], install: "phpactor from phpactor.readthedocs.io" },
		],
	},
	{
		name: "lua", exts: ["lua"], id: () => "lua", markers: [".luarc.json", ".luarc.jsonc"],
		candidates: [{ cmd: "lua-language-server", args: [], install: { darwin: "brew install lua-language-server", win32: "scoop install lua-language-server", any: "a release from github.com/LuaLS/lua-language-server" } }],
	},
	{
		name: "bash", exts: ["sh", "bash", "zsh"], id: () => "shellscript", markers: [],
		candidates: [{ cmd: "bash-language-server", args: ["start"], install: "npm i -g bash-language-server" }],
	},
	{
		name: "zig", exts: ["zig"], id: () => "zig", markers: ["build.zig"],
		candidates: [{ cmd: "zls", args: [], install: { darwin: "brew install zls", win32: "scoop install zls", any: "a release from github.com/zigtools/zls" } }],
	},
	{
		name: "elixir", exts: ["ex", "exs"], id: () => "elixir", markers: ["mix.exs"],
		candidates: [
			{ cmd: "elixir-ls", args: [], install: { darwin: "brew install elixir-ls", any: "a release from github.com/elixir-lsp/elixir-ls" } },
			{ cmd: "lexical", args: [], install: "a release from github.com/lexical-lsp/lexical" },
		],
	},
	{
		name: "dart", exts: ["dart"], id: () => "dart", markers: ["pubspec.yaml"],
		candidates: [{ cmd: "dart", args: ["language-server"], install: "install the Dart SDK" }],
	},
	{
		name: "haskell", exts: ["hs"], id: () => "haskell", markers: ["stack.yaml", "cabal.project", "*.cabal"],
		candidates: [{ cmd: "haskell-language-server-wrapper", args: ["--lsp"], install: "ghcup install hls" }],
	},
	{
		name: "ocaml", exts: ["ml", "mli"], id: () => "ocaml", markers: ["dune-project"],
		candidates: [{ cmd: "ocamllsp", args: [], install: "opam install ocaml-lsp-server" }],
	},
	{
		name: "scala", exts: ["scala", "sc"], id: () => "scala", markers: ["build.sbt", "build.sc"],
		candidates: [{ cmd: "metals", args: [], install: "coursier install metals" }],
	},
	{
		name: "vue", exts: ["vue"], id: () => "vue", markers: ["package.json"],
		candidates: [{ cmd: "vue-language-server", args: ["--stdio"], install: "npm i -g @vue/language-server" }],
	},
	{
		name: "svelte", exts: ["svelte"], id: () => "svelte", markers: ["package.json"],
		candidates: [{ cmd: "svelteserver", args: ["--stdio"], install: "npm i -g svelte-language-server" }],
	},
	{
		name: "terraform", exts: ["tf", "tfvars"], id: () => "terraform", markers: [".terraform", "main.tf"],
		candidates: [{ cmd: "terraform-ls", args: ["serve"], install: { darwin: "brew install hashicorp/tap/terraform-ls", win32: "choco install terraform-ls", any: "terraform-ls from the HashiCorp package repository" } }],
	},
	{
		name: "css", exts: ["css", "scss", "less"], id: (e) => e, markers: ["package.json"],
		candidates: [{ cmd: "vscode-css-language-server", args: ["--stdio"], install: "npm i -g vscode-langservers-extracted" }],
	},
	{
		name: "html", exts: ["html", "htm"], id: () => "html", markers: ["package.json"],
		candidates: [{ cmd: "vscode-html-language-server", args: ["--stdio"], install: "npm i -g vscode-langservers-extracted" }],
	},
	{
		name: "json", exts: ["json", "jsonc"], id: (e) => e, markers: ["package.json"],
		candidates: [{ cmd: "vscode-json-language-server", args: ["--stdio"], install: "npm i -g vscode-langservers-extracted" }],
	},
	{
		name: "yaml", exts: ["yaml", "yml"], id: () => "yaml", markers: [],
		candidates: [{ cmd: "yaml-language-server", args: ["--stdio"], install: "npm i -g yaml-language-server" }],
	},
];

/** Extensions that hold program code (for Grep steering). */
export const CODE_EXTS = new Set([
	...Object.keys(SG_LANGS).filter((e) => !["json", "yaml", "yml", "css", "html", "htm"].includes(e)),
	...SERVERS.flatMap((s) => s.exts).filter((e) => !["json", "jsonc", "yaml", "yml", "css", "scss", "less", "html", "htm", "tfvars"].includes(e)),
]);

/** Lower-case extension without the dot; "" when none. */
export function extOf(p) {
	const base = String(p ?? "").split(/[\\/]/).pop() ?? "";
	const i = base.lastIndexOf(".");
	return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** Extensions a glob names, e.g. "src/**\/*.{ts,tsx}" -> ["ts", "tsx"]. */
export function globExts(glob) {
	const out = [];
	for (const g of [].concat(glob ?? []).map(String)) {
		const brace = g.match(/\*\.\{([^}]+)\}\s*$/);
		if (brace) out.push(...brace[1].split(",").map((e) => e.trim().toLowerCase()));
		else {
			const one = g.match(/\*\.([A-Za-z0-9+_-]+)\s*$/);
			if (one) out.push(one[1].toLowerCase());
		}
	}
	return out.filter(Boolean);
}

export function normalizeLang(lang) {
	const k = String(lang ?? "").trim().toLowerCase();
	return k ? LANG_ALIASES[k] ?? k : "";
}

export function serverSpecFor(ext, overrides = {}) {
	const spec = SERVERS.find((s) => s.exts.includes(ext));
	const o = overrides[ext] ?? overrides[`.${ext}`];
	if (Array.isArray(o) && o.length && o.every((x) => typeof x === "string")) {
		const base = spec ?? { name: ext, exts: [ext], id: () => ext, markers: [] };
		return { ...base, candidates: [{ cmd: o[0], args: o.slice(1), install: "from your AST Lens config" }] };
	}
	return spec ?? null;
}

// Paths and processes
// ===================

const HOME = os.homedir();
const IS_WIN = process.platform === "win32";
const env = process.env;

/** Canonical path (symlinks resolved, e.g. macOS /var -> /private/var; real drive and name case on Windows), or the path itself. */
function real(p) {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return p;
	}
}

/** Major version of the TypeScript a project resolves (nearest node_modules/typescript), 0 when none. */
/**
 * tsconfig options of the workspace root that TypeScript 7 (tsgo) no longer supports: baseUrl, classic or
 * node10 resolution, AMD/UMD/System modules, esModuleInterop: false. Reads tsconfig.json and
 * tsconfig.base.json at the root and the configs they extend. With any of them, use tsserver.
 */
export function tsDroppedOptions(root) {
	const found = new Set();
	const seen = new Set();
	const read = (file, depth) => {
		if (depth > 3 || seen.has(file)) return;
		seen.add(file);
		let text;
		try {
			text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/[^\n]*/g, "$1");
		} catch {
			return;
		}
		if (/"baseUrl"\s*:/.test(text)) found.add("baseUrl");
		if (/"moduleResolution"\s*:\s*"(classic|node|node10)"/i.test(text)) found.add("moduleResolution");
		if (/"module"\s*:\s*"(amd|umd|system|none)"/i.test(text)) found.add("module");
		if (/"esModuleInterop"\s*:\s*false/.test(text)) found.add("esModuleInterop");
		for (const m of text.matchAll(/"extends"\s*:\s*(?:"([^"]+)"|\[([^\]]*)\])/g)) {
			const list = m[1] ? [m[1]] : [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
			for (const e of list) if (e.startsWith(".")) read(path.resolve(path.dirname(file), e.endsWith(".json") ? e : `${e}.json`), depth + 1);
		}
	};
	for (const n of ["tsconfig.json", "tsconfig.base.json"]) read(path.join(root, n), 0);
	return [...found];
}

export function tsMajor(root) {
	for (let dir = root; ; dir = path.dirname(dir)) {
		try {
			const v = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", "typescript", "package.json"), "utf8")).version;
			return Number.parseInt(String(v), 10) || 0;
		} catch {}
		if (path.dirname(dir) === dir) return 0;
	}
}

/** node_modules/.bin directories from dir up to the filesystem root. */
function localBins(dir) {
	const out = [];
	for (let d = dir; ; d = path.dirname(d)) {
		out.push(path.join(d, "node_modules", ".bin"));
		if (path.dirname(d) === d) return out;
	}
}

/** Immediate subdirectories of parent whose name matches re, newest version first, each joined with tail. */
function versionDirs(parent, re, ...tail) {
	try {
		return fs
			.readdirSync(parent)
			.filter((n) => re.test(n))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
			.map((n) => path.join(parent, n, ...tail));
	} catch {
		return [];
	}
}

/** Where installers put commands on this platform, beyond PATH. */
function platformDirs() {
	if (IS_WIN) {
		const roaming = env.APPDATA || path.join(HOME, "AppData", "Roaming");
		const local = env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
		const pf = env.ProgramFiles || "C:\\Program Files";
		return [
			path.join(roaming, "npm"), path.join(local, "pnpm"), path.join(local, "Volta", "bin"),
			path.join(HOME, "scoop", "shims"), path.join(env.ProgramData || "C:\\ProgramData", "chocolatey", "bin"),
			path.join(local, "Microsoft", "WinGet", "Links"), path.join(pf, "LLVM", "bin"), path.join(pf, "nodejs"),
			path.join(HOME, ".cargo", "bin"), path.join(HOME, "go", "bin"), path.join(pf, "Go", "bin"),
			path.join(HOME, ".dotnet", "tools"), path.join(HOME, ".bun", "bin"), path.join(HOME, ".deno", "bin"),
			path.join(HOME, ".local", "bin"), path.join(local, "Coursier", "data", "bin"), "C:\\ghcup\\bin",
			...versionDirs(path.join(local, "Programs", "Python"), /^Python3/i, "Scripts"),
			...versionDirs(path.join(roaming, "Python"), /^Python3/i, "Scripts"),
		];
	}
	return [
		"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", path.join(HOME, ".linuxbrew", "bin"),
		// Homebrew's llvm is keg-only: clangd is not linked into bin.
		"/opt/homebrew/opt/llvm/bin", "/usr/local/opt/llvm/bin",
		"/usr/bin", "/bin", "/snap/bin", "/usr/local/go/bin",
		path.join(HOME, ".cargo", "bin"), path.join(HOME, "go", "bin"), path.join(HOME, ".local", "bin"),
		path.join(HOME, ".bun", "bin"), path.join(HOME, ".npm-global", "bin"), path.join(HOME, ".volta", "bin"),
		path.join(HOME, ".deno", "bin"), path.join(HOME, ".dotnet", "tools"), path.join(HOME, ".ghcup", "bin"),
		path.join(HOME, ".asdf", "shims"), path.join(HOME, ".local", "share", "mise", "shims"),
		path.join(HOME, ".local", "share", "pnpm"), path.join(HOME, "Library", "pnpm"),
		path.join(HOME, ".local", "share", "fnm", "aliases", "default", "bin"),
		path.join(HOME, "Library", "Application Support", "fnm", "aliases", "default", "bin"),
		...versionDirs(path.join(HOME, ".nvm", "versions", "node"), /^v\d/, "bin"),
		path.join(HOME, ".local", "share", "coursier", "bin"), path.join(HOME, "Library", "Application Support", "Coursier", "bin"),
		...versionDirs(path.join(HOME, "Library", "Python"), /^3\./, "bin"),
	];
}

/**
 * PATH of the user's login shell. Apps started from the Dock or a desktop launcher get a minimal
 * PATH without what shell profiles add (nvm, asdf, Homebrew, ~/.local/bin). Read once; "" on Windows.
 */
let shellPathCache;
export function loginShellPath() {
	if (shellPathCache !== undefined) return shellPathCache;
	shellPathCache = "";
	if (IS_WIN || env.AST_LENS_NO_SHELL_PATH) return shellPathCache;
	const shell = env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
	const value = /\bfish$/.test(shell) ? "(string join : $PATH)" : '"$PATH"';
	try {
		const r = spawnSync(shell, ["-ilc", `printf '\\n__CC_PATH__%s__CC_PATH__\\n' ${value}`], {
			encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"], env: { ...env, TERM: "dumb" },
		});
		const m = String(r.stdout ?? "").match(/__CC_PATH__([^\n]*?)__CC_PATH__/);
		if (m) shellPathCache = m[1].trim();
	} catch {}
	return shellPathCache;
}

let baseDirsCache;
function searchDirs(cwd) {
	baseDirsCache ??= [
		...(env.PATH ?? env.Path ?? "").split(path.delimiter),
		...loginShellPath().split(path.delimiter),
	];
	const local = cwd ? localBins(cwd).slice(0, 4) : [];
	return [...new Set([...baseDirsCache, ...local, ...platformDirs()].filter(Boolean))];
}

/** Command names to try: on Windows the runnable extensions only (npm also writes an extensionless sh script). */
function commandNames(cmd) {
	if (!IS_WIN || path.extname(cmd)) return [cmd];
	return [".exe", ".cmd", ".bat", ".com"].map((e) => cmd + e);
}

/** Absolute path of an installed command, or null. */
export function which(cmd, cwd, only) {
	const dirs = path.isAbsolute(cmd) ? [""] : only ?? searchDirs(cwd);
	for (const d of dirs) {
		for (const n of commandNames(cmd)) {
			const full = d ? path.join(d, n) : n;
			try {
				if (!fs.statSync(full).isFile()) continue;
				if (!IS_WIN) fs.accessSync(full, fs.constants.X_OK);
				return full;
			} catch {}
		}
	}
	return null;
}

// cmd.exe quoting, as cross-spawn does it; batch files parse their arguments twice.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
export function cmdArg(arg) {
	const a = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	return a.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}
const cmdCommand = (file) => String(file).replace(CMD_META, "^$1");

/**
 * The script an npm, pnpm or yarn .cmd shim runs (its last quoted %dp0% path that is not node),
 * resolved against the shim's folder; null when the file is not such a shim.
 */
export function shimTarget(cmdFile, text, P = path.win32) {
	const quoted = [...String(text).matchAll(/"([^"\r\n]*%~?dp0%?[^"\r\n]*)"/gi)].map((m) => m[1]);
	const paths = quoted
		.filter((q) => !q.includes("="))
		.map((q) => q.replace(/%~?dp0%?\\?/i, ""))
		.filter((q) => q && !/(^|\\)node(\.exe)?$/i.test(q));
	const last = paths.at(-1);
	return last ? P.resolve(P.dirname(cmdFile), last) : null;
}

function readHead(file, bytes = 4096) {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const buf = Buffer.alloc(bytes);
			return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

/**
 * How to start `bin` on `platform`, without a shell where possible:
 * - a Node script runs with `node`, or with PI-Desktop's own runtime when node is not installed;
 * - a Windows .cmd/.bat shim runs the program it wraps; any other batch file goes through cmd.exe
 *   with every argument escaped, so patterns like `$X | (a & b)` reach the program unchanged.
 */
export function planLaunch(bin, args, o) {
	const win = o.platform === "win32";
	const head = o.head ?? readHead;
	const exists = o.exists ?? fs.existsSync;
	const viaNode = (script) =>
		o.node ? { file: o.node, args: [script, ...args], env: {} } : { file: o.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: "1" } };
	const nodeScript = (f) => /\.[cm]?js$/i.test(f) || /^#!.*\bnode\b/.test(head(f, 128));
	if (win && /\.(cmd|bat)$/i.test(bin)) {
		const target = shimTarget(bin, head(bin));
		if (target && exists(target)) {
			if (nodeScript(target)) return viaNode(target);
			if (/\.exe$/i.test(target)) return { file: target, args, env: {} };
		}
		const line = `"${cmdCommand(bin)}${args.map((a) => ` ${cmdArg(a)}`).join("")}"`;
		return { file: o.comspec || "cmd.exe", args: ["/d", "/s", "/c", line], env: {}, verbatim: true };
	}
	if (win ? /\.[cm]?js$/i.test(bin) : !o.node && nodeScript(bin)) return viaNode(bin);
	return { file: bin, args, env: {} };
}

/** process.env with PATH (whatever its case, e.g. Windows "Path") set to the full search path. */
function childEnv(cwd, extra) {
	const out = { ...env, ...extra };
	const keys = Object.keys(out).filter((k) => k.toUpperCase() === "PATH");
	for (const k of keys.slice(1)) delete out[k];
	out[keys[0] ?? "PATH"] = searchDirs(cwd).join(path.delimiter);
	return out;
}

function spawnBin(bin, args, cwd, stdio) {
	const plan = planLaunch(bin, args, { platform: process.platform, node: which("node", cwd), execPath: process.execPath, comspec: env.ComSpec });
	return spawn(plan.file, plan.args, {
		cwd, env: childEnv(cwd, plan.env), stdio, windowsHide: true,
		windowsVerbatimArguments: !!plan.verbatim,
		detached: !IS_WIN, // own process group, so the whole tree can be stopped
	});
}

/** Stops a child and everything it started (tsserver, gopls workers, a cmd.exe wrapper's program). */
function killTree(child) {
	if (!child?.pid || child.exitCode !== null || child.signalCode) return;
	try {
		if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {}
	}
}

/** Whether p is cwd or below it (any platform, any drive). */
export function isInside(cwd, p) {
	const r = path.relative(cwd, p);
	return r === "" || (!path.isAbsolute(r) && r.split(path.sep)[0] !== "..");
}

/** A path as a comparable key: canonical, and case-folded where the file system ignores case (Windows). */
export function pathKey(p) {
	const r = real(p);
	return IS_WIN ? r.toLowerCase() : r;
}

function rel(cwd, p) {
	return (isInside(cwd, p) && path.relative(cwd, p) ? path.relative(cwd, p) : p).split(path.sep).join("/");
}

function clip(s, limit = OUTPUT_LIMIT) {
	return s.length <= limit ? s : `${s.slice(0, limit)}\n[output cut at ${limit} of ${s.length} chars; narrow the query]`;
}

const clipLine = (s, max = LINE_MAX) => {
	const t = String(s ?? "").replace(/\s+$/, "");
	return t.length > max ? `${t.slice(0, max)}…` : t;
};

const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

/** A source line for output: trimmed; a line longer than LINE_MAX is cut to a window around col (0-based, in the raw line). */
export function showLine(raw, col = 0) {
	const s = String(raw ?? "").replace(/\r$/, "");
	const t = s.trim();
	if (t.length <= LINE_MAX) return t;
	const c = Math.max(0, col - (s.length - s.trimStart().length));
	const a = Math.max(0, Math.min(c - LINE_MAX / 2, t.length - LINE_MAX));
	return `${a > 0 ? "…" : ""}${t.slice(a, a + LINE_MAX)}${a + LINE_MAX < t.length ? "…" : ""}`;
}

/** A `limit` parameter: a whole number from 1 to 500, else the default. */
export function limitOf(v, dflt = LIMIT_DEFAULT) {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : dflt;
}

/**
 * Hits grouped by file: each path once, then `line:col: text` per hit, in the order given; more
 * hits on the same line add their column (`line:col,col: text`).
 * A hit is { path, line, col?, text, note?, more?: string[] } with 1-based line and col.
 * output "files" lists the paths, "count" the hits per path. At most `limit` hits (or paths) are
 * shown, and a footer counts the rest. `head` turns a path into its header line.
 */
export function formatGrouped(hits, { limit = LIMIT_DEFAULT, output = "lines", head = (p) => p } = {}) {
	const groups = new Map();
	for (const h of hits) {
		const g = groups.get(h.path);
		if (g) g.push(h);
		else groups.set(h.path, [h]);
	}
	const out = [];
	if (output === "files" || output === "count") {
		const all = [...groups];
		for (const [p, hs] of all.slice(0, limit)) out.push(output === "count" ? `${p}: ${hs.length}` : p);
		if (all.length > limit) out.push(`[${plural(all.length - limit, "more file")}; raise limit]`);
		return out.join("\n");
	}
	let shown = 0;
	const rest = new Set();
	for (const [p, hs] of groups) {
		if (shown >= limit) {
			rest.add(p);
			continue;
		}
		out.push(head(p));
		let prev = null;
		for (const h of hs) {
			if (shown >= limit) {
				rest.add(p);
				break;
			}
			shown++;
			// Another hit on the line just shown: add its column, not the line again.
			if (prev && prev.line === h.line && h.col && prev.col && !h.more?.length && !prev.more?.length && h.note === prev.note) {
				out[out.length - 1] = out[out.length - 1].replace(/^(\d+:[\d,]+): /, `$1,${h.col}: `);
				continue;
			}
			out.push(`${h.line}${h.col ? `:${h.col}` : ""}: ${h.text}${h.note ? `  ${h.note}` : ""}`);
			for (const m of h.more ?? []) out.push(`  ${m}`);
			prev = h;
		}
	}
	if (shown < hits.length) out.push(`[${hits.length - shown} more in ${plural(rest.size, "file")}; raise limit or narrow the path]`);
	return out.join("\n");
}

/** Counts code files per ast-grep language under dir (bounded walk). */
export function dominantLang(dir) {
	const counts = new Map();
	let seen = 0;
	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (++seen > WALK_BUDGET) return;
			if (e.name.startsWith(".")) continue;
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name));
			} else if (e.isFile()) {
				const ext = extOf(e.name);
				if (!CODE_EXTS.has(ext)) continue;
				const lang = SG_LANGS[ext];
				if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
			}
		}
	};
	walk(dir);
	const ranked = [...counts].sort((a, b) => b[1] - a[1]);
	return { lang: ranked[0]?.[0] ?? "", ranked };
}

/** The ast-grep language for a query: explicit, from the file, from the globs, then the tree. */
export function inferSgLang({ lang, target, globs }) {
	const explicit = normalizeLang(lang);
	if (explicit) return { lang: explicit, why: "given" };
	let isFile = false;
	try {
		isFile = fs.statSync(target).isFile();
	} catch {}
	if (isFile) {
		const l = SG_LANGS[extOf(target)];
		if (l) return { lang: l, why: `from .${extOf(target)}` };
	}
	for (const e of globExts(globs)) if (SG_LANGS[e]) return { lang: SG_LANGS[e], why: `from the glob *.${e}` };
	if (!isFile) {
		const d = dominantLang(target);
		if (d.lang) {
			const others = d.ranked.slice(1, 4).map(([l, n]) => `${l} ${n}`).join(", ");
			return { lang: d.lang, why: `most common code language under the path${others ? `; also: ${others}` : ""}` };
		}
	}
	return { lang: "", why: "" };
}

/**
 * Root of the project that holds file: the nearest dir with a marker, or with outermost the highest
 * one up to cwd; never above cwd when file is inside it.
 */
export function findRoot(file, markers, cwd, outermost = false) {
	const inside = cwd && isInside(cwd, file);
	if (outermost && inside) {
		let found = null;
		for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
			if (markers.some((m) => !m.startsWith("*") && fs.existsSync(path.join(dir, m)))) found = dir;
			if (pathKey(dir) === pathKey(cwd) || path.dirname(dir) === dir) return found ?? cwd;
		}
	}
	let dir = path.dirname(file);
	for (;;) {
		let names = null;
		for (const m of markers) {
			if (m.startsWith("*")) {
				names ??= (() => {
					try {
						return fs.readdirSync(dir);
					} catch {
						return [];
					}
				})();
				if (names.some((n) => n.endsWith(m.slice(1)))) return dir;
			} else if (fs.existsSync(path.join(dir, m))) return dir;
		}
		if (inside && pathKey(dir) === pathKey(cwd)) return cwd;
		const up = path.dirname(dir);
		if (up === dir) return inside ? cwd : path.dirname(file);
		dir = up;
	}
}

// Config
// ======

function readConfigFile(file) {
	try {
		const c = JSON.parse(fs.readFileSync(file, "utf8"));
		return c && typeof c === "object" && !Array.isArray(c) ? c : {};
	} catch {
		return {};
	}
}

/** The settings: mode (a mode of 0.3, "strict", now means "steer"), servers per extension, maxRssMb (0 = no limit), prewarm. */
export function readConfig(file = CONFIG_FILE) {
	const c = readConfigFile(file === CONFIG_FILE && !fs.existsSync(file) && fs.existsSync(LEGACY_CONFIG_FILE) ? LEGACY_CONFIG_FILE : file);
	const rss = Number(c.maxRssMb);
	return {
		mode: MODES.includes(c.mode) ? c.mode : "steer",
		servers: c.servers && typeof c.servers === "object" ? c.servers : {},
		maxRssMb: Number.isFinite(rss) && rss > 0 ? rss : 0,
		prewarm: c.prewarm !== false,
	};
}

/** Sets keys in the config file and keeps the others. */
function writeConfig(patch, file = CONFIG_FILE) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ ...readConfigFile(file), ...patch }, null, "\t")}\n`);
}

// ast-grep
// ========

let sgBinCache;
function sgBin(cwd) {
	if (sgBinCache === undefined || (sgBinCache === null && cwd)) {
		sgBinCache = which("ast-grep", cwd) ?? which("sg", cwd);
		// `sg` is also the name of the shadow-utils "switch group" command on Linux.
		if (sgBinCache && path.basename(sgBinCache).startsWith("sg") && process.platform === "linux") {
			const probe = spawnSyncText(sgBinCache, ["--version"]);
			if (!/ast-grep/i.test(probe)) sgBinCache = null;
		}
	}
	return sgBinCache;
}

function spawnSyncText(bin, args) {
	try {
		return String(spawnSync(bin, args, { encoding: "utf8", timeout: 5000 }).stdout ?? "");
	} catch {
		return "";
	}
}

export const SG_INSTALL = {
	darwin: "`brew install ast-grep`, or `npm i -g @ast-grep/cli`",
	win32: "`npm i -g @ast-grep/cli`, `scoop install main/ast-grep`, or `cargo install ast-grep --locked`",
	any: "`npm i -g @ast-grep/cli`, `cargo install ast-grep --locked`, or `pip install ast-grep-cli`",
};

/** An install hint for this platform: a string, or { darwin, linux, win32, any }. */
export function installHint(h, platform = process.platform) {
	return typeof h === "string" ? h : h?.[platform] ?? h?.any ?? "";
}

const SG_MISSING =
	`ast-grep is not installed. Install it with ${installHint(SG_INSTALL)}. Until then use Grep.`;

/** Wraps a bare rule body into a complete inline rule with id and language. */
export function completeRule(rule, lang) {
	let y = String(rule).replace(/\t/g, "  ").trimEnd();
	if (!/^rule\s*:/m.test(y)) y = `rule:\n${y.split("\n").map((l) => `  ${l}`).join("\n")}`;
	if (!/^language\s*:/m.test(y)) {
		if (!lang) return null;
		y = `language: ${lang}\n${y}`;
	}
	if (!/^id\s*:/m.test(y)) y = `id: ast-lens-query\n${y}`;
	return y;
}

function runCollect(bin, args, cwd, signal, max, ms = SG_TIMEOUT_MS) {
	return new Promise((resolve) => {
		const child = spawnBin(bin, args, cwd, ["ignore", "pipe", "pipe"]);
		const items = [];
		let buf = "";
		let err = "";
		let more = false;
		let timedOut = false;
		const stop = () => killTree(child);
		const timer = setTimeout(() => ((timedOut = true), stop()), ms);
		const onAbort = () => stop();
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (b) => {
			buf += b;
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (!line.trim()) continue;
				if (items.length >= max) {
					more = true;
					stop();
					return;
				}
				try {
					items.push(JSON.parse(line));
				} catch {
					err += `${line}\n`;
				}
			}
		});
		child.stderr.on("data", (b) => (err += b));
		const done = (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ items, more, err: err.trim(), code, timedOut, aborted: !!signal?.aborted });
		};
		child.on("error", (e) => ((err += String(e)), done(-1)));
		child.on("close", (code) => done(code ?? -1));
	});
}

function runText(bin, args, cwd, signal) {
	return new Promise((resolve) => {
		const child = spawnBin(bin, args, cwd, ["ignore", "pipe", "pipe"]);
		let out = "";
		const timer = setTimeout(() => killTree(child), SG_TIMEOUT_MS);
		const onAbort = () => killTree(child);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (b) => (out += b));
		child.stderr.on("data", (b) => (out += b));
		const done = (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ out: out.trim(), code });
		};
		child.on("error", (e) => ((out += String(e)), done(-1)));
		child.on("close", (code) => done(code ?? -1));
	});
}

/** ast-grep matches grouped by file: `line:col: source line`, then the captured metavariables and the rewrite. */
export function formatSgMatches(items, cwd, { rewrite, limit = LIMIT_DEFAULT, output = "lines" } = {}) {
	const hits = items.map((m) => {
		const col = m.range?.start?.column ?? 0;
		const src = String(m.lines ?? m.text ?? "").split("\n");
		const more = [];
		const vars = Object.entries(m.metaVariables?.single ?? {}).map(([k, v]) => `$${k}=${clipLine(v.text, 60)}`);
		for (const [k, vs] of Object.entries(m.metaVariables?.multi ?? {})) {
			const t = (vs ?? []).map((v) => v.text).filter((t) => t !== ",").join(", ");
			vars.push(`$$$${k}=[${clipLine(t, 80)}]`);
		}
		if (vars.length) more.push(vars.join("  "));
		if (rewrite && typeof m.replacement === "string") {
			more.push(`- ${clipLine(m.text.split("\n")[0])}`);
			more.push(`+ ${clipLine(m.replacement.split("\n")[0])}${m.replacement.includes("\n") ? "  […]" : ""}`);
		}
		return {
			path: rel(cwd, path.resolve(cwd, m.file ?? "")),
			line: (m.range?.start?.line ?? 0) + 1,
			col: col + 1,
			text: `${showLine(src[0], col)}${src.length > 1 ? `  [+${src.length - 1} lines]` : ""}`,
			more,
		};
	});
	return formatGrouped(hits, { limit, output });
}

async function astGrep(params, ctx, signal) {
	const cwd = ctx?.cwd ?? process.cwd();
	const bin = sgBin(cwd);
	if (!bin) throw new Error(SG_MISSING);
	const pattern = typeof params?.pattern === "string" ? params.pattern : "";
	const rule = typeof params?.rule === "string" ? params.rule : "";
	if (!pattern.trim() && !rule.trim()) throw new Error("Give a `pattern` (code with $VARS) or a YAML `rule`.");
	const paths = [].concat(params?.path ?? ".").map(String).filter(Boolean);
	const targets = paths.map((p) => path.resolve(cwd, p));
	for (const t of targets) if (!fs.existsSync(t)) throw new Error(`No such path: ${rel(cwd, t)}`);
	const globs = [].concat(params?.globs ?? []).map(String).filter(Boolean);
	const { lang, why } = inferSgLang({ lang: params?.lang, target: targets[0], globs });
	const limit = limitOf(params?.limit ?? params?.max); // `max` was the name in 0.3
	const output = ["files", "count"].includes(params?.output) ? params.output : "lines";
	const rewrite = typeof params?.rewrite === "string" ? params.rewrite : undefined;
	const apply = params?.apply === true;

	const args = [];
	if (rule.trim()) {
		const y = completeRule(rule, lang);
		if (!y) throw new Error("The rule has no `language:` and none could be inferred; pass `lang`.");
		args.push("scan", "--inline-rules", y);
	} else {
		if (!lang) throw new Error("Could not infer the language from the path; pass `lang` (e.g. typescript, python, go, rust).");
		args.push("run", "--pattern", pattern, "--lang", lang);
		if (params?.selector) args.push("--selector", String(params.selector));
		if (params?.strictness) args.push("--strictness", String(params.strictness));
		if (rewrite !== undefined) args.push("--rewrite", rewrite);
	}
	for (const g of globs) args.push("--globs", g);
	const head = `[ast-grep${lang ? ` · ${lang}${why ? ` (${why})` : ""}` : ""}]`;

	if (apply) {
		if (!rule.trim() && rewrite === undefined) throw new Error("apply needs `rewrite` (or a rule with `fix:`).");
		const r = await runText(bin, [...args, "--update-all", ...targets], cwd, signal);
		if (r.code !== 0 && r.code !== 1) throw new Error(`ast-grep failed (exit ${r.code}):\n${clip(r.out, 4000)}`);
		indexChanged();
		eachClient((c) => c.refresh());
		return { text: `${head}\n${clip(r.out || "No matches; nothing changed.")}`, details: { lang, applied: true } };
	}

	const r = await runCollect(bin, [...args, "--json=stream", ...targets], cwd, signal, SG_COLLECT_MAX);
	if (r.aborted) throw new Error("Stopped.");
	if (r.timedOut) throw new Error(`ast-grep did not finish in ${SG_TIMEOUT_MS / 1000}s; narrow the path or globs.`);
	if (r.code !== 0 && r.code !== 1 && !r.more) throw new Error(`ast-grep failed (exit ${r.code}):\n${clip(r.err, 4000)}`);
	if (!r.items.length) {
		const tip = r.err ? `\n${clip(r.err, 2000)}` : "\nCheck the pattern parses as valid code in that language, or try a `rule` with `kind:`.";
		return { text: `${head}\nNo matches.${tip}`, details: { lang, matches: 0 } };
	}
	const body = formatSgMatches(r.items, cwd, { rewrite: rewrite !== undefined, limit, output });
	const files = new Set(r.items.map((m) => m.file)).size;
	const foot = r.more
		? `\n[more than ${SG_COLLECT_MAX} matches; narrow the path or the pattern]`
		: `\n[${plural(r.items.length, "match", "matches")} in ${plural(files, "file")}]`;
	const note = rewrite !== undefined ? "\n[preview only: call again with apply: true to write the rewrite]" : "";
	return { text: clip(`${head}\n${body}${foot}${note}`), details: { lang, matches: r.items.length, more: r.more } };
}

// Grep results
// ============

/** ast-grep node kinds per language: comments, string literals, and code inside strings. */
const TEXT_KINDS = {
	typescript: { comment: ["comment"], string: ["string", "template_string"], code: ["template_substitution"] },
	tsx: { comment: ["comment"], string: ["string", "template_string"], code: ["template_substitution"] },
	javascript: { comment: ["comment"], string: ["string", "template_string"], code: ["template_substitution"] },
	python: { comment: ["comment"], string: ["string"], code: ["interpolation"] },
	go: { comment: ["comment"], string: ["interpreted_string_literal", "raw_string_literal", "rune_literal"] },
	rust: { comment: ["line_comment", "block_comment"], string: ["string_literal", "raw_string_literal", "char_literal"] },
	c: { comment: ["comment"], string: ["string_literal", "char_literal", "system_lib_string"] },
	cpp: { comment: ["comment"], string: ["string_literal", "char_literal", "raw_string_literal"] },
	java: { comment: ["line_comment", "block_comment"], string: ["string_literal", "character_literal"] },
	csharp: { comment: ["comment"], string: ["string_literal", "verbatim_string_literal", "raw_string_literal", "character_literal"], code: ["interpolation"] },
	kotlin: { comment: ["line_comment", "multiline_comment"], string: ["string_literal"], code: ["interpolated_expression"] },
	ruby: { comment: ["comment"], string: ["string"], code: ["interpolation"] },
	bash: { comment: ["comment"], string: ["string", "raw_string"] },
	php: { comment: ["comment"], string: ["string", "encapsed_string"] },
	swift: { comment: ["comment", "multiline_comment"], string: ["line_string_literal"] },
	lua: { comment: ["comment"], string: ["string"] },
	scala: { comment: ["comment", "block_comment"], string: ["string"] },
};

/** The ast-grep rules that find TEXT_KINDS nodes for these languages, one rule per tag and language. */
export function textKindRules(langs) {
	const rules = [];
	for (const lang of langs) {
		for (const [tag, kinds] of Object.entries(TEXT_KINDS[lang] ?? {})) {
			rules.push(`id: ${tag}-${lang}\nlanguage: ${lang}\nrule:\n  any:\n${kinds.map((k) => `    - kind: ${k}`).join("\n")}`);
		}
	}
	return rules.join("\n---\n");
}

/**
 * The tag of each word match of `name` on a line: "code", "comment" or "string", from the innermost
 * comment, string or code-in-string node that holds it. spans: [{ tag, a: [line, col], b: [line, col] }].
 */
export function tagOf(spans, line, col) {
	let best = null;
	for (const s of spans) {
		const after = line > s.a[0] || (line === s.a[0] && col >= s.a[1]);
		const before = line < s.b[0] || (line === s.b[0] && col < s.b[1]);
		if (after && before && (!best || s.a[0] > best.a[0] || (s.a[0] === best.a[0] && s.a[1] >= best.a[1]))) best = s;
	}
	return best ? best.tag : "code";
}

/**
 * Tags each hit { abs, line, text } with `tag`: "code" when the name is code anywhere on the line,
 * else "comment" or "string". One ast-grep run over the hit files. Returns false (hits untouched)
 * when ast-grep is missing, no file has a known language, or the run takes longer than budgetMs.
 */
export async function tagHits(hits, name, cwd, budgetMs = TAG_BUDGET_MS) {
	const bin = sgBin(cwd);
	if (!bin || !hits.length) return false;
	const files = [...new Set(hits.map((h) => h.abs))].filter((f) => TEXT_KINDS[SG_LANGS[extOf(f)]]);
	if (!files.length) return false;
	const rules = textKindRules(new Set(files.map((f) => SG_LANGS[extOf(f)])));
	const r = await runCollect(bin, ["scan", "--inline-rules", rules, "--json=stream", ...files], cwd, undefined, 50000, budgetMs);
	if (r.timedOut || r.more || (r.code !== 0 && r.code !== 1)) return false;
	const spans = new Map();
	for (const m of r.items) {
		const key = pathKey(path.resolve(cwd, m.file ?? ""));
		if (!spans.has(key)) spans.set(key, []);
		const s = m.range?.start;
		const e = m.range?.end;
		if (s && e) spans.get(key).push({ tag: String(m.ruleId ?? "").split("-")[0], a: [s.line, s.column], b: [e.line, e.column] });
	}
	for (const h of hits) {
		if (!TEXT_KINDS[SG_LANGS[extOf(h.abs)]]) continue;
		const list = spans.get(pathKey(h.abs)) ?? [];
		const tags = [...h.text.matchAll(wordRe(name, "g"))].map((m) => tagOf(list, h.line - 1, m.index));
		h.tag = !tags.length || tags.includes("code") ? "code" : tags.includes("string") ? "string" : "comment";
	}
	return true;
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a line looks like the declaration of name (keyword declarations, Go methods, C-style function heads). */
export function declaresName(line, name) {
	const n = esc(name);
	const t = String(line ?? "").trim();
	if (new RegExp(`(?:^|[^\\w$.])(?:function\\*?|class|interface|type|enum|struct|union|trait|impl|def|fn|func|module|namespace|record|protocol|typedef|object|val|var|let|const|#define)\\s+(?:[\\w$]+\\s*[.:]+\\s*)?${n}(?![\\w$])`).test(t)) return true;
	if (new RegExp(`^func\\s*\\([^)]*\\)\\s*${n}\\s*[(\\[]`).test(t)) return true;
	// C, C++, Java, C#: `type name(args) {` (the brace may be on the next line), or a method `name(args) {`; not a call.
	if (/[;,]$/.test(t) || /^(return|if|while|for|switch|else|case|throw|await|new|yield|do|delete|typeof)\b/.test(t) || new RegExp(`[=(]\\s*${n}\\s*\\(`).test(t)) return false;
	if (new RegExp(`^(?:[\\w$<>\\[\\]*&:,]+\\s+)+\\**${n}\\s*\\([^;=]*\\)?\\s*(?:const\\s*)?(?:\\{|$|->|:)`).test(t)) return true;
	return new RegExp(`^(?:async\\s+|static\\s+)*\\*?${n}\\s*(?:<[^>]*>)?\\([^;]*\\)\\s*(?::[^=;]*)?\\{\\s*\\}?$`).test(t);
}

/** The hits of a Grep result: PI-Desktop's JSON ({ matches: [{ path, line, text }], tags }) or `path:line: text` lines. null for any other shape. */
export function parseGrepResult(text) {
	const t = String(text ?? "");
	if (/^\s*\{/.test(t)) {
		try {
			const j = JSON.parse(t);
			if (!Array.isArray(j?.matches) || !j.matches.length) return null;
			const hits = j.matches.map((m) => ({ path: String(m?.path ?? ""), line: Number(m?.line), text: String(m?.text ?? "") }));
			if (hits.some((h) => !h.path || !Number.isFinite(h.line))) return null;
			const notes = [j.notice].filter((x) => typeof x === "string" && x);
			return { json: true, hits, tags: j.tags && typeof j.tags === "object" ? j.tags : {}, notes };
		} catch {
			return null;
		}
	}
	const [body, ...tail] = t.split(/\n\n(?=\[)/);
	const hits = [];
	for (const l of body.split("\n")) {
		if (!l) continue;
		const m = l.match(/^(.+?):(\d+): (.*)$/);
		if (!m) return null; // context lines (path-12- text), counts, file lists: left alone
		hits.push({ path: m[1], line: Number(m[2]), text: m[3] });
	}
	return hits.length ? { json: false, hits, tags: {}, notes: tail.map((s) => s.trim()) } : null;
}

/** The identifier a Grep pattern looks for (`\bfoo\b`, `^foo`, `obj.foo` -> foo), or "". */
export function grepIdentifier(input) {
	if (input?.outputMode && input.outputMode !== "content") return "";
	if (Number(input?.context) > 0 || input?.["-A"] || input?.["-B"] || input?.["-C"]) return "";
	const bare = String(input?.pattern ?? input?.query ?? "").trim().replace(/\\b/g, "").replace(/^\^|\$$/g, "");
	if (!/^[A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*$/.test(bare) || TEXT_MARKERS.test(bare)) return "";
	const name = bare.split(/\.|::|->/).pop();
	return name.length >= 2 ? name : "";
}

/**
 * A Grep result for an identifier, grouped by file. With tags, hits in comments and strings are
 * collapsed to their line numbers (never dropped), and declarations are marked. Returns the new text.
 */
export function formatGrepResult(parsed, name, { tagged, pattern } = {}) {
	const files = new Map();
	for (const h of parsed.hits) {
		if (!files.has(h.path)) files.set(h.path, []);
		files.get(h.path).push(h);
	}
	const out = [];
	const defs = [];
	let text = 0;
	for (const [p, hs] of files) {
		out.push(parsed.tags[p] ? `${p}#${parsed.tags[p]}` : p);
		const quiet = [];
		for (const h of hs.sort((a, b) => a.line - b.line)) {
			if (tagged && h.tag && h.tag !== "code") {
				quiet.push(h.line);
				continue;
			}
			const def = (!tagged || h.tag === "code") && declaresName(h.text, name);
			if (def) defs.push(`${p}:${h.line}`);
			out.push(`${h.line}: ${showLine(h.text, Math.max(0, h.text.search(wordRe(name))))}${def ? "  ← definition" : ""}`);
		}
		if (quiet.length) out.push(`${quiet.length} in comments/strings: ${quiet.length === 1 ? "line" : "lines"} ${quiet.join(", ")}`);
		text += quiet.length;
	}
	// The footer only when it says more than the lines above: collapsed hits, several declarations.
	if (text || defs.length > 1) {
		const facts = [`${plural(parsed.hits.length, "hit")} in ${plural(files.size, "file")}`];
		if (text) facts.push(`${text} in comments or strings shown as line numbers only (Read them for the text)`);
		if (defs.length > 1) facts.push(`${defs.length} declarations of ${name}`);
		out.push(`[Grep ${JSON.stringify(String(pattern ?? name)).slice(0, 80)}: ${facts.join("; ")}]`);
	}
	for (const note of parsed.notes) out.push(note.startsWith("[") ? note : `[${note}]`);
	return out.join("\n");
}

// LSP
// ===

/** Splits Content-Length framed JSON-RPC messages; returns the parsed messages and the rest. */
export function parseFrames(buffer) {
	const messages = [];
	let buf = buffer;
	for (;;) {
		const end = buf.indexOf("\r\n\r\n");
		if (end < 0) break;
		const header = buf.subarray(0, end).toString("ascii");
		const m = header.match(/content-length:\s*(\d+)/i);
		if (!m) {
			buf = buf.subarray(end + 4);
			continue;
		}
		const len = Number(m[1]);
		if (buf.length < end + 4 + len) break;
		const body = buf.subarray(end + 4, end + 4 + len).toString("utf8");
		buf = buf.subarray(end + 4 + len);
		try {
			messages.push(JSON.parse(body));
		} catch {}
	}
	return { messages, rest: buf };
}

export const frame = (msg) => {
	const body = Buffer.from(JSON.stringify(msg), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
};

const toUri = (p) => url.pathToFileURL(p).href;
const fromUri = (u) => {
	try {
		return url.fileURLToPath(u);
	} catch {
		return u;
	}
};

const uriKey = (u) => pathKey(fromUri(u));

class LspClient {
	constructor({ spec, cand, bin, root }) {
		Object.assign(this, { spec, cand, bin, root });
		this.nextId = 1;
		this.pending = new Map();
		this.open = new Map(); // uri -> { version, text }
		this.diags = new Map(); // uriKey -> { at, items }
		this.diagWaiters = new Set();
		this.buf = Buffer.alloc(0);
		this.stderr = "";
		this.dead = false;
		this.lastUse = Date.now();
		this.startedAt = Date.now();
		this.caps = {};
		this.progress = new Set(); // work-done tokens in flight
		this.lastProgress = 0;
		this.openedAt = 0; // a file was opened or changed
		this.progressBeganAt = 0;
	}

	async start() {
		const child = spawnBin(this.bin, this.cand.args, this.root, ["pipe", "pipe", "pipe"]);
		this.child = child;
		child.stdout.on("data", (b) => this.onData(b));
		child.stderr.on("data", (b) => (this.stderr = (this.stderr + b).slice(-4000)));
		child.on("error", (e) => this.onExit(`could not start: ${e.message}`));
		child.on("close", (code) => this.onExit(`exited with code ${code}`));
		child.stdin.on("error", () => {});
		const root = toUri(this.root);
		const init = await this
			.request(
			"initialize",
			{
				processId: process.pid,
				clientInfo: { name: "ast-lens" },
				...(this.cand.init ? { initializationOptions: this.cand.init } : {}),
				rootUri: root,
				rootPath: this.root,
				workspaceFolders: [{ uri: root, name: path.basename(this.root) }],
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: false },
						hover: { contentFormat: ["markdown", "plaintext"] },
						definition: { linkSupport: true },
						typeDefinition: { linkSupport: true },
						implementation: { linkSupport: true },
						references: {},
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						publishDiagnostics: { relatedInformation: false },
						diagnostic: { dynamicRegistration: false },
					},
					workspace: { workspaceFolders: true, configuration: true, symbol: {} },
					window: { workDoneProgress: true },
				},
			},
				LSP_START_MS,
			)
			.catch((e) => {
				this.kill();
				throw new Error(`${this.cand.cmd} did not start: ${e.message}`);
			});
		this.caps = init?.capabilities ?? {};
		this.notify("initialized", {});
	}

	kill() {
		this.dead = true;
		try {
			killTree(this.child);
		} catch {}
	}

	onData(b) {
		const { messages, rest } = parseFrames(Buffer.concat([this.buf, b]));
		this.buf = rest;
		for (const msg of messages) this.handle(msg);
	}

	handle(msg) {
		if (msg.method && msg.id !== undefined) {
			// Requests from the server: answer what a passive client can.
			let result = null;
			if (msg.method === "workspace/configuration") result = (msg.params?.items ?? []).map(() => null);
			else if (msg.method === "workspace/workspaceFolders") result = [{ uri: toUri(this.root), name: path.basename(this.root) }];
			this.send({ jsonrpc: "2.0", id: msg.id, result });
			return;
		}
		if (msg.method === "$/progress") {
			const kind = msg.params?.value?.kind;
			if (kind === "begin") {
				this.progress.add(msg.params.token);
				this.progressBeganAt = Date.now();
				// A load right after an open: this server reports the loads that opens cause (tsserver does, tsgo does not).
				if (this.openedAt && this.progressBeganAt - this.openedAt < 500) this.reportsLoads = true;
			}
			else if (kind === "end") this.progress.delete(msg.params.token);
			this.lastProgress = Date.now();
			return;
		}
		if (msg.method === "textDocument/publishDiagnostics") {
			const key = uriKey(msg.params?.uri ?? "");
			this.diags.set(key, { at: Date.now(), items: msg.params?.diagnostics ?? [] });
			for (const w of this.diagWaiters) w(key);
			return;
		}
		if (msg.id !== undefined && this.pending.has(msg.id)) {
			const p = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? "error"} (${msg.error.code})`));
			else p.resolve(msg.result);
		}
	}

	onExit(why) {
		if (this.dead) return;
		this.dead = true;
		const tail = this.stderr.trim().split("\n").slice(-8).join("\n");
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new Error(`${this.cand.cmd} ${why}${tail ? `:\n${tail}` : ""}`));
		}
		this.pending.clear();
	}

	send(msg) {
		if (this.dead) return;
		try {
			this.child.stdin.write(frame(msg));
		} catch {}
	}

	notify(method, params) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	request(method, params, ms = LSP_REQUEST_MS, signal) {
		if (this.dead) return Promise.reject(new Error(`${this.cand.cmd} is not running`));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.notify("$/cancelRequest", { id });
				reject(new Error(`${method} timed out after ${ms / 1000}s (${this.cand.cmd} may still be indexing; try again)`));
			}, ms);
			this.pending.set(id, { resolve, reject, timer, method });
			signal?.addEventListener(
				"abort",
				() => {
					if (!this.pending.has(id)) return;
					clearTimeout(timer);
					this.pending.delete(id);
					this.notify("$/cancelRequest", { id });
					reject(new Error("Stopped."));
				},
				{ once: true },
			);
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Opens or refreshes the file in the server; returns its uri, text and whether it changed. */
	sync(file) {
		const text = fs.readFileSync(file, "utf8");
		let st = null;
		try {
			st = fs.statSync(file);
		} catch {}
		const uri = toUri(file);
		const cur = this.open.get(uri);
		const stamp = { mtime: st?.mtimeMs ?? 0, size: st?.size ?? -1 };
		if (!cur) {
			this.open.set(uri, { version: 1, text, ...stamp });
			this.openedAt = Date.now();
			this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.spec.id(extOf(file)), version: 1, text } });
			return { uri, text, changed: true };
		}
		Object.assign(cur, stamp);
		if (cur.text !== text) {
			cur.version += 1;
			cur.text = text;
			this.openedAt = Date.now();
			this.notify("textDocument/didChange", { textDocument: { uri, version: cur.version }, contentChanges: [{ text }] });
			return { uri, text, changed: true };
		}
		return { uri, text, changed: false };
	}

	/** Closes a file opened only to check it, so the server does not keep it in memory. */
	close(file) {
		const uri = toUri(file);
		if (!this.open.delete(uri)) return;
		this.notify("textDocument/didClose", { textDocument: { uri } });
	}

	/**
	 * Sends every open file again that changed on disk since it was sent (by Edit, Write or a Bash
	 * command), and closes deleted ones. The server answers from the open text, so a stale open file
	 * gives stale references.
	 */
	refresh() {
		for (const [uri, doc] of [...this.open]) {
			const file = fromUri(uri);
			let st;
			try {
				st = fs.statSync(file);
			} catch {
				this.open.delete(uri);
				this.notify("textDocument/didClose", { textDocument: { uri } });
				continue;
			}
			if (st.mtimeMs === doc.mtime && st.size === doc.size) continue;
			try {
				this.sync(file);
			} catch {}
		}
	}

	/** Tells the server that files under its root changed on disk (it caches closed files too). */
	filesChanged(files) {
		const mine = files.filter((f) => isInside(this.root, f));
		if (!mine.length || this.dead) return;
		this.notify("workspace/didChangeWatchedFiles", { changes: mine.map((f) => ({ uri: toUri(f), type: fs.existsSync(f) ? 2 : 3 })) });
		this.refresh();
	}

	/**
	 * Waits while the server reports work in progress (project load, indexing), at most READY_MAX_MS
	 * after it started. A file just opened in a young server gets a short pause to be analysed.
	 */
	async ready(justOpened, signal) {
		if (this.spec.crossProject) {
			// tsserver reports each project load. While one runs it can answer from partial data, so wait
			// for it; after an open, give the load a moment to start. No load: no wait.
			const until = Date.now() + READY_MAX_MS;
			// A server that never reports progress (tsgo) holds each request until its load is done: no wait.
			const loading = () => this.progress.size > 0 || (this.reportsLoads && this.openedAt > this.progressBeganAt && Date.now() - this.openedAt < READY_LOAD_START_MS);
			while (loading() && Date.now() < until && !signal?.aborted) await sleep(10, signal);
			return;
		}
		const young = () => Date.now() - this.startedAt < READY_MAX_MS;
		if (justOpened && young()) await sleep(READY_OPEN_MS, signal);
		while (young() && !signal?.aborted && (this.progress.size || Date.now() - this.lastProgress < READY_QUIET_MS)) {
			await sleep(100, signal);
		}
	}

	waitDiagnostics(uri, since, changed, signal) {
		const key = uriKey(uri); // servers may spell a URI differently, e.g. file:///c%3A/ for C:\
		return new Promise((resolve) => {
			let settle;
			const finish = () => {
				clearTimeout(timer);
				clearTimeout(settle);
				this.diagWaiters.delete(onDiag);
				const d = this.diags.get(key);
				// A changed file only counts diagnostics published after the change.
				resolve(d && (d.at >= since || !changed) ? d.items : null);
			};
			const onDiag = (u) => {
				if (u !== key) return;
				clearTimeout(settle);
				settle = setTimeout(finish, DIAG_SETTLE_MS);
			};
			const timer = setTimeout(finish, DIAG_WAIT_MS);
			signal?.addEventListener("abort", finish, { once: true });
			this.diagWaiters.add(onDiag);
			const d = this.diags.get(key);
			if (d && (d.at >= since || !changed)) onDiag(key);
		});
	}

	async stop() {
		if (this.dead) return;
		try {
			await this.request("shutdown", null, 1500);
		} catch {}
		this.notify("exit", null);
		this.dead = true;
		setTimeout(() => {
			try {
				killTree(this.child);
			} catch {}
		}, 500).unref?.();
	}
}

const clients = new Map(); // `${root}\0${bin}` -> Promise<LspClient>; .client once started
const stopNotes = new Map(); // same key -> why the last server was stopped
let reaper;

/** Resident memory in MB per process group (a server and its children share one; Unix only). null on Windows. */
export function groupRssMb(psText) {
	let text = psText;
	if (text === undefined) {
		if (IS_WIN) return null;
		try {
			text = String(spawnSync("ps", ["-A", "-o", "pgid=,rss="], { encoding: "utf8", timeout: 3000 }).stdout ?? "");
		} catch {
			return null;
		}
	}
	const mb = new Map();
	for (const l of String(text).split("\n")) {
		const [g, kb] = l.trim().split(/\s+/).map(Number);
		if (g > 0 && kb >= 0) mb.set(g, (mb.get(g) ?? 0) + kb / 1024);
	}
	return mb;
}

/** Stops servers that are dead, idle, or above maxRssMb; the next lsp call starts a new one and says why. */
export async function reap(cfg = readConfig(), rss = cfg.maxRssMb ? groupRssMb() : null) {
	for (const [key, p] of clients) {
		const c = await p.catch(() => null);
		if (!c || c.dead || Date.now() - c.lastUse > LSP_IDLE_MS) {
			clients.delete(key);
			c?.stop();
			continue;
		}
		const mb = rss?.get(c.child?.pid);
		if (cfg.maxRssMb && mb > cfg.maxRssMb) {
			clients.delete(key);
			stopNotes.set(key, `the last ${c.cand.cmd} used ${Math.round(mb)} MB (maxRssMb ${cfg.maxRssMb}) and was stopped`);
			c.stop();
		}
	}
}

function startReaper() {
	if (reaper) return;
	reaper = setInterval(() => reap().catch(() => {}), REAPER_MS);
	reaper.unref?.();
}

async function stopAll() {
	const all = [...clients.values()];
	clients.clear();
	await Promise.all(all.map((p) => p.then((c) => c.stop()).catch(() => {})));
}

/** Runs fn on every started server; skips servers that are still starting. */
function eachClient(fn) {
	for (const p of clients.values()) {
		if (p.client && !p.client.dead) {
			try {
				fn(p.client);
			} catch {}
		}
	}
}

process.once?.("exit", () => {
	for (const p of clients.values()) p.then((c) => killTree(c.child)).catch(() => {});
});

/**
 * The running (or a new) language server for file: { client, startedMs (when this call started it),
 * note (why an earlier server was stopped) }. Throws with install hints when none is installed.
 */
async function clientFor(file, cwd, cfg) {
	const ext = extOf(file);
	const spec = serverSpecFor(ext, cfg.servers);
	if (!spec) throw new Error(`AST Lens has no language server for .${ext || "(no extension)"} files. Use ast_grep or Grep, or add one to ${CONFIG_FILE} as "servers": { "${ext}": ["command", "--stdio"] }.`);
	const root = findRoot(file, spec.markers, cwd, spec.root === "outermost");
	let cand = null;
	let bin = null;
	for (const c of spec.candidates) {
		if (c.when && !c.when(root)) continue;
		bin = c.local ? which(c.cmd, cwd, localBins(root)) : which(c.cmd, root);
		if (bin) {
			cand = c;
			break;
		}
	}
	if (!cand) {
		const opts = spec.candidates.filter((c) => !c.local && (!c.when || c.when(root))).map((c) => `\`${c.cmd}\` (${installHint(c.install)})`).join(", or ");
		throw new Error(`No ${spec.name} language server is installed for .${ext}. Install ${opts}. Until then use ast_grep for structure and Read for the code.`);
	}
	const key = `${root}\0${bin}`;
	let p = clients.get(key);
	if (p) {
		const c = await p.catch(() => null);
		if (c && !c.dead) {
			c.lastUse = Date.now();
			return { client: c };
		}
		clients.delete(key);
	}
	const t0 = Date.now();
	p = (async () => {
		const c = new LspClient({ spec, cand, bin, root });
		await c.start();
		return c;
	})();
	p.then((c) => (p.client = c), () => {});
	clients.set(key, p);
	startReaper();
	try {
		const client = await p;
		const note = stopNotes.get(key);
		stopNotes.delete(key);
		return { client, startedMs: Date.now() - t0, note };
	} catch (e) {
		clients.delete(key);
		throw e;
	}
}

/** Starts the server of the workspace's main language and opens one of its files (verified servers only). */
async function prewarm(cwd, cfg = readConfig()) {
	const root = real(cwd);
	astIndex(root).catch(() => {}); // the AST index, in parallel with the server start
	const file = anchorFile(root, {});
	const spec = serverSpecFor(extOf(file), cfg.servers);
	if (!spec || !VERIFIED.has(spec.name)) return false;
	const { client } = await clientFor(file, root, cfg);
	client.sync(file);
	return true;
}

export const SYMBOL_KINDS = [
	"", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
	"enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array",
	"object", "key", "null", "enum member", "struct", "event", "operator", "type parameter",
];
/** Symbol kinds that hold code: module, namespace, package, class, method, constructor, enum, interface, function, struct. */
const CONTAINER_KINDS = new Set([2, 3, 4, 5, 6, 9, 10, 11, 12, 23]);
const SEVERITY = ["", "error", "warning", "info", "hint"];

/** 0-based LSP position of `symbol` (word match) near `line` (1-based), or of line/column as given. */
export function locate(text, { line, column, symbol }) {
	const lines = text.split("\n");
	const name = typeof symbol === "string" ? symbol.trim() : "";
	if (name) {
		const re = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`);
		const order = [];
		const l0 = Number.isFinite(line) && line >= 1 ? line - 1 : -1;
		if (l0 >= 0) for (let d = 0; d <= 3; d++) for (const i of d ? [l0 - d, l0 + d] : [l0]) if (i >= 0 && i < lines.length) order.push(i);
		if (!order.length) for (let i = 0; i < lines.length; i++) order.push(i);
		for (const i of order) {
			const m = re.exec(lines[i]);
			if (m) return { line: i, character: m.index };
		}
		throw new Error(`\`${name}\` is not on ${l0 >= 0 ? `lines ${l0 - 2}-${l0 + 4}` : "any line"} of the file.`);
	}
	if (!Number.isFinite(line) || line < 1) throw new Error("Give `line` (1-based) and `column`, or a `symbol` name.");
	if (line > lines.length) throw new Error(`The file has ${lines.length} lines.`);
	const text0 = lines[line - 1];
	let character = Number.isFinite(column) && column >= 1 ? column - 1 : text0.search(/[\w$]/);
	if (character < 0) character = 0;
	return { line: line - 1, character: Math.min(character, text0.length) };
}

/** Line n (0-based) of file as it is on disk, read once per cache. */
function rawLine(cache, file, n) {
	if (!cache.has(file)) {
		try {
			cache.set(file, fs.readFileSync(file, "utf8").split("\n"));
		} catch {
			cache.set(file, []);
		}
	}
	return cache.get(file)[n] ?? "";
}

/** Location | Location[] | LocationLink[] -> [{ file, line, character }] */
export function normLocations(res) {
	const arr = res == null ? [] : Array.isArray(res) ? res : [res];
	const seen = new Set();
	const out = [];
	for (const l of arr) {
		const uri = l?.targetUri ?? l?.uri;
		const r = l?.targetSelectionRange ?? l?.targetRange ?? l?.range;
		if (!uri || !r) continue;
		const loc = { file: real(fromUri(uri)), line: r.start.line, character: r.start.character };
		const key = `${loc.file}:${loc.line}:${loc.character}`;
		if (!seen.has(key)) seen.add(key), out.push(loc);
	}
	return out;
}

const byPosition = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.col - b.col);

/** Locations as hits for formatGrouped, sorted by path and position. */
function locationHits(locs, cwd, cache = new Map()) {
	return locs
		.map((l) => ({ path: rel(cwd, l.file), line: l.line + 1, col: l.character + 1, text: showLine(rawLine(cache, l.file, l.line), l.character), file: l.file }))
		.sort(byPosition);
}

export function hoverText(res) {
	const c = res?.contents;
	const one = (x) => (typeof x === "string" ? x : x?.language ? `\`\`\`${x.language}\n${x.value}\n\`\`\`` : x?.value ?? "");
	return (Array.isArray(c) ? c.map(one).join("\n\n") : one(c)).trim();
}

/** Symbol kind names from a `kind` parameter: "function,class" or ["method"]. */
export function kindsOf(v) {
	const list = (Array.isArray(v) ? v : String(v ?? "").split(",")).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
	return list.length ? list : null;
}

/** A file outline: one line per symbol, `kind name detail  Lstart-end`, indented by depth. */
export function formatSymbols(res, cwd, { kinds = null, depth = Infinity, limit = 400 } = {}) {
	if (!Array.isArray(res) || !res.length) return "";
	const ok = (s) => !kinds || kinds.includes(SYMBOL_KINDS[s.kind]);
	const out = [];
	let more = 0;
	const add = (line) => (out.length < limit ? out.push(line) : more++);
	if (res[0].location) {
		for (const s of res) {
			if (!ok(s)) continue;
			const r = s.location.range;
			add(`${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.containerName ? `${s.containerName}.` : ""}${s.name}  L${r.start.line + 1}-${r.end.line + 1}`);
		}
	} else {
		const walk = (list, d) => {
			for (const s of list) {
				const a = s.selectionRange?.start ?? s.range?.start;
				const b = s.range?.end;
				if (ok(s)) add(`${"  ".repeat(d)}${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.name}${s.detail ? ` ${clipLine(s.detail, 80)}` : ""}  L${(a?.line ?? 0) + 1}${b ? `-${b.line + 1}` : ""}`);
				if (Array.isArray(s.children) && d < depth) walk(s.children, d + 1);
			}
		};
		walk(res, 0);
	}
	if (more) out.push(`[${more} more; raise limit, or filter with kind or depth]`);
	return out.join("\n");
}

/** Document symbols as a flat list: { name (qualified), short, kind, start, end, sel } with 0-based lines. */
export function flattenSymbols(res) {
	const out = [];
	if (!Array.isArray(res)) return out;
	const walk = (list, prefix) => {
		for (const s of list) {
			if (!s) continue;
			if (s.location) {
				const r = s.location.range;
				out.push({ name: s.containerName ? `${s.containerName}.${s.name}` : s.name, short: s.name, kind: s.kind, start: r.start.line, end: r.end.line, sel: r.start.line });
				continue;
			}
			const q = prefix ? `${prefix}.${s.name}` : s.name;
			const start = s.range?.start?.line ?? 0;
			out.push({ name: q, short: s.name, kind: s.kind, start, end: s.range?.end?.line ?? start, sel: s.selectionRange?.start?.line ?? start });
			if (Array.isArray(s.children)) walk(s.children, q);
		}
	};
	walk(res, "");
	return out;
}

/** The innermost symbol that holds code around a 0-based line; the declaration of `name` on that line does not count. */
export function enclosing(symbols, line, name) {
	let best = null;
	for (const s of symbols) {
		if (line < s.start || line > s.end) continue;
		if (s.sel === line && s.short === name) continue;
		if (!CONTAINER_KINDS.has(s.kind) && s.end === s.start) continue;
		if (!best || s.start > best.start || (s.start === best.start && s.end <= best.end)) best = s;
	}
	return best;
}

function formatDiagnostics(items, file, cwd) {
	const r = rel(cwd, file);
	return items
		.slice()
		.sort((a, b) => (a.severity ?? 9) - (b.severity ?? 9) || a.range.start.line - b.range.start.line)
		.slice(0, 200)
		.map((d) => {
			const src = [d.source, d.code].filter((x) => x !== undefined && x !== null && x !== "").join(" ");
			return `${r}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${SEVERITY[d.severity] ?? "note"}${src ? ` [${src}]` : ""} ${String(d.message).split("\n")[0]}`;
		})
		.join("\n");
}

const LSP_OPS = ["definition", "references", "rename", "hover", "implementation", "type_definition", "symbols", "workspace_symbols", "diagnostics"];
const POSITION_OPS = new Set(["definition", "references", "rename", "hover", "implementation", "type_definition"]);
const OUTPUTS = ["lines", "functions", "files", "count"];

/** A code file to start a server from when no file is given: one of `lang`, or of the project's main language. */
function anchorFile(cwd, params) {
	if (params?.file) return path.resolve(cwd, String(params.file));
	const want = normalizeLang(params?.lang) || dominantLang(cwd).lang;
	const exts = Object.entries(SG_LANGS).filter(([, l]) => l === want).map(([e]) => e);
	let found = null;
	let seen = 0;
	const walk = (d) => {
		if (found) return;
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (found || ++seen > WALK_BUDGET) return;
			if (e.name.startsWith(".")) continue;
			const full = path.join(d, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(full);
			} else if (exts.includes(extOf(e.name))) found = full;
		}
	};
	walk(cwd);
	if (!found) throw new Error("Give `file` (any file of the language) or `lang`.");
	return found;
}

const IDENT = /^[\w$]{2,}$/;
const wordRe = (name, flags = "") => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, flags);

let rgCache;
/** ripgrep: the one on PATH, or the one PI-Desktop ships for its Grep. */
function rgBin() {
	if (rgCache === undefined) rgCache = which("rg") ?? which("rg", undefined, [path.join(HOME, ".pi", "agent", "bin")]);
	return rgCache;
}

/** Files under root with one of exts that contain name as a whole word, as ripgrep lists them (it skips git-ignored files and build output). null when ripgrep cannot run. */
function rgFiles(root, name, exts) {
	const bin = rgBin();
	if (!bin) return null;
	const args = ["--files-with-matches", "--word-regexp", "--fixed-strings", "--no-messages", "--max-filesize", "2M", ...exts.flatMap((e) => ["-g", `*.${e}`]), ...[...SKIP_DIRS].flatMap((d) => ["-g", `!**/${d}/**`]), "--", name, "."];
	const r = spawnSync(bin, args, { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
	if (r.error || (r.status !== 0 && r.status !== 1)) return null;
	return String(r.stdout ?? "").split(/\r?\n/).filter(Boolean).map((f) => path.resolve(root, f));
}

/** Files under root with one of exts that contain name as a whole word: ripgrep, else a bounded walk. */
export function candidateFiles(root, name, exts, except) {
	if (!IDENT.test(String(name))) return [];
	const listed = name.includes("$") ? null : rgFiles(root, name, exts);
	if (listed) return listed.filter((f) => pathKey(f) !== pathKey(except ?? "")).slice(0, CANDIDATE_FILES_MAX);
	const re = wordRe(name);
	const out = [];
	let seen = 0;
	let bytes = 0;
	const walk = (d) => {
		let entries;
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= CANDIDATE_FILES_MAX || bytes > CANDIDATE_BYTES_MAX || ++seen > WALK_BUDGET * 4) return;
			if (e.name.startsWith(".")) continue;
			const full = path.join(d, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(full);
			} else if (e.isFile() && exts.includes(extOf(e.name)) && pathKey(full) !== pathKey(except ?? "")) {
				try {
					const t = fs.readFileSync(full, "utf8");
					bytes += t.length;
					if (re.test(t)) out.push(full);
				} catch {}
			}
		}
	};
	walk(root);
	return out;
}

/** Test files: tests/, __tests__/, spec/ folders, *.test.*, *.spec.*, *_test.*, test_*.py. */
export const isTestFile = (p) => /(^|[\\/])(__tests__|__mocks__|tests?|specs?)[\\/]|[._-](test|spec)\.[^\\/.]+$|(^|[\\/])test_[^\\/]*\.py$/i.test(String(p));

/** A line that imports names: an unresolved import's definition is the import itself. */
const IMPORT_LINE = /^\s*(?:(?:import|from|use|using)\b|export\s*(?:type\s+)?(?:\{|\*)|#\s*include\b)|\brequire\s*\(/;

/**
 * Whether a module file can use the export `name` of another module: it imports or re-exports the
 * name, or imports the module whole (namespace, require, dynamic import, export *).
 */
export function mayImport(text, name) {
	const n = name.replace(/\$/g, "\\$");
	return new RegExp(`\\b(?:import|export)\\s+(?:type\\s+)?\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}\\s*from\\b`).test(text)
		|| new RegExp(`\\bimport\\s+(?:type\\s+)?${n}\\s*(?:,|from\\b)`).test(text)
		|| /\bimport\s*\*\s*as\b|\bimport\s*\(|\brequire\s*\(|\bexport\s*\*\s*from\b/.test(text);
}

const otherFiles = new Map(); // `${target}|${file}` -> stamp of a file whose uses of the name are another symbol
const stampOf = (f) => {
	try {
		const st = fs.statSync(f);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "";
	}
};
const refState = new Map(); // `${file}:${line}:${character}:${includeDeclaration}` -> state of a partial references search

/**
 * Makes a references answer complete, or says what it misses. It scans the server's files under its
 * root for the name as a whole word. A file with a known location is covered: references list every
 * use in a file of the program. In each other file it asks for the definition at the first
 * occurrences: the same declaration as the start adds the references from there (servers like
 * tsserver answer only from the projects they have loaded); another declaration skips the file.
 * Occurrences in the files that are left are unverified text matches. Files not reached within
 * budgetMs are `remaining`; a later call can continue with the returned state.
 */
async function coverage(client, name, start, base, includeDeclaration, signal, budgetMs, saved) {
	const deadline = Date.now() + budgetMs;
	const key = (l) => `${pathKey(l.file)}:${l.line}:${l.character}`;
	const ask = (method, uri, position) =>
		client
			.request(method, { textDocument: { uri }, position, ...(method.endsWith("references") ? { context: { includeDeclaration } } : {}) }, LSP_REQUEST_MS, signal)
			.then(normLocations, () => []);
	const merged = new Map(base.map((l) => [key(l), l]));
	const covered = () => new Set([...merged.values()].map((l) => pathKey(l.file)));
	let done = covered();
	const target = saved ? saved.target : (await ask("textDocument/definition", start.uri, start.position))[0] ?? null;
	const files = saved ? saved.remaining : candidateFiles(client.root, name, client.spec.exts);
	const unverified = saved ? [...saved.unverified] : [];
	let other = saved?.other ?? 0;
	// The target is a top-level export: a file that does not import it cannot use it (ES modules).
	let exportTarget = false;
	if (target) {
		try {
			exportTarget = /^\s*export\s/.test(fs.readFileSync(target.file, "utf8").split("\n")[target.line] ?? "");
		} catch {}
	}
	const remaining = [];
	for (const [n, f] of files.entries()) {
		if (done.has(pathKey(f))) continue;
		if (signal?.aborted || Date.now() > deadline) {
			remaining.push(...files.slice(n).filter((x) => !done.has(pathKey(x))));
			break;
		}
		let lines;
		try {
			lines = fs.readFileSync(f, "utf8").split("\n");
		} catch {
			continue;
		}
		const otherKey = target ? `${key(target)}:${stampOf(target.file)}|${pathKey(f)}` : "";
		if (otherKey && otherFiles.get(otherKey) === stampOf(f)) {
			other++;
			continue;
		}
		if (exportTarget && pathKey(f) !== pathKey(target.file) && !mayImport(lines.join("\n"), name)) {
			other++;
			continue;
		}
		const occ = [];
		for (const [i, l] of lines.entries()) for (const m of l.matchAll(wordRe(name, "g"))) occ.push({ line: i, character: m.index, raw: l });
		if (!occ.length) continue;
		let verdict = "unverified";
		if (target) {
			const wasOpen = client.open.has(toUri(f));
			const { uri } = client.sync(f);
			// A few occurrences per file: a name in a comment or a string has no definition.
			let waited = wasOpen;
			for (const o of occ.slice(0, 3)) {
				let defs = await ask("textDocument/definition", uri, { line: o.line, character: o.character });
				// A file just opened in a young server: its project may still be loading, so wait once and ask again.
				if (!defs.length && !waited && Date.now() - client.startedAt < READY_MAX_MS) {
					waited = true;
					await client.ready(true, signal);
					defs = await ask("textDocument/definition", uri, { line: o.line, character: o.character });
				}
				// The same declaration, or one the references already hold (C: the header's declaration).
				if (defs.some((l) => key(l) === key(target) || merged.has(key(l)))) {
					for (const l of await ask("textDocument/references", uri, { line: o.line, character: o.character })) merged.set(key(l), l);
					done = covered();
					verdict = "same";
					break;
				}
				// An import the server cannot resolve points at itself: that is not another symbol.
				const unresolved = defs.every((l) => pathKey(l.file) === pathKey(f) && IMPORT_LINE.test(lines[l.line] ?? ""));
				if (defs.length && !unresolved) verdict = "other";
			}
			if (!wasOpen && !client.spec.crossProject) client.close(f);
		}
		if (verdict === "other") {
			other++;
			if (otherKey) otherFiles.set(otherKey, stampOf(f));
		}
		else if (verdict === "unverified" || !done.has(pathKey(f))) unverified.push(...occ.map((o) => ({ file: f, ...o })));
	}
	return {
		target,
		locations: [...merged.values()],
		unverified: unverified.filter((u) => !done.has(pathKey(u.file))),
		remaining,
		other,
	};
}

/** Adds `sym` (the enclosing symbol) and a note to each hit, file by file, until the deadline. */
async function addEnclosing(client, hits, name, signal, deadline) {
	const byFile = new Map();
	for (const h of hits) {
		if (!byFile.has(h.file)) byFile.set(h.file, []);
		byFile.get(h.file).push(h);
	}
	for (const [file, hs] of byFile) {
		if (signal?.aborted || Date.now() > deadline) return false;
		let syms = [];
		try {
			const wasOpen = client.open.has(toUri(file));
			const { uri } = client.sync(file);
			syms = flattenSymbols(await client.request("textDocument/documentSymbol", { textDocument: { uri } }, Math.max(300, deadline - Date.now()), signal));
			if (!wasOpen && !client.spec.crossProject) client.close(file);
		} catch {}
		for (const h of hs) {
			h.sym = enclosing(syms, h.line - 1, name);
			if (h.sym && !h.note) h.note = `in ${h.sym.name}`;
		}
	}
	return true;
}

/** References with output "functions": per file, one line per enclosing symbol with its use lines. */
export function formatFunctions(hits, limit) {
	const files = new Map();
	for (const h of hits) {
		if (!files.has(h.path)) files.set(h.path, new Map());
		const label = h.def ? "definition" : h.sym ? `${SYMBOL_KINDS[h.sym.kind] ?? "symbol"} ${h.sym.name} L${h.sym.start + 1}-${h.sym.end + 1}` : "top level";
		const m = files.get(h.path);
		if (!m.has(label)) m.set(label, []);
		m.get(label).push(h.line);
	}
	const out = [];
	let shown = 0;
	let more = 0;
	for (const [p, m] of files) {
		if (shown >= limit) {
			more += m.size;
			continue;
		}
		out.push(p);
		for (const [label, lines] of m) {
			if (shown >= limit) {
				more++;
				continue;
			}
			const at = [...new Set(lines)].join(", ");
			out.push(label === "definition" ? `definition: line ${at}` : `${label}: ${plural(lines.length, "use")} (line ${at})`);
			shown++;
		}
	}
	if (more) out.push(`[${more} more; raise limit]`);
	return out.join("\n");
}

async function referencesOp({ client, cwd, file, uri, text, pos, params, signal, askWarm, isEmpty, head, at, limit, output }) {
	const includeDeclaration = params?.includeDeclaration !== false;
	const name = (typeof params?.symbol === "string" && params.symbol.trim()) || (text.split("\n")[pos.line].slice(pos.character).match(/^[\w$]+/) ?? [""])[0];
	const stateKey = `${pathKey(file)}:${pos.line}:${pos.character}:${includeDeclaration}`;
	const saved = params?.continue ? refState.get(stateKey) : null;
	let res;
	if (saved) res = await coverage(client, name, { file, uri, position: pos }, saved.locations, includeDeclaration, signal, REFS_CONTINUE_MS, saved);
	else {
		const base = normLocations(await askWarm("textDocument/references", { textDocument: { uri }, position: pos, context: { includeDeclaration } }, isEmpty));
		res = IDENT.test(name)
			? await coverage(client, name, { file, uri, position: pos }, base, includeDeclaration, signal, REFS_BUDGET_MS, null)
			: { target: null, locations: base, unverified: [], remaining: [], other: 0 };
	}
	if (res.remaining.length) refState.set(stateKey, res);
	else refState.delete(stateKey);

	const cache = new Map();
	let hits = locationHits(res.locations, cwd, cache);
	let loose = res.unverified
		.map((u) => ({ path: rel(cwd, u.file), line: u.line + 1, col: u.character + 1, text: showLine(u.raw, u.character), file: u.file }))
		.sort(byPosition);
	let hidden = 0;
	if (params?.exclude_tests) {
		const keep = (h) => !isTestFile(h.path);
		hidden = hits.length + loose.length;
		hits = hits.filter(keep);
		loose = loose.filter(keep);
		hidden -= hits.length + loose.length;
	}
	const t = res.target;
	for (const h of hits) if (t && pathKey(h.file) === pathKey(t.file) && h.line === t.line + 1 && h.col === t.character + 1) (h.def = true), (h.note = "definition");
	const lines = [];
	if (output === "lines" || output === "functions") {
		const shown = output === "functions" ? hits : hits.slice(0, limit);
		await addEnclosing(client, shown, name, signal, Date.now() + NOTES_BUDGET_MS);
	}
	if (hits.length) lines.push(output === "functions" ? formatFunctions(hits, limit) : formatGrouped(hits, { limit, output }));
	else lines.push("No verified uses. Check the position is on the symbol name.");
	if (loose.length) {
		lines.push("unverified: the name as text, with no definition found (a comment, a string, or a file in no project):");
		lines.push(formatGrouped(loose, { limit: Math.max(10, limit - hits.length), output: output === "functions" ? "lines" : output }));
	}
	const files = new Set(hits.map((h) => h.path)).size;
	const facts = [`${hits.length} verified in ${plural(files, "file")}`, `${plural(loose.length, "unverified text match", "unverified text matches")}`, `${plural(res.remaining.length, "file")} unchecked`];
	if (res.other) facts.push(`${plural(res.other, "file")} with another ${name} skipped`);
	if (hidden) facts.push(`${hidden} in tests hidden`);
	lines.push(`[${facts.join(", ")}]`);
	if (res.remaining.length) lines.push(`[stopped after ${(saved ? REFS_CONTINUE_MS : REFS_BUDGET_MS) / 1000}s; call again with continue: true to check the rest]`);
	return {
		text: clip(`${head} references ${at}\n${lines.join("\n")}`),
		details: { count: hits.length, unverified: loose.length, unchecked: res.remaining.length, partial: res.remaining.length > 0 },
	};
}

/** WorkspaceEdit -> Map(file -> TextEdit[]); file creates, renames and deletes are left out. */
export function workspaceEdits(we) {
	const out = new Map();
	const add = (uri, edits) => {
		if (!uri || !Array.isArray(edits)) return;
		const f = real(fromUri(uri));
		if (!out.has(f)) out.set(f, []);
		out.get(f).push(...edits.filter((e) => e?.range && typeof e.newText === "string"));
	};
	for (const [uri, edits] of Object.entries(we?.changes ?? {})) add(uri, edits);
	for (const c of we?.documentChanges ?? []) if (c?.textDocument) add(c.textDocument.uri, c.edits);
	return out;
}

/** Applies TextEdits to text; overlapping edits after the first are dropped. Returns { text, applied }. */
export function applyEdits(text, edits) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	const off = (p) => Math.min(text.length, (starts[p.line] ?? text.length) + p.character);
	const seen = new Set();
	const list = [];
	for (const e of edits) {
		const s = off(e.range.start);
		const t = off(e.range.end);
		const k = `${s}:${t}`;
		if (seen.has(k)) continue;
		seen.add(k);
		list.push({ s, t, newText: e.newText });
	}
	list.sort((a, b) => a.s - b.s || a.t - b.t);
	const keep = [];
	for (const e of list) if (!keep.length || e.s >= keep[keep.length - 1].t) keep.push(e);
	let out = text;
	for (const e of [...keep].reverse()) out = out.slice(0, e.s) + e.newText + out.slice(e.t);
	return { text: out, applied: keep.length };
}

/**
 * rename: the server's rename edits from the symbol, plus the edits from a use in each file that
 * references found in another project (tsserver renames only in the projects it has loaded).
 * Preview unless apply; text matches with no definition (comments, strings) are listed, never changed.
 */
async function renameOp({ client, cwd, file, uri, text, pos, params, signal, head, at, limit }) {
	const newName = typeof params?.new_name === "string" ? params.new_name.trim() : "";
	if (!newName) throw new Error("rename needs `new_name`.");
	const name = (typeof params?.symbol === "string" && params.symbol.trim()) || (text.split("\n")[pos.line].slice(pos.character).match(/^[\w$]+/) ?? [""])[0];
	const ask = (u, position) => client.request("textDocument/rename", { textDocument: { uri: u }, position, newName }, LSP_REQUEST_MS, signal);
	let first;
	for (let i = 0; i < 4; i++) {
		first = await ask(uri, pos).catch((e) => ({ error: e }));
		if (!first?.error && workspaceEdits(first).size) break;
		if (Date.now() - client.startedAt > 60000) break;
		await sleep(1500, signal);
	}
	if (first?.error) return { text: `${head} rename ${at}\nThe server cannot rename here: ${first.error.message}` };
	const edits = new Map();
	const merge = (we) => {
		for (const [f, es] of workspaceEdits(we)) {
			const k = [...edits.keys()].find((x) => pathKey(x) === pathKey(f)) ?? f;
			// Renamed from an importing file, tsserver keeps the old name with an alias
			// (`old as new`); the export is renamed too, so the alias is the new name alone.
			edits.set(k, [...(edits.get(k) ?? []), ...es.map((e) => (e.newText === `${name} as ${newName}` || e.newText === `${newName} as ${name}` ? { ...e, newText: newName } : e))]);
		}
	};
	merge(first);
	if (!edits.size) return { text: `${head} rename ${at}\nNo rename edits. Check the position is on the symbol name.` };
	// The uses in files the server did not rename (another project): rename from there and merge.
	const refs = IDENT.test(name)
		? await coverage(client, name, { file, uri, position: pos }, [...edits].flatMap(([f, es]) => es.map((e) => ({ file: f, line: e.range.start.line, character: e.range.start.character }))), true, signal, REFS_CONTINUE_MS, null)
		: { locations: [], unverified: [], remaining: [] };
	const missing = () => {
		const byFile = new Map();
		for (const l of refs.locations) if (!byFile.has(pathKey(l.file))) byFile.set(pathKey(l.file), l);
		return [...byFile.values()].filter((l) => ![...edits.keys()].some((f) => pathKey(f) === pathKey(l.file)));
	};
	// The search opened the files with uses: their projects are loaded now, so ask again from the symbol.
	if (missing().length) merge(await ask(uri, pos).catch(() => null));
	for (const l of missing()) merge(await ask(toUri(l.file), { line: l.line, character: l.character }).catch(() => null));
	const outside = [...edits.keys()].filter((f) => !isInside(cwd, f) || /[\\/]node_modules[\\/]/.test(f));
	for (const f of outside) edits.delete(f);
	const results = [];
	for (const [f, es] of edits) {
		let before;
		try {
			before = fs.readFileSync(f, "utf8");
		} catch {
			continue;
		}
		const r = applyEdits(before, es);
		if (r.text !== before) results.push({ file: f, before, after: r.text, count: r.applied });
	}
	results.sort((a, b) => (rel(cwd, a.file) < rel(cwd, b.file) ? -1 : 1));
	const total = results.reduce((n, r) => n + r.count, 0);
	const apply = params?.apply === true;
	if (apply) {
		for (const r of results) fs.writeFileSync(r.file, r.after);
		client.filesChanged(results.map((r) => r.file));
		for (const r of results) indexChanged(r.file);
	}
	const hits = [];
	for (const r of results) {
		const a = r.after.split("\n");
		const b = r.before.split("\n");
		// Line counts change only with multi-line edits; then compare from the start only.
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) hits.push({ path: rel(cwd, r.file), line: i + 1, text: showLine(a[i].replace(/\r$/, ""), Math.max(0, a[i].indexOf(newName))), file: r.file });
	}
	// Written edits default to edits per file: the lines are known; a preview shows them.
	const out = OUTPUTS.includes(params?.output) && params.output !== "functions" ? params.output : apply ? "count" : "lines";
	const lines = [hits.length ? formatGrouped(hits, { limit, output: out }) : "No changes."];
	const notChanged = refs.unverified.filter((u) => {
		const r = results.find((x) => pathKey(x.file) === pathKey(u.file));
		return !r || (r.after.split("\n")[u.line] ?? "").slice(u.character, u.character + name.length) === name;
	});
	if (notChanged.length) {
		lines.push(`not changed: ${name} as text, with no definition (a comment, a string, or a file in no project):`);
		lines.push(formatGrouped(notChanged.map((u) => ({ path: rel(cwd, u.file), line: u.line + 1, col: u.character + 1, text: showLine(u.raw, u.character), file: u.file })).sort(byPosition), { limit: 20 }));
	}
	const facts = [`${plural(total, "edit")} in ${plural(results.length, "file")}`];
	if (notChanged.length) facts.push(`${plural(notChanged.length, "text match", "text matches")} not changed`);
	if (refs.remaining.length) facts.push(`${plural(refs.remaining.length, "file")} not checked in time`);
	if (outside.length) facts.push(`${plural(outside.length, "file")} outside the project skipped`);
	lines.push(`[${facts.join(", ")}]`);
	lines.push(apply ? `[written: ${name} → ${newName}]` : "[preview only: call again with apply: true to write]");
	return {
		text: clip(`${head} rename ${at} ${name} → ${newName}\n${lines.join("\n")}`),
		details: { edits: total, files: results.length, applied: apply, notChanged: notChanged.length, unchecked: refs.remaining.length },
	};
}

/** Symbol kinds whose members are the answer to "what is X": class, enum, interface, struct. */
const TYPE_KINDS = new Set([5, 10, 11, 23]);
const MEMBERS_MAX = 30;
const MEMBERS_MS = 3000; // the hover answer does not wait longer for the members

/** The DocumentSymbol declared on a 0-based line (its name's line), the innermost one. */
export function symbolOnLine(res, line) {
	let best = null;
	const walk = (list) => {
		for (const s of Array.isArray(list) ? list : []) {
			if (!s?.range) continue;
			if (line < s.range.start.line || line > s.range.end.line) continue;
			if ((s.selectionRange?.start?.line ?? s.range.start.line) === line) best = s;
			walk(s.children);
		}
	};
	walk(res);
	return best;
}

/**
 * For hover on a class, interface, struct or enum: its members as their source lines, so the
 * answer needs no Read. "" for other symbols, or when the server has no document symbols.
 */
async function typeMembers(client, tdp, cwd, signal) {
	try {
		const def = normLocations(await client.request("textDocument/definition", tdp, MEMBERS_MS, signal))[0];
		if (!def) return "";
		const wasOpen = client.open.has(toUri(def.file));
		const { uri, text } = client.sync(def.file);
		const res = await client.request("textDocument/documentSymbol", { textDocument: { uri } }, MEMBERS_MS, signal);
		if (!wasOpen && !client.spec.crossProject) client.close(def.file);
		const s = symbolOnLine(res, def.line);
		if (!s || !TYPE_KINDS.has(s.kind) || !s.children?.length) return "";
		const src = text.split("\n");
		const kids = [...s.children].sort((a, b) => a.range.start.line - b.range.start.line);
		const lines = kids.slice(0, MEMBERS_MAX).map((c) => {
			const ln = c.selectionRange?.start?.line ?? c.range.start.line;
			return `${ln + 1}: ${showLine(src[ln])}`;
		});
		const more = kids.length > MEMBERS_MAX ? `\n[${kids.length - MEMBERS_MAX} more; lsp symbols for all]` : "";
		return `\nmembers (${rel(cwd, def.file)} L${s.range.start.line + 1}-${s.range.end.line + 1}):\n${lines.join("\n")}${more}`;
	} catch {
		return "";
	}
}

/** Whether a workspace symbol is the one a query names: `name`, or `Container.name`. */
export function symbolMatches(s, query) {
	const parts = String(query).split(/\.|::/).filter(Boolean);
	const name = parts.pop() ?? "";
	const container = parts.join(".");
	const n = String(s?.name ?? "");
	const same = n === name || n.endsWith(`.${name}`) || n.endsWith(`::${name}`) || n.startsWith(`${name}(`);
	return same && (!container || `${s.containerName ?? ""}.${n}`.includes(container));
}

// AST index
// =========
//
// `ast-grep outline` lists every top-level declaration and class member of a workspace, with line
// ranges and signatures, in one process call (60 ms for 440 files). Definitions by name, file
// outlines, symbol bodies and symbol search come from it in milliseconds, with no language server.
// Files are re-outlined when their stamp changes; Write and Bash calls mark the index stale.

const INDEX_CHECK_MS = 2000; // re-check file stamps at most this often
const INDEX_MAX_FILES = 50000;
const astIndexes = new Map(); // root -> { files: Map(pathKey -> entry), checkedAt, stale, building }

/** One outline entry -> { path, stamp, syms: [{ name, kind, line, end, sig, container, exported }] } (1-based lines). */
export function indexEntry(o, root) {
	const file = path.resolve(root, String(o.path));
	const syms = [];
	const span = (r) => ({ line: (r?.start?.line ?? 0) + 1, end: (r?.end?.line ?? r?.start?.line ?? 0) + 1 });
	for (const it of o.items ?? []) {
		// Imports and `export * from` lines declare nothing.
		if (it.isImport || !it.name || /^['"`]/.test(String(it.name)) || /^export\s*(type\s+)?\*/.test(String(it.signature ?? ""))) continue;
		syms.push({ name: String(it.name), kind: String(it.symbolType ?? "symbol"), ...span(it.range), sig: String(it.signature ?? ""), container: "", exported: !!it.isExported });
		for (const m of it.members ?? []) {
			if (!m.name) continue;
			syms.push({ name: String(m.name), kind: String(m.symbolType ?? "member"), ...span(m.range), sig: String(m.signature ?? ""), container: String(it.name), exported: false });
		}
	}
	return { path: file, stamp: stampOf(file), syms };
}

async function outlineFiles(root, paths, signal) {
	const sg = sgBin(root);
	if (!sg) return null;
	const r = await runCollect(sg, ["outline", "--json=stream", "--items", "all", "--view", "expanded", ...(paths ?? ["."])], root, signal, INDEX_MAX_FILES, SG_TIMEOUT_MS);
	if (r.code !== 0 && !r.items.length) return null;
	return r.items.filter((o) => CODE_EXTS.has(extOf(String(o.path ?? "")))).map((o) => indexEntry(o, root));
}

/** The AST index of root, up to date with the disk; null without ast-grep (or an ast-grep without outline). */
async function astIndex(root, signal) {
	let ix = astIndexes.get(root);
	if (ix?.building) return ix.building;
	if (ix && !ix.stale && Date.now() - ix.checkedAt < INDEX_CHECK_MS) return ix;
	const build = (async () => {
		if (!ix || ix.stale) {
			const list = await outlineFiles(root, null, signal);
			if (!list) return null;
			ix = { files: new Map(list.map((e) => [pathKey(e.path), e])), checkedAt: Date.now(), stale: false };
			astIndexes.set(root, ix);
			return ix;
		}
		const changed = [];
		for (const [k, e] of ix.files) {
			const st = stampOf(e.path);
			if (!st) ix.files.delete(k);
			else if (st !== e.stamp) changed.push(e.path);
		}
		if (changed.length) for (const e of (await outlineFiles(root, changed.map((f) => path.relative(root, f)), signal)) ?? []) ix.files.set(pathKey(e.path), e);
		ix.checkedAt = Date.now();
		return ix;
	})();
	if (ix) ix.building = build;
	try {
		return await build;
	} finally {
		if (ix) ix.building = null;
	}
}

/** Marks the indexes stale: a file changed (re-outlined on the next check), or anything may have changed (rebuild). */
function indexChanged(file) {
	for (const [root, ix] of astIndexes) {
		if (!file) ix.stale = true;
		else if (isInside(root, file)) ix.checkedAt = 0;
	}
}

/** Declarations named like query (`name`, or `Container.name`) in the index: exact matches, then partial ones. */
export function indexLookup(ix, query) {
	const parts = String(query).split(/\.|::|#/).filter(Boolean);
	const name = parts.pop() ?? "";
	const container = parts.pop() ?? "";
	const exact = [];
	const partial = [];
	const low = name.toLowerCase();
	for (const e of ix.files.values()) {
		for (const s of e.syms) {
			if (s.name === name && (!container || s.container === container)) exact.push({ e, s });
			else if (low.length >= 2 && s.name.toLowerCase().includes(low)) partial.push({ e, s });
		}
	}
	return { exact, partial };
}

/**
 * The declarations a name alone means: the one exported top-level declaration if there is exactly one
 * (a field or a local of the same name is something else), else the one top-level one, else all.
 */
export function mainDeclarations(hits) {
	const exported = hits.filter((h) => h.sym && !h.sym.container && h.sym.exported);
	if (exported.length === 1) return exported;
	const top = hits.filter((h) => h.sym && !h.sym.container);
	if (top.length === 1) return top;
	return hits;
}

/** An index symbol as a hit for formatGrouped: its name on its declaration line. */
function indexHit({ e, s }, cwd, cache = new Map()) {
	const lines = (rawLine(cache, e.path, 0), cache.get(e.path));
	const re = wordRe(s.name);
	let ln = s.line - 1;
	for (let i = ln; i < Math.min(lines.length, s.end); i++) {
		if (re.test(lines[i])) {
			ln = i;
			break;
		}
	}
	const col = Math.max(0, (lines[ln] ?? "").search(re));
	return {
		path: rel(cwd, e.path), line: ln + 1, col: col + 1, text: showLine(lines[ln] ?? s.sig, col), file: e.path,
		note: s.container ? `${s.kind} of ${s.container}` : s.kind, outside: !isInside(cwd, e.path), sym: s,
	};
}

/** A file outline from the index: `kind name  Lstart-end`, members indented under their class. */
export function formatIndexOutline(entry, { kinds = null, depth = Infinity, limit = 400 } = {}) {
	const out = [];
	let more = 0;
	for (const s of entry.syms) {
		if (s.container && depth < 1) continue;
		if (kinds && !kinds.includes(s.kind)) continue;
		if (out.length >= limit) {
			more++;
			continue;
		}
		out.push(`${s.container ? "  " : ""}${s.kind} ${s.name}  L${s.line}-${s.end}`);
	}
	if (more) out.push(`[${more} more; raise limit or filter by kind]`);
	return out.join("\n");
}

/** A directory overview from the index: per file, its exported declarations with their first line. */
export function formatIndexDir(ix, dir, cwd, { kinds = null, limit = 200 } = {}) {
	const files = [...ix.files.values()].filter((e) => isInside(dir, e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
	const out = [];
	let shown = 0;
	let more = 0;
	for (const e of files) {
		const top = e.syms.filter((s) => !s.container && s.exported && (!kinds || kinds.includes(s.kind)));
		if (!top.length) continue;
		if (shown >= limit) {
			more += top.length;
			continue;
		}
		out.push(rel(cwd, e.path));
		for (const s of top) {
			if (shown >= limit) {
				more++;
				continue;
			}
			out.push(`${s.line}: ${showLine(s.sig || s.name, 0)}`);
			shown++;
		}
	}
	if (more) out.push(`[${more} more exports; raise limit or narrow the directory]`);
	return { text: out.join("\n"), files: files.length };
}

/** A workspace symbol as a hit on its name: the range start may be a decorator or a doc comment. */
function symbolHit(s, cwd, cache) {
	const file = real(fromUri(s.location.uri));
	const short = String(s.name).split(/\.|::/).pop().replace(/\(.*$/, "");
	const lines = (rawLine(cache, file, 0), cache.get(file));
	let ln = s.location.range?.start?.line;
	if (!Number.isFinite(ln)) ln = Math.max(0, lines.findIndex((l) => declaresName(l, short)));
	const re = wordRe(short);
	for (let i = ln; i < Math.min(lines.length, ln + 6); i++) {
		if (re.test(lines[i])) {
			ln = i;
			break;
		}
	}
	const col = Math.max(0, (lines[ln] ?? "").search(re));
	return {
		path: rel(cwd, file), line: ln + 1, col: col + 1, text: showLine(lines[ln], col), note: SYMBOL_KINDS[s.kind] ?? "",
		file, outside: !isInside(cwd, file), label: `${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.containerName ? `${s.containerName}.` : ""}${s.name}`,
	};
}

/**
 * The answers the AST index gives without a language server: definition by name, workspace symbols,
 * the outline of a file or a directory, and the body of a symbol. null: ask the language server.
 */
async function indexOp({ op, params, cwd, symbolName, byName, signal }) {
	if (!(byName || op === "symbols" || op === "workspace_symbols")) return null;
	const ix = await astIndex(cwd, signal).catch(() => null);
	if (!ix) return null;
	const head = `[index · ast-grep · ${plural(ix.files.size, "file")}]`;
	const output = OUTPUTS.includes(params?.output) ? params.output : "lines";
	const lang = normalizeLang(params?.lang);
	const inLang = (h) => !lang || SG_LANGS[extOf(h.e.path)] === lang;
	const cache = new Map();
	if (byName || op === "workspace_symbols") {
		const query = String((byName ? symbolName : params?.query ?? params?.symbol) ?? "").trim();
		if (!query) return null;
		const { exact, partial } = indexLookup(ix, query);
		const hits = exact.filter(inLang).map((h) => indexHit(h, cwd, cache)).sort(byPosition);
		if (byName) {
			// None: the language server may still know it (a local, a language ast-grep does not outline).
			if (!hits.length) return null;
			const limit = limitOf(params?.limit, LIMIT_DEFAULT);
			return {
				text: clip(`${head} definition ${query}\n${formatGrouped(hits, { limit, output })}\n[${plural(hits.length, `declaration named ${query}`, `declarations named ${query}`)}]`),
				details: { count: hits.length, hits: mainDeclarations(hits).map((h) => ({ path: h.path, line: h.line })) },
			};
		}
		const limit = limitOf(params?.limit, SYMBOLS_LIMIT_DEFAULT);
		const part = partial.filter(inLang).map((h) => indexHit(h, cwd, cache)).sort(byPosition);
		if (!hits.length && !part.length) return null;
		const out = [];
		if (hits.length) out.push(formatGrouped(hits.slice(0, limit), { limit }));
		const room = Math.max(0, limit - hits.length);
		if (part.length && room) {
			if (hits.length) out.push("partial matches:");
			for (const h of part.slice(0, room)) out.push(`${h.path}:${h.line}: ${h.note} ${h.sym.container ? `${h.sym.container}.` : ""}${h.sym.name}`);
		}
		const shown = Math.min(hits.length, limit) + Math.min(part.length, room);
		const total = hits.length + part.length;
		return { text: clip(`${head} workspace_symbols "${query}"\n${out.join("\n")}\n[${hits.length} exact, ${part.length} partial${shown < total ? `; ${total - shown} not shown, raise limit` : ""}]`), details: { exact: hits.length, partial: part.length } };
	}
	if (!params?.file) return null;
	const target = path.resolve(cwd, String(params.file));
	let st;
	try {
		st = fs.statSync(target);
	} catch {
		return null;
	}
	const kinds = kindsOf(params?.kind);
	if (st.isDirectory()) {
		const r = formatIndexDir(ix, real(target), cwd, { kinds, limit: limitOf(params?.limit, 200) });
		return { text: clip(`${head} symbols ${rel(cwd, target) || "."} (exported declarations per file)\n${r.text || "No exported declarations."}`) };
	}
	const e = ix.files.get(pathKey(real(target)));
	if (!e) return null;
	if (params?.body) {
		if (!symbolName) throw new Error("body needs `symbol`: the name of the symbol to show.");
		const parts = symbolName.split(/\.|::|#/).filter(Boolean);
		const name = parts.pop();
		const container = parts.pop();
		const all = e.syms.filter((x) => x.name === name && (!container || x.container === container));
		if (!all.length) return null;
		const l = Number(params?.line);
		const sym = all.find((x) => x.line <= l && l <= x.end) ?? all[0];
		const src = fs.readFileSync(e.path, "utf8").split("\n");
		const last = Math.min(sym.end, sym.line + 399);
		const body = src.slice(sym.line - 1, last).map((t, i) => `${sym.line + i}: ${t.replace(/\r$/, "")}`).join("\n");
		const cut = last < sym.end ? `\n[${sym.end - last} more lines; Read from line ${last + 1}]` : "";
		return { text: clip(`${head} symbols ${rel(cwd, e.path)} ${sym.kind} ${sym.container ? `${sym.container}.` : ""}${sym.name} L${sym.line}-${sym.end}\n${body}${cut}`) };
	}
	const depth = Number.isFinite(Number(params?.depth)) && params?.depth !== null && params?.depth !== "" ? Math.max(0, Number(params.depth)) : Infinity;
	const t = formatIndexOutline(e, { kinds, depth, limit: limitOf(params?.limit, 400) });
	return { text: clip(`${head} symbols ${rel(cwd, e.path)}\n${t || "No symbols."}`) };
}

async function lsp(params, ctx, signal) {
	const cwd = real(ctx?.cwd ?? process.cwd());
	const op = String(params?.operation ?? "").toLowerCase();
	if (!LSP_OPS.includes(op)) throw new Error(`operation must be one of: ${LSP_OPS.join(", ")}`);
	const cfg = readConfig();
	const symbolName = typeof params?.symbol === "string" ? params.symbol.trim() : "";
	// A name alone, for an operation that needs a file: resolve the name like `definition` does, then ask there.
	if (!params?.file && symbolName && ((POSITION_OPS.has(op) && op !== "definition") || op === "symbols")) {
		const d = await lsp({ operation: "definition", symbol: symbolName, lang: params?.lang }, ctx, signal);
		const hits = d.details?.hits ?? [];
		if (hits.length === 1) return lsp({ ...params, file: hits[0].path, ...(op === "symbols" ? {} : { line: hits[0].line }) }, ctx, signal);
		if (!hits.length) return d;
		return { text: `${d.text.replace(/\n\[[^\n]*\]$/, "")}\n[${hits.length} declarations named ${symbolName}: give \`file\` and \`line\` of the one you mean]`, details: d.details };
	}
	const byName = op === "definition" && !params?.file && !!symbolName;
	const fromIndex = await indexOp({ op, params, cwd, symbolName, byName, signal });
	if (fromIndex) return fromIndex;
	if (!params?.file && op !== "workspace_symbols" && !byName) throw new Error(op === "definition" ? "Give `file` and `line` with `symbol`, or `symbol` alone." : "Give `file`, or `symbol` alone.");
	const file = real(op === "workspace_symbols" || byName ? anchorFile(cwd, params) : path.resolve(cwd, String(params.file)));
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`No such file: ${rel(cwd, file)}`);
	const { client, startedMs, note } = await clientFor(file, cwd, cfg);
	const tags = [
		VERIFIED.has(client.spec.name) ? "" : "experimental",
		startedMs !== undefined ? `server started in ${(startedMs / 1000).toFixed(1)}s` : "",
		note ?? "",
	].filter(Boolean);
	const head = `[lsp · ${client.cand.cmd} · ${client.spec.name}${tags.map((t) => ` · ${t}`).join("")}]`;
	const since = Date.now();
	client.refresh();
	const { uri, text, changed } = client.sync(file);
	// Wait while the server reports work in progress (a project load answers with partial data).
	// tsserver reports its project loads, so it needs no fixed pause after an open.
	await client.ready(changed, signal);
	const ask = (method, p) => client.request(method, p, LSP_REQUEST_MS, signal);
	// Fresh servers often answer empty while they index; retry a few times then.
	const askWarm = async (method, p, empty) => {
		let res = await ask(method, p);
		for (let i = 0; i < 4 && empty(res) && Date.now() - client.startedAt < 60000; i++) {
			await sleep(1500, signal);
			res = await ask(method, p);
		}
		return res;
	};
	const isEmpty = (r) => r == null || (Array.isArray(r) && r.length === 0);
	const output = OUTPUTS.includes(params?.output) ? params.output : "lines";
	const limit = limitOf(params?.limit, op === "workspace_symbols" ? SYMBOLS_LIMIT_DEFAULT : op === "symbols" ? 400 : LIMIT_DEFAULT);

	/** Declarations of a file outline as workspace symbols; locals inside functions are left out. */
	const outlineSymbols = (res, uri) => {
		const out = [];
		const walk = (list, container) => {
			for (const s of Array.isArray(list) ? list : []) {
				if (!s?.name || s.location) continue;
				out.push({ name: s.name, kind: s.kind, containerName: container, location: { uri, range: s.selectionRange ?? s.range } });
				if (![6, 9, 12].includes(s.kind)) walk(s.children, container ? `${container}.${s.name}` : s.name);
			}
		};
		walk(res, "");
		return out;
	};
	if (op === "workspace_symbols" || byName) {
		const query = String((byName ? symbolName : params?.query ?? params?.symbol) ?? "").trim();
		if (!query) throw new Error("workspace_symbols needs `query`.");
		const search = async () => {
			const res = await askWarm("workspace/symbol", { query }, isEmpty);
			return Array.isArray(res) ? res.filter((s) => s?.location?.uri) : [];
		};
		let found = await search();
		const name = query.split(/\.|::/).pop();
		if (client.spec.crossProject && IDENT.test(name)) {
			// tsserver answers workspace/symbol from one project (the last file's): a declaration in another
			// project is missing. Check each file that seems to declare the name with its own outline.
			const decl = candidateFiles(client.root, name, client.spec.exts).filter((f) => {
				try {
					return fs.readFileSync(f, "utf8").split("\n").some((l) => declaresName(l, name));
				} catch {
					return false;
				}
			});
			const have = new Set(found.filter((s) => symbolMatches(s, query)).map((s) => pathKey(real(fromUri(s.location.uri)))));
			for (const f of decl.filter((x) => !have.has(pathKey(x))).slice(0, 10)) {
				const { uri } = client.sync(f);
				const res = await client.request("textDocument/documentSymbol", { textDocument: { uri } }, LSP_REQUEST_MS, signal).catch(() => null);
				found.push(...outlineSymbols(res, uri).filter((s) => symbolMatches(s, query)));
			}
		}
		const cache = new Map();
		const seen = new Set();
		const hits = [];
		for (const s of found) {
			const h = symbolHit(s, cwd, cache);
			const k = `${h.path}:${h.line}:${h.label}`;
			if (seen.has(k)) continue;
			seen.add(k);
			h.exact = symbolMatches(s, query);
			hits.push(h);
		}
		// Exact names first, project files before dependencies and SDKs.
		hits.sort((a, b) => b.exact - a.exact || a.outside - b.outside);
		let exact = hits.filter((h) => h.exact);
		// A re-export (`export { x } from`) is listed as a symbol too; with a real declaration it is noise.
		const declared = exact.filter((h) => !IMPORT_LINE.test(h.text));
		if (declared.length) exact = declared;
		// With exact matches, partial ones from dependencies and SDKs are noise.
		const partial = hits.filter((h) => !h.exact && !(exact.length && h.outside));
		if (byName) {
			if (!exact.length) {
				const similar = [...new Set(partial.map((h) => h.label))].slice(0, 5).join(", ");
				return { text: `${head} definition ${query}\nNo declaration named ${query}.${similar ? ` Similar: ${similar}.` : ""} For text, use Grep.` };
			}
			return {
				text: clip(`${head} definition ${query}\n${formatGrouped(exact, { limit, output })}\n[${plural(exact.length, `declaration named ${query}`, `declarations named ${query}`)}]`),
				details: { count: exact.length, hits: exact.map((h) => ({ path: h.path, line: h.line })) },
			};
		}
		const out = [];
		if (exact.length) out.push(formatGrouped(exact.slice(0, limit), { limit }));
		const room = Math.max(0, limit - exact.length);
		if (partial.length && room) {
			if (exact.length) out.push("partial matches:");
			for (const h of partial.slice(0, room)) out.push(`${h.path}:${h.line}: ${h.label}`);
		}
		const shown = Math.min(exact.length, limit) + Math.min(partial.length, room);
		const foot = `[${exact.length} exact, ${partial.length} partial${shown < hits.length ? `; ${hits.length - shown} not shown, raise limit` : ""}]`;
		return { text: clip(`${head} workspace_symbols "${query}"\n${out.join("\n") || "No symbols."}\n${foot}`), details: { exact: exact.length, partial: partial.length } };
	}

	if (POSITION_OPS.has(op)) {
		const pos = locate(text, { line: Number(params?.line), column: Number(params?.column), symbol: params?.symbol });
		const at = `${rel(cwd, file)}:${pos.line + 1}:${pos.character + 1}`;
		const tdp = { textDocument: { uri }, position: pos };
		if (op === "hover") {
			const res = await askWarm("textDocument/hover", tdp, (r) => !hoverText(r));
			const t = hoverText(res);
			const members = t ? await typeMembers(client, tdp, cwd, signal) : "";
			return { text: `${head} hover ${at}\n${t ? clip(`${t}${members}`, 8000) : "No hover information."}` };
		}
		if (op === "references") return referencesOp({ client, cwd, file, uri, text, pos, params, signal, askWarm, isEmpty, head, at, limit, output });
		if (op === "rename") return renameOp({ client, cwd, file, uri, text, pos, params, signal, head, at, limit });
		const method = { definition: "textDocument/definition", implementation: "textDocument/implementation", type_definition: "textDocument/typeDefinition" }[op];
		const locs = normLocations(await askWarm(method, tdp, isEmpty));
		if (!locs.length) return { text: `${head} ${op} ${at}\nNo results. Check the position is on the symbol name; for text use Grep.` };
		const hits = locationHits(locs, cwd);
		const files = new Set(hits.map((h) => h.path)).size;
		return {
			text: clip(`${head} ${op} ${at}\n${formatGrouped(hits, { limit, output: output === "functions" ? "lines" : output })}\n[${plural(locs.length, "location")} in ${plural(files, "file")}]`),
			details: { count: locs.length },
		};
	}
	if (op === "symbols") {
		const res = await askWarm("textDocument/documentSymbol", { textDocument: { uri } }, isEmpty);
		if (params?.body) {
			if (!symbolName) throw new Error("body needs `symbol`: the name of the symbol to show.");
			const all = flattenSymbols(res).filter((s) => s.name === symbolName || s.short === symbolName || s.name.endsWith(`.${symbolName}`));
			const l0 = Number(params?.line) - 1;
			const s = all.find((x) => x.start <= l0 && l0 <= x.end) ?? all[0];
			if (!s) return { text: `${head} symbols ${rel(cwd, file)}\nNo symbol named ${symbolName}. Call symbols without body for the outline.` };
			const src = text.split("\n");
			const end = Math.min(s.end, s.start + 399);
			const body = src.slice(s.start, end + 1).map((l, i) => `${s.start + i + 1}: ${l.replace(/\r$/, "")}`).join("\n");
			const cut = end < s.end ? `\n[${s.end - end} more lines; Read from line ${end + 2}]` : "";
			return { text: clip(`${head} symbols ${rel(cwd, file)} ${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.name} L${s.start + 1}-${s.end + 1}\n${body}${cut}`) };
		}
		const depth = Number.isFinite(Number(params?.depth)) && params?.depth !== null && params?.depth !== "" ? Math.max(0, Number(params.depth)) : Infinity;
		const t = formatSymbols(res, cwd, { kinds: kindsOf(params?.kind), depth, limit });
		return { text: clip(`${head} symbols ${rel(cwd, file)}\n${t || "No symbols."}`) };
	}
	// diagnostics
	let items = null;
	if (client.caps.diagnosticProvider) {
		try {
			const r = await ask("textDocument/diagnostic", { textDocument: { uri } });
			if (r?.kind === "full") items = r.items ?? [];
		} catch {}
	}
	if (items === null) items = await client.waitDiagnostics(uri, since, changed, signal);
	if (items === null) return { text: `${head} diagnostics ${rel(cwd, file)}\nThe server reported nothing within ${DIAG_WAIT_MS / 1000}s.` };
	return { text: clip(`${head} diagnostics ${rel(cwd, file)}\n${items.length ? formatDiagnostics(items, file, cwd) : "No problems."}`), details: { count: items.length } };
}

// Grep steering
// =============

const TEXT_EXTS = new Set(["md", "mdx", "txt", "rst", "adoc", "log", "csv", "tsv", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "html", "htm", "css", "scss", "less", "svg", "lock", "properties", "gradle", "sql"]);
const TEXT_MARKERS = /^(TODO|FIXME|XXX|HACK|NOTE|BUG|WARN|WARNING|ERROR|DEPRECATED|OPTIMIZE|REVIEW)$/;
const CODE_WORDS = /\b(function|class|def|interface|struct|enum|impl|trait|fn|func|import|from|require|extends|implements|type|const|let|var|module|package|namespace|async|return|new)\b/;

/**
 * Whether a Grep call is looking for code: an identifier or a code shape, in code files or a tree.
 * Plain text (spaces between words, quotes, messages) and non-code targets are left alone.
 */
export function grepTargetsCode(input) {
	const pattern = String(input?.pattern ?? input?.query ?? "").trim();
	if (!pattern) return false;
	const p = String(input?.path ?? "");
	const include = [input?.include, input?.glob, input?.type].filter((x) => typeof x === "string").join(" ");
	const pExt = extOf(p);
	const gExts = globExts(include.split(/\s+/));
	const exts = [pExt, ...gExts].filter(Boolean);
	if (exts.length && exts.every((e) => TEXT_EXTS.has(e) || !CODE_EXTS.has(e))) return false;
	const bare = pattern.replace(/\\b/g, "").replace(/^\^|\$$/g, "");
	const identifier = /^[A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*$/.test(bare) && bare.length >= 3 && !TEXT_MARKERS.test(bare);
	const shape = CODE_WORDS.test(bare) && /[A-Za-z_$][\w$]*\s*(\\?\(|<|:|\{|\b)/.test(bare) && !/[\"'`]/.test(bare);
	const call = /^[A-Za-z_$][\w$.]*\s*\\?\($/.test(bare) || /^[A-Za-z_$][\w$.]*\\\(/.test(bare);
	return identifier || shape || call;
}

/** Extensions of the languages with a verified server: the only ones Grep results steer to lsp. */
const VERIFIED_EXTS = new Set(SERVERS.filter((s) => VERIFIED.has(s.name)).flatMap((s) => s.exts));
const VERIFIED_PATH = new RegExp(`\\.(${[...VERIFIED_EXTS].join("|")})\\b`);

export const HINT = "AST Lens: lsp references (file + line + symbol of a hit) lists only the real uses, with the function around each; lsp hover gives the type.";

/** Where a Grep hit is on disk: PI-Desktop's paths are relative to cwd, pi's to the folder searched. */
function hitFile(cwd, input, json, p) {
	if (json) return path.resolve(cwd, p);
	const base = path.resolve(cwd, String(input?.path ?? "."));
	try {
		if (fs.statSync(base).isFile()) return base;
	} catch {}
	return path.resolve(base, p);
}

/**
 * The new content of a Grep result for an identifier: grouped by file, comment and string hits
 * collapsed to line numbers (with ast-grep), declarations marked. null when the result is not one
 * this can read. `content` is null when the result stays as it is: a text search (every hit in a
 * comment or a string: Grep's job, `plainText`), or a result that grouping does not make smaller.
 * `verified` says whether hits are in a language with a verified server.
 */
export async function rewriteGrep(event, cwd, budgetMs = TAG_BUDGET_MS) {
	const name = grepIdentifier(event?.input);
	if (!name) return null;
	const content = Array.isArray(event.content) ? event.content : [];
	const texts = content.filter((c) => c?.type === "text");
	if (texts.length !== 1) return null;
	const parsed = parseGrepResult(texts[0].text);
	if (!parsed) return null;
	for (const h of parsed.hits) h.abs = hitFile(cwd, event.input, parsed.json, h.path);
	const tagged = await tagHits(parsed.hits, name, cwd, budgetMs);
	const verified = parsed.hits.some((h) => VERIFIED_EXTS.has(extOf(h.path)));
	if (tagged && !parsed.hits.some((h) => h.tag === "code")) return { content: null, text: texts[0].text, verified, plainText: true };
	const text = formatGrepResult(parsed, name, { tagged, pattern: event.input?.pattern ?? event.input?.query });
	if (text.length >= texts[0].text.length) return { content: null, text: texts[0].text, verified };
	return { content: content.map((c) => (c === texts[0] ? { ...c, text } : c)), text, verified };
}

/** The system prompt section; kept short (it is in every request) and the same for the whole session. */
function systemSection(sg) {
	return `${MARKER}
## AST Lens
For code, before Grep or Read:
- what a symbol is: lsp hover; a file or dir outline: lsp symbols
- its code: lsp symbols, symbol, body: true
- where defined and used: lsp definition, references (symbol alone works)
- rename: lsp rename, new_name, apply: true${sg ? "\n- code shapes, rewrites: ast_grep" : ""}
- values at runtime: debug probe
Grep is for plain text.
`;
}

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

// Extension
// =========

export const TOOLS = {
	ast_grep: {
		name: "ast_grep",
		label: "ast-grep",
		description: "Structural code search/rewrite with ast-grep: matches syntax, never comments or strings. Pattern = code with $X (one node) and $$$ (any number). Language from the file extension.",
		promptSnippet: "Structural code search/rewrite",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "e.g. `fetch($URL, $$$)`" },
				rule: { type: "string", description: "YAML rule, e.g. `kind: call_expression`" },
				path: { type: "string" },
				lang: { type: "string" },
				globs: { type: "array", items: { type: "string" }, description: "e.g. [\"src/**\",\"!**/*.test.ts\"]" },
				rewrite: { type: "string", description: "Preview unless apply" },
				apply: { type: "boolean" },
				limit: { type: "number", description: "Default 50" },
				output: { type: "string", enum: ["lines", "files", "count"] },
			},
		},
	},
	lsp: {
		name: "lsp",
		label: "LSP",
		description: "Language server for the file's extension. Point at a symbol: file + line + symbol, or symbol alone. references: real uses, the function around each, a coverage footer. symbols + symbol + body: its code. rename + new_name: every verified use; apply writes.",
		promptSnippet: "Definition, references, rename, hover, symbols, diagnostics",
		parameters: {
			type: "object",
			properties: {
				operation: { type: "string", enum: LSP_OPS },
				file: { type: "string" },
				line: { type: "number", description: "1-based" },
				symbol: { type: "string" },
				column: { type: "number" },
				query: { type: "string", description: "workspace_symbols" },
				lang: { type: "string" },
				output: { type: "string", enum: OUTPUTS, description: "functions: uses per function" },
				limit: { type: "number" },
				kind: { type: "string", description: "symbols: e.g. function,class" },
				depth: { type: "number", description: "symbols: 0 = top level" },
				body: { type: "boolean" },
				exclude_tests: { type: "boolean" },
				continue: { type: "boolean", description: "Resume a partial references" },
				new_name: { type: "string" },
				apply: { type: "boolean", description: "rename: write, else preview" },
			},
			required: ["operation"],
		},
	},
	debug: {
		name: "debug",
		label: "Debug",
		description: "probe: run to the first breakpoint; get stack, locals, evals; stop. start, then continue/step/eval/stop: a live session. Node/TS built in; Python, Go, C/C++/Rust use debugpy, dlv, lldb-dap.",
		promptSnippet: "Breakpoint: stack, locals, values",
		parameters: {
			type: "object",
			properties: {
				operation: { type: "string", enum: DEBUG_OPS },
				program: { type: "string" },
				args: { type: "array", items: { type: "string" } },
				breakpoints: { type: "array", items: { type: "string" }, description: "file:line, or file:line if cond" },
				eval: { type: "array", items: { type: "string" } },
				step: { type: "string", enum: ["over", "in", "out"] },
				lang: { type: "string" },
				timeout: { type: "number" },
			},
		},
	},
};

export default function astLens(pi) {
	let hints = 0;
	// Chosen once per session, so the tool list and the prompt section stay a stable cached prefix.
	const hasSg = !!sgBin();
	const section = systemSection(hasSg);

	let warmed = false;
	pi.on("before_agent_start", async (event, ctx) => {
		hints = 0;
		const cfg = readConfig();
		if (!warmed && cfg.mode !== "off" && cfg.prewarm) {
			warmed = true;
			// Start the main language server while the model reads the prompt: the first lsp call then
			// does not pay the server start. Never blocks the turn; a failure is silent.
			setTimeout(() => prewarm(ctx?.cwd ?? process.cwd(), cfg).catch(() => {}), 0).unref?.();
		}
		const prompt = event?.systemPrompt;
		if (typeof prompt !== "string" || prompt.includes(MARKER) || cfg.mode === "off") return;
		return { systemPrompt: `${prompt}\n\n${section}` };
	});

	pi.on("tool_result", async (event, ctx) => {
		const tool = String(event?.toolName ?? "").toLowerCase();
		if (event?.isError) return;
		const cwd = ctx?.cwd ?? process.cwd();
		if (EDIT_TOOLS.has(tool) || tool === "bash") {
			// Keep the servers in step with the disk, so the next references are not stale.
			const p = event.input?.path ?? event.input?.file_path;
			const changed = EDIT_TOOLS.has(tool) && typeof p === "string" ? [real(path.resolve(cwd, p))] : [];
			eachClient((c) => (changed.length ? c.filesChanged(changed) : c.refresh()));
			if (changed.length) for (const f of changed) indexChanged(f);
			else indexChanged();
			return;
		}
		if (tool !== "grep" || readConfig().mode !== "steer") return;
		const steer = hints < HINTS_PER_PROMPT && grepTargetsCode(event.input);
		const r = await rewriteGrep(event, cwd).catch(() => null);
		if (r?.plainText) return; // a text search: Grep's job, no rewrite and no hint
		const content = r?.content ?? (Array.isArray(event.content) ? event.content : []);
		const verified = r ? r.verified : content.some((c) => c?.type === "text" && VERIFIED_PATH.test(c.text ?? ""));
		if (steer && verified) {
			hints += 1;
			return { content: [...content, { type: "text", text: `\n${HINT}` }] };
		}
		return r?.content ? { content } : undefined;
	});

	pi.on("session_shutdown", async () => {
		await stopDebug();
		await stopAll();
	});

	pi.registerCommand?.("ast-lens", {
		description: "AST Lens: status, or `mode steer|off` for Grep results on code",
		handler: async (args, ctx) => {
			const [sub, value] = String(args ?? "").trim().split(/\s+/);
			const cfg = readConfig();
			if (sub === "mode") {
				if (!MODES.includes(value)) {
					ctx?.ui?.notify?.(`AST Lens mode is ${cfg.mode}. Use: /ast-lens mode steer|off`, "info");
					return;
				}
				writeConfig({ mode: value });
				ctx?.ui?.notify?.(`AST Lens mode: ${value}`, "info");
				return;
			}
			const cwd = ctx?.cwd ?? process.cwd();
			const sg = sgBin(cwd);
			const { ranked } = dominantLang(cwd);
			const seenServers = new Set();
			const lines = [`AST Lens · mode ${cfg.mode} · ast-grep: ${sg ?? `not installed (${installHint(SG_INSTALL)})`}${cfg.maxRssMb ? ` · maxRssMb ${cfg.maxRssMb}` : ""}`];
			for (const [lang] of ranked.slice(0, 6)) {
				const ext = Object.entries(SG_LANGS).find(([, l]) => l === lang)?.[0];
				const spec = serverSpecFor(ext, cfg.servers);
				if (!spec || seenServers.has(spec.name)) continue;
				seenServers.add(spec.name);
				const found = spec.candidates.filter((c) => !c.when || c.when(cwd)).map((c) => ({ c, bin: which(c.cmd, cwd) })).find((x) => x.bin);
				const state = VERIFIED.has(spec.name) ? "verified" : "experimental";
				const faster = found?.c.cmd === "typescript-language-server" ? `; tsgo answers 4–8× faster: ${installHint("npm i -g @typescript/native-preview")}` : "";
				lines.push(`${lang} (${state}): ${found ? `${found.c.cmd} (${found.bin})${faster}` : `no server — install ${spec.candidates[0].cmd}: ${installHint(spec.candidates[0].install)}`}`);
			}
			lines.push(`running servers: ${clients.size}`);
			ctx?.ui?.notify?.(lines.join("\n"), "info");
		},
	});

	if (hasSg) {
		pi.registerTool({
			...TOOLS.ast_grep,
			async execute(_id, params, signal, _onUpdate, ctx) {
				const r = await astGrep(params, ctx, signal);
				return { content: [{ type: "text", text: r.text }], details: r.details ?? {} };
			},
		});
	}

	pi.registerTool({
		...TOOLS.lsp,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const r = await lsp(params, ctx, signal);
			return { content: [{ type: "text", text: r.text }], details: r.details ?? {} };
		},
	});

	pi.registerTool({
		...TOOLS.debug,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const r = await debugTool(params, ctx, signal, { which, spawnBin, spawn, killTree });
			return { content: [{ type: "text", text: r.text }], details: r.details ?? {} };
		},
	});
}

export const _test = { astGrep, lsp, stopAll, systemSection, readConfig, clients, reap, rewriteGrep };
