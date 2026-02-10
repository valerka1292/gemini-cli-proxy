import express from "express";
import {GeminiApiClient, GeminiApiError} from "../gemini/client.js";
import * as Anthropic from "../types/anthropic.js";
import {mapAnthropicMessagesRequestToGemini, mapGeminiResponseToAnthropic} from "../gemini/anthropic-mapper.js";
import * as Gemini from "../types/gemini.js";
import {getLogger} from "../utils/logger.js";
import chalk from "chalk";
import crypto from "crypto";
import * as fs from "node:fs";
import {assertModelEnabled, recordUsageFromRequest, requireProxyApiKey} from "../dashboard/security.js";
import {dashboardStore} from "../dashboard/store.js";
import {
    cacheThinkingSignature,
    cacheToolSignature,
    getModelFamily,
    isValidSignature,
} from "../utils/signature-cache.js";

export function createAnthropicRouter(geminiClient: GeminiApiClient): express.Router {
    const router = express.Router();
    const logger = getLogger("SERVER-ANTHROPIC", chalk.green);

    router.use(requireProxyApiKey);

    router.get("/v1/models", (_req, res) => {
        const data = Object.values(Gemini.Model).filter((modelId) => dashboardStore.isModelEnabled(modelId)).map((modelId) => ({
            id: modelId,
            type: "model",
            display_name: modelId,
            created_at: Math.floor(Date.now() / 1000),
            owned_by: "Google",
        }));

        res.json({
            data,
            has_more: false
        });
    });

    router.post("/v1/messages", async (req, res) => {
        // Timing: Request start
        const requestStartTime = Date.now();
        const requestTimestamp = new Date().toISOString();

        try {
            const body = req.body as Anthropic.MessagesRequest;

            logger.info(`[TIMING] Request started at ${requestTimestamp} | Model: ${body.model} | Stream: ${body.stream}`);

            const modelAccess = assertModelEnabled(body.model);
            if (!modelAccess.allowed) {
                recordUsageFromRequest(req, 403);
                const forbiddenError: Anthropic.AnthropicError = {
                    type: "error",
                    error: {
                        type: "permission_error",
                        message: modelAccess.message,
                    },
                };
                return res.status(403).json(forbiddenError);
            }

            // Optional debug logging for request/response payloads.
            // Disabled by default to avoid writing potentially sensitive prompts/tools to disk.
            const enablePayloadDebugLogs = process.env.DEBUG_LOG_PAYLOADS === "true";
            if (enablePayloadDebugLogs) {
                try {
                    const requestsDir = "requests";
                    if (!fs.existsSync(requestsDir)) {
                        fs.mkdirSync(requestsDir);
                    }
                    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                    const uniqueId = crypto.randomUUID().slice(0, 8);
                    const filename = `${requestsDir}/request_${timestamp}_${uniqueId}.json`;
                    fs.writeFileSync(filename, JSON.stringify(body, null, 2));
                    logger.info(`Saved incoming Anthropic request to ${filename}`);

                    // Also write to anthropic_request.json for easy debugging
                    fs.writeFileSync("anthropic_request.json", JSON.stringify(body, null, 2));
                } catch (err) {
                    logger.error("Failed to save anthropic request", err);
                }
            }

            // Validation
            if (!body.messages || body.messages.length === 0) {
                const error: Anthropic.AnthropicError = {
                    type: "error",
                    error: {
                        type: "invalid_request_error",
                        message: "messages is required and cannot be empty"
                    }
                };
                return res.status(400).json(error);
            }

            if (!body.max_tokens) {
                const error: Anthropic.AnthropicError = {
                    type: "error",
                    error: {
                        type: "invalid_request_error",
                        message: "max_tokens is required"
                    }
                };
                return res.status(400).json(error);
            }

            const projectId = await geminiClient.discoverProjectId();
            const geminiRequest = mapAnthropicMessagesRequestToGemini(projectId, body);
            const requestId = `msg_${crypto.randomUUID()}`;

            if (body.stream) {
                // Streaming response with native Anthropic SSE format
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("X-Accel-Buffering", "no");
                res.flushHeaders();

                try {
                    logger.info(`[TIMING] Starting Gemini stream call (${Date.now() - requestStartTime}ms since request start)`);
                    const usage = await streamAnthropicResponse(res, geminiClient, geminiRequest, body.model, requestId, logger, requestStartTime);
                    recordUsageFromRequest(req, 200, usage);
                } catch (error) {
                    logger.error("streaming error", error);
                    if (!res.headersSent) {
                        const errorMessage = error instanceof Error ? error.message : "Unknown stream error";

                        // Check if it's a rate limit error
                        const isRateLimit = error instanceof GeminiApiError && error.statusCode === 429;

                        // Use 400 for rate limits to prevent client from retrying (same as antigravity-claude-proxy)
                        const statusCode = isRateLimit ? 400 : 500;
                        const errorType = isRateLimit ? "invalid_request_error" : "api_error";

                        const anthropicError: Anthropic.AnthropicError = {
                            type: "error",
                            error: {
                                type: errorType,
                                message: errorMessage
                            }
                        };
                        recordUsageFromRequest(req, statusCode);
                        res.status(statusCode).json(anthropicError);
                    } else {
                        // Headers already sent - write error as SSE event
                        const errorMessage = error instanceof Error ? error.message : "Unknown stream error";
                        res.write(`event: error\ndata: ${JSON.stringify({
                            type: "error",
                            error: {type: "api_error", message: errorMessage}
                        })}\n\n`);
                        res.end();
                    }
                }
            } else {
                // Non-streaming response
                try {
                    const geminiCallStartTime = Date.now();
                    logger.info(`[TIMING] Starting Gemini completion call (${geminiCallStartTime - requestStartTime}ms since request start)`);
                    const completion = await geminiClient.getCompletion(geminiRequest);
                    const geminiCallDuration = Date.now() - geminiCallStartTime;
                    logger.info(`[TIMING] Gemini call completed in ${geminiCallDuration}ms`);

                    const response = mapGeminiResponseToAnthropic(
                        completion,
                        body.model,
                        requestId
                    );

                    if (enablePayloadDebugLogs) {
                        try {
                            fs.writeFileSync("response.json", JSON.stringify(response, null, 2));
                        } catch (err) {
                            logger.error("Failed to save response.json", err);
                        }
                    }

                    recordUsageFromRequest(req, 200, {
                        inputTokens: completion.usage?.inputTokens,
                        outputTokens: completion.usage?.outputTokens,
                    });
                    res.json(response);
                } catch (completionError: unknown) {
                    const errorMessage = completionError instanceof Error
                        ? completionError.message
                        : String(completionError);

                    logger.error("completion error", completionError);

                    // Check if it's a rate limit error
                    const isRateLimit = completionError instanceof GeminiApiError && completionError.statusCode === 429;
                    const statusCode = isRateLimit ? 400 : 500;
                    const errorType = isRateLimit ? "invalid_request_error" : "api_error";

                    const error: Anthropic.AnthropicError = {
                        type: "error",
                        error: {
                            type: errorType,
                            message: errorMessage
                        }
                    };

                    recordUsageFromRequest(req, statusCode);
                    res.status(statusCode).json(error);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
            logger.error("completion error", error);

            if (!res.headersSent) {
                // Check if it's a rate limit error
                const isRateLimit = error instanceof GeminiApiError && error.statusCode === 429;
                const statusCode = isRateLimit ? 400 : 500;
                const errorType = isRateLimit ? "invalid_request_error" : "api_error";

                const anthropicError: Anthropic.AnthropicError = {
                    type: "error",
                    error: {
                        type: errorType,
                        message: errorMessage
                    }
                };
                res.status(statusCode).json(anthropicError);
            } else {
                res.end();
            }
        }
    });

    return router;
}

/**
 * Stream response in native Anthropic SSE format
 * Based on antigravity-claude-proxy/src/cloudcode/sse-streamer.js
 */
async function streamAnthropicResponse(
    res: express.Response,
    geminiClient: GeminiApiClient,
    geminiRequest: Gemini.ChatCompletionRequest,
    originalModel: string,
    messageId: string,
    logger: ReturnType<typeof getLogger>,
    requestStartTime: number
): Promise<{inputTokens: number; outputTokens: number}> {
    const streamFunctionStartTime = Date.now();
    logger.info(`[TIMING] streamAnthropicResponse started (${streamFunctionStartTime - requestStartTime}ms since request)`);

    let hasEmittedStart = false;
    let blockIndex = 0;
    let currentBlockType: "thinking" | "text" | "tool_use" | null = null;
    let currentThinkingSignature = "";
    let inputTokens = 0;
    let outputTokens = 0;
    const cacheReadTokens = 0;
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
    let totalContent = "";
    const modelFamily = getModelFamily(originalModel);

    const writeEvent = (eventType: string, data: unknown) => {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof (res as express.Response & {flush?: () => void}).flush === "function") {
            (res as express.Response & {flush?: () => void}).flush?.();
        }
    };

    const geminiStream = geminiClient.streamContent(geminiRequest);

    for await (const chunk of geminiStream) {
        // Extract usage from chunk
        if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens || inputTokens;
            outputTokens = chunk.usage.completion_tokens || outputTokens;
        }

        // Get delta from chunk
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Check for native thinking signals
        const isThinking = delta._thought === true;
        const isThinkingEnd = delta._thinkingEnd === true;
        const thoughtSignature = delta._thoughtSignature || "";

        // Emit message_start on first content
        if (!hasEmittedStart && (delta.content || delta.tool_calls)) {
            hasEmittedStart = true;
            writeEvent("message_start", {
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: originalModel,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                        input_tokens: inputTokens - cacheReadTokens,
                        output_tokens: 0,
                        cache_read_input_tokens: cacheReadTokens,
                        cache_creation_input_tokens: 0
                    }
                }
            });
        }

        // Handle thinking content
        if (isThinking && delta.content) {
            if (currentBlockType !== "thinking") {
                // Close previous block if any
                if (currentBlockType !== null) {
                    writeEvent("content_block_stop", {type: "content_block_stop", index: blockIndex});
                    blockIndex++;
                }
                currentBlockType = "thinking";
                currentThinkingSignature = "";
                writeEvent("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: {type: "thinking", thinking: ""}
                });
            }

            // Cache signature if valid
            if (isValidSignature(thoughtSignature)) {
                currentThinkingSignature = thoughtSignature;
                cacheThinkingSignature(thoughtSignature, modelFamily);
            }

            // Send thinking delta
            writeEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: {type: "thinking_delta", thinking: delta.content}
            });
        }
        // Handle thinking end signal
        else if (isThinkingEnd) {
            if (currentBlockType === "thinking" && currentThinkingSignature) {
                // Emit signature delta before closing thinking block
                writeEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: {type: "signature_delta", signature: currentThinkingSignature}
                });
                currentThinkingSignature = "";
            }
            if (currentBlockType !== null) {
                writeEvent("content_block_stop", {type: "content_block_stop", index: blockIndex});
                blockIndex++;
            }
            currentBlockType = null;
        }
        // Handle regular text content
        else if (delta.content && !isThinking) {
            // Skip empty content
            if (!delta.content.trim()) continue;

            // Close thinking block if transitioning
            if (currentBlockType === "thinking") {
                if (currentThinkingSignature) {
                    writeEvent("content_block_delta", {
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: {type: "signature_delta", signature: currentThinkingSignature}
                    });
                    currentThinkingSignature = "";
                }
                writeEvent("content_block_stop", {type: "content_block_stop", index: blockIndex});
                blockIndex++;
            }

            // Start text block if not already
            if (currentBlockType !== "text") {
                currentBlockType = "text";
                writeEvent("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: {type: "text", text: ""}
                });
            }

            totalContent += delta.content;
            writeEvent("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: {type: "text_delta", text: delta.content}
            });
        }

        // Handle tool calls
        if (delta.tool_calls) {
            stopReason = "tool_use";

            // Close current block first
            if (currentBlockType === "thinking" && currentThinkingSignature) {
                writeEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: {type: "signature_delta", signature: currentThinkingSignature}
                });
                currentThinkingSignature = "";
            }
            if (currentBlockType !== null) {
                writeEvent("content_block_stop", {type: "content_block_stop", index: blockIndex});
                blockIndex++;
            }
            currentBlockType = "tool_use";

            for (const toolCall of delta.tool_calls) {
                const toolId = toolCall.id || `toolu_${crypto.randomBytes(12).toString("hex")}`;
                const toolSignature = toolCall._thoughtSignature || "";

                // Build tool_use block
                const toolUseBlock: Anthropic.ToolUse & {thoughtSignature?: string} = {
                    type: "tool_use",
                    id: toolId,
                    name: toolCall.function?.name,
                    input: {}
                };

                // Include signature if valid
                if (isValidSignature(toolSignature)) {
                    toolUseBlock.thoughtSignature = toolSignature;
                    cacheToolSignature(toolId, toolSignature);
                }

                writeEvent("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: toolUseBlock
                });

                // Send input JSON
                if (toolCall.function?.arguments) {
                    writeEvent("content_block_delta", {
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: {
                            type: "input_json_delta",
                            partial_json: toolCall.function.arguments
                        }
                    });
                }

                writeEvent("content_block_stop", {type: "content_block_stop", index: blockIndex});
                blockIndex++;
            }
            currentBlockType = null;
        }

        // Check for finish reason
        if (chunk.choices?.[0]?.finish_reason) {
            const fr = chunk.choices[0].finish_reason;
            if (fr === "tool_calls") {
                stopReason = "tool_use";
            } else if (fr === "length") {
                stopReason = "max_tokens";
            }
        }
    }

    // Handle case where no content was received
    if (!hasEmittedStart) {
        logger.warn("No content received from Gemini, emitting empty response");
        writeEvent("message_start", {
            type: "message_start",
            message: {
                id: messageId,
                type: "message",
                role: "assistant",
                content: [],
                model: originalModel,
                stop_reason: null,
                stop_sequence: null,
                usage: {input_tokens: 0, output_tokens: 0}
            }
        });
        writeEvent("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: {type: "text", text: ""}
        });
        writeEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: {type: "text_delta", text: "[No response received - please try again]"}
        });
        writeEvent("content_block_stop", {type: "content_block_stop", index: 0});
    } else {
        // Close any open block
        if (currentBlockType !== null) {
            if (currentBlockType === "thinking" && currentThinkingSignature) {
                writeEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: {type: "signature_delta", signature: currentThinkingSignature}
                });
            }
            writeEvent("content_block_stop", {type: "content_block_stop", index: blockIndex});
        }
    }

    // Emit message_delta with final usage
    writeEvent("message_delta", {
        type: "message_delta",
        delta: {stop_reason: stopReason, stop_sequence: null},
        usage: {
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: 0
        }
    });

    // Emit message_stop
    writeEvent("message_stop", {type: "message_stop"});

    // Log the final response
    try {
        const finalResponse = {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [{type: "text", text: totalContent}],
            model: originalModel,
            stop_reason: stopReason,
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens
            }
        };
        fs.writeFileSync("response.json", JSON.stringify(finalResponse, null, 2));
    } catch (err) {
        logger.error("Failed to save response.json", err);
    }

    const totalDuration = Date.now() - requestStartTime;
    logger.info(`[TIMING] Stream completed | Total: ${totalDuration}ms | Tokens: in=${inputTokens}, out=${outputTokens}`);

    res.end();

    return {inputTokens, outputTokens};
}
