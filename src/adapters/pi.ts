import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import { watch } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
	AgentAdapter,
	AgentSession,
	LaunchOpts,
	LifecycleEvent,
	ListOpts,
	PeekOpts,
	StopOpts,
} from "../core/types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PI_DIR = path.join(os.homedir(), ".pi");

// Default: only show stopped sessions from the last 7 days
const STOPPED_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PidInfo {
	pid: number;
	cwd: string;
	args: string;
	/** Process start time from `ps -p <pid> -o lstart=`, used to detect PID recycling */
	startTime?: string;
}

/** Metadata persisted by launch() so status checks survive wrapper exit */
export interface LaunchedSessionMeta {
	sessionId: string;
	pid: number;
	/** Process start time from `ps -p <pid> -o lstart=` for PID recycling detection */
	startTime?: string;
	/** The PID of the wrapper (agentctl launch) — may differ from `pid` (pi process) */
	wrapperPid?: number;
	cwd: string;
	model?: string;
	prompt?: string;
	launchedAt: string;
}

export interface PiAdapterOpts {
	piDir?: string; // Override ~/.pi for testing
	sessionsMetaDir?: string; // Override metadata dir for testing
	getPids?: () => Promise<Map<number, PidInfo>>; // Override PID detection for testing
	/** Override PID liveness check for testing (default: process.kill(pid, 0)) */
	isProcessAlive?: (pid: number) => boolean;
}

// --- Pi JSONL entry types ---

interface PiSessionHeader {
	type: "session";
	id: string;
	cwd: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	version?: string;
}

interface PiMessage {
	type: "message";
	id?: string;
	parentId?: string | null;
	role: "user" | "assistant" | "toolResult";
	content: string | Array<{ type: string; text?: string }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: number;
	};
	stopReason?: string;
}

interface PiModelChange {
	type: "model_change";
	modelId: string;
}

type PiJSONLEntry =
	| PiSessionHeader
	| PiMessage
	| PiModelChange
	| { type: string; [key: string]: unknown };

/** Discovered session from filesystem scan */
interface DiscoveredSession {
	sessionId: string;
	filePath: string;
	header: PiSessionHeader;
	created: Date;
	modified: Date;
	cwdSlug: string;
}

/**
 * Pi adapter — reads session data from ~/.pi/agent/sessions/
 * and cross-references with running PIDs. NEVER maintains its own registry.
 *
 * Pi stores sessions as JSONL files in ~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl
 * Each file starts with a type:'session' header line containing metadata.
 */
export class PiAdapter implements AgentAdapter {
	readonly id = "pi";
	private readonly piDir: string;
	private readonly sessionsDir: string;
	private readonly sessionsMetaDir: string;
	private readonly getPids: () => Promise<Map<number, PidInfo>>;
	private readonly isProcessAlive: (pid: number) => boolean;

	constructor(opts?: PiAdapterOpts) {
		this.piDir = opts?.piDir || DEFAULT_PI_DIR;
		this.sessionsDir = path.join(this.piDir, "agent", "sessions");
		this.sessionsMetaDir =
			opts?.sessionsMetaDir ||
			path.join(this.piDir, "agentctl", "sessions");
		this.getPids = opts?.getPids || getPiPids;
		this.isProcessAlive = opts?.isProcessAlive || defaultIsProcessAlive;
	}

	async list(opts?: ListOpts): Promise<AgentSession[]> {
		const runningPids = await this.getPids();
		const discovered = await this.discoverSessions();
		const sessions: AgentSession[] = [];

		for (const disc of discovered) {
			const session = await this.buildSession(disc, runningPids);

			// Filter by status
			if (opts?.status && session.status !== opts.status) continue;

			// If not --all, skip old stopped sessions
			if (!opts?.all && session.status === "stopped") {
				const age = Date.now() - session.startedAt.getTime();
				if (age > STOPPED_SESSION_MAX_AGE_MS) continue;
			}

			// Default: only show running sessions unless --all
			if (
				!opts?.all &&
				!opts?.status &&
				session.status !== "running" &&
				session.status !== "idle"
			) {
				continue;
			}

			sessions.push(session);
		}

		// Sort: running first, then by most recent
		sessions.sort((a, b) => {
			if (a.status === "running" && b.status !== "running") return -1;
			if (b.status === "running" && a.status !== "running") return 1;
			return b.startedAt.getTime() - a.startedAt.getTime();
		});

		return sessions;
	}

	async peek(sessionId: string, opts?: PeekOpts): Promise<string> {
		const lines = opts?.lines ?? 20;
		const disc = await this.findSession(sessionId);
		if (!disc) throw new Error(`Session not found: ${sessionId}`);

		const content = await fs.readFile(disc.filePath, "utf-8");
		const jsonlLines = content.trim().split("\n");

		const assistantMessages: string[] = [];
		for (const line of jsonlLines) {
			try {
				const entry = JSON.parse(line) as PiJSONLEntry;
				if (entry.type === "message") {
					const msg = entry as PiMessage;
					if (msg.role === "assistant" && msg.content) {
						const text = extractContent(msg.content);
						if (text) assistantMessages.push(text);
					}
				}
			} catch {
				// skip malformed lines
			}
		}

		// Take last N messages
		const recent = assistantMessages.slice(-lines);
		return recent.join("\n---\n");
	}

	async status(sessionId: string): Promise<AgentSession> {
		const runningPids = await this.getPids();
		const disc = await this.findSession(sessionId);
		if (!disc) throw new Error(`Session not found: ${sessionId}`);

		return this.buildSession(disc, runningPids);
	}

	async launch(opts: LaunchOpts): Promise<AgentSession> {
		const args = ["-p", opts.prompt];

		if (opts.model) {
			args.unshift("--model", opts.model);
		}

		const env = { ...process.env, ...opts.env };
		const cwd = opts.cwd || process.cwd();

		// Write stdout to a log file so we can extract the session ID
		await fs.mkdir(this.sessionsMetaDir, { recursive: true });
		const logPath = path.join(
			this.sessionsMetaDir,
			`launch-${Date.now()}.log`,
		);
		const logFd = await fs.open(logPath, "w");

		const child = spawn("pi", args, {
			cwd,
			env,
			stdio: ["ignore", logFd.fd, "ignore"],
			detached: true,
		});

		// Fully detach: child runs in its own process group.
		child.unref();

		const pid = child.pid;
		const now = new Date();

		// Close our handle — child keeps its own fd open
		await logFd.close();

		// Try to extract the session ID from the log output.
		// Pi's session header has type: "session" with an id field.
		let resolvedSessionId: string | undefined;
		if (pid) {
			resolvedSessionId = await this.pollForSessionId(logPath, pid, 5000);
		}

		const sessionId =
			resolvedSessionId || (pid ? `pending-${pid}` : crypto.randomUUID());

		// Persist session metadata so status checks work after wrapper exits
		if (pid) {
			await this.writeSessionMeta({
				sessionId,
				pid,
				wrapperPid: process.pid,
				cwd,
				model: opts.model,
				prompt: opts.prompt.slice(0, 200),
				launchedAt: now.toISOString(),
			});
		}

		const session: AgentSession = {
			id: sessionId,
			adapter: this.id,
			status: "running",
			startedAt: now,
			cwd,
			model: opts.model,
			prompt: opts.prompt.slice(0, 200),
			pid,
			meta: {
				adapterOpts: opts.adapterOpts,
				spec: opts.spec,
				logPath,
			},
		};

		return session;
	}

	/**
	 * Poll the launch log file for up to `timeoutMs` to extract the real session ID.
	 * Pi's JSONL output includes a session header with type: "session" and id field.
	 */
	private async pollForSessionId(
		logPath: string,
		pid: number,
		timeoutMs: number,
	): Promise<string | undefined> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const content = await fs.readFile(logPath, "utf-8");
				for (const line of content.split("\n")) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line);
						// Pi session header: type "session" with id
						if (
							msg.type === "session" &&
							msg.id &&
							typeof msg.id === "string"
						) {
							return msg.id;
						}
					} catch {
						// Not valid JSON yet
					}
				}
			} catch {
				// File may not exist yet
			}
			// Check if process is still alive
			try {
				process.kill(pid, 0);
			} catch {
				break; // Process died
			}
			await sleep(200);
		}
		return undefined;
	}

	async stop(sessionId: string, opts?: StopOpts): Promise<void> {
		const pid = await this.findPidForSession(sessionId);
		if (!pid)
			throw new Error(`No running process for session: ${sessionId}`);

		if (opts?.force) {
			// SIGINT first, then SIGKILL after 5s
			process.kill(pid, "SIGINT");
			await sleep(5000);
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already dead — good
			}
		} else {
			process.kill(pid, "SIGTERM");
		}
	}

	async resume(sessionId: string, message: string): Promise<void> {
		// Pi doesn't have a native --continue flag.
		// Launch a new pi session in the same cwd with the continuation message.
		const disc = await this.findSession(sessionId);
		const cwd = disc?.header.cwd || process.cwd();

		const child = spawn("pi", ["-p", message], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});

		child.unref();
	}

	async *events(): AsyncIterable<LifecycleEvent> {
		// Track known sessions to detect transitions
		let knownSessions = new Map<string, AgentSession>();

		// Initial snapshot
		const initial = await this.list({ all: true });
		for (const s of initial) {
			knownSessions.set(s.id, s);
		}

		// Poll + fs.watch hybrid
		const watcher = watch(this.sessionsDir, { recursive: true });

		try {
			while (true) {
				await sleep(5000);

				const current = await this.list({ all: true });
				const currentMap = new Map(current.map((s) => [s.id, s]));

				// Detect new sessions
				for (const [id, session] of currentMap) {
					const prev = knownSessions.get(id);
					if (!prev) {
						yield {
							type: "session.started",
							adapter: this.id,
							sessionId: id,
							session,
							timestamp: new Date(),
						};
					} else if (
						prev.status === "running" &&
						session.status === "stopped"
					) {
						yield {
							type: "session.stopped",
							adapter: this.id,
							sessionId: id,
							session,
							timestamp: new Date(),
						};
					} else if (
						prev.status === "running" &&
						session.status === "idle"
					) {
						yield {
							type: "session.idle",
							adapter: this.id,
							sessionId: id,
							session,
							timestamp: new Date(),
						};
					}
				}

				knownSessions = currentMap;
			}
		} finally {
			watcher.close();
		}
	}

	// --- Private helpers ---

	/**
	 * Scan ~/.pi/agent/sessions/ recursively for .jsonl files and parse headers.
	 * Pi stores sessions at <sessionsDir>/<cwd-slug>/<timestamp>_<id>.jsonl
	 */
	private async discoverSessions(): Promise<DiscoveredSession[]> {
		const results: DiscoveredSession[] = [];

		let cwdSlugs: string[];
		try {
			cwdSlugs = await fs.readdir(this.sessionsDir);
		} catch {
			return [];
		}

		for (const slug of cwdSlugs) {
			const slugDir = path.join(this.sessionsDir, slug);
			const stat = await fs.stat(slugDir).catch(() => null);
			if (!stat?.isDirectory()) continue;

			let files: string[];
			try {
				files = await fs.readdir(slugDir);
			} catch {
				continue;
			}

			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;

				const filePath = path.join(slugDir, file);
				let fileStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
				try {
					fileStat = await fs.stat(filePath);
				} catch {
					continue;
				}

				// Parse session header from first lines
				const header = await this.parseSessionHeader(filePath);
				if (!header) continue;

				// Extract session ID from header or filename
				// Filename format: <timestamp>_<id>.jsonl
				const sessionId =
					header.id || this.extractSessionIdFromFilename(file);
				if (!sessionId) continue;

				results.push({
					sessionId,
					filePath,
					header: { ...header, id: sessionId },
					created: fileStat.birthtime,
					modified: fileStat.mtime,
					cwdSlug: slug,
				});
			}
		}

		return results;
	}

	/** Extract session ID from filename format: <timestamp>_<id>.jsonl */
	private extractSessionIdFromFilename(
		filename: string,
	): string | undefined {
		const base = filename.replace(".jsonl", "");
		const underscoreIdx = base.indexOf("_");
		if (underscoreIdx >= 0) {
			return base.slice(underscoreIdx + 1);
		}
		return base; // fallback: use entire filename as ID
	}

	/** Parse the session header (type:'session') from the first few lines of a JSONL file */
	private async parseSessionHeader(
		filePath: string,
	): Promise<PiSessionHeader | null> {
		try {
			const content = await fs.readFile(filePath, "utf-8");
			for (const line of content.split("\n").slice(0, 10)) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line);
					if (entry.type === "session") {
						return entry as PiSessionHeader;
					}
				} catch {
					// skip malformed line
				}
			}
		} catch {
			// file unreadable
		}
		return null;
	}

	private async buildSession(
		disc: DiscoveredSession,
		runningPids: Map<number, PidInfo>,
	): Promise<AgentSession> {
		const isRunning = await this.isSessionRunning(disc, runningPids);
		const { model, tokens, cost } = await this.parseSessionTail(
			disc.filePath,
			disc.header,
		);

		return {
			id: disc.sessionId,
			adapter: this.id,
			status: isRunning ? "running" : "stopped",
			startedAt: disc.created,
			stoppedAt: isRunning ? undefined : disc.modified,
			cwd: disc.header.cwd,
			model,
			prompt: await this.getFirstPrompt(disc.filePath),
			tokens,
			cost,
			pid: isRunning
				? await this.findMatchingPid(disc, runningPids)
				: undefined,
			meta: {
				provider: disc.header.provider,
				thinkingLevel: disc.header.thinkingLevel,
				version: disc.header.version,
				cwdSlug: disc.cwdSlug,
			},
		};
	}

	private async isSessionRunning(
		disc: DiscoveredSession,
		runningPids: Map<number, PidInfo>,
	): Promise<boolean> {
		const sessionCwd = disc.header.cwd;
		if (!sessionCwd) return false;

		const sessionCreated = disc.created.getTime();

		// 1. Check running PIDs discovered via `ps aux`
		for (const [, info] of runningPids) {
			// Check if the session ID appears in the command args — most reliable match
			if (info.args.includes(disc.sessionId)) {
				if (this.processStartedAfterSession(info, sessionCreated))
					return true;
				// PID recycling: process started before this session existed
				continue;
			}
			// Match by cwd — less specific (multiple sessions share a project)
			if (info.cwd === sessionCwd) {
				if (this.processStartedAfterSession(info, sessionCreated))
					return true;
			}
		}

		// 2. Check persisted session metadata (for detached processes that
		//    may not appear in `ps aux` filtering, e.g. after wrapper exit)
		const meta = await this.readSessionMeta(disc.sessionId);
		if (meta?.pid) {
			// Verify the persisted PID is still alive
			if (this.isProcessAlive(meta.pid)) {
				// Cross-check: if this PID appears in runningPids with a DIFFERENT
				// start time than what we recorded, the PID was recycled.
				const pidInfo = runningPids.get(meta.pid);
				if (pidInfo?.startTime && meta.startTime) {
					const currentStartMs = new Date(
						pidInfo.startTime,
					).getTime();
					const recordedStartMs = new Date(
						meta.startTime,
					).getTime();
					if (
						!Number.isNaN(currentStartMs) &&
						!Number.isNaN(recordedStartMs) &&
						Math.abs(currentStartMs - recordedStartMs) > 5000
					) {
						// Process at this PID has a different start time — recycled
						await this.deleteSessionMeta(disc.sessionId);
						return false;
					}
				}

				// Verify stored start time is consistent with launch time
				if (meta.startTime) {
					const metaStartMs = new Date(meta.startTime).getTime();
					const sessionMs = new Date(meta.launchedAt).getTime();
					if (
						!Number.isNaN(metaStartMs) &&
						metaStartMs >= sessionMs - 5000
					) {
						return true;
					}
					// Start time doesn't match — PID was recycled, clean up stale metadata
					await this.deleteSessionMeta(disc.sessionId);
					return false;
				}
				// No start time in metadata — can't verify, assume alive
				return true;
			}
			// PID is dead — clean up stale metadata
			await this.deleteSessionMeta(disc.sessionId);
		}

		// 3. Fallback: check if JSONL was modified very recently (last 60s)
		try {
			const stat = await fs.stat(disc.filePath);
			const age = Date.now() - stat.mtimeMs;
			if (age < 60_000) {
				for (const [, info] of runningPids) {
					if (
						info.cwd === sessionCwd &&
						this.processStartedAfterSession(info, sessionCreated)
					) {
						return true;
					}
				}
			}
		} catch {
			// file doesn't exist
		}

		return false;
	}

	/**
	 * Check whether a process plausibly belongs to a session by verifying
	 * the process started at or after the session's creation time.
	 * When start time is unavailable, defaults to false (assume no match).
	 */
	private processStartedAfterSession(
		info: PidInfo,
		sessionCreatedMs: number,
	): boolean {
		if (!info.startTime) return false;
		const processStartMs = new Date(info.startTime).getTime();
		if (Number.isNaN(processStartMs)) return false;
		// Allow 5s tolerance for clock skew
		return processStartMs >= sessionCreatedMs - 5000;
	}

	private async findMatchingPid(
		disc: DiscoveredSession,
		runningPids: Map<number, PidInfo>,
	): Promise<number | undefined> {
		const sessionCwd = disc.header.cwd;
		const sessionCreated = disc.created.getTime();

		for (const [pid, info] of runningPids) {
			if (info.args.includes(disc.sessionId)) {
				if (this.processStartedAfterSession(info, sessionCreated))
					return pid;
				continue;
			}
			if (info.cwd === sessionCwd) {
				if (this.processStartedAfterSession(info, sessionCreated))
					return pid;
			}
		}

		// Check persisted metadata for detached processes
		const meta = await this.readSessionMeta(disc.sessionId);
		if (meta?.pid && this.isProcessAlive(meta.pid)) {
			return meta.pid;
		}

		return undefined;
	}

	/** Parse session tail for model, tokens, and cost aggregation */
	private async parseSessionTail(
		filePath: string,
		header: PiSessionHeader,
	): Promise<{
		model?: string;
		tokens?: { in: number; out: number };
		cost?: number;
	}> {
		try {
			const content = await fs.readFile(filePath, "utf-8");
			const lines = content.trim().split("\n");

			let model: string | undefined = header.modelId;
			let totalIn = 0;
			let totalOut = 0;
			let totalCost = 0;

			for (const line of lines) {
				try {
					const entry = JSON.parse(line) as PiJSONLEntry;
					if (entry.type === "message") {
						const msg = entry as PiMessage;
						if (msg.role === "assistant" && msg.usage) {
							totalIn += msg.usage.input || 0;
							totalOut += msg.usage.output || 0;
							totalCost += msg.usage.cost || 0;
						}
					} else if (entry.type === "model_change") {
						model = (entry as PiModelChange).modelId;
					}
				} catch {
					// skip
				}
			}

			return {
				model,
				tokens:
					totalIn || totalOut
						? { in: totalIn, out: totalOut }
						: undefined,
				cost: totalCost || undefined,
			};
		} catch {
			return { model: header.modelId };
		}
	}

	/** Get the first user prompt from a session JSONL file */
	private async getFirstPrompt(
		filePath: string,
	): Promise<string | undefined> {
		try {
			const content = await fs.readFile(filePath, "utf-8");
			for (const line of content.split("\n").slice(0, 20)) {
				try {
					const entry = JSON.parse(line) as PiJSONLEntry;
					if (entry.type === "message") {
						const msg = entry as PiMessage;
						if (msg.role === "user" && msg.content) {
							const text = extractContent(msg.content);
							return text?.slice(0, 200);
						}
					}
				} catch {
					// skip
				}
			}
		} catch {
			// skip
		}
		return undefined;
	}

	/** Find a session by exact or prefix ID match */
	private async findSession(
		sessionId: string,
	): Promise<DiscoveredSession | null> {
		const all = await this.discoverSessions();
		return (
			all.find(
				(d) =>
					d.sessionId === sessionId ||
					d.sessionId.startsWith(sessionId),
			) || null
		);
	}

	private async findPidForSession(
		sessionId: string,
	): Promise<number | null> {
		const session = await this.status(sessionId);
		return session.pid ?? null;
	}

	// --- Session metadata persistence ---

	/** Write session metadata to disk so status checks survive wrapper exit */
	async writeSessionMeta(
		meta: Omit<LaunchedSessionMeta, "startTime">,
	): Promise<void> {
		await fs.mkdir(this.sessionsMetaDir, { recursive: true });

		// Try to capture the process start time immediately
		let startTime: string | undefined;
		try {
			const { stdout } = await execFileAsync("ps", [
				"-p",
				meta.pid.toString(),
				"-o",
				"lstart=",
			]);
			startTime = stdout.trim() || undefined;
		} catch {
			// Process may have already exited or ps failed
		}

		const fullMeta: LaunchedSessionMeta = { ...meta, startTime };
		const metaPath = path.join(
			this.sessionsMetaDir,
			`${meta.sessionId}.json`,
		);
		await fs.writeFile(metaPath, JSON.stringify(fullMeta, null, 2));
	}

	/** Read persisted session metadata */
	async readSessionMeta(
		sessionId: string,
	): Promise<LaunchedSessionMeta | null> {
		// Check exact sessionId first
		const metaPath = path.join(this.sessionsMetaDir, `${sessionId}.json`);
		try {
			const raw = await fs.readFile(metaPath, "utf-8");
			return JSON.parse(raw) as LaunchedSessionMeta;
		} catch {
			// File doesn't exist or is unreadable
		}

		// Scan all metadata files for one whose sessionId matches
		try {
			const files = await fs.readdir(this.sessionsMetaDir);
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				try {
					const raw = await fs.readFile(
						path.join(this.sessionsMetaDir, file),
						"utf-8",
					);
					const m = JSON.parse(raw) as LaunchedSessionMeta;
					if (m.sessionId === sessionId) return m;
				} catch {
					// skip
				}
			}
		} catch {
			// Dir doesn't exist
		}
		return null;
	}

	/** Delete stale session metadata */
	private async deleteSessionMeta(sessionId: string): Promise<void> {
		for (const id of [sessionId, `pending-${sessionId}`]) {
			const metaPath = path.join(this.sessionsMetaDir, `${id}.json`);
			try {
				await fs.unlink(metaPath);
			} catch {
				// File doesn't exist
			}
		}
	}
}

// --- Utility functions ---

/** Check if a process is alive via kill(pid, 0) signal check */
function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Discover running pi processes via `ps aux` */
async function getPiPids(): Promise<Map<number, PidInfo>> {
	const pids = new Map<number, PidInfo>();

	try {
		const { stdout } = await execFileAsync("ps", ["aux"]);

		for (const line of stdout.split("\n")) {
			if (line.includes("grep")) continue;

			// Extract PID (second field) and command (everything after 10th field)
			const fields = line.trim().split(/\s+/);
			if (fields.length < 11) continue;
			const pid = parseInt(fields[1], 10);
			const command = fields.slice(10).join(" ");

			// Match 'pi' command invocations with flags (e.g. "pi -p", "pi --json")
			// Avoid matching other commands that happen to contain "pi"
			if (!command.startsWith("pi -") && !command.startsWith("pi --"))
				continue;
			if (pid === process.pid) continue;

			// Try to extract working directory from lsof
			let cwd = "";
			try {
				const { stdout: lsofOut } = await execFileAsync(
					"/usr/sbin/lsof",
					["-p", pid.toString(), "-Fn"],
				);
				const lsofLines = lsofOut.split("\n");
				for (let i = 0; i < lsofLines.length; i++) {
					if (
						lsofLines[i] === "fcwd" &&
						lsofLines[i + 1]?.startsWith("n")
					) {
						cwd = lsofLines[i + 1].slice(1);
						break;
					}
				}
			} catch {
				// lsof might fail — that's fine
			}

			// Get process start time for PID recycling detection
			let startTime: string | undefined;
			try {
				const { stdout: lstart } = await execFileAsync("ps", [
					"-p",
					pid.toString(),
					"-o",
					"lstart=",
				]);
				startTime = lstart.trim() || undefined;
			} catch {
				// ps might fail — that's fine
			}

			pids.set(pid, { pid, cwd, args: command, startTime });
		}
	} catch {
		// ps failed — return empty
	}

	return pids;
}

/** Extract text content from Pi message content field */
function extractContent(
	content: string | Array<{ type: string; text?: string }>,
): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => b.type === "text" && b.text)
			.map((b) => b.text as string)
			.join("\n");
	}
	return "";
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
