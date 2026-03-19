/**
 * OpenCode Acontext Plugin
 *
 * Skill memory for OpenCode agents — captures conversations, extracts tasks,
 * distills reusable skills, and makes them available via tools and system prompt.
 *
 * Features:
 * - Auto-capture: stores each conversation turn to an Acontext session
 * - Skill sync: downloads learned skills from Learning Space
 * - Auto-learn: triggers Learning Space skill distillation after sessions
 * - 3 tools: acontext_search_skills, acontext_session_history, acontext_learn_now
 * - System prompt injection: injects relevant skills via experimental.chat.system.transform
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================================================
// Types
// ============================================================================

export type AcontextConfig = {
  apiKey: string;
  baseUrl: string;
  userId: string;
  learningSpaceId?: string;
  skillsDir: string;
  autoCapture: boolean;
  autoLearn: boolean;
  minTurnsForLearn: number;
};

interface AcontextClientLike {
  sessions: {
    list(options?: Record<string, unknown>): Promise<{ items: Array<{ id: string; created_at?: string }>; has_more: boolean }>;
    create(options?: Record<string, unknown>): Promise<{ id: string }>;
    storeMessage(sessionId: string, blob: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ id: string }>;
    flush(sessionId: string): Promise<{ status: number; errmsg: string }>;
    getSessionSummary(sessionId: string, options?: Record<string, unknown>): Promise<string>;
  };
  learningSpaces: {
    list(options?: Record<string, unknown>): Promise<{ items: Array<{ id: string }>; has_more: boolean }>;
    create(options?: Record<string, unknown>): Promise<{ id: string }>;
    listSkills(spaceId: string): Promise<Array<{
      id: string;
      name: string;
      description: string;
      disk_id: string;
      file_index?: Array<{ path: string; mime: string }>;
      updated_at: string;
    }>>;
    learn(options: { spaceId: string; sessionId: string }): Promise<{ id: string }>;
  };
  skills: {
    getFile(options: { skillId: string; filePath: string; expire?: number }): Promise<{ content?: { type: string; raw: string } | null; url?: string | null }>;
  };
  artifacts: {
    grepArtifacts(diskId: string, options: { query: string; limit?: number }): Promise<Array<{ path: string; filename: string }>>;
  };
}

// ============================================================================
// Config Parsing (exported for testing)
// ============================================================================

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    if (envValue === "") {
      throw new Error(`Environment variable ${envVar} is set but empty`);
    }
    return envValue;
  });
}

const ALLOWED_KEYS = [
  "apiKey",
  "baseUrl",
  "userIdentifier",
  "userId",
  "learningSpaceId",
  "skillsDir",
  "autoCapture",
  "autoLearn",
  "minTurnsForLearn",
];

export function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

/**
 * Resolve the Acontext config directory.
 * Priority: ACONTEXT_CONFIG_DIR env var > ~/.acontext
 */
function getAcontextConfigDir(): string {
  return process.env.ACONTEXT_CONFIG_DIR || path.join(os.homedir(), ".acontext");
}

/**
 * Read credentials.json and return the default project's API key.
 */
function loadApiKeyFromCredentials(): string | undefined {
  try {
    const filePath = path.join(getAcontextConfigDir(), "credentials.json");
    const data = JSON.parse(fsSync.readFileSync(filePath, "utf-8")) as {
      default_project?: string;
      keys?: Record<string, string>;
    };
    if (data.default_project && data.keys?.[data.default_project]) {
      return data.keys[data.default_project];
    }
  } catch {
    // File doesn't exist or is invalid — silently fall through
  }
  return undefined;
}

/**
 * Read auth.json and return the user's email.
 */
function loadUserIdFromAuth(): string | undefined {
  try {
    const filePath = path.join(getAcontextConfigDir(), "auth.json");
    const data = JSON.parse(fsSync.readFileSync(filePath, "utf-8")) as {
      user?: { email?: string };
    };
    if (data.user?.email) {
      return data.user.email;
    }
  } catch {
    // File doesn't exist or is invalid — silently fall through
  }
  return undefined;
}

export const configSchema = {
  parse(value: unknown): AcontextConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("acontext plugin config required");
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_KEYS, "acontext config");

    // Resolve apiKey: ~/.acontext/credentials.json > config/env var
    let resolvedApiKey: string | undefined;
    resolvedApiKey = loadApiKeyFromCredentials();
    if (!resolvedApiKey && typeof cfg.apiKey === "string" && cfg.apiKey) {
      try {
        resolvedApiKey = resolveEnvVars(cfg.apiKey).trim() || undefined;
      } catch {
        // Env var resolution failed — fall through
      }
    }
    if (!resolvedApiKey) {
      throw new Error(
        'ACONTEXT_API_KEY is required. Run "acontext login" to configure ~/.acontext/credentials.json, or set apiKey in plugin config.',
      );
    }

    // Resolve userIdentifier: plugin config (userIdentifier > userId) > auth.json > "default"
    const userIdentifier =
      (typeof cfg.userIdentifier === "string" && cfg.userIdentifier ? cfg.userIdentifier : undefined) ||
      (typeof cfg.userId === "string" && cfg.userId ? cfg.userId : undefined);
    const userId = userIdentifier || loadUserIdFromAuth() || "opencode";

    return {
      apiKey: resolvedApiKey,
      baseUrl:
        typeof cfg.baseUrl === "string" && cfg.baseUrl
          ? resolveEnvVars(cfg.baseUrl)
          : "https://api.acontext.app/api/v1",
      userId,
      learningSpaceId:
        typeof cfg.learningSpaceId === "string"
          ? cfg.learningSpaceId
          : undefined,
      skillsDir:
        typeof cfg.skillsDir === "string" && cfg.skillsDir
          ? cfg.skillsDir
          : path.join(os.homedir(), ".opencode", "skills"),
      autoCapture: cfg.autoCapture !== false,
      autoLearn: cfg.autoLearn !== false,
      minTurnsForLearn:
        typeof cfg.minTurnsForLearn === "number" ? cfg.minTurnsForLearn : 4,
    };
  },
};

// ============================================================================
// Acontext Client Wrapper
// ============================================================================

export interface BridgeLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export type LearnResult =
  | { status: "learned"; id: string }
  | { status: "skipped" }
  | { status: "error" };

type SkillMeta = {
  id: string;
  name: string;
  description: string;
  diskId: string;
  fileIndex: Array<{ path: string; mime: string }>;
  updatedAt: string;
};

interface SkillManifest {
  syncedAt: number;
  skills: SkillMeta[];
}

/**
 * Sanitize a skill name for use as a directory name.
 * Replaces non-alphanumeric characters (except hyphens/underscores) with hyphens.
 * Throws if the result is empty to prevent operating on the skills root directory.
 */
export function sanitizeSkillName(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw new Error(`Cannot sanitize skill name to valid directory name: "${name}"`);
  }
  return sanitized;
}

/**
 * Write a file atomically: write to a .tmp sibling then rename into place.
 * Prevents corruption if the process crashes mid-write.
 */
let atomicWriteCounter = 0;
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + `.tmp.${process.pid}.${Date.now()}.${atomicWriteCounter++}`;
  await fs.writeFile(tmpPath, data, "utf-8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// ============================================================================
// Message Normalization (OpenCode → OpenAI Chat Completions)
// ============================================================================

type ContentBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  [key: string]: unknown;
};

type AgentMessage = {
  role: string;
  content?: string | ContentBlock[] | null;
  [key: string]: unknown;
};

type OpenAIMessage = {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

/**
 * Convert OpenCode messages to standard OpenAI Chat Completions format.
 *
 * - Extracts only { role, content } and converts non-standard roles/structures
 * - Drops thinking blocks, extra fields (api, model, usage, timestamp, etc.)
 * - Skips empty assistant messages and unknown roles
 */
export function normalizeMessages(
  messages: Record<string, unknown>[],
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    const role = msg.role as string | undefined;
    if (!role) continue;

    if (role === "user") {
      const normalized = normalizeUserMessage(msg as AgentMessage);
      if (normalized) result.push(normalized);
    } else if (role === "assistant") {
      const normalized = normalizeAssistantMessage(msg as AgentMessage);
      if (normalized) result.push(normalized);
    } else if (role === "tool") {
      const normalized = normalizeToolMessage(msg as AgentMessage);
      if (normalized) result.push(normalized);
    } else if (role === "toolResult") {
      const normalized = normalizeToolResultMessage(msg as AgentMessage);
      if (normalized) result.push(normalized);
    }
    // Unknown roles are silently skipped
  }

  return result;
}

function normalizeUserMessage(msg: AgentMessage): OpenAIMessage | null {
  const content = extractTextContent(msg.content);
  if (content === null || content === undefined) return null;
  return { role: "user", content };
}

function normalizeAssistantMessage(msg: AgentMessage): OpenAIMessage | null {
  // content undefined/null → skip
  if (msg.content === undefined || msg.content === null) return null;

  if (typeof msg.content === "string") {
    if (!msg.content) return null;
    return { role: "assistant", content: msg.content };
  }

  if (!Array.isArray(msg.content)) return null;

  // Extract text and tool_calls from content blocks
  const textParts: string[] = [];
  const toolCalls: OpenAIMessage["tool_calls"] = [];

  for (const block of msg.content as ContentBlock[]) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block.type === "toolCall" || block.type === "toolUse" || block.type === "tool_use" || block.type === "functionCall") {
      const callId = (block.id ?? "") as string;
      const fnName = (block.name ?? "") as string;
      if (!callId || !fnName) continue;
      const args = block.arguments ?? block.input;
      toolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: fnName,
          arguments:
            typeof args === "string"
              ? args
              : JSON.stringify(args ?? {}),
        },
      });
    }
    // thinking blocks and other types are silently ignored
  }

  // Empty array with no text and no tool_calls → skip
  if (textParts.length === 0 && toolCalls.length === 0) return null;

  const normalized: OpenAIMessage = { role: "assistant" };
  normalized.content = textParts.length > 0 ? textParts.join("\n") : null;
  if (toolCalls.length > 0) normalized.tool_calls = toolCalls;
  return normalized;
}

function normalizeToolMessage(msg: AgentMessage): OpenAIMessage | null {
  const raw = msg as Record<string, unknown>;
  const toolCallId = raw.tool_call_id as string | undefined;
  if (!toolCallId) return null;
  const content = extractTextContent(msg.content);
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: content ?? "",
  };
}

function normalizeToolResultMessage(msg: AgentMessage): OpenAIMessage | null {
  const raw = msg as Record<string, unknown>;
  const toolCallId = (raw.toolCallId ?? raw.toolUseId) as string | undefined;
  if (!toolCallId) return null;
  const content = extractTextContent(msg.content);
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: content ?? "",
  };
}

function extractTextContent(
  content: string | ContentBlock[] | null | undefined,
): string | null {
  if (content === undefined || content === null) return null;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const texts = (content as ContentBlock[])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!);
  return texts.length > 0 ? texts.join("\n") : null;
}

export class AcontextBridge {
  private client: AcontextClientLike | null = null;
  private initPromise: Promise<void> | null = null;
  private sessionMap = new Map<string, string>();
  private sessionPromises = new Map<string, Promise<string>>();
  private learningSpaceId: string | null = null;
  private learningSpacePromise: Promise<string> | null = null;
  private logger: BridgeLogger;
  private dataDir: string;
  private skillsDir: string;

  private skillsMetadata: SkillMeta[] | null = null;
  private skillsSynced = false;
  private syncInProgress: Promise<SkillMeta[]> | null = null;
  private learnedSessions = new Set<string>();
  private learnedSessionsLoaded = false;
  private learnedSessionsLoadPromise: Promise<void> | null = null;
  private sentMessages = new Map<string, Map<string, string>>();
  private sentMessagesLoaded = false;
  private sentMessagesLoadPromise: Promise<void> | null = null;
  private static MANIFEST_STALE_MS = 30 * 60 * 1000; // 30 minutes
  static MAX_SENT_SESSIONS = 100;
  static MAX_LEARNED_SESSIONS = 500;

  constructor(private readonly cfg: AcontextConfig, dataDir: string, skillsDir: string, logger?: BridgeLogger) {
    this.dataDir = dataDir;
    this.skillsDir = skillsDir;
    this.logger = logger ?? { info: () => {}, warn: () => {} };
    if (cfg.learningSpaceId) {
      this.learningSpaceId = cfg.learningSpaceId;
    }
  }

  private manifestPath(): string {
    return path.join(this.dataDir, ".manifest.json");
  }

  private learnedSessionsPath(): string {
    return path.join(this.dataDir, ".learned-sessions.json");
  }

  private async loadLearnedSessions(): Promise<void> {
    try {
      const raw = await fs.readFile(this.learnedSessionsPath(), "utf-8");
      const ids = JSON.parse(raw) as string[];
      for (const id of ids) this.learnedSessions.add(id);
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        this.logger.warn(`acontext: failed to load learned-sessions state: ${String(err)}`);
      }
    }
  }

  private async persistLearnedSessions(): Promise<void> {
    // Evict oldest entries if over cap
    if (this.learnedSessions.size > AcontextBridge.MAX_LEARNED_SESSIONS) {
      const arr = [...this.learnedSessions];
      const toKeep = arr.slice(arr.length - AcontextBridge.MAX_LEARNED_SESSIONS);
      this.learnedSessions = new Set(toKeep);
    }
    await fs.mkdir(this.dataDir, { recursive: true });
    await atomicWriteFile(
      this.learnedSessionsPath(),
      JSON.stringify([...this.learnedSessions]),
    );
  }

  private sentMessagesPath(): string {
    return path.join(this.dataDir, ".sent-messages.json");
  }

  private async loadSentMessages(): Promise<void> {
    try {
      const raw = await fs.readFile(this.sentMessagesPath(), "utf-8");
      const data = JSON.parse(raw) as Record<string, Record<string, string>>;
      for (const [sessionId, hashes] of Object.entries(data)) {
        this.sentMessages.set(sessionId, new Map(Object.entries(hashes)));
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        this.logger.warn(`acontext: failed to load sent-messages state: ${String(err)}`);
      }
    }
  }

  private async persistSentMessages(): Promise<void> {
    // Evict oldest sessions if over cap (Map preserves insertion order)
    if (this.sentMessages.size > AcontextBridge.MAX_SENT_SESSIONS) {
      const keys = [...this.sentMessages.keys()];
      const toRemove = keys.slice(0, keys.length - AcontextBridge.MAX_SENT_SESSIONS);
      for (const key of toRemove) {
        this.sentMessages.delete(key);
      }
    }
    await fs.mkdir(this.dataDir, { recursive: true });
    const data: Record<string, Record<string, string>> = {};
    for (const [sessionId, hashes] of this.sentMessages) {
      data[sessionId] = Object.fromEntries(hashes);
    }
    await atomicWriteFile(this.sentMessagesPath(), JSON.stringify(data));
  }

  static computeMessageHash(index: number, blob: Record<string, unknown>): string {
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify({ i: index, r: blob.role, c: blob.content }))
      .digest("hex")
      .slice(0, 16);
    return `${index}:${hash}`;
  }

  private skillDir(skillName: string): string {
    return path.join(this.skillsDir, sanitizeSkillName(skillName));
  }

  private async readManifest(): Promise<SkillManifest | null> {
    try {
      const raw = await fs.readFile(this.manifestPath(), "utf-8");
      return JSON.parse(raw) as SkillManifest;
    } catch {
      return null;
    }
  }

  private async writeManifest(skills: SkillMeta[]): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const manifest: SkillManifest = { syncedAt: Date.now(), skills };
    await atomicWriteFile(this.manifestPath(), JSON.stringify(manifest));
  }

  /**
   * Download .md files for a single skill to the local skill directory.
   */
  private async downloadSkillFiles(skill: SkillMeta): Promise<boolean> {
    const client = await this.ensureClient();
    const dir = this.skillDir(skill.name);
    let allSucceeded = true;

    for (const fi of skill.fileIndex) {
      if (!fi.path.endsWith(".md")) continue;

      const fileDest = path.resolve(dir, fi.path);
      const rel = path.relative(dir, fileDest);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        this.logger.warn(`acontext: skipping file with path traversal: ${fi.path} (skill: ${skill.name})`);
        continue;
      }
      await fs.mkdir(path.dirname(fileDest), { recursive: true });

      try {
        const resp = await client.skills.getFile({
          skillId: skill.id,
          filePath: fi.path,
          expire: 60,
        });
        if (resp.content) {
          if (resp.content.type === "base64") {
            await fs.writeFile(fileDest, Buffer.from(resp.content.raw, "base64"));
          } else {
            await fs.writeFile(fileDest, resp.content.raw, "utf-8");
          }
        } else if (resp.url) {
          const res = await fetch(resp.url);
          if (res.ok) {
            await fs.writeFile(fileDest, Buffer.from(await res.arrayBuffer()));
          } else {
            allSucceeded = false;
          }
        }
      } catch (err) {
        this.logger.warn(`acontext: download failed for ${skill.id}:${fi.path}: ${String(err)}`);
        allSucceeded = false;
      }
    }
    return allSucceeded;
  }

  /**
   * Sync skills from API to local skill directory.
   * Uses updated_at for incremental sync — only downloads new or changed skills.
   * Concurrent calls are deduplicated via a promise guard.
   */
  async syncSkillsToLocal(): Promise<SkillMeta[]> {
    if (this.syncInProgress) return this.syncInProgress;
    this.syncInProgress = this._doSync();
    try {
      return await this.syncInProgress;
    } finally {
      this.syncInProgress = null;
    }
  }

  private async _doSync(): Promise<SkillMeta[]> {
    const client = await this.ensureClient();
    const spaceId = await this.ensureLearningSpace();
    const rawSkills = await client.learningSpaces.listSkills(spaceId);
    const remoteSkills: SkillMeta[] = rawSkills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      diskId: s.disk_id,
      fileIndex: s.file_index ?? [],
      updatedAt: s.updated_at,
    }));

    const manifest = await this.readManifest();
    const localMap = new Map<string, SkillMeta>();
    if (manifest) {
      for (const s of manifest.skills) {
        localMap.set(s.id, s);
      }
    }

    const remoteIds = new Set<string>();
    const failedSkillIds = new Set<string>();
    const sanitizedNames = new Map<string, string[]>(); // sanitized-name → skill-ids
    let downloadCount = 0;

    const collidingSkillIds = new Set<string>();

    // Pass 1: detect all sanitized name collisions before downloading anything
    for (const skill of remoteSkills) {
      const sName = sanitizeSkillName(skill.name);
      const existing = sanitizedNames.get(sName);
      if (existing) {
        existing.push(skill.id);
      } else {
        sanitizedNames.set(sName, [skill.id]);
      }
    }
    for (const [sName, ids] of sanitizedNames) {
      if (ids.length > 1) {
        this.logger.warn(`acontext: sanitized name collision — ${ids.length} skills collide as "${sName}", skipping all: ${ids.join(", ")}`);
        for (const id of ids) collidingSkillIds.add(id);
      }
    }

    // Pass 2: download non-colliding skills
    for (const skill of remoteSkills) {
      if (collidingSkillIds.has(skill.id)) continue;
      remoteIds.add(skill.id);

      const local = localMap.get(skill.id);

      if (!local || local.updatedAt !== skill.updatedAt) {
        if (local && sanitizeSkillName(local.name) !== sanitizeSkillName(skill.name)) {
          const oldDir = this.skillDir(local.name);
          await fs.rm(oldDir, { recursive: true, force: true }).catch(() => {});
        }
        const targetDir = this.skillDir(skill.name);
        await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
        const success = await this.downloadSkillFiles(skill);
        if (!success) {
          failedSkillIds.add(skill.id);
        }
        downloadCount++;
      }
    }

    // Clean up disk directories for colliding skills that were previously synced
    for (const cid of collidingSkillIds) {
      const local = localMap.get(cid);
      if (local) {
        const dir = this.skillDir(local.name);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }

    for (const [id, local] of localMap) {
      if (!remoteIds.has(id) && !collidingSkillIds.has(id)) {
        const dir = this.skillDir(local.name);
        await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
          this.logger.warn(`acontext: failed to remove deleted skill dir ${dir}: ${String(err)}`);
        });
      }
    }

    // Filter out colliding skills, then preserve old updatedAt for failed downloads
    const nonCollidingSkills = remoteSkills.filter((s) => !collidingSkillIds.has(s.id));
    const manifestSkills = nonCollidingSkills.map((skill) => {
      if (failedSkillIds.has(skill.id)) {
        const local = localMap.get(skill.id);
        return { ...skill, updatedAt: local?.updatedAt ?? "" };
      }
      return skill;
    });
    await this.writeManifest(manifestSkills);
    this.skillsMetadata = nonCollidingSkills;
    this.skillsSynced = true;

    if (downloadCount > 0) {
      this.logger.info(`acontext: synced ${downloadCount} skill(s) to ${this.skillsDir} (${nonCollidingSkills.length} total)`);
    }
    return nonCollidingSkills;
  }

  private async ensureClient(): Promise<AcontextClientLike> {
    if (this.client) return this.client;
    if (!this.initPromise) {
      this.initPromise = this._init().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    await this.initPromise;
    return this.client!;
  }

  private async _init(): Promise<void> {
    const { AcontextClient } = await import("@acontext/acontext");
    this.client = new AcontextClient({
      apiKey: this.cfg.apiKey,
      baseUrl: this.cfg.baseUrl,
    }) as unknown as AcontextClientLike;
  }

  async ensureSession(opencodeSessionId: string): Promise<string> {
    const cached = this.sessionMap.get(opencodeSessionId);
    if (cached) return cached;

    const inflight = this.sessionPromises.get(opencodeSessionId);
    if (inflight) return inflight;

    const promise = this._createOrFindSession(opencodeSessionId).then(
      (result) => { this.sessionPromises.delete(opencodeSessionId); return result; },
      (err) => { this.sessionPromises.delete(opencodeSessionId); throw err; },
    );
    this.sessionPromises.set(opencodeSessionId, promise);
    return promise;
  }

  private async _createOrFindSession(opencodeSessionId: string): Promise<string> {
    const client = await this.ensureClient();

    const existing = await client.sessions.list({
      user: this.cfg.userId,
      filterByConfigs: {
        source: "opencode",
        opencode_session_id: opencodeSessionId,
      },
      limit: 1,
    });
    if (existing.items.length > 0) {
      const sid = existing.items[0].id;
      this.sessionMap.set(opencodeSessionId, sid);
      return sid;
    }

    const session = await client.sessions.create({
      user: this.cfg.userId,
      configs: {
        source: "opencode",
        opencode_session_id: opencodeSessionId,
      },
    });
    this.sessionMap.set(opencodeSessionId, session.id);
    return session.id;
  }

  clearSessionMapping(key: string): void {
    this.sessionMap.delete(key);
  }

  async ensureLearningSpace(): Promise<string> {
    if (this.learningSpaceId) return this.learningSpaceId;

    if (this.learningSpacePromise) return this.learningSpacePromise;

    this.learningSpacePromise = this._createOrFindLearningSpace().catch((err) => {
      this.learningSpacePromise = null;
      throw err;
    });
    return this.learningSpacePromise;
  }

  private async _createOrFindLearningSpace(): Promise<string> {
    const client = await this.ensureClient();

    const existing = await client.learningSpaces.list({
      user: this.cfg.userId,
      filterByMeta: { source: "opencode" },
      limit: 1,
    });
    if (existing.items.length > 0) {
      this.learningSpaceId = existing.items[0].id;
      return this.learningSpaceId!;
    }

    const space = await client.learningSpaces.create({
      user: this.cfg.userId,
      meta: { source: "opencode" },
    });
    this.learningSpaceId = space.id;
    return this.learningSpaceId!;
  }

  // -- Skill sync --------------------------------------------------------------

  async listSkills(): Promise<SkillMeta[]> {
    if (this.skillsMetadata && this.skillsSynced) {
      return this.skillsMetadata;
    }

    try {
      const manifest = await this.readManifest();
      if (manifest && Date.now() - manifest.syncedAt < AcontextBridge.MANIFEST_STALE_MS) {
        this.skillsMetadata = manifest.skills;
        this.skillsSynced = true;
        return manifest.skills;
      }

      return await this.syncSkillsToLocal();
    } catch (err) {
      this.logger.warn(`acontext: listSkills failed, returning cached: ${String(err)}`);
      return this.skillsMetadata ?? [];
    }
  }

  async grepSkills(diskId: string, query: string, limit = 10): Promise<Array<{ path: string; filename: string }>> {
    const client = await this.ensureClient();
    try {
      const result = await client.artifacts.grepArtifacts(diskId, {
        query,
        limit,
      });
      return (result ?? []).map((a) => ({
        path: a.path,
        filename: a.filename,
      }));
    } catch (err) {
      this.logger.warn(`acontext: grepSkills failed for disk ${diskId}: ${String(err)}`);
      return [];
    }
  }

  // -- Session history (on-demand) ---------------------------------------------

  async getRecentSessionSummaries(limit = 3): Promise<string> {
    const client = await this.ensureClient();
    try {
      const sessions = await client.sessions.list({
        user: this.cfg.userId,
        limit,
        timeDesc: true,
        filterByConfigs: { source: "opencode" },
      });

      if (!sessions.items.length) return "";

      const parts: string[] = [];
      for (const session of sessions.items) {
        try {
          const summary = await client.sessions.getSessionSummary(
            session.id,
            { limit: 20 },
          );
          if (summary) {
            parts.push(
              `<session id="${session.id}" created="${session.created_at}">\n${summary}\n</session>`,
            );
          }
        } catch (err) {
          this.logger.warn(`acontext: getSessionSummary failed for ${session.id}: ${String(err)}`);
        }
      }
      return parts.join("\n");
    } catch (err) {
      this.logger.warn(`acontext: getRecentSessionSummaries failed: ${String(err)}`);
      return "";
    }
  }

  // -- Capture -----------------------------------------------------------------

  async storeMessage(
    sessionId: string,
    blob: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const client = await this.ensureClient();
    return await client.sessions.storeMessage(sessionId, blob, { format: "openai" });
  }

  async storeMessages(
    sessionId: string,
    blobs: Record<string, unknown>[],
    startIndex = 0,
  ): Promise<{ stored: number; processed: number }> {
    if (!this.sentMessagesLoaded) {
      if (!this.sentMessagesLoadPromise) {
        this.sentMessagesLoadPromise = this.loadSentMessages().then(() => {
          this.sentMessagesLoaded = true;
          this.sentMessagesLoadPromise = null;
        }).catch((err) => {
          this.sentMessagesLoadPromise = null;
          throw err;
        });
      }
      await this.sentMessagesLoadPromise;
    }

    const client = await this.ensureClient();
    let sessionSent = this.sentMessages.get(sessionId);
    if (!sessionSent) {
      sessionSent = new Map();
      this.sentMessages.set(sessionId, sessionSent);
    }

    let stored = 0;
    let processed = 0;
    for (let i = 0; i < blobs.length; i++) {
      const blob = blobs[i];
      const hash = AcontextBridge.computeMessageHash(startIndex + i, blob);

      if (sessionSent.has(hash)) {
        this.logger.info(`acontext: skipping duplicate message ${hash}`);
        processed++;
        continue;
      }

      try {
        const result = await client.sessions.storeMessage(sessionId, blob, { format: "openai" });
        sessionSent.set(hash, result.id);
        stored++;
        processed++;
      } catch (err) {
        this.logger.warn(`acontext: storeMessage failed at index ${startIndex + i}: ${String(err)}`);
        break;
      }
    }

    if (stored > 0) {
      await this.persistSentMessages();
    }
    return { stored, processed };
  }

  async flush(sessionId: string): Promise<{ status: number; errmsg: string }> {
    const client = await this.ensureClient();
    return await client.sessions.flush(sessionId);
  }

  // -- Learn -------------------------------------------------------------------

  async learnFromSession(sessionId: string): Promise<LearnResult> {
    if (!this.learnedSessionsLoaded) {
      if (!this.learnedSessionsLoadPromise) {
        this.learnedSessionsLoadPromise = this.loadLearnedSessions().then(() => {
          this.learnedSessionsLoaded = true;
          this.learnedSessionsLoadPromise = null;
        }).catch((err) => {
          this.learnedSessionsLoadPromise = null;
          throw err;
        });
      }
      await this.learnedSessionsLoadPromise;
    }

    if (this.learnedSessions.has(sessionId)) {
      return { status: "skipped" };
    }

    const client = await this.ensureClient();
    const spaceId = await this.ensureLearningSpace();
    try {
      const result = await client.learningSpaces.learn({
        spaceId,
        sessionId,
      });
      this.learnedSessions.add(sessionId);
      await this.persistLearnedSessions();
      this.invalidateSkillCaches();
      return { status: "learned", id: result.id };
    } catch (err) {
      const msg = String(err);
      if (msg.includes("already learned")) {
        this.learnedSessions.add(sessionId);
        await this.persistLearnedSessions();
        this.invalidateSkillCaches();
        this.logger.info(`acontext: session ${sessionId} already learned, skipping`);
        return { status: "skipped" };
      }
      this.logger.warn(`acontext: learnFromSession failed for ${sessionId}: ${msg}`);
      return { status: "error" };
    }
  }

  invalidateSkillCaches(): void {
    this.skillsMetadata = null;
    this.skillsSynced = false;
  }

  // -- Stats -------------------------------------------------------------------

  async getStats(): Promise<{
    sessionCount: number;
    sessionCountIsApproximate: boolean;
    skillCount: number;
    learningSpaceId: string | null;
  }> {
    const client = await this.ensureClient();
    try {
      const sessions = await client.sessions.list({
        user: this.cfg.userId,
        filterByConfigs: { source: "opencode" },
        limit: 100,
      });
      const skills = await this.listSkills();
      return {
        sessionCount: sessions.items.length,
        sessionCountIsApproximate: sessions.has_more,
        skillCount: skills.length,
        learningSpaceId: this.learningSpaceId,
      };
    } catch (err) {
      this.logger.warn(`acontext: getStats failed: ${String(err)}`);
      return { sessionCount: 0, sessionCountIsApproximate: false, skillCount: 0, learningSpaceId: null };
    }
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const PLUGIN_VERSION = "0.1.0";

/**
 * AcontextPlugin for OpenCode.
 *
 * Usage in opencode.json:
 * ```json
 * {
 *   "$schema": "https://opencode.ai/config.json",
 *   "plugin": ["@acontext/opencode"]
 * }
 * ```
 *
 * Environment variables:
 * - ACONTEXT_API_KEY: API key (or use `acontext login`)
 * - ACONTEXT_CONFIG_DIR: Override config directory (default: ~/.acontext)
 *
 * The plugin reads its configuration from environment variables and
 * ~/.acontext/credentials.json. It auto-captures conversation turns,
 * learns skills from sessions, and provides tools for searching skills
 * and session history.
 */
export const AcontextPlugin = async (ctx: {
  project: { name?: string; root?: string };
  client: Record<string, unknown>;
  $: unknown;
  directory: string;
  worktree: string;
}) => {
  // Load config from environment
  const cfgInput: Record<string, unknown> = {};
  if (process.env.ACONTEXT_API_KEY) {
    cfgInput.apiKey = process.env.ACONTEXT_API_KEY;
  }
  if (process.env.ACONTEXT_BASE_URL) {
    cfgInput.baseUrl = process.env.ACONTEXT_BASE_URL;
  }
  if (process.env.ACONTEXT_USER_ID) {
    cfgInput.userId = process.env.ACONTEXT_USER_ID;
  }
  if (process.env.ACONTEXT_LEARNING_SPACE_ID) {
    cfgInput.learningSpaceId = process.env.ACONTEXT_LEARNING_SPACE_ID;
  }
  if (process.env.ACONTEXT_AUTO_CAPTURE === "false") {
    cfgInput.autoCapture = false;
  }
  if (process.env.ACONTEXT_AUTO_LEARN === "false") {
    cfgInput.autoLearn = false;
  }
  if (process.env.ACONTEXT_MIN_TURNS) {
    const n = parseInt(process.env.ACONTEXT_MIN_TURNS, 10);
    if (!isNaN(n)) cfgInput.minTurnsForLearn = n;
  }

  let cfg: AcontextConfig;
  try {
    cfg = configSchema.parse(cfgInput);
  } catch (err) {
    console.warn(`[acontext] Plugin initialization failed: ${String(err)}`);
    // Return empty hooks — plugin is inactive
    return {};
  }

  const dataDir = path.join(os.homedir(), ".opencode", "acontext-data");
  const bridge = new AcontextBridge(cfg, dataDir, cfg.skillsDir, {
    info: (msg: string) => console.log(`[acontext] ${msg}`),
    warn: (msg: string) => console.warn(`[acontext] ${msg}`),
  });

  // State tracking
  let currentSessionId: string | undefined;
  let capturedTurnCount = 0;
  /** Number of messages already captured from the message history. */
  let messagesCaptured = 0;

  console.log(
    `[acontext] initialized (user: ${cfg.userId}, autoCapture: ${cfg.autoCapture}, autoLearn: ${cfg.autoLearn})`,
  );

  // Kick off initial skill sync in the background
  bridge.syncSkillsToLocal().catch((err) => {
    console.warn(`[acontext] initial skill sync failed: ${String(err)}`);
  });

  // Import tool and z from @opencode-ai/plugin dynamically to avoid hard dep at import time
  let toolFn: typeof import("@opencode-ai/plugin").tool;
  let z: typeof import("@opencode-ai/plugin").tool.schema;
  try {
    const pluginMod = await import("@opencode-ai/plugin");
    toolFn = pluginMod.tool;
    z = toolFn.schema;
  } catch {
    // Fallback: define minimal tool helper using zod directly
    const zodMod = await import("zod");
    z = zodMod.z as any;
    toolFn = ((input: any) => input) as any;
  }

  return {
    // ========================================================================
    // Custom Tools
    // ========================================================================
    tool: {
      acontext_search_skills: toolFn({
        description:
          "Search through learned skill files by keyword. Use when you need to find specific knowledge from past sessions.",
        args: {
          query: z.string().describe("Search keyword or regex pattern"),
          limit: z.number().optional().describe("Max results (default: 10)"),
        },
        async execute(args) {
          try {
            const skills = await bridge.listSkills();
            if (skills.length === 0) {
              return "No skills learned yet.";
            }

            const queryLimit = args.limit ?? 10;
            const allMatches: Array<{
              skillName: string;
              path: string;
              filename: string;
            }> = [];

            for (const skill of skills) {
              if (!skill.diskId) continue;
              const remaining = queryLimit - allMatches.length;
              if (remaining <= 0) break;
              const matches = await bridge.grepSkills(
                skill.diskId,
                args.query,
                remaining,
              );
              for (const m of matches) {
                allMatches.push({
                  skillName: skill.name,
                  path: m.path,
                  filename: m.filename,
                });
              }
              if (allMatches.length >= queryLimit) break;
            }

            if (allMatches.length === 0) {
              return `No matches for "${args.query}" in skill files.`;
            }

            const text = allMatches
              .slice(0, queryLimit)
              .map(
                (m, i) =>
                  `${i + 1}. [${m.skillName}] ${m.path}/${m.filename}`,
              )
              .join("\n");

            return `Found ${allMatches.length} matches:\n\n${text}`;
          } catch (err) {
            return `Skill search failed: ${String(err)}`;
          }
        },
      }),

      acontext_session_history: toolFn({
        description:
          "Get task summaries from recent past sessions. Use to recall what was done previously.",
        args: {
          limit: z.number().optional().describe("Max sessions to include (default: 3)"),
        },
        async execute(args) {
          try {
            const summaries = await bridge.getRecentSessionSummaries(args.limit);
            if (!summaries) {
              return "No session history available.";
            }
            return `Recent session history:\n\n${summaries}`;
          } catch (err) {
            return `Session history failed: ${String(err)}`;
          }
        },
      }),

      acontext_learn_now: toolFn({
        description:
          "Trigger skill learning from the current session immediately. Distills reusable skills from this conversation.",
        args: {},
        async execute() {
          try {
            if (!currentSessionId) {
              return "No active session to learn from.";
            }

            await bridge.flush(currentSessionId);

            const result = await bridge.learnFromSession(currentSessionId);
            if (result.status === "skipped") {
              return "This session has already been learned.";
            }
            if (result.status === "error") {
              return "Failed to trigger learning.";
            }

            return `Learning triggered (id: ${result.id}). Skills will be available once processing completes.`;
          } catch (err) {
            return `Learn failed: ${String(err)}`;
          }
        },
      }),
    },

    // ========================================================================
    // Event Hooks
    // ========================================================================

    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      if (!cfg.autoCapture) return;

      // On session.idle, trigger auto-learn if we have enough turns
      if (event.type === "session.idle") {
        if (!currentSessionId || !cfg.autoLearn) return;

        if (capturedTurnCount >= cfg.minTurnsForLearn) {
          try {
            const learnSessionId = currentSessionId;
            capturedTurnCount = 0;

            const result = await bridge.learnFromSession(learnSessionId);
            if (result.status === "learned") {
              console.log(`[acontext] auto-learn triggered (learning: ${result.id})`);
            }
          } catch (err) {
            console.warn(`[acontext] auto-learn failed: ${String(err)}`);
          }
        }
      }

      // On session.deleted, clean up session mapping
      if (event.type === "session.deleted") {
        const sessionId = event.properties?.id as string | undefined;
        if (sessionId) {
          bridge.clearSessionMapping(sessionId);
          if (currentSessionId === sessionId) {
            currentSessionId = undefined;
            capturedTurnCount = 0;
            messagesCaptured = 0;
          }
        }
      }
    },

    // ========================================================================
    // Message Capture Hook
    // ========================================================================

    "message.updated": async (input: {
      sessionID: string;
      messageID?: string;
      [key: string]: unknown;
    }) => {
      if (!cfg.autoCapture) return;
      // We can't access full message list from this hook alone, but we track
      // that a new message was posted. The actual capture happens below via
      // the chat.message hook which has access to message content.
    },

    "chat.message": async (
      input: {
        sessionID: string;
        messageID?: string;
        [key: string]: unknown;
      },
      output: {
        message: { role: string; parts?: Array<{ type: string; text?: string }> };
        parts: Array<{ type: string; text?: string }>;
      },
    ) => {
      if (!cfg.autoCapture) return;
      if (!input.sessionID) return;

      try {
        const acontextSessionId = await bridge.ensureSession(input.sessionID);
        currentSessionId = acontextSessionId;

        // Extract text content from the message parts
        const textParts = output.parts
          ?.filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!)
          ?? [];
        const textContent = textParts.join("\n");
        if (!textContent) return;

        const role = output.message?.role ?? "user";
        const normalized = normalizeMessages([{ role, content: textContent }]);
        if (normalized.length === 0) return;

        const { stored } = await bridge.storeMessages(
          acontextSessionId,
          normalized as Record<string, unknown>[],
          messagesCaptured,
        );
        messagesCaptured += normalized.length;
        if (stored > 0) {
          capturedTurnCount += 1;
          console.log(`[acontext] captured ${stored} message(s) to session ${acontextSessionId}`);
        }
      } catch (err) {
        console.warn(`[acontext] message capture failed: ${String(err)}`);
      }
    },

    // ========================================================================
    // System Prompt Injection
    // ========================================================================

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model: unknown },
      output: { system: string[] },
    ) => {
      try {
        const skills = await bridge.listSkills();
        if (skills.length === 0) return;

        const skillDescriptions = skills
          .map((s) => `- **${s.name}**: ${s.description}`)
          .join("\n");

        output.system.push(`
## Acontext Skills

You have access to learned skills from previous sessions. Use the \`acontext_search_skills\` tool to find detailed skill content.

Available skills:
${skillDescriptions}
`);
      } catch {
        // Silently ignore — skills are optional context
      }
    },

    // ========================================================================
    // Compaction Hook
    // ========================================================================

    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      if (!cfg.autoCapture || !currentSessionId) return;

      // Flush and learn before compaction to avoid losing data
      try {
        await bridge.flush(currentSessionId);
        if (cfg.autoLearn) {
          const result = await bridge.learnFromSession(currentSessionId);
          if (result.status === "learned") {
            console.log(`[acontext] pre-compaction learn triggered (learning: ${result.id})`);
          }
        }
      } catch (err) {
        console.warn(`[acontext] pre-compaction learn failed: ${String(err)}`);
      }

      // Reset message cursor after compaction rewrites messages
      messagesCaptured = 0;

      // Add context about learned skills to compaction
      try {
        const skills = await bridge.listSkills();
        if (skills.length > 0) {
          output.context.push(
            `Acontext has ${skills.length} learned skill(s) available. Use the acontext_search_skills tool to find relevant knowledge.`,
          );
        }
      } catch {
        // Silently ignore
      }
    },
  };
};

// Also export as default for npm plugin loading
export default AcontextPlugin;

// Export version for programmatic access
export const version = PLUGIN_VERSION;
