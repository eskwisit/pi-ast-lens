// AST Lens debugger: run a program to a breakpoint and show its stack, locals and expressions.
//
// Node.js and TypeScript (Node strips the types and keeps the lines) use Node's own inspector
// (Chrome DevTools Protocol over a WebSocket): nothing to install. Python, Go and C/C++/Rust/Swift
// use the Debug Adapter Protocol with the adapter on the machine: debugpy, `dlv dap`, lldb-dap.
//
// Every operation that runs the program waits until it stops (breakpoint, step, exception), exits,
// or times out, and answers with one small snapshot. `probe` is a whole session in one call: start,
// run to the first stop, answer, stop. The other operations drive one live session.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";

const RUN_MS = 30000; // default wait for the program to stop
const START_MS = 15000; // wait for the debugger to accept a connection
const FRAMES = 5;
const LOCALS = 20;
const VALUE_MAX = 160;
const OUTPUT_LINES = 20;
const OUTPUT_KEEP = 200;
const SECRET = /pass(word)?|secret|token|api[-_]?key|private[-_]?key|credential/i;
export const DEBUG_OPS = ["probe", "start", "continue", "step", "eval", "stop"];

const NODE_EXTS = new Set(["js", "mjs", "cjs", "ts", "mts", "cts"]);
const LLDB_EXTS = new Set(["", "out", "exe", "bin"]);

/** The debugger for a program: node, python, go or lldb (a built executable). */
export function debugKind(program, lang) {
	const l = String(lang ?? "").toLowerCase();
	if (["node", "javascript", "js", "typescript", "ts"].includes(l)) return "node";
	if (["python", "py"].includes(l)) return "python";
	if (["go", "golang"].includes(l)) return "go";
	if (["c", "cpp", "c++", "rust", "swift", "zig", "lldb", "native"].includes(l)) return "lldb";
	const ext = path.extname(String(program ?? "")).slice(1).toLowerCase();
	if (NODE_EXTS.has(ext)) return "node";
	if (ext === "py") return "python";
	if (ext === "go") return "go";
	if (LLDB_EXTS.has(ext)) return "lldb";
	return null;
}

/** "src/a.ts:12" or "src/a.ts:12 if x > 3" -> { file, line, condition } with file absolute. */
export function parseBreakpoint(spec, cwd) {
	const m = /^(.*?):(\d+)(?:\s+if\s+(.+))?$/.exec(String(spec).trim());
	if (!m) throw new Error(`Breakpoint "${spec}": write file:line, or file:line if condition.`);
	return { file: path.resolve(cwd, m[1]), line: Number(m[2]), condition: m[3]?.trim() || undefined };
}

const clipValue = (s, max = VALUE_MAX) => {
	const t = String(s).replace(/\s+/g, " ");
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const hidden = (name) => SECRET.test(String(name));

/** A frame with its source line and two lines around it, as `  11 | text` with `>` on the current line. */
function sourceAround(file, line) {
	let lines;
	try {
		lines = fs.readFileSync(file, "utf8").split("\n");
	} catch {
		return "";
	}
	const out = [];
	for (let i = Math.max(1, line - 2); i <= Math.min(lines.length, line + 2); i++) out.push(`${i === line ? ">" : " "} ${String(i).padStart(4)} | ${lines[i - 1].replace(/\r$/, "")}`);
	return out.join("\n");
}

/**
 * The snapshot: where it stopped, the code there, the stack, the locals, the evaluated expressions and
 * the end of the output. Short by design: 5 frames, 20 locals of at most 160 characters.
 */
export function formatSnapshot(snap, cwd) {
	let realCwd = cwd;
	try {
		realCwd = fs.realpathSync.native(cwd);
	} catch {}
	const relp = (f) => {
		if (!f) return "?";
		const base = path.isAbsolute(f) && !path.relative(realCwd, f).startsWith("..") ? realCwd : cwd;
		return path.relative(base, f) || f;
	};
	const out = [`[debug · ${snap.kind} · ${snap.state}${snap.reason ? `: ${snap.reason}` : ""}]`];
	// The first line: the stack is shown below.
	if (snap.exception) out.push(`exception: ${clipValue(String(snap.exception).split("\n")[0].replace(/\s+at\s.*$/, ""), 400)}`);
	const top = snap.frames?.[0];
	if (top) {
		out.push(`at ${relp(top.file)}:${top.line}${top.name ? ` in ${top.name}` : ""}`);
		const src = top.file ? sourceAround(top.file, top.line) : "";
		if (src) out.push(src);
		// Runtime and system frames (node:internal, dyld) are noise: show the frames in files on disk.
		const mine = snap.frames.filter((f, i) => i === 0 || (f.file && path.isAbsolute(f.file) && fs.existsSync(f.file))).slice(0, FRAMES);
		if (mine.length > 1) out.push(`stack: ${mine.map((f) => `${f.name || "?"} (${relp(f.file)}:${f.line})`).join(" ← ")}`);
	}
	if (snap.locals?.length) {
		const shown = snap.locals.slice(0, LOCALS).map((v) => `${v.name} = ${hidden(v.name) ? "«hidden»" : clipValue(v.value)}`);
		out.push(`locals: ${shown.join(" · ")}${snap.locals.length > LOCALS ? ` · [${snap.locals.length - LOCALS} more; use eval]` : ""}`);
	}
	for (const e of snap.evals ?? []) out.push(`eval ${e.expression} = ${e.error ? `error: ${clipValue(e.error)}` : clipValue(e.value, 400)}`);
	const lines = (snap.output ?? []).slice(-OUTPUT_LINES);
	if (lines.length) out.push(`output (last ${lines.length} lines):\n${lines.map((l) => `  ${clipValue(l, 200)}`).join("\n")}`);
	if (snap.next) out.push(`[${snap.next}]`);
	return out.join("\n");
}

// A minimal WebSocket client is not needed: Node 22+ and Electron have a global WebSocket.

/** A regex source that matches a file as a path or a file URL (ES modules percent-encode, e.g. spaces). */
export function urlPattern(file) {
	const q = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const segs = file.split(/[\\/]/).map((seg) => {
		if (/^[a-z]:$/i.test(seg)) return `[${seg[0].toLowerCase()}${seg[0].toUpperCase()}]:`; // a Windows drive, either case
		const enc = encodeURIComponent(seg).replace(/%3A/gi, ":");
		return enc === seg ? q(seg) : `(?:${q(seg)}|${q(enc)})`;
	});
	return `^(?:file://)?/?${segs.join("[\\\\/]")}$`;
}

/** Node's inspector (Chrome DevTools Protocol). */
class NodeSession {
	constructor(h, o) {
		Object.assign(this, { h, o, kind: "node", output: [], seq: 0, pending: new Map(), waiters: new Set(), scripts: new Map() });
	}

	async start() {
		if (typeof WebSocket !== "function") throw new Error("Debugging Node needs a runtime with WebSocket (Node 22 or later).");
		const node = this.h.which("node", this.o.cwd);
		const file = node ?? process.execPath;
		const major = node ? Number(String(spawnSync(node, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5000 }).stdout).split(".")[0]) : Number(process.versions.node.split(".")[0]);
		const ts = /\.(c|m)?ts$/i.test(this.o.program);
		if (ts && major && major < 22) throw new Error(`Node ${major} cannot run TypeScript. Use Node 22.6 or later, or debug the compiled .js file.`);
		const flags = ["--inspect-brk=127.0.0.1:0", ...(ts && major < 23 ? ["--experimental-strip-types"] : []), ...(ts ? ["--enable-source-maps"] : [])];
		this.child = this.h.spawn(file, [...flags, this.o.program, ...this.o.args], { cwd: this.o.cwd, env: { ...process.env, ...(node ? {} : { ELECTRON_RUN_AS_NODE: "1" }) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
		const wsUrl = await new Promise((resolve, reject) => {
			let err = "";
			const timer = setTimeout(() => reject(new Error(`The inspector did not start within ${START_MS / 1000}s.${err ? `\n${err.slice(-800)}` : ""}`)), START_MS);
			this.child.stderr.on("data", (b) => {
				const t = String(b);
				err += t;
				const m = /ws:\/\/[^\s]+/.exec(err);
				if (m) (clearTimeout(timer), resolve(m[0]));
				if (!/Debugger (listening|attached)|For help, see|Waiting for the debugger/.test(t)) this.addOutput(t);
			});
			this.child.on("exit", (code) => (clearTimeout(timer), reject(new Error(`The program exited (code ${code}) before the debugger connected.\n${err.slice(-800)}`))));
		});
		this.child.stdout.on("data", (b) => this.addOutput(String(b)));
		this.child.on("exit", (code) => ((this.exitCode = code ?? 0), this.wake()));
		this.ws = new WebSocket(wsUrl);
		await new Promise((resolve, reject) => {
			this.ws.onopen = resolve;
			this.ws.onerror = () => reject(new Error("Could not connect to the Node inspector."));
		});
		this.ws.onmessage = (ev) => this.onMessage(JSON.parse(String(ev.data)));
		this.ws.onclose = () => ((this.closed = true), this.wake());
		await this.send("Runtime.enable");
		await this.send("Debugger.enable");
		await this.send("Debugger.setPauseOnExceptions", { state: "uncaught" });
		for (const bp of this.o.breakpoints) {
			// Node names scripts by their real path (macOS: /var is /private/var): match both.
			let realFile = bp.file;
			try {
				realFile = fs.realpathSync.native(bp.file);
			} catch {}
			const urlRegex = realFile === bp.file ? urlPattern(bp.file) : `(?:${urlPattern(bp.file)})|(?:${urlPattern(realFile)})`;
			await this.send("Debugger.setBreakpointByUrl", { urlRegex, lineNumber: bp.line - 1, ...(bp.condition ? { condition: bp.condition } : {}) });
		}
		this.paused = null;
		await this.send("Runtime.runIfWaitingForDebugger");
		// --inspect-brk stops before the first line: go on to the first breakpoint.
		const first = await this.waitStop(START_MS);
		if (first?.reason === "Break on start" || first?.reason === "other" && !this.o.breakpoints.some((b) => b.file === first.file && b.line === first.line)) {
			if (this.o.stopOnEntry) return;
			this.paused = null;
			await this.send("Debugger.resume").catch(() => {});
		}
	}

	addOutput(t) {
		for (const l of t.replace(/\r/g, "").split("\n")) if (l.trim()) this.output.push(l);
		if (this.output.length > OUTPUT_KEEP) this.output.splice(0, this.output.length - OUTPUT_KEEP);
	}

	send(method, params = {}) {
		if (this.closed) return Promise.reject(new Error("The debug session has ended."));
		const id = ++this.seq;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	onMessage(m) {
		if (m.id && this.pending.has(m.id)) {
			const p = this.pending.get(m.id);
			this.pending.delete(m.id);
			if (m.error) p.reject(new Error(m.error.message));
			else p.resolve(m.result);
			return;
		}
		if (m.method === "Debugger.scriptParsed") this.scripts.set(m.params.scriptId, m.params.url);
		else if (m.method === "Debugger.paused") {
			const f = m.params.callFrames[0];
			this.paused = { ...m.params, file: this.fileOf(f?.url || this.scripts.get(f?.location.scriptId)), line: (f?.location.lineNumber ?? 0) + 1 };
			this.wake();
		} else if (m.method === "Debugger.resumed") this.paused = null;
		else if (m.method === "Runtime.executionContextDestroyed") ((this.ended = true), this.wake());
	}

	fileOf(u) {
		if (!u) return "";
		try {
			return u.startsWith("file:") ? url.fileURLToPath(u) : u;
		} catch {
			return u;
		}
	}

	wake() {
		for (const w of this.waiters) w();
	}

	/** Waits for a pause, the end of the program, or the timeout. */
	waitStop(ms) {
		return new Promise((resolve) => {
			const done = () => {
				if (!(this.paused || this.ended || this.closed || this.exitCode !== undefined)) return;
				clearTimeout(timer);
				this.waiters.delete(done);
				resolve(this.paused);
			};
			const timer = setTimeout(() => (this.waiters.delete(done), resolve(null)), ms);
			this.waiters.add(done);
			done();
		});
	}

	async resume(how) {
		const method = { continue: "Debugger.resume", over: "Debugger.stepOver", in: "Debugger.stepInto", out: "Debugger.stepOut" }[how];
		this.paused = null;
		await this.send(method);
	}

	async value(o) {
		if (!o) return "undefined";
		if (o.type === "string") return JSON.stringify(o.value);
		if (o.unserializableValue) return o.unserializableValue;
		if ("value" in o && o.type !== "object") return String(o.value);
		if (o.subtype === "null") return "null";
		if (o.preview?.properties) {
			const p = o.preview;
			const items = p.properties.map((x) => (p.subtype === "array" ? x.value : `${x.name}: ${x.type === "string" ? JSON.stringify(x.value) : x.value}`));
			const body = items.join(", ") + (p.overflow ? ", …" : "");
			return p.subtype === "array" ? `${o.description}[${body}]` : `${o.className && o.className !== "Object" ? `${o.className} ` : ""}{${body}}`;
		}
		return o.description ?? o.type;
	}

	async snapshot(evals = []) {
		const p = this.paused;
		const snap = { kind: "node (inspector)", output: this.output };
		if (!p) {
			const done = this.ended || this.closed || this.exitCode !== undefined;
			return { ...snap, state: done ? `exited${this.exitCode !== undefined ? ` with code ${this.exitCode}` : ""}` : "running" };
		}
		const frames = p.callFrames.slice(0, FRAMES * 2).map((f) => ({ name: f.functionName || "(anonymous)", file: this.fileOf(f.url || this.scripts.get(f.location.scriptId)), line: f.location.lineNumber + 1 }));
		const locals = [];
		for (const sc of p.callFrames[0]?.scopeChain ?? []) {
			if (!["local", "block", "catch"].includes(sc.type) || locals.length >= LOCALS * 2) continue;
			const r = await this.send("Runtime.getProperties", { objectId: sc.object.objectId, ownProperties: true, generatePreview: true }).catch(() => null);
			for (const prop of r?.result ?? []) if (prop.value && !locals.some((l) => l.name === prop.name)) locals.push({ name: prop.name, value: await this.value(prop.value) });
		}
		const out = [];
		for (const expression of evals) {
			const r = await this.send("Debugger.evaluateOnCallFrame", { callFrameId: p.callFrames[0].callFrameId, expression, generatePreview: true, timeout: 2000 }).catch((e) => ({ error: e }));
			if (r.error || r.exceptionDetails) out.push({ expression, error: r.error?.message ?? r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text });
			else out.push({ expression, value: await this.value(r.result) });
		}
		const reason = { other: "breakpoint", exception: "exception", promiseRejection: "unhandled rejection", "Break on start": "entry" }[p.reason] ?? p.reason;
		const exception = p.reason === "exception" || p.reason === "promiseRejection" ? p.data?.description ?? p.data?.value : undefined;
		return { ...snap, state: "paused", reason, exception, frames, locals, evals: out };
	}

	async stop() {
		try {
			this.ws?.close();
		} catch {}
		this.h.killTree(this.child);
	}
}

/** Content-Length framed JSON messages (DAP), as in LSP. */
function* frames(state, chunk) {
	state.buf = Buffer.concat([state.buf, chunk]);
	for (;;) {
		const end = state.buf.indexOf("\r\n\r\n");
		if (end < 0) return;
		const m = /Content-Length:\s*(\d+)/i.exec(state.buf.slice(0, end).toString("ascii"));
		if (!m) return void (state.buf = state.buf.slice(end + 4));
		const len = Number(m[1]);
		if (state.buf.length < end + 4 + len) return;
		const body = state.buf.slice(end + 4, end + 4 + len).toString("utf8");
		state.buf = state.buf.slice(end + 4 + len);
		try {
			yield JSON.parse(body);
		} catch {}
	}
}

/** The debug adapter for a kind on this machine: { cmd, args, tcp?, adapterID, launch(o) } or an error with install hints. */
export function findAdapter(kind, h, cwd) {
	if (kind === "python") {
		for (const py of ["python3", "python", "py"]) {
			const bin = h.which(py, cwd);
			if (!bin) continue;
			const ok = spawnSync(bin, ["-c", "import debugpy"], { timeout: 10000, windowsHide: true }).status === 0;
			if (ok) return { cmd: bin, args: ["-m", "debugpy.adapter"], adapterID: "debugpy", launch: (o) => ({ type: "python", request: "launch", program: o.program, args: o.args, cwd: o.cwd, console: "internalConsole", justMyCode: true, stopOnEntry: !!o.stopOnEntry }) };
		}
		throw new Error("Python debugging needs debugpy: pip install debugpy");
	}
	if (kind === "go") {
		const bin = h.which("dlv", cwd);
		if (!bin) throw new Error("Go debugging needs Delve: go install github.com/go-delve/delve/cmd/dlv@latest");
		return { cmd: bin, args: ["dap", "--listen", "127.0.0.1:0"], tcp: /listening at:?\s*(?:\[?([\d.:a-f]+?)\]?):(\d+)/i, adapterID: "go", launch: (o) => ({ request: "launch", mode: "debug", program: o.program, args: o.args, cwd: o.cwd, stopOnEntry: !!o.stopOnEntry }) };
	}
	if (kind === "lldb") {
		let bin = h.which("lldb-dap", cwd) ?? h.which("lldb-vscode", cwd);
		if (!bin && process.platform === "darwin") {
			const r = spawnSync("xcrun", ["-f", "lldb-dap"], { encoding: "utf8", timeout: 10000 });
			if (r.status === 0 && r.stdout.trim()) bin = r.stdout.trim();
		}
		if (!bin) throw new Error(`Native debugging needs lldb-dap (LLVM): ${process.platform === "darwin" ? "xcode-select --install" : process.platform === "win32" ? "winget install LLVM.LLVM" : "apt install lldb (or your distribution's lldb package)"}`);
		return { cmd: bin, args: [], adapterID: "lldb-dap", launch: (o) => ({ request: "launch", program: o.program, args: o.args, cwd: o.cwd, stopOnEntry: !!o.stopOnEntry }) };
	}
	throw new Error(`No debugger for ${kind}.`);
}

/** A Debug Adapter Protocol session (debugpy, dlv, lldb-dap). */
class DapSession {
	constructor(h, o, adapter, kind) {
		Object.assign(this, { h, o, adapter, kind, output: [], seq: 0, pending: new Map(), waiters: new Set(), state: { buf: Buffer.alloc(0) } });
	}

	async start() {
		const a = this.adapter;
		this.child = this.h.spawnBin(a.cmd, a.args, this.o.cwd, ["pipe", "pipe", "pipe"]);
		let err = "";
		this.child.stderr.on("data", (b) => (err = (err + b).slice(-4000)));
		this.child.on("exit", () => ((this.closed = true), this.wake()));
		if (a.tcp) {
			const port = await new Promise((resolve, reject) => {
				let text = "";
				const timer = setTimeout(() => reject(new Error(`${path.basename(a.cmd)} did not listen within ${START_MS / 1000}s.\n${(text + err).slice(-800)}`)), START_MS);
				const look = (b) => {
					text += b;
					const m = a.tcp.exec(text);
					if (m) (clearTimeout(timer), resolve(Number(m[2])));
				};
				this.child.stdout.on("data", look);
				this.child.stderr.on("data", look);
			});
			this.sock = net.connect(port, "127.0.0.1");
			await new Promise((resolve, reject) => (this.sock.once("connect", resolve), this.sock.once("error", reject)));
			this.sock.on("data", (b) => this.onData(b));
			this.sock.on("close", () => ((this.closed = true), this.wake()));
			this.write = (s) => this.sock.write(s);
		} else {
			this.child.stdout.on("data", (b) => this.onData(b));
			this.write = (s) => this.child.stdin.write(s);
		}
		this.caps = await this.request("initialize", { clientID: "ast-lens", adapterID: a.adapterID, linesStartAt1: true, columnsStartAt1: true, pathFormat: "path", supportsRunInTerminalRequest: false, supportsVariableType: true, supportsStartDebuggingRequest: false }, START_MS);
		const initialized = new Promise((resolve) => (this.onInitialized = resolve));
		// Some adapters answer launch only after configurationDone: send it, configure, then wait for the answer.
		const launched = this.request("launch", a.launch(this.o), RUN_MS);
		launched.catch(() => {});
		await Promise.race([initialized, launched]);
		const byFile = new Map();
		for (const bp of this.o.breakpoints) byFile.set(bp.file, [...(byFile.get(bp.file) ?? []), bp]);
		for (const [file, bps] of byFile) await this.request("setBreakpoints", { source: { path: file }, breakpoints: bps.map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) })) });
		const filters = (this.caps?.exceptionBreakpointFilters ?? []).map((f) => f.filter).filter((f) => /uncaught|panic|cpp_throw|swift_throw/i.test(f));
		if (this.caps?.exceptionBreakpointFilters) await this.request("setExceptionBreakpoints", { filters }).catch(() => {});
		if (this.caps?.supportsConfigurationDoneRequest !== false) await this.request("configurationDone").catch(() => {});
		await launched;
	}

	onData(b) {
		for (const m of frames(this.state, b)) this.onMessage(m);
	}

	send(m) {
		const body = Buffer.from(JSON.stringify(m), "utf8");
		this.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
	}

	request(command, args = {}, ms = 10000) {
		if (this.closed) return Promise.reject(new Error("The debug session has ended."));
		const seq = ++this.seq;
		this.send({ seq, type: "request", command, arguments: args });
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => (this.pending.delete(seq), reject(new Error(`${command} timed out`))), ms);
			this.pending.set(seq, { resolve, reject, timer });
		});
	}

	onMessage(m) {
		if (m.type === "response") {
			const p = this.pending.get(m.request_seq);
			if (!p) return;
			this.pending.delete(m.request_seq);
			clearTimeout(p.timer);
			if (m.success) p.resolve(m.body ?? {});
			else p.reject(new Error(m.message || m.body?.error?.format || `${m.command} failed`));
		} else if (m.type === "event") {
			const e = m.event;
			if (e === "initialized") this.onInitialized?.();
			else if (e === "stopped") ((this.stopped = m.body ?? {}), this.wake());
			else if (e === "continued") this.stopped = null;
			else if (e === "exited") ((this.exitCode = m.body?.exitCode), this.wake());
			else if (e === "terminated") ((this.ended = true), this.wake());
			else if (e === "output" && m.body?.category !== "telemetry") {
				for (const l of String(m.body?.output ?? "").replace(/\r/g, "").split("\n")) if (l.trim()) this.output.push(l);
				if (this.output.length > OUTPUT_KEEP) this.output.splice(0, this.output.length - OUTPUT_KEEP);
			}
		} else if (m.type === "request") {
			// Reverse requests (runInTerminal, startDebugging): not supported, say so.
			this.send({ seq: ++this.seq, type: "response", request_seq: m.seq, command: m.command, success: false, message: "not supported" });
		}
	}

	wake() {
		for (const w of this.waiters) w();
	}

	waitStop(ms) {
		return new Promise((resolve) => {
			const done = () => {
				if (!(this.stopped || this.ended || this.closed || this.exitCode !== undefined)) return;
				clearTimeout(timer);
				this.waiters.delete(done);
				resolve(this.stopped);
			};
			const timer = setTimeout(() => (this.waiters.delete(done), resolve(null)), ms);
			this.waiters.add(done);
			done();
		});
	}

	async resume(how) {
		const threadId = this.stopped?.threadId ?? 1;
		const command = { continue: "continue", over: "next", in: "stepIn", out: "stepOut" }[how];
		this.stopped = null;
		await this.request(command, { threadId });
	}

	async snapshot(evals = []) {
		const snap = { kind: this.adapter.adapterID, output: this.output };
		if (!this.stopped) {
			const done = this.ended || this.closed || this.exitCode !== undefined;
			return { ...snap, state: done ? `exited${this.exitCode !== undefined ? ` with code ${this.exitCode}` : ""}` : "running" };
		}
		let threadId = this.stopped.threadId;
		if (threadId === undefined) threadId = (await this.request("threads").catch(() => ({}))).threads?.[0]?.id ?? 1;
		const st = await this.request("stackTrace", { threadId, startFrame: 0, levels: FRAMES * 2 }).catch(() => ({ stackFrames: [] }));
		const frames = (st.stackFrames ?? []).map((f) => ({ id: f.id, name: f.name, file: f.source?.path ?? f.source?.name ?? "", line: f.line }));
		const locals = [];
		if (frames[0]) {
			const sc = await this.request("scopes", { frameId: frames[0].id }).catch(() => ({ scopes: [] }));
			for (const s of (sc.scopes ?? []).filter((x) => !x.expensive).slice(0, 2)) {
				const v = await this.request("variables", { variablesReference: s.variablesReference, start: 0, count: LOCALS * 2 }).catch(() => ({ variables: [] }));
				for (const x of v.variables ?? []) if (!/^(special|function) variables$/i.test(x.name) && !locals.some((l) => l.name === x.name)) locals.push({ name: x.name, value: x.value });
			}
		}
		const out = [];
		for (const expression of evals) {
			const r = await this.request("evaluate", { expression, frameId: frames[0]?.id, context: "repl" }).catch((e) => ({ error: e.message }));
			out.push(r.error ? { expression, error: r.error } : { expression, value: r.result });
		}
		let exception;
		if (this.stopped.reason === "exception") {
			const info = this.caps?.supportsExceptionInfoRequest ? await this.request("exceptionInfo", { threadId }).catch(() => null) : null;
			exception = info ? `${info.exceptionId ?? ""} ${info.description ?? ""}`.trim() : this.stopped.text ?? this.stopped.description;
		}
		return { ...snap, state: "paused", reason: this.stopped.reason, exception, frames, locals, evals: out };
	}

	async stop() {
		await this.request("disconnect", { terminateDebuggee: true }, 2000).catch(() => {});
		try {
			this.sock?.destroy();
		} catch {}
		this.h.killTree(this.child);
	}
}

let session = null; // one live session

export async function stopDebug() {
	const s = session;
	session = null;
	await s?.stop().catch(() => {});
}

/**
 * The debug tool. h: { which, spawnBin, spawn, killTree } from the extension.
 * probe and start need `program` and usually `breakpoints`.
 */
export async function debugTool(params, ctx, signal, h) {
	const cwd = path.resolve(ctx?.cwd ?? process.cwd(), String(params?.cwd ?? "."));
	const op = String(params?.operation ?? "probe").toLowerCase();
	if (!DEBUG_OPS.includes(op)) throw new Error(`operation must be one of: ${DEBUG_OPS.join(", ")}`);
	const timeout = Math.min(300000, Math.max(1000, Number(params?.timeout) * 1000 || RUN_MS));
	const evals = (Array.isArray(params?.eval) ? params.eval : params?.eval ? [params.eval] : []).concat(params?.expression ? [params.expression] : []).map(String);
	const show = async (s, next) => {
		const snap = await s.snapshot(evals);
		const live = snap.state === "paused" || snap.state === "running";
		return { text: formatSnapshot({ ...snap, next: next ?? (live ? "session open: debug continue, step, eval or stop" : "the program ended; the session is closed") }, cwd), details: { state: snap.state } };
	};
	if (op === "probe" || op === "start") {
		const program = String(params?.program ?? "").trim();
		if (!program) throw new Error("Give `program`: the file to run (a .js/.ts/.py/.go file, or a built executable).");
		const kind = debugKind(program, params?.lang);
		if (!kind) throw new Error(`Cannot tell the language of ${program}; pass lang (node, python, go, c, rust…).`);
		const o = {
			cwd,
			program: path.resolve(cwd, program),
			args: (Array.isArray(params?.args) ? params.args : []).map(String),
			breakpoints: (Array.isArray(params?.breakpoints) ? params.breakpoints : params?.breakpoints ? [params.breakpoints] : []).map((b) => parseBreakpoint(b, cwd)),
			stopOnEntry: params?.stopOnEntry === true,
		};
		if (!fs.existsSync(o.program)) throw new Error(`No such program: ${program}`);
		await stopDebug();
		const s = kind === "node" ? new NodeSession(h, o) : new DapSession(h, o, findAdapter(kind, h, cwd), kind);
		const abort = () => s.stop();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await s.start();
			await s.waitStop(timeout);
			if (op === "probe") {
				const ended = !(s.paused ?? s.stopped);
				const r = await show(s, ended && o.breakpoints.length ? "no breakpoint was hit; the program ended" : "probe done; the program was stopped");
				await s.stop();
				return r;
			}
			session = s;
			return await show(s);
		} catch (e) {
			await s.stop();
			throw e;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}
	if (!session) throw new Error("No debug session. Start one with operation start (or use probe for one answer).");
	const s = session;
	if (op === "stop") {
		const snap = await s.snapshot([]);
		await stopDebug();
		return { text: formatSnapshot({ ...snap, state: "stopped", frames: [], locals: [], next: "session closed" }, cwd), details: { state: "stopped" } };
	}
	if (op === "eval") {
		if (!evals.length) throw new Error("eval needs `expression`.");
		return show(s);
	}
	const how = op === "continue" ? "continue" : ["in", "out"].includes(params?.step) ? params.step : "over";
	const paused = s.paused ?? s.stopped;
	if (paused) await s.resume(how);
	await s.waitStop(timeout);
	const r = await show(s);
	if (!/paused|running/.test(r.details.state)) await stopDebug();
	return r;
}
