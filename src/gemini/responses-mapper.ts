import * as OpenAI from "../types/openai.js";
import * as Responses from "../types/responses.js";

/**
 * Convert a Responses API request into an OpenAI Chat Completions request
 * so we can reuse the existing openai-mapper → Gemini pipeline.
 */
export function mapResponsesRequestToChatCompletion(
    request: Responses.ResponsesRequest,
): OpenAI.ChatCompletionRequest {
    const messages: OpenAI.ChatMessage[] = [];

    // Instructions → system message
    if (request.instructions) {
        messages.push({role: "system", content: request.instructions});
    }

    // Convert input
    if (typeof request.input === "string") {
        messages.push({role: "user", content: request.input});
    } else if (Array.isArray(request.input)) {
        convertInputItems(request.input, messages);
    }

    const result: OpenAI.ChatCompletionRequest = {
        model: request.model,
        messages,
        stream: request.stream,
        temperature: request.temperature,
    };

    // Tools
    if (request.tools && request.tools.length > 0) {
        result.tools = request.tools
            .filter((t) => t.type === "function")
            .map(convertResponseTool);
    }

    // Tool choice
    if (request.tool_choice !== undefined) {
        result.tool_choice = convertToolChoice(request.tool_choice);
    }

    // Reasoning
    if (request.reasoning?.effort) {
        result.reasoning = {effort: request.reasoning.effort as OpenAI.ReasoningEffort};
    }

    return result;
}

// ─── Input item conversion ───

function convertInputItems(
    items: Responses.ResponseInputItem[],
    messages: OpenAI.ChatMessage[],
): void {
    // We need to group consecutive function_call items into one assistant message
    // and consecutive function_call_output items into individual tool messages.
    let pendingToolCalls: OpenAI.ToolCall[] = [];

    for (const item of items) {
        if (isMessage(item)) {
            // Flush any pending tool calls first
            flushPendingToolCalls(pendingToolCalls, messages);
            pendingToolCalls = [];

            const msg = item as Responses.EasyInputMessage;
            const role = mapRole(msg.role);
            const content = convertMessageContent(msg.content);
            messages.push({role, content});

        } else if (isFunctionCall(item)) {
            const fc = item as Responses.ResponseFunctionToolCall;
            pendingToolCalls.push({
                index: pendingToolCalls.length,
                id: fc.call_id,
                type: "function",
                function: {
                    name: fc.name,
                    arguments: fc.arguments,
                },
            });

        } else if (isFunctionCallOutput(item)) {
            // Flush any pending tool calls first
            flushPendingToolCalls(pendingToolCalls, messages);
            pendingToolCalls = [];

            const fco = item as Responses.FunctionCallOutput;
            messages.push({
                role: "tool",
                content: fco.output,
                tool_call_id: fco.call_id,
            });
        }
    }

    // Flush remaining tool calls
    flushPendingToolCalls(pendingToolCalls, messages);
}

function flushPendingToolCalls(
    toolCalls: OpenAI.ToolCall[],
    messages: OpenAI.ChatMessage[],
): void {
    if (toolCalls.length === 0) return;

    messages.push({
        role: "assistant",
        content: "",
        tool_calls: [...toolCalls],
    });
}

function isMessage(item: Responses.ResponseInputItem): item is Responses.EasyInputMessage {
    const t = (item as Responses.EasyInputMessage);
    return t.type === "message" || t.type === undefined;
}

function isFunctionCall(item: Responses.ResponseInputItem): item is Responses.ResponseFunctionToolCall {
    return (item as Responses.ResponseFunctionToolCall).type === "function_call";
}

function isFunctionCallOutput(item: Responses.ResponseInputItem): item is Responses.FunctionCallOutput {
    return (item as Responses.FunctionCallOutput).type === "function_call_output";
}

function mapRole(role: string): OpenAI.Role {
    switch (role) {
        case "user":
        case "assistant":
        case "system":
        case "developer":
        case "tool":
            return role;
        default:
            return "user";
    }
}

function convertMessageContent(
    content: string | Responses.ResponseInputContent[],
): string | OpenAI.MessageContent[] {
    if (typeof content === "string") {
        return content;
    }

    return content.map((c): OpenAI.MessageContent => {
        if (c.type === "input_text") {
            return {type: "text", text: c.text};
        }
        if (c.type === "input_image") {
            return {
                type: "image_url",
                image_url: {
                    url: (c as Responses.ResponseInputImage).image_url,
                    detail: (c as Responses.ResponseInputImage).detail,
                },
            };
        }
        // Fallback
        return {type: "text", text: String((c as Responses.ResponseInputText).text ?? "")};
    });
}

// ─── Tool conversion ───

function convertResponseTool(tool: Responses.ResponseTool): OpenAI.Tool {
    return {
        type: "function",
        function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.parameters ?? {type: "object"},
        },
    };
}

function convertToolChoice(tc: Responses.ResponseToolChoice): OpenAI.ToolChoice {
    if (tc === "none") return "none";
    if (tc === "auto" || tc === "required") return "auto";
    if (typeof tc === "object" && tc.type === "function") {
        return {type: "function", function: {name: tc.name}};
    }
    return "auto";
}

// ─── Output building (non-streaming) ───

export function buildResponseObject(
    requestModel: string,
    completion: {
        content: string;
        tool_calls?: OpenAI.ToolCall[];
        usage?: {inputTokens: number; outputTokens: number};
    },
): Responses.ResponseObject {
    const output: Responses.ResponseOutputItem[] = [];

    // Text content → message output item
    if (completion.content) {
        output.push({
            type: "message",
            id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
            status: "completed",
            role: "assistant",
            content: [
                {
                    type: "output_text",
                    text: completion.content,
                    annotations: [],
                },
            ],
        });
    }

    // Tool calls → function_call output items
    if (completion.tool_calls) {
        for (const tc of completion.tool_calls) {
            output.push({
                type: "function_call",
                id: `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
                call_id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
                status: "completed",
            });
        }
    }

    const response: Responses.ResponseObject = {
        id: `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: requestModel,
        status: "completed",
        output,
        error: null,
    };

    if (completion.usage) {
        response.usage = {
            input_tokens: completion.usage.inputTokens,
            output_tokens: completion.usage.outputTokens,
            total_tokens: completion.usage.inputTokens + completion.usage.outputTokens,
        };
    }

    return response;
}
