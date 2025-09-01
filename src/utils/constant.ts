export const OPENAI_CHAT_COMPLETION_OBJECT = "chat.completion.chunk";
export const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const CODE_ASSIST_API_VERSION = "v1internal";
export const DEFAULT_PORT = "3000";
export const DISABLE_GOOGLE_SEARCH = false;
export const DISABLE_BROWSER_AUTH = false;
export const DISABLE_AUTO_MODEL_SWITCH = false;
export const DEFAULT_TEMPERATURE = 1;

// Rate Limit Detection
export const RATE_LIMIT_STATUS_CODES = [429, 503] as const;

// Model Fallback Mapping
export const AUTO_SWITCH_MODEL_MAP = {
    "gemini-2.5-pro": "gemini-2.5-flash",
    "gemini-2.5-flash": "gemini-2.5-flash-lite",
} as const;

// Cooldown Configuration  
export const DEFAULT_COOLDOWN_MINUTES = 10;


