import * as Anthropic from "../types/anthropic.js";
import * as Gemini from "../types/gemini.js";
import { DEFAULT_TEMPERATURE } from "../utils/constant.js";
import { mapModelToGemini, mapJsonSchemaToGemini } from "./mapper.js";

export const mapAnthropicMessagesRequestToGemini = (
    project: string,
    request: Anthropic.MessagesRequest,
): Gemini.ChatCompletionRequest => {
    const model = mapModelToGemini(request.model);

    const geminiRequest: Gemini.ChatCompletionRequestBody = {
        contents: mapAnthropicMessagesToGeminiFormat(request.messages),
        generationConfig: {
            temperature: request.temperature ?? DEFAULT_TEMPERATURE,
            maxOutputTokens: request.max_tokens,
        }
    };

    // Add interleaved thinking hint for Claude models with tools
    if (request.tools && request.tools.length > 0) {
        const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.';
        if (!geminiRequest.systemInstruction) {
            geminiRequest.systemInstruction = { parts: [{ text: hint }] };
        } else {
            const lastPart = geminiRequest.systemInstruction.parts[geminiRequest.systemInstruction.parts.length - 1];
            if (lastPart) {
                lastPart.text = `${lastPart.text}\n\n${hint}`;
            } else {
                geminiRequest.systemInstruction.parts.push({ text: hint });
            }
        }
    }

    // Special handling for gemini-3-pro-preview
    if (model === "gemini-3-pro-preview") {
        geminiRequest.generationConfig = {
            ...geminiRequest.generationConfig,
            thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: request.thinking?.budget_tokens || 16000
            }
        };
    }

    if (request.system) {
        let parts: { text: string }[] = [];
        if (typeof request.system === "string") {
            parts = [{ text: request.system }];
        } else {
            parts = request.system
                .filter((msg) => msg.type === "text")
                .map((msg) => ({ text: msg.text }));
        }

        if (parts.length > 0) {
            geminiRequest.systemInstruction = {
                parts,
            };
        }
    }

    // Handle tools
    // Handle tools
    if (request.tools && request.tools.length > 0) {
        geminiRequest.tools = [{
            functionDeclarations: request.tools.map(convertAnthropicToolToGemini)
        }];
    }

    // Handle tool choice
    if (request.tool_choice) {
        geminiRequest.toolConfig = mapAnthropicToolChoiceToGemini(request.tool_choice);
    }

    // Note: Gemini doesn't support top_p, top_k, stop_sequences in generationConfig
    // These parameters are ignored for now

    return {
        model,
        project,
        request: geminiRequest,
    };
};

const mapAnthropicMessagesToGeminiFormat = (messages: Anthropic.Message[]): Gemini.ChatMessage[] => {
    const geminiMessages: Gemini.ChatMessage[] = [];

    for (const message of messages) {
        geminiMessages.push(mapAnthropicMessageToGeminiFormat(message, messages));
    }

    return geminiMessages;
};

const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

const mapAnthropicMessageToGeminiFormat = (message: Anthropic.Message, allMessages: Anthropic.Message[]): Gemini.ChatMessage => {
    const role = message.role === "assistant" ? "model" : "user";

    if (typeof message.content === "string") {
        return {
            role,
            parts: [{ text: message.content }]
        };
    }

    // Handle array content
    let parts: Gemini.Part[] = [];
    const contentBlocks = message.content as Anthropic.RequestContent[];

    for (const content of contentBlocks) {
        if (content.type === "text") {
            let text = content.text ?? "";
            if (text.trim().length === 0) {
                continue;
            }
            if (!text.endsWith("\n")) {
                text += "\n";
            }
            parts.push({ text });
        } else if (content.type === "image") {
            const imageContent = content as Anthropic.ImageContent;
            parts.push({
                inlineData: {
                    mimeType: imageContent.source.media_type,
                    data: imageContent.source.data
                }
            });
        } else if (content.type === "tool_use") {
            parts.push({
                functionCall: {
                    name: content.name,
                    args: content.input
                },
                // Add synthetic signature for tool calls in history to satisfy gemini-3-pro-preview validation.
                // We provide both camelCase and snake_case to be extra safe.
                thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE,
                thought_signature: SYNTHETIC_THOUGHT_SIGNATURE
            });
        } else if (content.type === "tool_result") {
            // Find tool name from previous messages
            let toolName = "unknown_tool";
            for (const msg of allMessages) {
                if (Array.isArray(msg.content)) {
                    const toolUse = msg.content.find(c => c.type === "tool_use" && (c as any).id === content.tool_use_id);
                    if (toolUse) {
                        toolName = (toolUse as any).name;
                        break;
                    }
                }
            }

            let response: any;
            if (typeof content.content === 'string') {
                response = { result: content.content };
            } else if (Array.isArray(content.content)) {
                // Combine text content from tool result
                const textParts = content.content
                    .filter(c => c.type === 'text')
                    .map(c => (c as any).text)
                    .join('\n');
                response = { result: textParts };
            } else {
                response = { result: "Success" }; // Default if empty
            }

            parts.push({
                functionResponse: {
                    name: toolName,
                    response: response
                }
            });
        } else if (content.type === "thinking") {
            // ALWAYS skip thinking blocks in Gemini history turns.
            // gemini-cli excludes them from history to avoid verification issues.
            // When we skip them, we MUST use 'skip_thought_signature_validator' on the tool call.
            continue;
        }
    }

    // Safety check: Gemini doesn't allow empty parts
    if (parts.length === 0) {
        parts = [{ text: "." }];
    }

    return { role, parts };
};

const convertAnthropicToolToGemini = (tool: any): Gemini.FunctionDeclaration => {
    // Support both Anthropic and OpenAI tool formats
    if (tool.type === "function" && tool.function) {
        const parameters = mapJsonSchemaToGemini(tool.function.parameters);
        return {
            name: tool.function.name,
            description: tool.function.description,
            parameters
        };
    }

    // Standard Anthropic format
    const parameters = mapJsonSchemaToGemini(tool.input_schema);
    return {
        name: tool.name,
        description: tool.description,
        parameters
    };
};

const mapAnthropicToolChoiceToGemini = (toolChoice: Anthropic.ToolChoice): Gemini.ToolConfig => {
    if (toolChoice === "auto") {
        return {
            functionCallingConfig: {
                mode: "AUTO"
            }
        };
    }

    if (toolChoice === "any") {
        return {
            functionCallingConfig: {
                mode: "ANY"
            }
        };
    }

    if (typeof toolChoice === "object" && toolChoice.type === "tool") {
        return {
            functionCallingConfig: {
                mode: "ANY",
                allowedFunctionNames: [toolChoice.name]
            }
        };
    }

    return {
        functionCallingConfig: {
            mode: "AUTO"
        }
    };
};

// Helper function to map Gemini response back to Anthropic format
export const mapGeminiResponseToAnthropic = (
    geminiResponse: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; usage?: { inputTokens?: number; outputTokens?: number } },
    model: string,
    requestId: string
): Anthropic.MessagesResponse => {
    const content: Anthropic.MessageContent[] = [];
    if (geminiResponse.content) {
        content.push({
            type: "text",
            text: geminiResponse.content
        });
    }

    // Handle tool calls if present
    if (geminiResponse.tool_calls) {
        for (const toolCall of geminiResponse.tool_calls) {
            content.push({
                type: "tool_use",
                id: toolCall.id,
                name: toolCall.function.name,
                input: JSON.parse(toolCall.function.arguments)
            });
        }
    }

    return {
        id: requestId,
        type: "message",
        role: "assistant",
        content,
        model,
        stop_reason: (geminiResponse.tool_calls?.length ?? 0) > 0 ? "tool_use" : "end_turn",
        usage: {
            input_tokens: geminiResponse.usage?.inputTokens || 0,
            output_tokens: geminiResponse.usage?.outputTokens || 0
        }
    };
};
