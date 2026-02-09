/**
 * Signature Cache Utility
 * 
 * Caches thinking signatures and tool call signatures for cross-turn persistence.
 * Based on antigravity-claude-proxy pattern.
 */

// Minimum signature length for validation
export const MIN_SIGNATURE_LENGTH = 100;

// Model family for signature compatibility
export type ModelFamily = "gemini" | "claude";

// Cache for thinking signatures by model family
const thinkingSignatureCache = new Map<ModelFamily, string>();

// Cache for tool call signatures by tool ID
const toolSignatureCache = new Map<string, string>();

// Cache for signature to model family mapping
const signatureFamilyMap = new Map<string, ModelFamily>();

/**
 * Get model family from model name
 */
export function getModelFamily(model: string): ModelFamily {
    if (model.includes("claude")) {
        return "claude";
    }
    return "gemini";
}

/**
 * Cache a thinking signature with its model family
 */
export function cacheThinkingSignature(signature: string, modelFamily: ModelFamily): void {
    if (!signature || signature.length < MIN_SIGNATURE_LENGTH) return;

    thinkingSignatureCache.set(modelFamily, signature);
    signatureFamilyMap.set(signature, modelFamily);
}

/**
 * Get cached thinking signature for a model family
 */
export function getCachedThinkingSignature(modelFamily: ModelFamily): string | undefined {
    return thinkingSignatureCache.get(modelFamily);
}

/**
 * Cache a tool call signature by tool ID
 */
export function cacheToolSignature(toolId: string, signature: string): void {
    if (!signature || signature.length < MIN_SIGNATURE_LENGTH) return;
    if (!toolId) return;

    toolSignatureCache.set(toolId, signature);
}

/**
 * Get cached tool signature by tool ID
 */
export function getCachedToolSignature(toolId: string): string | undefined {
    return toolSignatureCache.get(toolId);
}

/**
 * Get the model family that generated a signature
 */
export function getCachedSignatureFamily(signature: string): ModelFamily | undefined {
    return signatureFamilyMap.get(signature);
}

/**
 * Check if a signature is valid (meets minimum length)
 */
export function isValidSignature(signature: string | undefined): boolean {
    return typeof signature === "string" && signature.length >= MIN_SIGNATURE_LENGTH;
}

/**
 * Clear all caches (useful for testing)
 */
export function clearSignatureCaches(): void {
    thinkingSignatureCache.clear();
    toolSignatureCache.clear();
    signatureFamilyMap.clear();
}
