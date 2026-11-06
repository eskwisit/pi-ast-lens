// Code Compass: the agent reads code as syntax (ast-grep) and symbols (LSP) instead of grepping text.
//
//   ast_grep  structural search (and optional rewrite) with ast-grep; the language comes from the
//             file extension, the globs, or the most common code language under the path
//   lsp       definition, references, hover, implementation, type definition, symbols, workspace
//             symbols and diagnostics; the language server is picked by the file extension and kept
//             running per project root until it is idle
//   steering  a system prompt section tells the agent which tool to use; a Grep call that looks for
//             code gets a one-line hint (mode "steer"), is blocked (mode "strict"), or is left alone
//             (mode "off"). Set it with /code-compass mode <steer|strict|off>.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const MARKER = "<!-- code-compass -->";
const OUTPUT_LIMIT = 40000;
const LINE_LIMIT = 220;
const SG_TIMEOUT_MS = 60000;
const LSP_REQUEST_MS = 30000;
const REFS_BUDGET_MS = 40000; // references across projects: stop and report what was not checked
const CANDIDATE_FILES_MAX = 300;
const CANDIDATE_BYTES_MAX = 64 * 1024 * 1024;
const LSP_START_MS = 45000;
const LSP_IDLE_MS = 10 * 60 * 1000;
const DIAG_WAIT_MS = 8000;
const DIAG_SETTLE_MS = 400;
const READY_MAX_MS = 30000; // wait for a fresh server's startup work at most this long after it started
const READY_OPEN_MS = 600; // pause after opening a file in a young server
const READY_QUIET_MS = 250; // no progress for this long counts as idle
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
const MODES = ["steer", "strict", "off"];
const CONFIG_FILE = process.platform === "win32"
	? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "code-compass", "config.json")
	: path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "code-compass", "config.json");
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
			{ cmd: "tsgo", args: ["--lsp", "--stdio"], when: (root) => tsMajor(root) === 0 || tsMajor(root) >= 7, install: "npm i -g @typescript/native-preview" },
			{ cmd: "typescript-language-server", args: ["--stdio"], when: (root) => tsMajor(root) < 7, install: "npm i -g typescript typescript-language-server" },
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
		return { ...base, candidates: [{ cmd: o[0], args: o.slice(1), install: "from your Code Compass config" }] };
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
	if (IS_WIN || env.CODE_COMPASS_NO_SHELL_PATH) return shellPathCache;
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

const clipLine = (s) => {
	const t = String(s ?? "").replace(/\s+$/, "");
	return t.length > LINE_LIMIT ? `${t.slice(0, LINE_LIMIT)}…` : t;
};

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

export function readConfig(file = CONFIG_FILE) {
	try {
		const c = JSON.parse(fs.readFileSync(file, "utf8"));
		return {
			mode: MODES.includes(c?.mode) ? c.mode : "steer",
			servers: c?.servers && typeof c.servers === "object" ? c.servers : {},
		};
	} catch {
		return { mode: "steer", servers: {} };
	}
}

function writeConfig(cfg, file = CONFIG_FILE) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, "\t")}\n`);
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
	if (!/^id\s*:/m.test(y)) y = `id: code-compass-query\n${y}`;
	return y;
}

function runCollect(bin, args, cwd, signal, max) {
	return new Promise((resolve) => {
		const child = spawnBin(bin, args, cwd, ["ignore", "pipe", "pipe"]);
		const items = [];
		let buf = "";
		let err = "";
		let more = false;
		let timedOut = false;
		const stop = () => killTree(child);
		const timer = setTimeout(() => ((timedOut = true), stop()), SG_TIMEOUT_MS);
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

/** One line per match: path:line:col: source line, plus captured metavariables. */
export function formatSgMatches(items, cwd, { rewrite } = {}) {
	const lines = [];
	for (const m of items) {
		const file = rel(cwd, path.resolve(cwd, m.file ?? ""));
		const ln = (m.range?.start?.line ?? 0) + 1;
		const col = (m.range?.start?.column ?? 0) + 1;
		const src = String(m.lines ?? m.text ?? "").split("\n");
		lines.push(`${file}:${ln}:${col}: ${clipLine(src[0])}${src.length > 1 ? `  [+${src.length - 1} lines]` : ""}`);
		const vars = Object.entries(m.metaVariables?.single ?? {}).map(([k, v]) => `$${k}=${clipLine(v.text).slice(0, 60)}`);
		for (const [k, vs] of Object.entries(m.metaVariables?.multi ?? {})) {
			const t = (vs ?? []).map((v) => v.text).filter((t) => t !== ",").join(", ");
			vars.push(`$$$${k}=[${clipLine(t).slice(0, 80)}]`);
		}
		if (vars.length) lines.push(`    ${vars.join("  ")}`);
		if (rewrite && typeof m.replacement === "string") {
			lines.push(`    - ${clipLine(m.text.split("\n")[0])}`);
			lines.push(`    + ${clipLine(m.replacement.split("\n")[0])}${m.replacement.includes("\n") ? "  […]" : ""}`);
		}
	}
	return lines.join("\n");
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
	const max = Math.min(Math.max(Number(params?.max) || 80, 1), 500);
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
		return { text: `${head}\n${clip(r.out || "No matches; nothing changed.")}`, details: { lang, applied: true } };
	}

	const r = await runCollect(bin, [...args, "--json=stream", ...targets], cwd, signal, max);
	if (r.aborted) throw new Error("Stopped.");
	if (r.timedOut) throw new Error(`ast-grep did not finish in ${SG_TIMEOUT_MS / 1000}s; narrow the path or globs.`);
	if (r.code !== 0 && r.code !== 1 && !r.more) throw new Error(`ast-grep failed (exit ${r.code}):\n${clip(r.err, 4000)}`);
	if (!r.items.length) {
		const tip = r.err ? `\n${clip(r.err, 2000)}` : "\nCheck the pattern parses as valid code in that language, or try a `rule` with `kind:`.";
		return { text: `${head}\nNo matches.${tip}`, details: { lang, matches: 0 } };
	}
	const body = formatSgMatches(r.items, cwd, { rewrite: rewrite !== undefined });
	const files = new Set(r.items.map((m) => m.file)).size;
	const foot = r.more
		? `\n[first ${max} matches shown; raise max or narrow the path]`
		: `\n[${r.items.length} match${r.items.length === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}]`;
	const note = rewrite !== undefined ? "\n[preview only: call again with apply: true to write the rewrite]" : "";
	return { text: clip(`${head}\n${body}${foot}${note}`), details: { lang, matches: r.items.length, more: r.more } };
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
				clientInfo: { name: "code-compass" },
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
			if (kind === "begin") this.progress.add(msg.params.token);
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
		const uri = toUri(file);
		const cur = this.open.get(uri);
		if (!cur) {
			this.open.set(uri, { version: 1, text });
			this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.spec.id(extOf(file)), version: 1, text } });
			return { uri, text, changed: true };
		}
		if (cur.text !== text) {
			cur.version += 1;
			cur.text = text;
			this.notify("textDocument/didChange", { textDocument: { uri, version: cur.version }, contentChanges: [{ text }] });
			return { uri, text, changed: true };
		}
		return { uri, text, changed: false };
	}

	/**
	 * Waits while the server reports work in progress (project load, indexing), at most READY_MAX_MS
	 * after it started. A file just opened in a young server gets a short pause to be analysed.
	 */
	async ready(justOpened, signal) {
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

const clients = new Map(); // `${root}\0${cmd}` -> Promise<LspClient>
let reaper;

function startReaper() {
	if (reaper) return;
	reaper = setInterval(async () => {
		for (const [key, p] of clients) {
			const c = await p.catch(() => null);
			if (!c || c.dead || Date.now() - c.lastUse > LSP_IDLE_MS) {
				clients.delete(key);
				c?.stop();
			}
		}
	}, 60000);
	reaper.unref?.();
}

async function stopAll() {
	const all = [...clients.values()];
	clients.clear();
	await Promise.all(all.map((p) => p.then((c) => c.stop()).catch(() => {})));
}

process.once?.("exit", () => {
	for (const p of clients.values()) p.then((c) => killTree(c.child)).catch(() => {});
});

/** The running (or a new) language server for file. Throws with install hints when none is installed. */
async function clientFor(file, cwd, cfg) {
	const ext = extOf(file);
	const spec = serverSpecFor(ext, cfg.servers);
	if (!spec) throw new Error(`Code Compass has no language server for .${ext || "(no extension)"} files. Use ast_grep or Grep, or add one to ${CONFIG_FILE} as "servers": { "${ext}": ["command", "--stdio"] }.`);
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
			return c;
		}
		clients.delete(key);
	}
	p = (async () => {
		const c = new LspClient({ spec, cand, bin, root });
		await c.start();
		return c;
	})();
	clients.set(key, p);
	startReaper();
	try {
		return await p;
	} catch (e) {
		clients.delete(key);
		throw e;
	}
}

export const SYMBOL_KINDS = [
	"", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
	"enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array",
	"object", "key", "null", "enum member", "struct", "event", "operator", "type parameter",
];
const SEVERITY = ["", "error", "warning", "info", "hint"];

/** 0-based LSP position of `symbol` (word match) near `line` (1-based), or of line/column as given. */
export function locate(text, { line, column, symbol }) {
	const lines = text.split("\n");
	const name = typeof symbol === "string" ? symbol.trim() : "";
	if (name) {
		const re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
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

function lineOf(cache, file, n) {
	if (!cache.has(file)) {
		try {
			cache.set(file, fs.readFileSync(file, "utf8").split("\n"));
		} catch {
			cache.set(file, []);
		}
	}
	return clipLine((cache.get(file)[n] ?? "").trim());
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

function formatLocations(locs, cwd, limit = 200) {
	const cache = new Map();
	const seen = new Set();
	const out = [];
	for (const l of locs) {
		const k = `${l.file}:${l.line}:${l.character}`;
		if (seen.has(k)) continue;
		seen.add(k);
		if (out.length >= limit) {
			out.push(`[${locs.length - limit} more not shown]`);
			break;
		}
		out.push(`${rel(cwd, l.file)}:${l.line + 1}:${l.character + 1}: ${lineOf(cache, l.file, l.line)}`);
	}
	return out.join("\n");
}

export function hoverText(res) {
	const c = res?.contents;
	const one = (x) => (typeof x === "string" ? x : x?.language ? `\`\`\`${x.language}\n${x.value}\n\`\`\`` : x?.value ?? "");
	return (Array.isArray(c) ? c.map(one).join("\n\n") : one(c)).trim();
}

export function formatSymbols(res, cwd) {
	if (!Array.isArray(res) || !res.length) return "";
	const out = [];
	if (res[0].location) {
		const cache = new Map();
		for (const s of res.slice(0, 300)) {
			const f = fromUri(s.location.uri);
			const ln = s.location.range.start.line;
			out.push(`${rel(cwd, f)}:${ln + 1}: ${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.containerName ? `${s.containerName}.` : ""}${s.name}  ${lineOf(cache, f, ln).slice(0, 100)}`);
		}
		if (res.length > 300) out.push(`[${res.length - 300} more]`);
		return out.join("\n");
	}
	const walk = (list, depth) => {
		for (const s of list) {
			if (out.length >= 400) return;
			const a = s.selectionRange?.start ?? s.range?.start;
			const b = s.range?.end;
			out.push(`${"  ".repeat(depth)}${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.name}${s.detail ? ` ${clipLine(s.detail).slice(0, 80)}` : ""}  L${(a?.line ?? 0) + 1}${b ? `-${b.line + 1}` : ""}`);
			if (Array.isArray(s.children)) walk(s.children, depth + 1);
		}
	};
	walk(res, 0);
	return out.join("\n");
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

const LSP_OPS = ["definition", "references", "hover", "implementation", "type_definition", "symbols", "workspace_symbols", "diagnostics"];
const POSITION_OPS = new Set(["definition", "references", "hover", "implementation", "type_definition"]);

/** A code file to start the workspace-symbol server from: the given one, or one of the given lang. */
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
	if (!found) throw new Error("workspace_symbols needs a `file` (any file of the language) or `lang`.");
	return found;
}

const IDENT = /^[\w$]{2,}$/;
const wordRe = (name, flags = "") => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`, flags);

/** Files under root with one of exts that contain name as a whole word (bounded walk). */
export function candidateFiles(root, name, exts, except) {
	if (!IDENT.test(String(name))) return [];
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

/**
 * References over every project, for servers that answer only from the projects they have loaded
 * (tsserver: what it has loaded depends on what was asked before). For each file that has the name
 * and no known location yet, it finds an occurrence whose definition is the same declaration, asks
 * references there and merges the answers. Same-named other symbols are skipped. Stops after
 * REFS_BUDGET_MS and reports how many files it did not check.
 */
async function referencesAcrossProjects(client, name, start, base, includeDeclaration, signal) {
	const deadline = Date.now() + REFS_BUDGET_MS;
	const key = (l) => `${pathKey(l.file)}:${l.line}:${l.character}`;
	const ask = (method, uri, position) =>
		client
			.request(method, { textDocument: { uri }, position, ...(method.endsWith("references") ? { context: { includeDeclaration } } : {}) }, LSP_REQUEST_MS, signal)
			.then(normLocations, () => []);
	const target = (await ask("textDocument/definition", start.uri, start.position))[0];
	if (!target) return { locations: base, unchecked: 0 };
	const merged = new Map(base.map((l) => [key(l), l]));
	const covered = () => new Set([...merged.values()].map((l) => pathKey(l.file)));
	let done = covered();
	const files = candidateFiles(client.root, name, client.spec.exts, start.file);
	let unchecked = 0;
	for (const [n, f] of files.entries()) {
		if (signal?.aborted || Date.now() > deadline) {
			unchecked = files.slice(n).filter((x) => !done.has(pathKey(x))).length;
			break;
		}
		// A file with a known location is covered: references list every use in a file of that program.
		if (done.has(pathKey(f))) continue;
		const { uri, text } = client.sync(f);
		const lines = text.split("\n");
		let tries = 0;
		search: for (let i = 0; i < lines.length; i++) {
			for (const m of lines[i].matchAll(wordRe(name, "g"))) {
				// A few occurrences per file: a name in a comment or string has no definition.
				if (tries++ >= 3) break search;
				const position = { line: i, character: m.index };
				if (!(await ask("textDocument/definition", uri, position)).some((l) => key(l) === key(target))) continue;
				for (const l of await ask("textDocument/references", uri, position)) merged.set(key(l), l);
				done = covered();
				break search;
			}
		}
	}
	return { locations: [...merged.values()], unchecked };
}

async function lsp(params, ctx, signal) {
	const cwd = real(ctx?.cwd ?? process.cwd());
	const op = String(params?.operation ?? "").toLowerCase();
	if (!LSP_OPS.includes(op)) throw new Error(`operation must be one of: ${LSP_OPS.join(", ")}`);
	const cfg = readConfig();
	const file = real(op === "workspace_symbols" ? anchorFile(cwd, params) : path.resolve(cwd, String(params?.file ?? "")));
	if (!params?.file && op !== "workspace_symbols") throw new Error("Give `file`.");
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`No such file: ${rel(cwd, file)}`);
	const client = await clientFor(file, cwd, cfg);
	const head = `[lsp · ${client.cand.cmd} · ${client.spec.name}]`;
	const since = Date.now();
	const { uri, text, changed } = client.sync(file);
	await client.ready(changed, signal);
	const ask = (method, p) => client.request(method, p, LSP_REQUEST_MS, signal);
	// Fresh servers often answer empty while they index; retry a few times then.
	const askWarm = async (method, p, empty) => {
		let res = await ask(method, p);
		for (let i = 0; i < 4 && empty(res) && Date.now() - client.startedAt < 60000; i++) {
			await new Promise((r) => setTimeout(r, 1500));
			res = await ask(method, p);
		}
		return res;
	};
	const isEmpty = (r) => r == null || (Array.isArray(r) && r.length === 0);

	if (POSITION_OPS.has(op)) {
		const pos = locate(text, { line: Number(params?.line), column: Number(params?.column), symbol: params?.symbol });
		const at = `${rel(cwd, file)}:${pos.line + 1}:${pos.character + 1}`;
		const tdp = { textDocument: { uri }, position: pos };
		if (op === "hover") {
			const res = await askWarm("textDocument/hover", tdp, (r) => !hoverText(r));
			const t = hoverText(res);
			return { text: `${head} hover ${at}\n${t ? clip(t, 8000) : "No hover information."}` };
		}
		const method = { definition: "textDocument/definition", references: "textDocument/references", implementation: "textDocument/implementation", type_definition: "textDocument/typeDefinition" }[op];
		const p = op === "references" ? { ...tdp, context: { includeDeclaration: params?.includeDeclaration !== false } } : tdp;
		let locs = normLocations(await askWarm(method, p, isEmpty));
		let partial = "";
		if (client.spec.crossProject && op === "references") {
			const name = params?.symbol || (text.split("\n")[pos.line].slice(pos.character).match(/^[\w$]+/) ?? [""])[0];
			if (IDENT.test(name)) {
				const r = await referencesAcrossProjects(client, name, { file, uri, position: pos }, locs, params?.includeDeclaration !== false, signal);
				locs = r.locations;
				if (r.unchecked) partial = `\n[search stopped after ${REFS_BUDGET_MS / 1000}s: ${r.unchecked} file${r.unchecked === 1 ? "" : "s"} with the name not checked; narrow with ast_grep or Grep]`;
			}
		}
		if (!locs.length) return { text: `${head} ${op} ${at}\nNo results. Check the position is on the symbol name; for text use Grep.` };
		const files = new Set(locs.map((l) => l.file)).size;
		return { text: clip(`${head} ${op} ${at}\n${formatLocations(locs, cwd)}\n[${locs.length} location${locs.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}]${partial}`), details: { count: locs.length, partial: !!partial } };
	}
	if (op === "symbols") {
		const res = await askWarm("textDocument/documentSymbol", { textDocument: { uri } }, isEmpty);
		const t = formatSymbols(res, cwd);
		return { text: clip(`${head} symbols ${rel(cwd, file)}\n${t || "No symbols."}`) };
	}
	if (op === "workspace_symbols") {
		const query = String(params?.query ?? params?.symbol ?? "");
		if (!query) throw new Error("workspace_symbols needs `query`.");
		const res = await askWarm("workspace/symbol", { query }, isEmpty);
		// Project files first, then dependencies and SDKs.
		const outside = (s) => (s.location?.uri && !isInside(cwd, fromUri(s.location.uri)) ? 1 : 0);
		const sorted = Array.isArray(res) ? res.map((s, i) => [s, i]).sort((a, b) => outside(a[0]) - outside(b[0]) || a[1] - b[1]).map(([s]) => s) : res;
		const t = formatSymbols(sorted, cwd);
		return { text: clip(`${head} workspace_symbols "${query}"\n${t || "No symbols."}`) };
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
	const shape = CODE_WORDS.test(bare) && /[A-Za-z_$][\w$]*\s*(\\?\(|<|:|\{|\b)/.test(bare) && !/["'`]/.test(bare);
	const call = /^[A-Za-z_$][\w$.]*\s*\\?\($/.test(bare) || /^[A-Za-z_$][\w$.]*\\\(/.test(bare);
	return identifier || shape || call;
}

const HINT =
	"Code Compass: Grep matched text (comments and strings too). For this symbol, call lsp with operation definition or references on a file:line from these results; for a code shape, call ast_grep with a pattern.";

function systemSection(mode, sg) {
	const sgLine = sg
		? "- `ast_grep`: find code by its shape. A pattern is code with metavariables: `$X` one node, `$$$ARGS` any number. Example: `fetch($URL, $$$)`, `class $C extends Base { $$$ }`. The language comes from the file extension. Add `rewrite` to preview a structural edit, and `apply: true` to write it."
		: `- \`ast_grep\` is not usable: ast-grep is not installed (${installHint(SG_INSTALL)}). Tell the user once when a structural search would help.`;
	return `${MARKER}
## Code Compass: read code as code

Code Compass parses code with ast-grep and language servers. Prefer them to Grep for code:
- \`lsp\`: what a symbol is and where it is used. Operations: definition, references, hover, implementation, type_definition, symbols (outline of one file), workspace_symbols (find a symbol by name), diagnostics. Give \`file\` and \`line\` with \`symbol\` (the name on that line); the language server is chosen by the file extension.
${sgLine}
- Grep: only for plain text — comments, strings, log messages, docs, config — or when the tools above report the language is not supported.
- Find a symbol by name with workspace_symbols, or with ast_grep, then follow it with definition and references. Read only the lines these tools return.${mode === "strict" ? "\n- Strict mode: Grep calls that search code for an identifier or a code shape are blocked." : ""}
`;
}

// Extension
// =========

export default function codeCompass(pi) {
	let hints = 0;

	pi.on("before_agent_start", async (event, ctx) => {
		hints = 0;
		const prompt = event?.systemPrompt;
		const cfg = readConfig();
		if (typeof prompt !== "string" || prompt.includes(MARKER) || cfg.mode === "off") return;
		return { systemPrompt: `${prompt}\n\n${systemSection(cfg.mode, !!sgBin(ctx?.cwd))}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (String(event?.toolName).toLowerCase() !== "grep") return;
		const cfg = readConfig();
		if (cfg.mode !== "strict" || !grepTargetsCode(event.input)) return;
		if (!sgBin(ctx?.cwd)) return;
		return {
			block: true,
			reason: `Code Compass (strict): this Grep searches code for "${String(event.input?.pattern).slice(0, 80)}". Use lsp (workspace_symbols, then definition / references) or ast_grep with a pattern. Grep is for plain text: comments, strings, docs, config.`,
		};
	});

	pi.on("tool_result", async (event) => {
		if (String(event?.toolName).toLowerCase() !== "grep" || event.isError) return;
		if (hints >= HINTS_PER_PROMPT || readConfig().mode !== "steer" || !grepTargetsCode(event.input)) return;
		hints += 1;
		const content = [...(Array.isArray(event.content) ? event.content : []), { type: "text", text: `\n${HINT}` }];
		return { content };
	});

	pi.on("session_shutdown", async () => {
		await stopAll();
	});

	pi.registerCommand?.("code-compass", {
		description: "Code Compass: status, or `mode steer|strict|off` for how Grep on code is handled",
		handler: async (args, ctx) => {
			const [sub, value] = String(args ?? "").trim().split(/\s+/);
			const cfg = readConfig();
			if (sub === "mode") {
				if (!MODES.includes(value)) {
					ctx?.ui?.notify?.(`Code Compass mode is ${cfg.mode}. Use: /code-compass mode steer|strict|off`, "info");
					return;
				}
				writeConfig({ ...cfg, mode: value });
				ctx?.ui?.notify?.(`Code Compass mode: ${value}`, "info");
				return;
			}
			const cwd = ctx?.cwd ?? process.cwd();
			const sg = sgBin(cwd);
			const { ranked } = dominantLang(cwd);
			const seenServers = new Set();
			const lines = [`Code Compass · mode ${cfg.mode} · ast-grep: ${sg ?? "not installed"}`];
			for (const [lang] of ranked.slice(0, 6)) {
				const ext = Object.entries(SG_LANGS).find(([, l]) => l === lang)?.[0];
				const spec = serverSpecFor(ext, cfg.servers);
				if (!spec || seenServers.has(spec.name)) continue;
				seenServers.add(spec.name);
				const found = spec.candidates.map((c) => ({ c, bin: which(c.cmd, cwd) })).find((x) => x.bin);
				lines.push(`${lang}: ${found ? `${found.c.cmd} (${found.bin})` : `no server — install ${spec.candidates[0].cmd}: ${installHint(spec.candidates[0].install)}`}`);
			}
			lines.push(`running servers: ${clients.size}`);
			ctx?.ui?.notify?.(lines.join("\n"), "info");
		},
	});

	pi.registerTool({
		name: "ast_grep",
		label: "ast-grep",
		description:
			"Structural code search with ast-grep: matches syntax, not text, so comments, strings and formatting never cause false hits. The language is inferred from the file extension (or globs, or the most common code language under the path); pass lang to override. Pattern = code with metavariables: $X matches one node, $$$ any number. Optional rewrite previews a structural replacement; apply: true writes it.",
		promptSnippet: "Structural code search/rewrite with ast-grep (language from file extension)",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Code pattern, e.g. `console.log($$$)`, `def $F($$$): $$$`, `$A == null`" },
				rule: { type: "string", description: "Instead of pattern: an ast-grep YAML rule (body or full rule), e.g. `kind: function_declaration\\nhas:\\n  pattern: await $X\\n  stopBy: end`" },
				path: { type: "string", description: "File or directory to search; default the project root" },
				lang: { type: "string", description: "Override the inferred language (typescript, tsx, javascript, python, go, rust, java, c, cpp, …)" },
				globs: { type: "array", items: { type: "string" }, description: "Include/exclude globs, e.g. [\"src/**\", \"!**/*.test.ts\"]" },
				selector: { type: "string", description: "Node kind to pick inside the pattern, for patterns that need context" },
				strictness: { type: "string", enum: ["cst", "smart", "ast", "relaxed", "signature", "template"], description: "Match strictness; default smart" },
				rewrite: { type: "string", description: "Replacement using the same metavariables, e.g. `logger.debug($$$)`" },
				apply: { type: "boolean", description: "With rewrite (or a rule with fix): write the changes to the files. Default false (preview)" },
				max: { type: "number", description: "Maximum matches to return; default 80, up to 500" },
			},
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			const r = await astGrep(params, ctx, signal);
			return { content: [{ type: "text", text: r.text }], details: r.details ?? {} };
		},
	});

	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description:
			"Ask the language server for the file's language (chosen by file extension; started on first use and kept running): definition, references, hover (type and docs), implementation, type_definition, symbols (outline of a file), workspace_symbols (find symbols by name), diagnostics (errors and warnings). Point at a symbol with file + line + symbol (its name on that line), or file + line + column (1-based).",
		promptSnippet: "Go to definition / find references / hover / symbols / diagnostics via the language server for the file's extension",
		parameters: {
			type: "object",
			properties: {
				operation: { type: "string", enum: LSP_OPS, description: "What to ask" },
				file: { type: "string", description: "File path; its extension picks the language server" },
				line: { type: "number", description: "1-based line of the symbol" },
				symbol: { type: "string", description: "The symbol's name on that line (preferred over column)" },
				column: { type: "number", description: "1-based column, when symbol is not given" },
				query: { type: "string", description: "workspace_symbols: name or part of a name" },
				lang: { type: "string", description: "workspace_symbols without file: the language to ask (default: the project's main language)" },
				includeDeclaration: { type: "boolean", description: "references: include the declaration; default true" },
			},
			required: ["operation"],
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			const r = await lsp(params, ctx, signal);
			return { content: [{ type: "text", text: r.text }], details: r.details ?? {} };
		},
	});
}

export const _test = { astGrep, lsp, stopAll, systemSection, readConfig };
