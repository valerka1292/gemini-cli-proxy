export const OPENAI_CHAT_COMPLETION_OBJECT = "chat.completion.chunk";

// Endpoint fallback order - daily endpoint first, production as fallback
// antigravity-claude-proxy uses this pattern for better reliability
export const CODE_ASSIST_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const CODE_ASSIST_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
export const CODE_ASSIST_ENDPOINT_FALLBACKS = [
    CODE_ASSIST_ENDPOINT_DAILY,
    CODE_ASSIST_ENDPOINT_PROD,
];
// Default endpoint for backward compatibility
export const CODE_ASSIST_ENDPOINT = CODE_ASSIST_ENDPOINT_DAILY;

export const CODE_ASSIST_API_VERSION = "v1internal";
export const DEFAULT_PORT = "3456";
export const DISABLE_GOOGLE_SEARCH = false;
export const DISABLE_BROWSER_AUTH = false;
export const DISABLE_AUTO_MODEL_SWITCH = false;
export const DEFAULT_TEMPERATURE = 1;

// Rate Limit Detection
export const RATE_LIMIT_STATUS_CODES = [429, 503] as const;

// Rate limit wait thresholds
export const MAX_WAIT_BEFORE_ERROR_MS = 120000; // 2 minutes - throw error if wait exceeds this

// Model Fallback Mapping - NO FALLBACKS (pro stays pro)
export const AUTO_SWITCH_MODEL_MAP = {
    // Empty - no automatic model switching, rate limit errors are returned as-is
} as const;

// Cooldown Configuration  
export const DEFAULT_COOLDOWN_MINUTES = 10;

// Max retries for rate limit errors
export const MAX_RETRIES = 3;


