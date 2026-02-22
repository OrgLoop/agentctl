import fs from "node:fs/promises";
import path from "node:path";

// --- Persisted types ---

export interface SessionRecord {
  id: string;
  adapter: string;
  status:
    | "running"
    | "idle"
    | "stopped"
    | "error"
    | "completed"
    | "failed"
    | "pending";
  startedAt: string; // ISO 8601
  stoppedAt?: string;
  cwd?: string;
  spec?: string;
  model?: string;
  prompt?: string;
  tokens?: { in: number; out: number };
  cost?: number;
  pid?: number;
  exitCode?: number;
  group?: string; // launch group tag, e.g. "g-a1b2c3"
  meta: Record<string, unknown>;
}

export interface Lock {
  directory: string; // absolute, resolved path
  type: "auto" | "manual";
  sessionId?: string; // for auto-locks
  lockedBy?: string; // for manual locks
  reason?: string;
  lockedAt: string; // ISO 8601
}

export interface FuseTimer {
  directory: string; // absolute path of the worktree
  clusterName: string; // e.g. "kindo-charlie-feature-x"
  branch: string; // extracted branch name
  expiresAt: string; // ISO 8601
  sessionId: string; // session that triggered the fuse
}

export interface PersistedState {
  sessions: Record<string, SessionRecord>; // keyed by session ID
  locks: Lock[];
  fuses: FuseTimer[];
  version: number; // schema version
}

const SCHEMA_VERSION = 1;

export class StateManager {
  private state: PersistedState;
  private configDir: string;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(configDir: string, state?: PersistedState) {
    this.configDir = configDir;
    this.state = state || {
      sessions: {},
      locks: [],
      fuses: [],
      version: SCHEMA_VERSION,
    };
  }

  static async load(configDir: string): Promise<StateManager> {
    await fs.mkdir(configDir, { recursive: true });

    const state: PersistedState = {
      sessions: {},
      locks: [],
      fuses: [],
      version: SCHEMA_VERSION,
    };

    // Load state.json
    try {
      const raw = await fs.readFile(
        path.join(configDir, "state.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw);
      if (parsed.sessions) state.sessions = parsed.sessions;
      if (parsed.version) state.version = parsed.version;
    } catch {
      // First run or missing file
    }

    // Load locks.json
    try {
      const raw = await fs.readFile(
        path.join(configDir, "locks.json"),
        "utf-8",
      );
      state.locks = JSON.parse(raw);
    } catch {
      // First run or missing file
    }

    // Load fuses.json
    try {
      const raw = await fs.readFile(
        path.join(configDir, "fuses.json"),
        "utf-8",
      );
      state.fuses = JSON.parse(raw);
    } catch {
      // First run or missing file
    }

    return new StateManager(configDir, state);
  }

  async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    await fs.mkdir(this.configDir, { recursive: true });

    // Atomic writes via write-to-tmp + rename
    await atomicWrite(
      path.join(this.configDir, "state.json"),
      JSON.stringify(
        { sessions: this.state.sessions, version: this.state.version },
        null,
        2,
      ),
    );

    await atomicWrite(
      path.join(this.configDir, "locks.json"),
      JSON.stringify(this.state.locks, null, 2),
    );

    await atomicWrite(
      path.join(this.configDir, "fuses.json"),
      JSON.stringify(this.state.fuses, null, 2),
    );
  }

  markDirty(): void {
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persist().catch((err) =>
          console.error("Failed to persist state:", err),
        );
      }, 1000);
    }
  }

  // --- Session accessors ---

  getSessions(): Record<string, SessionRecord> {
    return this.state.sessions;
  }

  getSession(id: string): SessionRecord | undefined {
    return this.state.sessions[id];
  }

  setSession(id: string, session: SessionRecord): void {
    this.state.sessions[id] = session;
    this.markDirty();
  }

  removeSession(id: string): void {
    delete this.state.sessions[id];
    this.markDirty();
  }

  // --- Lock accessors ---

  getLocks(): Lock[] {
    return [...this.state.locks];
  }

  addLock(lock: Lock): void {
    this.state.locks.push(lock);
    this.markDirty();
  }

  removeLocks(predicate: (lock: Lock) => boolean): void {
    this.state.locks = this.state.locks.filter((l) => !predicate(l));
    this.markDirty();
  }

  // --- Fuse accessors ---

  getFuses(): FuseTimer[] {
    return [...this.state.fuses];
  }

  addFuse(fuse: FuseTimer): void {
    // Remove existing fuse for same directory first
    this.state.fuses = this.state.fuses.filter(
      (f) => f.directory !== fuse.directory,
    );
    this.state.fuses.push(fuse);
    this.markDirty();
  }

  removeFuse(directory: string): void {
    this.state.fuses = this.state.fuses.filter(
      (f) => f.directory !== directory,
    );
    this.markDirty();
  }

  /** Flush pending timer (for clean shutdown) */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, data, "utf-8");
  await fs.rename(tmpPath, filePath);
}
