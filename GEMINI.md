# GEMINI.md

## Development Commands

### Build & Development
- `npm run dev` - Start development server with hot reload using ts-node
- `npm run build` - Build TypeScript to JavaScript in `dist/` directory
- `npm start` - Start production server from built files

### Testing
- `npm test` - Run all tests
- `npm test:cov` - Run all tests with coverage report
- `vitest <test-file>` - Run specific test file
- Coverage reports are generated in `coverage/` directory

### Code Quality
- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint -- --fix` - Auto-fix linting issues
- Follow `.editorconfig` for code formatting (4-space indentation, double quotes)

## Architecture Overview

This is a proxy server that provides OpenAI and Anthropic Claude-compatible APIs backed by Google's Gemini models through the Code Assist endpoint.

### Core Components

**Main Server (`src/index.ts`)**
- Express server with custom JSON parsing middleware
- Command-line interface using Commander.js
- Google OAuth authentication setup
- Health check endpoint at `/health`

**API Routes**
- `/openai/*` - OpenAI-compatible endpoints (chat completions, models)
- `/anthropic/*` - Anthropic Claude-compatible endpoints (messages, models)

**Gemini Client (`src/gemini/client.ts`)**
- `GeminiApiClient` class handles Google Code Assist API communication
- Project discovery and authentication management
- Both streaming and non-streaming completion support

**Type System (`src/types/`)**
- Comprehensive TypeScript definitions for OpenAI, Anthropic, and Gemini APIs
- Separate type files for each API format

**Mappers (`src/gemini/`)**
- `openai-mapper.ts` - Converts OpenAI requests to Gemini format
- `anthropic-mapper.ts` - Converts Anthropic requests to Gemini format and responses back
- Handles model mapping (Claude models → Gemini models)
- Tool schema conversion with `$schema` removal for Anthropic compatibility

### Authentication Flow
Uses Google OAuth2 for authentication with Code Assist API. Can run in browser mode (default) or disable browser auth for code-based flow.


