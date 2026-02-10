import {OAuth2Client} from "google-auth-library";
import * as readline from "node:readline";
import * as OpenAI from "../types/openai.js";
import * as Gemini from "../types/gemini.js";
import {CODE_ASSIST_API_VERSION, CODE_ASSIST_ENDPOINT, OPENAI_CHAT_COMPLETION_OBJECT} from "../utils/constant.js";
import {AutoModelSwitchingHelper, type RetryableRequestData} from "./auto-model-switching.js";
import {getLogger, Logger} from "../utils/logger.js";
import chalk from "chalk";

/**
 * Custom error class for Gemini API errors with status code information
 */
export class GeminiApiError extends Error {
    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly responseText?: string
    ) {
        super(message);
        this.name = "GeminiApiError";
    }
}

/**
 * Handles communication with Google's Gemini API through the Code Assist endpoint.
 */
type ReadableLike = {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
};

const isReadableLike = (value: unknown): value is ReadableLike => typeof value === "object" && value !== null && "on" in value && typeof (value as {on?: unknown}).on === "function";

export class GeminiApiClient {
    private projectId: string | null = null;
    private firstChunk: boolean = true;
    private readonly creationTime: number;
    private readonly chatID: string;
    private readonly autoSwitcher: AutoModelSwitchingHelper;
    private readonly logger: Logger;

    constructor(
        private readonly authClient: OAuth2Client,
        private readonly googleCloudProject: string | undefined,
        private readonly disableAutoModelSwitch: boolean,
    ) {
        this.googleCloudProject = googleCloudProject;
        this.chatID = `chat-${crypto.randomUUID()}`;
        this.creationTime = Math.floor(Date.now() / 1000);
        this.autoSwitcher = AutoModelSwitchingHelper.getInstance();
        this.logger = getLogger("GEMINI-CLIENT", chalk.blue);
    }

    /**
     * Discovers the Google Cloud project ID.
     */
    public async discoverProjectId(): Promise<string> {
        if (this.googleCloudProject) {
            return this.googleCloudProject;
        }
        if (this.projectId) {
            return this.projectId;
        }

        // Check environment variables first (like gemini-cli)
        const envProject = process.env["GOOGLE_CLOUD_PROJECT"] || process.env["GOOGLE_CLOUD_PROJECT_ID"];
        if (envProject) {
            this.projectId = envProject;
            return envProject;
        }

        try {
            // gemini-cli sends undefined (omitted key) instead of "default-project"
            const loadResponse = (await this.callEndpoint("loadCodeAssist", {
                cloudaicompanionProject: undefined,
                metadata: {
                    ideType: "IDE_UNSPECIFIED",
                    platform: "PLATFORM_UNSPECIFIED",
                    pluginType: "GEMINI",
                    duetProject: undefined
                },
            })) as Gemini.ProjectDiscoveryResponse;

            if (loadResponse.cloudaicompanionProject) {
                this.projectId = loadResponse.cloudaicompanionProject;
                return loadResponse.cloudaicompanionProject;
            }

            // If no project returned, we might need onboarding or it's a new user
            const defaultTier = loadResponse.allowedTiers?.find((tier) => tier.isDefault);
            const tierId = defaultTier?.id ?? "free-tier";

            // If free tier, gemini-cli sends undefined for project during onboarding
            const onboardRequest = {
                tierId,
                cloudaicompanionProject: undefined,
                metadata: {
                    ideType: "IDE_UNSPECIFIED",
                    platform: "PLATFORM_UNSPECIFIED",
                    pluginType: "GEMINI"
                }
            };

            // Poll until operation is complete with timeout protection
            const MAX_RETRIES = 30;
            let retryCount = 0;
            let lroResponse: Gemini.OnboardUserResponse | undefined;
            while (retryCount < MAX_RETRIES) {
                lroResponse = (await this.callEndpoint("onboardUser", onboardRequest)) as Gemini.OnboardUserResponse;
                if (lroResponse.done) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
                retryCount++;
            }

            if (!lroResponse?.done) {
                throw new Error("common:errors.geminiCli.onboardingTimeout");
            }

            // Use the returned project ID
            this.projectId = lroResponse.response?.cloudaicompanionProject?.id ?? null;

            if (!this.projectId) {
                throw new Error("Could not automatically discover a valid Google Cloud Project ID.");
            }

            return this.projectId;
        } catch (error: unknown) {
            this.logger.error("Failed to discover project ID", error);
            throw new Error("Could not discover project ID.");
        }
    }

    private async callEndpoint(method: string, body: Record<string, unknown>): Promise<unknown> {
        const {token} = await this.authClient.getAccessToken();
        const response = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(body),
            },
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new GeminiApiError(
                `API call failed with status ${response.status}: ${errorText}`,
                response.status,
                errorText
            );
        }

        return response.json();
    }

    /**
     * Get non-streaming completion from Gemini API.
     */
    async getCompletion(
        geminiCompletionRequest: Gemini.ChatCompletionRequest,
        isRetry: boolean = false,
    ): Promise<{
        content: string;
        tool_calls?: OpenAI.ToolCall[];
        usage?: {
            inputTokens: number;
            outputTokens: number;
        };
        _autoSwitchNotification?: string;
    }> {
        this.logger.debug(`Getting completion for model: ${geminiCompletionRequest.model}`);
        try {
            const chunks: OpenAI.StreamChunk[] = [];
            for await (const chunk of this.streamContent(geminiCompletionRequest, isRetry)) {
                chunks.push(chunk);
            }

            let content = "";
            const tool_calls: OpenAI.ToolCall[] = [];
            let usage: {inputTokens: number; outputTokens: number} | undefined;

            for (const chunk of chunks) {
                if (chunk.choices[0].delta.content) {
                    content += chunk.choices[0].delta.content;
                }
                if (chunk.choices[0].delta.tool_calls) {
                    tool_calls.push(...chunk.choices[0].delta.tool_calls);
                }
                if (chunk.usage) {
                    usage = {
                        inputTokens: chunk.usage.prompt_tokens,
                        outputTokens: chunk.usage.completion_tokens,
                    };
                }
            }

            this.logger.debug(`Completion finished. Content length: ${content.length}, Tool calls: ${tool_calls.length}, Usage: ${JSON.stringify(usage)}`);

            return {
                content,
                tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
                usage,
            };
        } catch (error) {
            if (error instanceof GeminiApiError &&
                !this.disableAutoModelSwitch &&
                this.autoSwitcher.isRateLimitError(error.statusCode) &&
                this.autoSwitcher.shouldAttemptFallback(geminiCompletionRequest.model)) {

                // Attempt fallback using auto-switching helper
                return await this.autoSwitcher.handleNonStreamingFallback(
                    geminiCompletionRequest.model,
                    error.statusCode,
                    geminiCompletionRequest,
                    async (model: string, data: RetryableRequestData) => {
                        const updatedRequest = {...data, model} as Gemini.ChatCompletionRequest;
                        return await this.getCompletion(updatedRequest, isRetry);
                    }
                ) as Promise<{
                    content: string;
                    tool_calls?: OpenAI.ToolCall[];
                    usage?: {
                        inputTokens: number;
                        outputTokens: number;
                    };
                    _autoSwitchNotification?: string;
                }>;
            }
            throw error;
        }
    }

    /**
     * Stream content from Gemini API.
     */
    async* streamContent(
        geminiCompletionRequest: Gemini.ChatCompletionRequest,
        isRetry: boolean = false,
    ): AsyncGenerator<OpenAI.StreamChunk> {
        try {
            yield* this.streamContentInternal(geminiCompletionRequest, isRetry);
        } catch (error) {
            if (error instanceof GeminiApiError &&
                !this.disableAutoModelSwitch &&
                this.autoSwitcher.isRateLimitError(error.statusCode) &&
                this.autoSwitcher.shouldAttemptFallback(geminiCompletionRequest.model)) {

                // eslint-disable-next-line @typescript-eslint/no-this-alias
                const self = this;
                yield* this.autoSwitcher.handleStreamingFallback(
                    geminiCompletionRequest.model,
                    error.statusCode,
                    geminiCompletionRequest,
                    async function* (model: string, data: RetryableRequestData) {
                        const updatedRequest = {...data, model} as Gemini.ChatCompletionRequest;
                        // Create new client instance to reset firstChunk state
                        const fallbackClient = new GeminiApiClient(
                            self.authClient,
                            self.googleCloudProject,
                            self.disableAutoModelSwitch,
                        );
                        yield* fallbackClient.streamContent(updatedRequest, isRetry);
                    },
                    "openai"
                ) as AsyncIterable<OpenAI.StreamChunk>;
                return;
            }
            throw error;
        }
    }

    /**
     * Internal streaming method with no retry logic
     */
    private async* streamContentInternal(
        geminiCompletionRequest: Gemini.ChatCompletionRequest,
        isRetry: boolean = false,
    ): AsyncGenerator<OpenAI.StreamChunk> {
        this.logger.info("Starting stream request...");

        // Match gemini-cli's CAGenerateContentRequest structure
        // See: gemini-cli/packages/core/src/code_assist/converter.ts
        const payload = {
            ...geminiCompletionRequest,
            user_prompt_id: crypto.randomUUID(),
        };

        // Inject session_id if missing (gemini-cli uses this.sessionId)
        if (payload.request && !payload.request.session_id) {
            payload.request.session_id = this.chatID;
        }

        try {
            // Using authClient.request() exactly like gemini-cli's CodeAssistServer.requestStreamingPost
            // See: gemini-cli/packages/core/src/code_assist/server.ts
            const version = "0.25.0";
            const userAgent = `GeminiCLI/${version}/${payload.model} (${process.platform}; ${process.arch})`;

            const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent`;
            const installationId = "68260397-5066-4f72-b0d2-9f92585ddd1c";
            this.logger.info(`Making request to: ${url}`);

            const headers: Record<string, string> = {
                "Content-Type": "application/json",
                "User-Agent": userAgent,
                "x-gemini-api-privileged-user-id": installationId,
            };

            const res = await this.authClient.request({
                url,
                method: "POST",
                params: {
                    alt: "sse",
                },
                headers,
                responseType: "stream",
                body: JSON.stringify(payload),
                validateStatus: (status) => (status >= 200 && status < 300) || status === 400,
                retryConfig: {
                    retry: 3,
                    retryDelay: 1000,
                    statusCodesToRetry: [[429, 429], [500, 599]],
                    onRetryAttempt: (err) => {
                        this.logger.warn(`Retrying request due to ${err.code || err.message}. Attempt ${err.config.retryConfig?.currentRetryAttempt}`);
                    }
                }
            });

            if (res.status === 400) {
                const stream = res.data as NodeJS.ReadableStream;
                let errorBody = "";
                for await (const chunk of stream) {
                    errorBody += chunk.toString();
                }
                this.logger.error(`API ERROR 400 BODY: ${errorBody}`);

                let errorMessage = `API call failed with status 400: ${errorBody}`;
                try {
                    const parsed = JSON.parse(errorBody);
                    if (parsed.error) {
                        errorMessage = `API Error ${parsed.error.code} (${parsed.error.status}): ${parsed.error.message}`;
                    }
                } catch { /* ignore */ }

                throw new GeminiApiError(errorMessage, 400, errorBody);
            }

            this.logger.info("Response received, starting SSE parsing...");

            // Use readline exactly like gemini-cli does
            const rl = readline.createInterface({
                input: res.data as NodeJS.ReadableStream,
                crlfDelay: Infinity, // Recognizes '\r\n' and '\n' as line breaks
            });

            let bufferedLines: string[] = [];
            let toolCallId: string | undefined = undefined;
            let usageData: OpenAI.UsageData | undefined;
            let thinkingInProgress = false;

            for await (const line of rl) {
                if (line.startsWith("data: ")) {
                    bufferedLines.push(line.slice(6).trim());
                } else if (line === "") {
                    if (bufferedLines.length === 0) {
                        continue; // no data to yield
                    }

                    try {
                        const jsonData = JSON.parse(bufferedLines.join("\n")) as Gemini.Response;
                        bufferedLines = []; // Reset the buffer after parsing

                        const candidate = jsonData.response?.candidates?.[0];

                        if (candidate?.content?.parts) {
                            for (const part of candidate.content.parts as Gemini.Part[]) {
                                if ("text" in part) {
                                    // Handle text content
                                    // Check for thinking content
                                    const isThinking = part.thought === true;

                                    if (isThinking) {
                                        // Handle thinking content from Gemini - pass through native format
                                        const thinkingText = part.text;
                                        const signature = part.thought_signature || part.thoughtSignature || "";
                                        if (signature) {
                                            this.logger.debug(`Captured thought signature: ${signature.substring(0, 10)}...`);
                                        }

                                        // Pass through native Gemini format for Anthropic handler
                                        const delta: OpenAI.StreamDelta = {
                                            content: thinkingText,
                                            // Custom fields for native Gemini format pass-through
                                            _thought: true,
                                            _thoughtSignature: signature,
                                        };

                                        if (this.firstChunk) {
                                            delta.role = "assistant";
                                            this.firstChunk = false;
                                        }

                                        if (!thinkingInProgress) {
                                            delta._thinkingStart = true;
                                            thinkingInProgress = true;
                                        }

                                        yield this.createOpenAIChunk(delta, geminiCompletionRequest.model);
                                    } else {
                                        // Handle regular content
                                        if (thinkingInProgress) {
                                            // Signal end of thinking block
                                            const closingDelta: OpenAI.StreamDelta = {
                                                content: "",
                                                _thinkingEnd: true,
                                            };
                                            yield this.createOpenAIChunk(closingDelta, geminiCompletionRequest.model);
                                            thinkingInProgress = false;
                                        }

                                        const delta: OpenAI.StreamDelta = {content: part.text};
                                        if (this.firstChunk) {
                                            delta.role = "assistant";
                                            this.firstChunk = false;
                                        }
                                        yield this.createOpenAIChunk(delta, geminiCompletionRequest.model);
                                    }
                                }
                                else if ("functionCall" in part) {
                                    // Handle function calls from Gemini
                                    if (thinkingInProgress) {
                                        // Signal end of thinking block
                                        const closingDelta: OpenAI.StreamDelta = {
                                            content: "",
                                            _thinkingEnd: true,
                                        };
                                        yield this.createOpenAIChunk(closingDelta, geminiCompletionRequest.model);
                                        thinkingInProgress = false;
                                    }

                                    // Get thoughtSignature from the part if available
                                    const partSignature = part.thought_signature || part.thoughtSignature || "";

                                    toolCallId = `call_${crypto.randomUUID()}`;
                                    const delta: OpenAI.StreamDelta = {
                                        tool_calls: [{
                                            index: 0,
                                            id: toolCallId,
                                            type: "function",
                                            function: {
                                                name: part.functionCall.name,
                                                arguments: JSON.stringify(part.functionCall.args)
                                            },
                                            // Pass through signature for tool calls
                                            _thoughtSignature: partSignature,
                                        }]
                                    };

                                    if (this.firstChunk) {
                                        delta.role = "assistant";
                                        delta.content = null;
                                        this.firstChunk = false;
                                    }

                                    yield this.createOpenAIChunk(delta, geminiCompletionRequest.model);
                                }
                            }
                        }

                        if (jsonData.response?.usageMetadata) {
                            const usage = jsonData.response.usageMetadata;
                            const prompt_tokens = usage.promptTokenCount ?? 0;
                            const completion_tokens = usage.candidatesTokenCount ?? 0;
                            usageData = {
                                prompt_tokens,
                                completion_tokens,
                                total_tokens: prompt_tokens + completion_tokens,
                            };
                        }

                        if (candidate?.finishReason) {
                            const fr = toolCallId ? "tool_calls" : "stop";
                            const chunk = this.createOpenAIChunk({}, geminiCompletionRequest.model, fr);
                            if (usageData) {
                                chunk.usage = usageData;
                            }
                            yield chunk;
                            this.logger.debug(`Stream explicitly finished due to finishReason: ${candidate.finishReason}`);
                            return; // Exit the generator
                        }
                    } catch (parseError) {
                        this.logger.error("Error parsing SSE JSON", parseError);
                        bufferedLines = [];
                    }
                }
                // Ignore other lines like comments or id fields
            }

            // Ensure thinking block is closed if the stream ends
            if (thinkingInProgress) {
                const closingDelta: OpenAI.StreamDelta = {
                    content: "",
                    _thinkingEnd: true,
                };
                yield this.createOpenAIChunk(closingDelta, geminiCompletionRequest.model);
            }

            // Send final chunk with usage data
            const finishReason = toolCallId ? "tool_calls" : "stop";
            const finalChunk = this.createOpenAIChunk({}, geminiCompletionRequest.model, finishReason);

            if (usageData) {
                finalChunk.usage = usageData;
            }

            yield finalChunk;

        } catch (error: unknown) {
            const err = error as {
                message?: string;
                response?: {
                    status?: number;
                    headers?: Record<string, string>;
                    data?: unknown;
                };
            };

            // Handle 401 retry
            if (err.response?.status === 401 && !isRetry) {
                this.logger.info("Got 401 error, forcing token refresh and retrying...");
                this.authClient.credentials.access_token = undefined;
                yield* this.streamContentInternal(geminiCompletionRequest, true);
                return;
            }

            // Handle 429 rate limit errors specifically
            if (err.response?.status === 429) {
                this.logger.warn("Rate limited (429). Parsing reset time...");

                // Try to get retry-after from headers
                const retryAfter = err.response.headers?.["retry-after"];
                let resetMs = 60000; // Default 1 minute

                if (retryAfter) {
                    const seconds = parseInt(retryAfter, 10);
                    if (!isNaN(seconds)) {
                        resetMs = seconds * 1000;
                    }
                }

                // Try to extract reset time from error body
                let errorBody = "";
                try {
                    const errorData = err.response?.data;
                    if (errorData) {
                        if (isReadableLike(errorData)) {
                            // Stream
                            const chunks: Buffer[] = [];
                            await new Promise<void>((resolve) => {
                                errorData.on("data", (d) => chunks.push(Buffer.from(d as Buffer | string)));
                                errorData.on("end", () => resolve());
                                errorData.on("error", () => resolve());
                                setTimeout(() => resolve(), 2000);
                            });
                            errorBody = Buffer.concat(chunks).toString("utf-8");
                        } else if (typeof errorData === "string") {
                            errorBody = errorData;
                        }
                    }
                } catch { /* ignore */ }

                // Parse reset time from error body (Google sometimes includes it)
                const resetMatch = errorBody.match(/quota.*?reset.*?(\d+)\s*(seconds?|minutes?|hours?)/i);
                if (resetMatch) {
                    const value = parseInt(resetMatch[1], 10);
                    const unit = resetMatch[2].toLowerCase();
                    if (unit.startsWith("minute")) {
                        resetMs = value * 60 * 1000;
                    } else if (unit.startsWith("hour")) {
                        resetMs = value * 60 * 60 * 1000;
                    } else {
                        resetMs = value * 1000;
                    }
                }

                const resetTime = new Date(Date.now() + resetMs).toISOString();
                const humanReadable = resetMs >= 60000
                    ? `${Math.ceil(resetMs / 60000)} minute(s)`
                    : `${Math.ceil(resetMs / 1000)} second(s)`;

                const errorMessage = `RESOURCE_EXHAUSTED: Rate limited on ${geminiCompletionRequest.model}. Quota will reset after ${humanReadable}. Next available: ${resetTime}`;
                this.logger.error(errorMessage);
                throw new GeminiApiError(errorMessage, 429, errorBody || undefined);
            }

            // Extract error message for other errors
            let errorMessage = `Stream request failed: ${err.message || String(error)}`;
            const statusCode = err.response?.status || 500;

            // Try to read error body from streaming response
            if (err.response) {
                try {
                    const errorData = err.response?.data;
                    if (errorData) {
                        if (isReadableLike(errorData)) {
                            // It's a stream
                            const chunks: Buffer[] = [];
                            try {
                                const collected = await new Promise<Buffer[]>((resolve, reject) => {
                                    const c: Buffer[] = [];
                                    errorData.on("data", (d) => c.push(Buffer.from(d as Buffer | string)));
                                    errorData.on("end", () => resolve(c));
                                    errorData.on("error", reject);
                                    setTimeout(() => resolve(c), 2000);
                                });
                                chunks.push(...collected);
                            } catch { /* ignore */ }

                            if (chunks.length > 0) {
                                const errorBody = Buffer.concat(chunks).toString("utf-8");
                                try {
                                    const parsed = JSON.parse(errorBody);
                                    if (parsed.error) {
                                        errorMessage = `API Error ${parsed.error.code} (${parsed.error.status}): ${parsed.error.message}`;
                                    }
                                } catch { /* ignore */ }
                            }
                        } else {
                            const dataObj = errorData as {error?: {code?: string | number; status?: string; message?: string}};
                            if (dataObj.error) {
                                errorMessage = `API Error ${dataObj.error.code} (${dataObj.error.status}): ${dataObj.error.message}`;
                            }
                        }
                    }
                } catch { /* ignore */ }
            }

            this.logger.error("Error in streamContentInternal", error);
            const responseText = errorMessage.includes("API Error") ? errorMessage : (err.response?.data ? JSON.stringify(err.response.data) : undefined);
            throw new GeminiApiError(errorMessage, statusCode, responseText);
        }
    }

    /**
     * Creates an OpenAI stream chunk with the given delta
     */
    private createOpenAIChunk(delta: OpenAI.StreamDelta, modelId: string, finishReason: string | null = null): OpenAI.StreamChunk {
        return {
            id: this.chatID,
            object: OPENAI_CHAT_COMPLETION_OBJECT,
            created: this.creationTime,
            model: modelId,
            choices: [{
                index: 0,
                delta,
                finish_reason: finishReason,
                logprobs: null
            }],
            usage: null
        };
    }
}
