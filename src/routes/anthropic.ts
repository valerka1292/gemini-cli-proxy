import express from "express";
import {GeminiApiClient} from "../gemini/client.js";
import * as Anthropic from "../types/anthropic.js";
import {mapAnthropicMessagesRequestToGemini, mapGeminiResponseToAnthropic} from "../gemini/anthropic-mapper.js";
import * as Gemini from "../types/gemini.js";
import {getLogger} from "../utils/logger.js";
import chalk from "chalk";

export function createAnthropicRouter(geminiClient: GeminiApiClient): express.Router {
    const router = express.Router();
    const logger = getLogger("SERVER-ANTHROPIC", chalk.green);

    router.get("/v1/models", (_req, res) => {
        const data = Object.values(Gemini.Model).map((modelId) => ({
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
        try {
            const body = req.body as Anthropic.MessagesRequest;
            
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
                // Streaming response
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                res.setHeader("Access-Control-Allow-Origin", "*");

                try {
                    // Send message_start event
                    const messageStart: Anthropic.MessageStartEvent = {
                        type: "message_start",
                        message: {
                            id: requestId,
                            type: "message",
                            role: "assistant",
                            content: [],
                            model: body.model,
                            stop_reason: "end_turn",
                            usage: {
                                input_tokens: 0,
                                output_tokens: 0
                            }
                        }
                    };
                    res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);

                    // Send content_block_start event
                    const contentBlockStart: Anthropic.ContentBlockStartEvent = {
                        type: "content_block_start",
                        index: 0,
                        content_block: {
                            type: "text",
                            text: ""
                        }
                    };
                    res.write(`event: content_block_start\ndata: ${JSON.stringify(contentBlockStart)}\n\n`);

                    const geminiStream = geminiClient.streamContent(geminiRequest);
                    let totalContent = "";
                    
                    for await (const chunk of geminiStream) {
                        if (chunk.choices && chunk.choices[0]?.delta?.content) {
                            const deltaText = chunk.choices[0].delta.content;
                            totalContent += deltaText;
                            
                            const contentDelta: Anthropic.ContentBlockDeltaEvent = {
                                type: "content_block_delta",
                                index: 0,
                                delta: {
                                    type: "text_delta",
                                    text: deltaText
                                }
                            };
                            res.write(`event: content_block_delta\ndata: ${JSON.stringify(contentDelta)}\n\n`);
                        }
                    }

                    // Send content_block_stop event
                    const contentBlockStop: Anthropic.ContentBlockStopEvent = {
                        type: "content_block_stop",
                        index: 0
                    };
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`);

                    // Send message_delta event (with final usage)
                    const messageDelta: Anthropic.MessageDeltaEvent = {
                        type: "message_delta",
                        delta: {
                            stop_reason: "end_turn"
                        },
                        usage: {
                            output_tokens: Math.ceil(totalContent.length / 4) // Rough token estimate
                        }
                    };
                    res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);

                    // Send message_stop event
                    const messageStop: Anthropic.MessageStopEvent = {
                        type: "message_stop"
                    };
                    res.write(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`);

                    res.end();
                } catch (error) {
                    logger.error("streaming error", error);
                    if (!res.headersSent) {
                        const errorMessage = error instanceof Error ? error.message : "Unknown stream error";
                        const anthropicError: Anthropic.AnthropicError = {
                            type: "error",
                            error: {
                                type: "api_error",
                                message: errorMessage
                            }
                        };
                        res.status(500).json(anthropicError);
                    } else {
                        res.end();
                    }
                }
            } else {
                // Non-streaming response
                try {
                    const completion = await geminiClient.getCompletion(geminiRequest);
                    
                    const response = mapGeminiResponseToAnthropic(
                        completion,
                        body.model,
                        requestId
                    );


                    res.json(response);
                } catch (completionError: unknown) {
                    const errorMessage = completionError instanceof Error 
                        ? completionError.message 
                        : String(completionError);

                    logger.error("completion error", completionError);
                    
                    const error: Anthropic.AnthropicError = {
                        type: "error",
                        error: {
                            type: "api_error",
                            message: errorMessage
                        }
                    };
                    
                    res.status(500).json(error);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
            logger.error("completion error", error);
            
            if (!res.headersSent) {
                const anthropicError: Anthropic.AnthropicError = {
                    type: "error",
                    error: {
                        type: "api_error",
                        message: errorMessage
                    }
                };
                res.status(500).json(anthropicError);
            } else {
                res.end();
            }
        }
    });

    return router;
}
