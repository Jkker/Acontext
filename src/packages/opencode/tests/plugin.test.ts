/**
 * Unit tests for @acontext/opencode plugin.
 *
 * Tests config parsing, helper functions, AcontextBridge logic,
 * and plugin hook behavior using mocks.
 */

import { jest, describe, test, expect, beforeEach, afterEach, afterAll } from "@jest/globals";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveEnvVars,
  assertAllowedKeys,
  configSchema,
  sanitizeSkillName,
  atomicWriteFile,
  normalizeMessages,
  AcontextBridge,
  AcontextPlugin,
  version,
  type AcontextConfig,
  type BridgeLogger,
  type LearnResult,
} from "../index";

// ============================================================================
// Config Parsing
// ============================================================================

describe("resolveEnvVars", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("resolves a single env var", () => {
    process.env.MY_KEY = "secret123";
    expect(resolveEnvVars("${MY_KEY}")).toBe("secret123");
  });

  test("resolves multiple env vars in one string", () => {
    process.env.HOST = "localhost";
    process.env.PORT = "8080";
    expect(resolveEnvVars("http://${HOST}:${PORT}")).toBe(
      "http://localhost:8080",
    );
  });

  test("returns string unchanged if no env vars", () => {
    expect(resolveEnvVars("plain-string")).toBe("plain-string");
  });

  test("throws on unset env var", () => {
    delete process.env.MISSING_VAR;
    expect(() => resolveEnvVars("${MISSING_VAR}")).toThrow(
      "Environment variable MISSING_VAR is not set",
    );
  });

  test("throws distinct error for empty string vs undefined", () => {
    delete process.env.UNDEF_VAR;
    expect(() => resolveEnvVars("${UNDEF_VAR}")).toThrow("is not set");

    process.env.EMPTY_VAR = "";
    expect(() => resolveEnvVars("${EMPTY_VAR}")).toThrow("is set but empty");
  });
});

describe("assertAllowedKeys", () => {
  test("passes for known keys only", () => {
    expect(() =>
      assertAllowedKeys({ a: 1, b: 2 }, ["a", "b", "c"], "test"),
    ).not.toThrow();
  });

  test("throws listing unknown keys", () => {
    expect(() =>
      assertAllowedKeys({ a: 1, x: 2, y: 3 }, ["a"], "myConfig"),
    ).toThrow("myConfig has unknown keys: x, y");
  });
});

describe("configSchema.parse", () => {
  const originalEnv = process.env;
  let tmpConfigDir: string;

  beforeEach(async () => {
    // Use a temp dir as config dir so real ~/.acontext/ files don't interfere
    tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-test-"));
    process.env = { ...originalEnv, ACONTEXT_API_KEY: "sk-ac-test", ACONTEXT_CONFIG_DIR: tmpConfigDir };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tmpConfigDir, { recursive: true, force: true }).catch(() => {});
  });

  test("parses minimal valid config with env var", () => {
    const cfg = configSchema.parse({
      apiKey: "${ACONTEXT_API_KEY}",
    });
    expect(cfg.apiKey).toBe("sk-ac-test");
    expect(cfg.userId).toBe("opencode");
    expect(cfg.baseUrl).toBe("https://api.acontext.app/api/v1");
  });

  test("parses config with all fields", () => {
    const cfg = configSchema.parse({
      apiKey: "sk-ac-literal",
      baseUrl: "http://localhost:3000",
      userId: "alice",
      learningSpaceId: "space-123",
      skillsDir: "/custom/skills",
      autoCapture: false,
      autoLearn: false,
      minTurnsForLearn: 6,
    });
    expect(cfg.apiKey).toBe("sk-ac-literal");
    expect(cfg.baseUrl).toBe("http://localhost:3000");
    expect(cfg.userId).toBe("alice");
    expect(cfg.learningSpaceId).toBe("space-123");
    expect(cfg.skillsDir).toBe("/custom/skills");
    expect(cfg.autoCapture).toBe(false);
    expect(cfg.autoLearn).toBe(false);
    expect(cfg.minTurnsForLearn).toBe(6);
  });

  test("fills defaults for optional fields", () => {
    const cfg = configSchema.parse({ apiKey: "sk-ac-x" });
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.autoLearn).toBe(true);
    expect(cfg.minTurnsForLearn).toBe(4);
    expect(cfg.learningSpaceId).toBeUndefined();
    expect(cfg.skillsDir).toContain(".opencode");
    expect(cfg.skillsDir).toContain("skills");
  });

  test("throws on missing apiKey when no credentials file", () => {
    expect(() => configSchema.parse({ userId: "bob" })).toThrow(
      "ACONTEXT_API_KEY is required",
    );
  });

  test("throws on empty apiKey when no credentials file", () => {
    expect(() => configSchema.parse({ apiKey: "" })).toThrow(
      "ACONTEXT_API_KEY is required",
    );
  });

  test("throws on non-object input", () => {
    expect(() => configSchema.parse(null)).toThrow("config required");
    expect(() => configSchema.parse("string")).toThrow("config required");
    expect(() => configSchema.parse(42)).toThrow("config required");
  });

  test("throws on unknown keys", () => {
    expect(() =>
      configSchema.parse({ apiKey: "sk-ac-x", badKey: true }),
    ).toThrow("unknown keys: badKey");
  });

  test("resolves env var in apiKey", () => {
    process.env.MY_SECRET = "resolved-key";
    const cfg = configSchema.parse({ apiKey: "${MY_SECRET}" });
    expect(cfg.apiKey).toBe("resolved-key");
  });

  test("resolves env var in baseUrl", () => {
    process.env.BASE = "http://custom:9000";
    const cfg = configSchema.parse({
      apiKey: "sk-ac-x",
      baseUrl: "${BASE}",
    });
    expect(cfg.baseUrl).toBe("http://custom:9000");
  });

  test("throws on apiKey that resolves to whitespace only when no credentials file", () => {
    process.env.WHITESPACE_KEY = "   ";
    expect(() => configSchema.parse({ apiKey: "${WHITESPACE_KEY}" })).toThrow(
      "ACONTEXT_API_KEY is required",
    );
  });

  test("throws on apiKey that resolves to empty env var when no credentials file", () => {
    process.env.EMPTY_KEY = "";
    expect(() => configSchema.parse({ apiKey: "${EMPTY_KEY}" })).toThrow(
      "ACONTEXT_API_KEY is required",
    );
  });

  test("parses empty config when credentials.json exists", async () => {
    const credPath = path.join(tmpConfigDir, "credentials.json");
    await fs.writeFile(credPath, JSON.stringify({
      default_project: "my-project",
      keys: { "my-project": "sk-ac-from-creds" },
    }));
    const cfg = configSchema.parse({});
    expect(cfg.apiKey).toBe("sk-ac-from-creds");
    expect(cfg.userId).toBe("opencode");
  });

  test("parses empty config and reads userId from auth.json", async () => {
    const credPath = path.join(tmpConfigDir, "credentials.json");
    await fs.writeFile(credPath, JSON.stringify({
      default_project: "my-project",
      keys: { "my-project": "sk-ac-from-creds" },
    }));
    const authPath = path.join(tmpConfigDir, "auth.json");
    await fs.writeFile(authPath, JSON.stringify({
      user: { email: "alice@example.com" },
    }));
    const cfg = configSchema.parse({});
    expect(cfg.apiKey).toBe("sk-ac-from-creds");
    expect(cfg.userId).toBe("alice@example.com");
  });

  test("throws on empty config when no credentials file and no apiKey", () => {
    expect(() => configSchema.parse({})).toThrow(
      "ACONTEXT_API_KEY is required",
    );
  });
});

// ============================================================================
// sanitizeSkillName
// ============================================================================

describe("sanitizeSkillName", () => {
  test("lowercases and replaces spaces/special chars", () => {
    expect(sanitizeSkillName("My Great Skill!")).toBe("my-great-skill");
  });

  test("strips leading/trailing hyphens", () => {
    expect(sanitizeSkillName("---hello---")).toBe("hello");
  });

  test("preserves underscores and hyphens", () => {
    expect(sanitizeSkillName("my_skill-v2")).toBe("my_skill-v2");
  });

  test("throws on empty result", () => {
    expect(() => sanitizeSkillName("!!!")).toThrow("Cannot sanitize");
  });

  test("throws on whitespace-only input", () => {
    expect(() => sanitizeSkillName("   ")).toThrow("Cannot sanitize");
  });
});

// ============================================================================
// atomicWriteFile
// ============================================================================

describe("atomicWriteFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-write-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("writes file content", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await atomicWriteFile(filePath, "hello world");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("hello world");
  });

  test("creates parent directories", async () => {
    const filePath = path.join(tmpDir, "sub", "dir", "file.txt");
    await atomicWriteFile(filePath, "nested");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("nested");
  });

  test("overwrites existing file", async () => {
    const filePath = path.join(tmpDir, "overwrite.txt");
    await atomicWriteFile(filePath, "first");
    await atomicWriteFile(filePath, "second");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("second");
  });
});

// ============================================================================
// normalizeMessages
// ============================================================================

describe("normalizeMessages", () => {
  test("normalizes user message", () => {
    const result = normalizeMessages([
      { role: "user", content: "Hello!" },
    ]);
    expect(result).toEqual([{ role: "user", content: "Hello!" }]);
  });

  test("normalizes assistant text message", () => {
    const result = normalizeMessages([
      { role: "assistant", content: "Hi there" },
    ]);
    expect(result).toEqual([{ role: "assistant", content: "Hi there" }]);
  });

  test("normalizes assistant with content blocks", () => {
    const result = normalizeMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" },
        ],
      },
    ]);
    expect(result).toEqual([
      { role: "assistant", content: "Part 1\nPart 2" },
    ]);
  });

  test("extracts tool_calls from assistant", () => {
    const result = normalizeMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me help" },
          {
            type: "toolCall",
            id: "call-1",
            name: "search",
            arguments: '{"q":"test"}',
          },
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Let me help");
    expect(result[0].tool_calls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: { name: "search", arguments: '{"q":"test"}' },
      },
    ]);
  });

  test("handles tool_use blocks", () => {
    const result = normalizeMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-2",
            name: "read_file",
            input: { path: "/foo" },
          },
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].tool_calls![0].function.arguments).toBe('{"path":"/foo"}');
  });

  test("normalizes tool message", () => {
    const result = normalizeMessages([
      { role: "tool", content: "result data", tool_call_id: "call-1" },
    ]);
    expect(result).toEqual([
      { role: "tool", tool_call_id: "call-1", content: "result data" },
    ]);
  });

  test("normalizes toolResult message", () => {
    const result = normalizeMessages([
      { role: "toolResult", content: "result", toolCallId: "call-3" },
    ]);
    expect(result).toEqual([
      { role: "tool", tool_call_id: "call-3", content: "result" },
    ]);
  });

  test("skips empty assistant messages", () => {
    const result = normalizeMessages([
      { role: "assistant", content: "" },
      { role: "assistant", content: null },
    ]);
    expect(result).toEqual([]);
  });

  test("skips unknown roles", () => {
    const result = normalizeMessages([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  test("skips messages without role", () => {
    const result = normalizeMessages([
      { content: "no role" } as any,
    ]);
    expect(result).toEqual([]);
  });

  test("handles mixed content with thinking blocks", () => {
    const result = normalizeMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal thought" },
          { type: "text", text: "visible response" },
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("visible response");
  });

  test("skips assistant with only thinking blocks", () => {
    const result = normalizeMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal thought" },
        ],
      },
    ]);
    expect(result).toEqual([]);
  });
});

// ============================================================================
// AcontextBridge
// ============================================================================

function makeConfig(overrides: Partial<AcontextConfig> = {}): AcontextConfig {
  return {
    apiKey: "sk-ac-test",
    baseUrl: "https://api.acontext.app/api/v1",
    userId: "test-user",
    skillsDir: "/tmp/test-skills",
    autoCapture: true,
    autoLearn: true,
    minTurnsForLearn: 4,
    ...overrides,
  };
}

function makeLogger(): BridgeLogger & { logs: string[]; warnings: string[] } {
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    logs,
    warnings,
    info: (msg: string) => logs.push(msg),
    warn: (msg: string) => warnings.push(msg),
  };
}

describe("AcontextBridge.computeMessageHash", () => {
  test("returns deterministic hash", () => {
    const h1 = AcontextBridge.computeMessageHash(0, {
      role: "user",
      content: "hello",
    });
    const h2 = AcontextBridge.computeMessageHash(0, {
      role: "user",
      content: "hello",
    });
    expect(h1).toBe(h2);
  });

  test("different content gives different hash", () => {
    const h1 = AcontextBridge.computeMessageHash(0, {
      role: "user",
      content: "hello",
    });
    const h2 = AcontextBridge.computeMessageHash(0, {
      role: "user",
      content: "world",
    });
    expect(h1).not.toBe(h2);
  });

  test("format is index:hex16", () => {
    const h = AcontextBridge.computeMessageHash(5, {
      role: "user",
      content: "x",
    });
    expect(h).toMatch(/^5:[0-9a-f]{16}$/);
  });
});

describe("AcontextBridge session management", () => {
  let tmpDir: string;
  let bridge: AcontextBridge;
  let logger: ReturnType<typeof makeLogger>;

  const mockClient = {
    sessions: {
      list: jest.fn<any>().mockResolvedValue({ items: [], has_more: false }),
      create: jest.fn<any>().mockResolvedValue({ id: "acontext-session-1" }),
      storeMessage: jest.fn<any>().mockResolvedValue({ id: "msg-1" }),
      flush: jest.fn<any>().mockResolvedValue({ status: 0, errmsg: "" }),
      getSessionSummary: jest.fn<any>().mockResolvedValue("Summary text"),
    },
    learningSpaces: {
      list: jest.fn<any>().mockResolvedValue({ items: [], has_more: false }),
      create: jest.fn<any>().mockResolvedValue({ id: "ls-1" }),
      listSkills: jest.fn<any>().mockResolvedValue([]),
      learn: jest.fn<any>().mockResolvedValue({ id: "learn-1" }),
    },
    skills: {
      getFile: jest.fn<any>().mockResolvedValue({ content: null, url: null }),
    },
    artifacts: {
      grepArtifacts: jest.fn<any>().mockResolvedValue([]),
    },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    logger = makeLogger();
    const cfg = makeConfig();
    bridge = new AcontextBridge(cfg, tmpDir, path.join(tmpDir, "skills"), logger);

    // Inject mock client
    (bridge as any).client = mockClient;
    (bridge as any).initPromise = Promise.resolve();

    // Reset mocks
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("ensureSession creates a new session", async () => {
    const sid = await bridge.ensureSession("oc-session-1");
    expect(sid).toBe("acontext-session-1");
    const callArgs = mockClient.sessions.create.mock.calls[0][0] as Record<string, any>;
    expect(callArgs.configs.source).toBe("opencode");
  });

  test("ensureSession reuses existing session from API", async () => {
    mockClient.sessions.list.mockResolvedValueOnce({
      items: [{ id: "existing-session" }],
      has_more: false,
    });
    const sid = await bridge.ensureSession("oc-session-2");
    expect(sid).toBe("existing-session");
    expect(mockClient.sessions.create).not.toHaveBeenCalled();
  });

  test("ensureSession caches session ID", async () => {
    await bridge.ensureSession("oc-session-3");
    mockClient.sessions.list.mockClear();
    mockClient.sessions.create.mockClear();

    const sid = await bridge.ensureSession("oc-session-3");
    expect(sid).toBe("acontext-session-1");
    expect(mockClient.sessions.list).not.toHaveBeenCalled();
    expect(mockClient.sessions.create).not.toHaveBeenCalled();
  });

  test("clearSessionMapping removes cached session", async () => {
    await bridge.ensureSession("oc-session-4");
    bridge.clearSessionMapping("oc-session-4");

    mockClient.sessions.list.mockResolvedValueOnce({ items: [], has_more: false });
    mockClient.sessions.create.mockResolvedValueOnce({ id: "new-session" });

    const sid = await bridge.ensureSession("oc-session-4");
    expect(sid).toBe("new-session");
  });

  test("storeMessages stores and tracks messages", async () => {
    const result = await bridge.storeMessages("sid-1", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(result.stored).toBe(2);
    expect(result.processed).toBe(2);
    expect(mockClient.sessions.storeMessage).toHaveBeenCalledTimes(2);
  });

  test("storeMessages deduplicates messages", async () => {
    await bridge.storeMessages("sid-1", [
      { role: "user", content: "hello" },
    ]);
    mockClient.sessions.storeMessage.mockClear();

    const result = await bridge.storeMessages("sid-1", [
      { role: "user", content: "hello" },
    ]);
    expect(result.stored).toBe(0);
    expect(result.processed).toBe(1);
    expect(mockClient.sessions.storeMessage).not.toHaveBeenCalled();
  });

  test("learnFromSession triggers learning", async () => {
    // Need a learning space first
    (bridge as any).learningSpaceId = "ls-1";

    const result = await bridge.learnFromSession("sid-1");
    expect(result.status).toBe("learned");
    expect((result as any).id).toBe("learn-1");
  });

  test("learnFromSession skips already learned sessions", async () => {
    (bridge as any).learningSpaceId = "ls-1";

    await bridge.learnFromSession("sid-1");
    const result = await bridge.learnFromSession("sid-1");
    expect(result.status).toBe("skipped");
  });

  test("learnFromSession handles 'already learned' API error", async () => {
    (bridge as any).learningSpaceId = "ls-1";
    mockClient.learningSpaces.learn.mockRejectedValueOnce(
      new Error("session already learned"),
    );

    const result = await bridge.learnFromSession("sid-new");
    expect(result.status).toBe("skipped");
  });

  test("learnFromSession handles general errors", async () => {
    (bridge as any).learningSpaceId = "ls-1";
    mockClient.learningSpaces.learn.mockRejectedValueOnce(
      new Error("network error"),
    );

    const result = await bridge.learnFromSession("sid-error");
    expect(result.status).toBe("error");
  });

  test("flush delegates to client", async () => {
    await bridge.flush("sid-1");
    expect(mockClient.sessions.flush).toHaveBeenCalled();
    expect(mockClient.sessions.flush.mock.calls[0][0]).toBe("sid-1");
  });

  test("getRecentSessionSummaries returns formatted summaries", async () => {
    mockClient.sessions.list.mockResolvedValueOnce({
      items: [{ id: "s1", created_at: "2025-01-01" }],
      has_more: false,
    });

    const result = await bridge.getRecentSessionSummaries(1);
    expect(result).toContain("Summary text");
    expect(result).toContain("s1");
  });

  test("getRecentSessionSummaries returns empty for no sessions", async () => {
    mockClient.sessions.list.mockResolvedValueOnce({
      items: [],
      has_more: false,
    });

    const result = await bridge.getRecentSessionSummaries();
    expect(result).toBe("");
  });

  test("getStats returns session and skill counts", async () => {
    mockClient.sessions.list.mockResolvedValueOnce({
      items: [{ id: "s1" }, { id: "s2" }],
      has_more: false,
    });

    const stats = await bridge.getStats();
    expect(stats.sessionCount).toBe(2);
    expect(stats.sessionCountIsApproximate).toBe(false);
    expect(stats.skillCount).toBe(0);
  });

  test("invalidateSkillCaches resets caches", () => {
    (bridge as any).skillsMetadata = [{ id: "s1" }];
    (bridge as any).skillsSynced = true;

    bridge.invalidateSkillCaches();

    expect((bridge as any).skillsMetadata).toBeNull();
    expect((bridge as any).skillsSynced).toBe(false);
  });
});

// ============================================================================
// Plugin Export
// ============================================================================

describe("AcontextPlugin", () => {
  const originalEnv = process.env;
  let tmpConfigDir: string;

  beforeEach(async () => {
    tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-test-"));
    process.env = {
      ...originalEnv,
      ACONTEXT_API_KEY: "sk-ac-plugin-test",
      ACONTEXT_CONFIG_DIR: tmpConfigDir,
    };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tmpConfigDir, { recursive: true, force: true }).catch(() => {});
  });

  test("exports correct version", async () => {
    // Read version from package.json
    const pkgJsonPath = path.join(
      new URL(".", import.meta.url).pathname,
      "..",
      "package.json",
    );
    const pkgJson = JSON.parse(
      await fs.readFile(pkgJsonPath, "utf-8"),
    );
    expect(version).toBe(pkgJson.version);
  });

  test("returns hooks object when configured correctly", async () => {
    const hooks = await AcontextPlugin({
      project: { name: "test-project" },
      client: {},
      $: {},
      directory: "/tmp/test",
      worktree: "/tmp/test",
    });

    expect(hooks).toBeDefined();
    expect(typeof hooks).toBe("object");
  });

  test("returns empty hooks when API key is missing", async () => {
    delete process.env.ACONTEXT_API_KEY;

    const hooks = await AcontextPlugin({
      project: { name: "test-project" },
      client: {},
      $: {},
      directory: "/tmp/test",
      worktree: "/tmp/test",
    });

    // Should return empty hooks (plugin inactive)
    expect(hooks).toBeDefined();
    expect(hooks.tool).toBeUndefined();
  });

  test("returns tools when configured", async () => {
    const hooks = await AcontextPlugin({
      project: { name: "test-project" },
      client: {},
      $: {},
      directory: "/tmp/test",
      worktree: "/tmp/test",
    });

    // Plugin should have tools defined
    if (hooks.tool) {
      expect(hooks.tool.acontext_search_skills).toBeDefined();
      expect(hooks.tool.acontext_session_history).toBeDefined();
      expect(hooks.tool.acontext_learn_now).toBeDefined();
    }
  });

  test("returns event hook when configured", async () => {
    const hooks = await AcontextPlugin({
      project: { name: "test-project" },
      client: {},
      $: {},
      directory: "/tmp/test",
      worktree: "/tmp/test",
    });

    expect(hooks.event).toBeDefined();
    expect(typeof hooks.event).toBe("function");
  });

  test("returns system transform hook when configured", async () => {
    const hooks = await AcontextPlugin({
      project: { name: "test-project" },
      client: {},
      $: {},
      directory: "/tmp/test",
      worktree: "/tmp/test",
    });

    expect(hooks["experimental.chat.system.transform"]).toBeDefined();
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
  });

  test("returns compaction hook when configured", async () => {
    const hooks = await AcontextPlugin({
      project: { name: "test-project" },
      client: {},
      $: {},
      directory: "/tmp/test",
      worktree: "/tmp/test",
    });

    expect(hooks["experimental.session.compacting"]).toBeDefined();
    expect(typeof hooks["experimental.session.compacting"]).toBe("function");
  });
});

// ============================================================================
// Learned Sessions Persistence
// ============================================================================

describe("AcontextBridge learned sessions persistence", () => {
  let tmpDir: string;
  let logger: ReturnType<typeof makeLogger>;

  const mockClient = {
    sessions: {
      list: jest.fn<any>().mockResolvedValue({ items: [], has_more: false }),
      create: jest.fn<any>().mockResolvedValue({ id: "s1" }),
      storeMessage: jest.fn<any>().mockResolvedValue({ id: "m1" }),
      flush: jest.fn<any>().mockResolvedValue({ status: 0, errmsg: "" }),
      getSessionSummary: jest.fn<any>().mockResolvedValue(""),
    },
    learningSpaces: {
      list: jest.fn<any>().mockResolvedValue({ items: [], has_more: false }),
      create: jest.fn<any>().mockResolvedValue({ id: "ls-1" }),
      listSkills: jest.fn<any>().mockResolvedValue([]),
      learn: jest.fn<any>().mockResolvedValue({ id: "learn-1" }),
    },
    skills: {
      getFile: jest.fn<any>().mockResolvedValue({ content: null }),
    },
    artifacts: {
      grepArtifacts: jest.fn<any>().mockResolvedValue([]),
    },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "persist-test-"));
    logger = makeLogger();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("persists and loads learned sessions across instances", async () => {
    const cfg = makeConfig();

    // Instance 1: learn a session
    const bridge1 = new AcontextBridge(cfg, tmpDir, path.join(tmpDir, "skills"), logger);
    (bridge1 as any).client = mockClient;
    (bridge1 as any).initPromise = Promise.resolve();
    (bridge1 as any).learningSpaceId = "ls-1";

    const result1 = await bridge1.learnFromSession("sid-persist-1");
    expect(result1.status).toBe("learned");

    // Instance 2: should skip same session
    const bridge2 = new AcontextBridge(cfg, tmpDir, path.join(tmpDir, "skills"), logger);
    (bridge2 as any).client = mockClient;
    (bridge2 as any).initPromise = Promise.resolve();
    (bridge2 as any).learningSpaceId = "ls-1";

    const result2 = await bridge2.learnFromSession("sid-persist-1");
    expect(result2.status).toBe("skipped");
  });
});

// ============================================================================
// Sent Messages Persistence
// ============================================================================

describe("AcontextBridge sent messages persistence", () => {
  let tmpDir: string;
  let logger: ReturnType<typeof makeLogger>;

  const mockClient = {
    sessions: {
      list: jest.fn<any>().mockResolvedValue({ items: [], has_more: false }),
      create: jest.fn<any>().mockResolvedValue({ id: "s1" }),
      storeMessage: jest.fn<any>().mockResolvedValue({ id: "m1" }),
      flush: jest.fn<any>().mockResolvedValue({ status: 0, errmsg: "" }),
      getSessionSummary: jest.fn<any>().mockResolvedValue(""),
    },
    learningSpaces: {
      list: jest.fn<any>().mockResolvedValue({ items: [], has_more: false }),
      create: jest.fn<any>().mockResolvedValue({ id: "ls-1" }),
      listSkills: jest.fn<any>().mockResolvedValue([]),
      learn: jest.fn<any>().mockResolvedValue({ id: "learn-1" }),
    },
    skills: {
      getFile: jest.fn<any>().mockResolvedValue({ content: null }),
    },
    artifacts: {
      grepArtifacts: jest.fn<any>().mockResolvedValue([]),
    },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sent-test-"));
    logger = makeLogger();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("persists and loads sent messages across instances", async () => {
    const cfg = makeConfig();

    // Instance 1: store messages
    const bridge1 = new AcontextBridge(cfg, tmpDir, path.join(tmpDir, "skills"), logger);
    (bridge1 as any).client = mockClient;
    (bridge1 as any).initPromise = Promise.resolve();

    await bridge1.storeMessages("sid-1", [
      { role: "user", content: "hello" },
    ]);

    // Instance 2: same message should be skipped
    const bridge2 = new AcontextBridge(cfg, tmpDir, path.join(tmpDir, "skills"), logger);
    (bridge2 as any).client = mockClient;
    (bridge2 as any).initPromise = Promise.resolve();

    mockClient.sessions.storeMessage.mockClear();
    const result = await bridge2.storeMessages("sid-1", [
      { role: "user", content: "hello" },
    ]);
    expect(result.stored).toBe(0);
    expect(result.processed).toBe(1);
  });
});
