import express from "express";
import { GeminiApiClient } from "../gemini/client.js";
import * as Gemini from "../types/gemini.js";
import * as OpenAI from "../types/openai.js";
import * as Responses from "../types/responses.js";
import { mapOpenAIChatCompletionRequestToGemini } from "../gemini/openai-mapper.js";
import { mapResponsesRequestToChatCompletion, buildResponseObject } from "../gemini/responses-mapper.js";
import { getLogger } from "../utils/logger.js";
import { cacheToolSignature, cacheThinkingSignature } from "../utils/signature-cache.js";
import chalk from "chalk";


export function createOpenAIRouter(geminiClient: GeminiApiClient): express.Router {
    const router = express.Router();
    const logger = getLogger("SERVER-OPENAI", chalk.green);

    // ─── Responses API ───

    router.post("/responses", async (req, res) => {
        try {
            const body = req.body as Responses.ResponsesRequest;
            if (!body.input) {
                return res.status(400).json({ error: "input is a required field" });
            }

            const chatCompletionRequest = mapResponsesRequestToChatCompletion(body);
            const projectId = await geminiClient.discoverProjectId();
            const geminiCompletionRequest = mapOpenAIChatCompletionRequestToGemini(projectId, chatCompletionRequest);

            if (body.stream) {
                // ── Streaming path ──
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                res.setHeader("Access-Control-Allow-Origin", "*");

                const responseId = `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
                const createdAt = Math.floor(Date.now() / 1000);

                const sendEvent = (event: Responses.ResponseStreamEvent) => {
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                };

                // Build the initial shell response object
                const shellResponse: Responses.ResponseObject = {
                    id: responseId,
                    object: "response",
                    created_at: createdAt,
                    model: body.model,
                    status: "in_progress",
                    output: [],
                    error: null,
                };

                sendEvent({ type: "response.created", response: { ...shellResponse, status: "in_progress" } });
                sendEvent({ type: "response.in_progress", response: { ...shellResponse, status: "in_progress" } });

                // State tracking
                let messageItemEmitted = false;
                let messageItemId = "";
                let accumulatedText = "";
                let outputIndex = 0;

                // Track tool calls: key = tool call index from stream
                const toolCallItems: Map<number, {
                    outputIndex: number;
                    itemId: string;
                    callId: string;
                    name: string;
                    args: string;
                }> = new Map();

                try {
                    const geminiStream = geminiClient.streamContent(geminiCompletionRequest);
                    for await (const chunk of geminiStream) {
                        const delta = chunk.choices[0]?.delta;
                        if (!delta) continue;

                        // Cache thinking signatures for later re-attachment to function call parts
                        const thoughtSig = (delta as any)._thoughtSignature;
                        if (thoughtSig && thoughtSig.length >= 100) {
                            cacheThinkingSignature(thoughtSig, "gemini");
                        }

                        // Handle text content (skip thinking content — it's internal to Gemini)
                        if (delta.content && !(delta as any)._thought) {
                            if (!messageItemEmitted) {
                                messageItemId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
                                const msgItem: Responses.ResponseOutputMessage = {
                                    type: "message",
                                    id: messageItemId,
                                    status: "in_progress",
                                    role: "assistant",
                                    content: [],
                                };
                                sendEvent({
                                    type: "response.output_item.added",
                                    output_index: outputIndex,
                                    item: msgItem,
                                });
                                sendEvent({
                                    type: "response.content_part.added",
                                    output_index: outputIndex,
                                    content_index: 0,
                                    part: { type: "output_text", text: "", annotations: [] },
                                });
                                messageItemEmitted = true;
                            }

                            accumulatedText += delta.content;
                            sendEvent({
                                type: "response.output_text.delta",
                                output_index: messageItemEmitted ? 0 : outputIndex,
                                content_index: 0,
                                delta: delta.content,
                            });
                        }

                        // Handle tool calls
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const tcIdx = tc.index;
                                if (!toolCallItems.has(tcIdx)) {
                                    // Close message item if still open
                                    if (messageItemEmitted && !toolCallItems.size) {
                                        // Close the text content part
                                        sendEvent({
                                            type: "response.output_text.done",
                                            output_index: 0,
                                            content_index: 0,
                                            text: accumulatedText,
                                        });
                                        sendEvent({
                                            type: "response.content_part.done",
                                            output_index: 0,
                                            content_index: 0,
                                            part: { type: "output_text", text: accumulatedText, annotations: [] },
                                        });
                                        sendEvent({
                                            type: "response.output_item.done",
                                            output_index: 0,
                                            item: {
                                                type: "message",
                                                id: messageItemId,
                                                status: "completed",
                                                role: "assistant",
                                                content: [{ type: "output_text", text: accumulatedText, annotations: [] }],
                                            },
                                        });
                                        outputIndex++;
                                    }

                                    // Start new function_call item
                                    const itemId = `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
                                    const callId = tc.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
                                    const currentOutputIndex = messageItemEmitted ? outputIndex : outputIndex;

                                    toolCallItems.set(tcIdx, {
                                        outputIndex: currentOutputIndex,
                                        itemId,
                                        callId,
                                        name: tc.function.name || "",
                                        args: "",
                                    });

                                    sendEvent({
                                        type: "response.output_item.added",
                                        output_index: currentOutputIndex,
                                        item: {
                                            type: "function_call",
                                            id: itemId,
                                            call_id: callId,
                                            name: tc.function.name || "",
                                            arguments: "",
                                            status: "in_progress",
                                        },
                                    });
                                    outputIndex++;
                                }

                                // Accumulate arguments
                                const tracked = toolCallItems.get(tcIdx)!;
                                if (tc.function.arguments) {
                                    tracked.args += tc.function.arguments;
                                    sendEvent({
                                        type: "response.function_call_arguments.delta",
                                        output_index: tracked.outputIndex,
                                        delta: tc.function.arguments,
                                    });
                                }
                                // Update name if it arrives in later chunks
                                if (tc.function.name) {
                                    tracked.name = tc.function.name;
                                }
                                // Cache thought signature for this tool call (required by Gemini thinking models)
                                const thoughtSig = (tc as any)._thoughtSignature;
                                if (thoughtSig && tracked.callId) {
                                    cacheToolSignature(tracked.callId, thoughtSig);
                                }
                            }
                        }
                    }

                    // ── Close remaining open items ──

                    // Close text message if still open and no tool calls closed it
                    if (messageItemEmitted && toolCallItems.size === 0) {
                        sendEvent({
                            type: "response.output_text.done",
                            output_index: 0,
                            content_index: 0,
                            text: accumulatedText,
                        });
                        sendEvent({
                            type: "response.content_part.done",
                            output_index: 0,
                            content_index: 0,
                            part: { type: "output_text", text: accumulatedText, annotations: [] },
                        });
                        sendEvent({
                            type: "response.output_item.done",
                            output_index: 0,
                            item: {
                                type: "message",
                                id: messageItemId,
                                status: "completed",
                                role: "assistant",
                                content: [{ type: "output_text", text: accumulatedText, annotations: [] }],
                            },
                        });
                    }

                    // Close all tool call items
                    for (const [, tracked] of toolCallItems) {
                        sendEvent({
                            type: "response.function_call_arguments.done",
                            output_index: tracked.outputIndex,
                            arguments: tracked.args,
                        });
                        sendEvent({
                            type: "response.output_item.done",
                            output_index: tracked.outputIndex,
                            item: {
                                type: "function_call",
                                id: tracked.itemId,
                                call_id: tracked.callId,
                                name: tracked.name,
                                arguments: tracked.args,
                                status: "completed",
                            },
                        });
                    }

                    // Build final completed response
                    const finalOutput: Responses.ResponseOutputItem[] = [];
                    if (messageItemEmitted) {
                        finalOutput.push({
                            type: "message",
                            id: messageItemId,
                            status: "completed",
                            role: "assistant",
                            content: [{ type: "output_text", text: accumulatedText, annotations: [] }],
                        });
                    }
                    for (const [, tracked] of toolCallItems) {
                        finalOutput.push({
                            type: "function_call",
                            id: tracked.itemId,
                            call_id: tracked.callId,
                            name: tracked.name,
                            arguments: tracked.args,
                            status: "completed",
                        });
                    }

                    const completedResponse: Responses.ResponseObject = {
                        id: responseId,
                        object: "response",
                        created_at: createdAt,
                        model: body.model,
                        status: "completed",
                        output: finalOutput,
                        error: null,
                    };

                    sendEvent({ type: "response.completed", response: completedResponse });
                    res.end();

                } catch (streamError) {
                    logger.error("responses stream error", streamError);
                    if (!res.headersSent) {
                        const errorMessage = streamError instanceof Error ? streamError.message : "Unknown stream error";
                        res.status(500).json({ error: errorMessage });
                    } else {
                        res.end();
                    }
                }

            } else {
                // ── Non-streaming path ──
                try {
                    const completion = await geminiClient.getCompletion(geminiCompletionRequest);
                    const response = buildResponseObject(body.model, completion);
                    res.json(response);
                } catch (completionError: unknown) {
                    const errorMessage = completionError instanceof Error ? completionError.message : String(completionError);
                    logger.error("responses completion error", completionError);
                    res.status(500).json({ error: errorMessage });
                }
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
            logger.error("responses error", error);
            if (!res.headersSent) {
                res.status(500).json({ error: errorMessage });
            } else {
                res.end();
            }
        }
    });

    // ─── Models ───

    router.get("/models", (_req, res) => {
        const modelData = Object.values(Gemini.Model).map((modelId) => ({
            id: modelId,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "Google",
        }));

        res.json({
            object: "list",
            data: modelData,
        });
    });

    router.post("/chat/completions", async (req, res) => {
        try {
            const body = req.body as OpenAI.ChatCompletionRequest;
            if (!body.messages.length) {
                return res.status(400).json({ error: "messages is a required field" });
            }
            const projectId = await geminiClient.discoverProjectId();
            const geminiCompletionRequest = mapOpenAIChatCompletionRequestToGemini(projectId, body);

            if (body.stream) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                res.setHeader("Access-Control-Allow-Origin", "*");

                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const reader = readable.getReader();

                (async () => {
                    try {
                        const geminiStream = geminiClient.streamContent(geminiCompletionRequest);
                        for await (const chunk of geminiStream) {
                            // Cache thought signatures for tool calls (needed by thinking models in multi-turn)
                            const delta = chunk.choices?.[0]?.delta;
                            if (delta?.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    const sig = (tc as any)._thoughtSignature;
                                    if (sig && tc.id) {
                                        cacheToolSignature(tc.id, sig);
                                    }
                                }
                            }
                            await writer.write(chunk);
                        }
                        await writer.close();
                    } catch (error) {
                        logger.error("stream error", error);
                        const errorMessage = error instanceof Error ? error.message : "Unknown stream error";
                        await writer.abort(errorMessage);
                    }
                })();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        res.write("data: [DONE]\n\n");
                        res.end();
                        break;
                    }
                    res.write(`data: ${JSON.stringify(value)}\n\n`);
                }
            } else {
                // Non-streaming response
                try {
                    const completion = await geminiClient.getCompletion(geminiCompletionRequest);

                    const response: OpenAI.ChatCompletionResponse = {
                        id: `chatcmpl-${crypto.randomUUID()}`,
                        object: "chat.completion",
                        created: Math.floor(Date.now() / 1000),
                        model: body.model,
                        choices: [
                            {
                                index: 0,
                                message: {
                                    role: "assistant",
                                    content: completion.content,
                                    tool_calls: completion.tool_calls
                                },
                                finish_reason: completion.tool_calls && completion.tool_calls.length > 0 ? "tool_calls" : "stop"
                            }
                        ]
                    };

                    // Add usage information if available
                    if (completion.usage) {
                        response.usage = {
                            prompt_tokens: completion.usage.inputTokens,
                            completion_tokens: completion.usage.outputTokens,
                            total_tokens: completion.usage.inputTokens + completion.usage.outputTokens
                        };
                    }

                    res.json(response);
                } catch (completionError: unknown) {
                    const errorMessage = completionError instanceof Error ? completionError.message : String(completionError);
                    logger.error("completion error", completionError);
                    res.status(500).json({ error: errorMessage });
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
            logger.error("completion error", error);

            if (!res.headersSent) {
                res.status(500).json({ error: errorMessage });
            } else {
                res.end();
            }
        }
    });

    return router;
}
