# 🚀 Gemini CLI Proxy

<div align="center">

[![Node.js](https://img.shields.io/badge/Node.js-≥20.0.0-43853D?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=for-the-badge)](LICENSE)

**Use Google Gemini models through OpenAI & Anthropic compatible APIs**

*Unlock Gemini 3 Pro, Gemini 2.5 Pro, Gemini 2.5 Flash and more with Claude Code, Aider, and your favorite AI tools!*

</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔌 **Dual API Compatibility** | OpenAI and Anthropic API endpoints in one server |
| 🧠 **Gemini 3 Support** | Full support for `gemini-3-pro-preview` and `gemini-3-flash-preview` |
| 🤔 **Extended Thinking** | Native thinking/reasoning support (like Claude's thinking blocks) |
| 🔄 **Auto Model Switching** | Automatic fallback on rate limits |
| 🌐 **Google Search Tool** | Native Google Search grounding support |
| 🔧 **Tool Calling** | Full function/tool calling support |
| 🎯 **Custom Model Aliases** | Use `gemini-3-pro-high[1m]` and similar suffixes |
| 🔐 **OAuth Authentication** | Uses Gemini CLI credentials automatically |

---

## 🎁 Free Tier Benefits

Google Gemini CodeAssist offers a generous free tier:

| Limit | Value |
|-------|-------|
| Requests per minute | 60 |
| Requests per day | 1,000 |
| Token limit | Generous |

---

## 🚀 Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/emrullahakclk/gemini-cli-proxy.git
cd gemini-cli-proxy

# Install dependencies
npm install

# Start the server
npm run dev
```

### For Production Use

```bash
# Build the project
npm run build

# Start production server
npm start
```

### Global Installation (Optional)

```bash
# Install globally from GitHub
npm install -g github:emrullahakclk/gemini-cli-proxy

# Then run anywhere
gemini-cli-proxy
```

### Server Endpoints

Once running, the server provides:

| Endpoint | URL |
|----------|-----|
| **OpenAI Compatible** | `http://localhost:3456/openai` |
| **Anthropic Compatible** | `http://localhost:3456/anthropic` |
| **Health Check** | `http://localhost:3456/health` |

---

## ⚙️ Configuration Options

```bash
# Development mode
npm run dev -- [options]

# Production mode (after npm run build)
npm start -- [options]

# If installed globally
gemini-cli-proxy [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <port>` | Server port | `3456` |
| `-g, --google-cloud-project <project>` | Google Cloud project ID (for paid/enterprise) | env variable |
| `--disable-browser-auth` | Uses code-based auth instead of browser | `false` |
| `--disable-google-search` | Disables native Google Search tool | `false` |
| `--disable-auto-model-switch` | Disables auto model switching on rate limit | `false` |

---

## 🔑 Authentication

The proxy uses Google OAuth2 authentication:

1. **First run**: Opens browser for Google login
2. **Subsequent runs**: Uses cached credentials from `~/.gemini/oauth_creds.json`
3. **Gemini CLI users**: Automatically uses existing credentials

---

## 🤖 Supported Models

### Model Aliases

| Alias | Maps To |
|-------|---------|
| `gemini-3-pro-high` | `gemini-3-pro-preview` |
| `gemini-3-pro` | `gemini-3-pro-preview` |
| `gemini-3-flash` | `gemini-3-flash-preview` |
| `gemini-3` | `gemini-3-flash-preview` |
| `gemini-2.5-pro` | `gemini-2.5-pro` |
| `gemini-2.5-flash` | `gemini-2.5-flash` |
| `gemini-2.5-flash-lite` | `gemini-2.5-flash-lite-preview` |

### Thinking Budget

You can specify a thinking budget using the `[Xm]` suffix:

```
gemini-3-pro-high[1m]   → 1 million thinking tokens
gemini-3-pro[512k]      → 512k thinking tokens
```

---

## 🛠️ Integration Examples

### Claude Code (Recommended)

Add to your `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["Edit", "Bash(npm:*)"],
    "deny": []
  },
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "not-needed",
    "ANTHROPIC_BASE_URL": "http://localhost:3456/anthropic",
    "ANTHROPIC_MODEL": "gemini-3-pro-high[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3-pro-high[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3-pro-high[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3-flash[1m]",
    "CLAUDE_CODE_SUBAGENT_MODEL": "gemini-3-pro-high[1m]",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
```

### Environment Variables (Generic)

```bash
# For OpenAI-compatible tools
export OPENAI_API_BASE=http://localhost:3456/openai
export OPENAI_API_KEY=not-needed

# For Anthropic-compatible tools
export ANTHROPIC_BASE_URL=http://localhost:3456/anthropic
export ANTHROPIC_AUTH_TOKEN=not-needed
export ANTHROPIC_MODEL=gemini-3-pro-high
```

### Aider

```bash
# Start the proxy
npx gemini-cli-proxy

# In another terminal
export OPENAI_API_BASE=http://localhost:3456/openai
export OPENAI_API_KEY=not-needed
aider --model gemini-3-pro-high
```

### Zed Editor

Add to Zed settings:

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://localhost:3456/openai",
      "available_models": [
        {
          "name": "gemini-3-pro-high",
          "display_name": "Gemini 3 Pro (via Proxy)",
          "max_tokens": 1000000
        },
        {
          "name": "gemini-3-flash",
          "display_name": "Gemini 3 Flash (via Proxy)",
          "max_tokens": 1000000
        }
      ]
    }
  }
}
```

### Continue.dev

Add to `.continue/config.json`:

```json
{
  "models": [
    {
      "title": "Gemini 3 Pro",
      "provider": "openai",
      "model": "gemini-3-pro-high",
      "apiBase": "http://localhost:3456/openai",
      "apiKey": "not-needed"
    }
  ]
}
```

---

## 🏗️ Development

### Setup

```bash
git clone https://github.com/your-username/gemini-cli-proxy.git
cd gemini-cli-proxy
npm install
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build TypeScript to JavaScript |
| `npm start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm test` | Run tests |
| `npm run test:cov` | Run tests with coverage |

### Project Structure

```
src/
├── auth/           # Google OAuth authentication
├── gemini/         # Gemini API client & mappers
│   ├── client.ts           # Core API client
│   ├── mapper.ts           # Model & schema mapping
│   ├── openai-mapper.ts    # OpenAI format conversion
│   └── anthropic-mapper.ts # Anthropic format conversion
├── routes/         # Express route handlers
│   ├── openai.ts           # /openai/* endpoints
│   └── anthropic.ts        # /anthropic/* endpoints
├── types/          # TypeScript definitions
└── utils/          # Utility functions & constants
```

---

## 🔧 Troubleshooting

### Rate Limiting (429 Error)

```
RESOURCE_EXHAUSTED: Rate limited on gemini-3-pro-preview
```

**Solutions:**
- Wait for quota reset (usually 1 minute)
- Switch to Flash model for less critical tasks
- Enable auto model switching: remove `--disable-auto-model-switch`

### Authentication Issues

```
Could not discover project ID
```

**Solutions:**
1. Delete `~/.gemini/oauth_creds.json`
2. Restart the proxy
3. Complete browser authentication

### Socket Hang Up

```
Stream request failed: socket hang up
```

**Solutions:**
- Check your internet connection
- Retry the request
- The proxy has built-in retry logic

---

## 📄 License

Apache 2.0 - See [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- [Google Gemini](https://deepmind.google/technologies/gemini/) for the amazing models
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) for the authentication flow
- Original project by [uur](https://github.com/AshishKatale)

---

<div align="center">

**⭐ Star this repo if you find it useful!**

Made with ❤️ for the AI developer community

</div>
