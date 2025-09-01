import {
    RATE_LIMIT_STATUS_CODES,
    AUTO_SWITCH_MODEL_MAP,
    DEFAULT_COOLDOWN_MINUTES,
} from "../utils/constant.js";
import {getLogger} from "../utils/logger.js";
import chalk from "chalk";

/**
 * Type for request data that can be retried with a different model
 */
export interface RetryableRequestData {
    model: string;
    [key: string]: unknown;
}

/**
 * Type for retry functions for non-streaming requests
 */
type NonStreamingRetryFunction = (model: string, data: RetryableRequestData) => Promise<unknown>;

/**
 * Type for retry functions for streaming requests
 */
type StreamingRetryFunction = (model: string, data: RetryableRequestData) => AsyncIterable<unknown>;

/**
 * Interface representing the cooldown state for rate-limited models
 */
interface ModelCooldownState {
    [modelId: string]: {
        rateLimitedAt: number;    // Timestamp when rate limited
        statusCodes: number[];    // Which status codes triggered it
    };
}

/**
 * Helper class for automatic model switching when rate limits are encountered
 * Provides fallback mechanism with cooldown management to avoid repeated rate limit hits
 */
export class AutoModelSwitchingHelper {
    private static instance: AutoModelSwitchingHelper;
    private cooldownState: ModelCooldownState = {};
    private logger = getLogger("AUTO-SWITCH", chalk.yellow);

    /**
   * Singleton pattern - get the global instance
   */
    public static getInstance(): AutoModelSwitchingHelper {
        if (!AutoModelSwitchingHelper.instance) {
            AutoModelSwitchingHelper.instance = new AutoModelSwitchingHelper();
        }
        return AutoModelSwitchingHelper.instance;
    }

    /**
   * Get the fallback model for a given model
   * @param {string} model - Current model that hit rate limits
   * @returns {string | null} Fallback model or null if no fallback available
   */
    public getFallbackModel(model: string): string | null {
        return AUTO_SWITCH_MODEL_MAP[model as keyof typeof AUTO_SWITCH_MODEL_MAP] || null;
    }

    /**
   * Check if an error is a rate limit error based on status code
   * @param {number} statusCode - HTTP status code from the error
   * @returns {boolean} True if the status code indicates rate limiting
   */
    public isRateLimitError(statusCode: number): boolean {
        return this.isRateLimitStatus(statusCode);
    }

    /**
   * Check if a status code indicates rate limiting
   * @param {number} statusCode - HTTP status code to check
   * @returns {boolean} True if status code is in RATE_LIMIT_STATUS_CODES
   */
    public isRateLimitStatus(statusCode: number): boolean {
        return (RATE_LIMIT_STATUS_CODES as readonly number[]).includes(statusCode);
    }

    /**
   * Determine if fallback should be attempted for a model
   * @param {string} model - Model to check for fallback availability
   * @returns {boolean} True if fallback should be attempted
   */
    public shouldAttemptFallback(model: string): boolean {
        if (this.isModelInCooldown(model)) return false;
        return this.getFallbackModel(model) !== null;
    }

    /**
   * Create a downgrade notification message with status codes
   * @param {string} fromModel - Original model that was rate limited
   * @param {string} toModel - Fallback model being used
   * @param {number} statusCode - HTTP status code that triggered the switch
   * @returns {string} Formatted downgrade notification message
   */
    public createDowngradeNotification(fromModel: string, toModel: string, statusCode: number): string {
        return `<${statusCode}> You are downgraded from ${fromModel} to ${toModel} because of rate limits`;
    }

    /**
   * Create an upgrade notification message for rate limit recovery
   * @param {string} model - Model that is now available again
   * @returns {string} Formatted upgrade notification message
   */
    public createUpgradeNotification(model: string): string {
        return `Model upgraded: Now using ${model} (rate limits cleared)`;
    }

    /**
   * Add a model to cooldown state when it hits rate limits
   * @param {string} model - Model that encountered rate limits
   * @param {number} statusCode - HTTP status code that triggered rate limiting
   */
    public addRateLimitedModel(model: string, statusCode: number): void {
        const now = Date.now();
        if (!this.cooldownState[model]) {
            this.cooldownState[model] = {
                rateLimitedAt: now,
                statusCodes: [statusCode],
            };
        } else {
            this.cooldownState[model].rateLimitedAt = now;
            if (!this.cooldownState[model].statusCodes.includes(statusCode)) {
                this.cooldownState[model].statusCodes.push(statusCode);
            }
        }
    
        this.logger.info(`Model ${model} added to cooldown due to status code ${statusCode}`);
    }

    /**
   * Check if a model is currently in cooldown
   * @param {string} model - Model to check cooldown status
   * @returns {boolean} True if model is in cooldown period
   */
    public isModelInCooldown(model: string): boolean {
        const modelState = this.cooldownState[model];
        if (!modelState) return false;

        const now = Date.now();
        const cooldownDuration = DEFAULT_COOLDOWN_MINUTES * 60 * 1000; // Convert to milliseconds
        const isInCooldown = (now - modelState.rateLimitedAt) < cooldownDuration;

        // Clean up expired cooldown
        if (!isInCooldown) {
            delete this.cooldownState[model];
        }

        return isInCooldown;
    }

    /**
   * Get the best available model considering cooldown states
   * @param {string} preferredModel - Initially preferred model
   * @returns {string} Best available model that's not in cooldown
   */
    public getBestAvailableModel(preferredModel: string): string {
        let currentModel = preferredModel;
    
        // Walk through the fallback chain to find first available model
        while (currentModel && this.isModelInCooldown(currentModel)) {
            const fallback = this.getFallbackModel(currentModel);
            if (!fallback) break;
            currentModel = fallback;
        }

        return currentModel || preferredModel; // Fallback to original if all are in cooldown
    }

    /**
   * Handle fallback for non-streaming requests
   * @param {string} originalModel - The model that encountered rate limits
   * @param {number} statusCode - HTTP status code from the rate limit error
   * @param {any} requestData - Original request data to retry with fallback model
   * @param {Function} retryFunction - Function to call for retry with new model
   * @returns {Promise<any>} Result from the retry attempt
   */
    public async handleNonStreamingFallback(
        originalModel: string,
        statusCode: number,
        requestData: RetryableRequestData,
        retryFunction: NonStreamingRetryFunction
    ): Promise<unknown> {
        if (!this.shouldAttemptFallback(originalModel)) {
            throw new Error(`No fallback available for model ${originalModel}`);
        }

        // Add original model to cooldown
        this.addRateLimitedModel(originalModel, statusCode);

        // Get fallback model
        const fallbackModel = this.getFallbackModel(originalModel);
        if (!fallbackModel) {
            throw new Error(`No fallback model found for ${originalModel}`);
        }

        this.logger.info(`Attempting fallback from ${originalModel} to ${fallbackModel} due to rate limit`);

        // Create downgrade notification
        const notification = this.createDowngradeNotification(originalModel, fallbackModel, statusCode);
    
        // Update request data with fallback model
        const updatedData = {...requestData, model: fallbackModel};

        try {
            const result = await retryFunction(fallbackModel, updatedData);
      
            // Add notification to response if it's a non-streaming response
            if (result && typeof result === "object") {
                (result as unknown as {_autoSwitchNotification?: string})._autoSwitchNotification = notification;
            }

            return result;
        } catch (error) {
            this.logger.error(`Fallback to ${fallbackModel} also failed`, error);
            throw error;
        }
    }

    /**
   * Handle fallback for streaming requests
   * @param {string} originalModel - The model that encountered rate limits
   * @param {number} statusCode - HTTP status code from the rate limit error
   * @param {any} requestData - Original request data to retry with fallback model
   * @param {Function} retryFunction - Function to call for retry with new model
   * @param {string} streamFormat - Format for streaming ('openai' or 'anthropic')
   * @returns {AsyncIterable<any>} Stream from the retry attempt with notification
   */
    public async* handleStreamingFallback(
        originalModel: string,
        statusCode: number,
        requestData: RetryableRequestData,
        retryFunction: StreamingRetryFunction,
        _streamFormat: "openai" | "anthropic" = "openai"
    ): AsyncIterable<unknown> {
        if (!this.shouldAttemptFallback(originalModel)) {
            throw new Error(`No fallback available for model ${originalModel}`);
        }

        // Add original model to cooldown
        this.addRateLimitedModel(originalModel, statusCode);

        // Get fallback model
        const fallbackModel = this.getFallbackModel(originalModel);
        if (!fallbackModel) {
            throw new Error(`No fallback model found for ${originalModel}`);
        }

        this.logger.info(`Attempting streaming fallback from ${originalModel} to ${fallbackModel} due to rate limit`);

        // Create downgrade notification
        const notification = this.createDowngradeNotification(originalModel, fallbackModel, statusCode);
    
        // Update request data with fallback model
        const updatedData = {...requestData, model: fallbackModel};

        try {
            // Log notification to console only (don't inject into stream)
            this.logger.info(`🔄 ${notification}`);

            // Yield results from fallback model
            const stream = retryFunction(fallbackModel, updatedData);
            for await (const chunk of stream) {
                yield chunk;
            }
        } catch (error) {
            this.logger.error(`Streaming fallback to ${fallbackModel} also failed`, error);
            throw error;
        }
    }
}
