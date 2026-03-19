# @acontext/opencode

Acontext skill memory plugin for [OpenCode](https://opencode.ai/) — auto-capture conversations, auto-learn skills, and make them available to your AI assistant.

## Features

- **Auto-capture**: stores each conversation turn to an Acontext session
- **Skill sync**: downloads learned skills from your Learning Space
- **Auto-learn**: triggers skill distillation after sessions reach a turn threshold
- **3 custom tools**:
  - `acontext_search_skills` — search through learned skill files by keyword
  - `acontext_session_history` — get task summaries from recent past sessions
  - `acontext_learn_now` — trigger skill learning from the current session immediately
- **System prompt injection**: injects learned skill descriptions into the system prompt so the AI knows what skills are available

## Quick Start

### 1. Install

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@acontext/opencode"]
}
```

### 2. Configure

The plugin reads configuration from environment variables and `~/.acontext/credentials.json`.

**Option A: Use `acontext login` (recommended)**

```bash
npx acontext login
```

This creates `~/.acontext/credentials.json` with your API key.

**Option B: Set environment variables**

```bash
export ACONTEXT_API_KEY="sk-ac-your-key-here"
```

### 3. Use

Start OpenCode normally. The plugin will:

1. Automatically capture your conversations
2. Learn skills after enough turns (default: 4)
3. Make learned skills available via tools and system prompt

## Configuration

All configuration is via environment variables:

| Variable | Description | Default |
|---|---|---|
| `ACONTEXT_API_KEY` | API key for Acontext | (from `~/.acontext/credentials.json`) |
| `ACONTEXT_BASE_URL` | API base URL | `https://api.acontext.app/api/v1` |
| `ACONTEXT_USER_ID` | User identifier | (from `~/.acontext/auth.json` or `"opencode"`) |
| `ACONTEXT_LEARNING_SPACE_ID` | Learning Space ID | (auto-created) |
| `ACONTEXT_AUTO_CAPTURE` | Enable auto-capture | `true` (set to `"false"` to disable) |
| `ACONTEXT_AUTO_LEARN` | Enable auto-learn | `true` (set to `"false"` to disable) |
| `ACONTEXT_MIN_TURNS` | Minimum turns before auto-learn triggers | `4` |
| `ACONTEXT_CONFIG_DIR` | Override config directory | `~/.acontext` |

## Tools

### `acontext_search_skills`

Search through learned skill files by keyword or regex pattern.

```
Arguments:
  query: string  — Search keyword or regex pattern
  limit?: number — Max results (default: 10)
```

### `acontext_session_history`

Get task summaries from recent past sessions to recall what was done previously.

```
Arguments:
  limit?: number — Max sessions to include (default: 3)
```

### `acontext_learn_now`

Trigger skill learning from the current session immediately. Distills reusable skills from the current conversation.

```
Arguments: (none)
```

## How It Works

1. **Capture**: Each conversation turn is stored to an Acontext session via the `chat.message` hook
2. **Learn**: After enough turns, the session is submitted to Learning Space for skill distillation
3. **Sync**: Learned skills are downloaded to `~/.opencode/skills/` for local access
4. **Inject**: Skill descriptions are injected into the system prompt via `experimental.chat.system.transform`
5. **Search**: The `acontext_search_skills` tool lets the AI search through learned skill content

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test
```

## License

Apache-2.0
