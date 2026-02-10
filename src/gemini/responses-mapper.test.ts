import {describe, it, expect} from "vitest";
import {mapResponsesRequestToChatCompletion, buildResponseObject} from "./responses-mapper.js";
import * as Responses from "../types/responses.js";
import * as OpenAI from "../types/openai.js";

describe("mapResponsesRequestToChatCompletion", () => {
    it("should map string input to single user message", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-flash",
            input: "Hello world",
        };

        const result = mapResponsesRequestToChatCompletion(request);

        expect(result.model).toBe("gemini-2.5-flash");
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toEqual({role: "user", content: "Hello world"});
    });

    it("should prepend instructions as system message", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: "Hello",
            instructions: "You are a helpful assistant",
        };

        const result = mapResponsesRequestToChatCompletion(request);

        expect(result.messages).toHaveLength(2);
        expect(result.messages[0]).toEqual({role: "system", content: "You are a helpful assistant"});
        expect(result.messages[1]).toEqual({role: "user", content: "Hello"});
    });

    it("should map message input items with proper roles", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: [
                {role: "user", content: "What is 2+2?"},
                {role: "assistant", content: "4"},
                {role: "user", content: "Thanks"},
            ],
        };

        const result = mapResponsesRequestToChatCompletion(request);

        expect(result.messages).toHaveLength(3);
        expect(result.messages[0].role).toBe("user");
        expect(result.messages[1].role).toBe("assistant");
        expect(result.messages[2].role).toBe("user");
    });

    it("should map input_text content to text MessageContent", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: [
                {
                    role: "user",
                    content: [
                        {type: "input_text" as const, text: "Hello"},
                        {type: "input_text" as const, text: "World"},
                    ],
                },
            ],
        };

        const result = mapResponsesRequestToChatCompletion(request);

        expect(result.messages).toHaveLength(1);
        const content = result.messages[0].content as OpenAI.MessageContent[];
        expect(content).toHaveLength(2);
        expect(content[0]).toEqual({type: "text", text: "Hello"});
        expect(content[1]).toEqual({type: "text", text: "World"});
    });

    it("should map input_image content to image_url MessageContent", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: [
                {
                    role: "user",
                    content: [
                        {type: "input_image" as const, image_url: "data:image/png;base64,abc123", detail: "low" as const},
                    ],
                },
            ],
        };

        const result = mapResponsesRequestToChatCompletion(request);

        const content = result.messages[0].content as OpenAI.MessageContent[];
        expect(content[0]).toEqual({
            type: "image_url",
            image_url: {url: "data:image/png;base64,abc123", detail: "low"},
        });
    });

    it("should convert function tools to OpenAI Tool format", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: "Test",
            tools: [
                {
                    type: "function",
                    name: "get_weather",
                    description: "Get weather info",
                    parameters: {type: "object", properties: {location: {type: "string"}}},
                    strict: true,
                },
            ],
        };

        const result = mapResponsesRequestToChatCompletion(request);

        expect(result.tools).toHaveLength(1);
        expect(result.tools![0]).toEqual({
            type: "function",
            function: {
                name: "get_weather",
                description: "Get weather info",
                parameters: {type: "object", properties: {location: {type: "string"}}},
            },
        });
        // strict should NOT be present
        expect((result.tools![0] as unknown as Record<string, unknown>).strict).toBeUndefined();
    });

    it("should map tool_choice none", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: "Test",
            tool_choice: "none",
        };

        const result = mapResponsesRequestToChatCompletion(request);
        expect(result.tool_choice).toBe("none");
    });

    it("should map tool_choice auto", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: "Test",
            tool_choice: "auto",
        };

        const result = mapResponsesRequestToChatCompletion(request);
        expect(result.tool_choice).toBe("auto");
    });

    it("should map tool_choice required to auto", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: "Test",
            tool_choice: "required",
        };

        const result = mapResponsesRequestToChatCompletion(request);
        expect(result.tool_choice).toBe("auto");
    });

    it("should map specific tool_choice", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: "Test",
            tool_choice: {type: "function", name: "my_tool"},
        };

        const result = mapResponsesRequestToChatCompletion(request);
        expect(result.tool_choice).toEqual({type: "function", function: {name: "my_tool"}});
    });

    it("should map function_call input items to assistant message with tool_calls", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: [
                {role: "user", content: "Get weather"},
                {
                    type: "function_call" as const,
                    id: "fc_1",
                    call_id: "call_123",
                    name: "get_weather",
                    arguments: "{\"location\": \"Paris\"}",
                },
                {
                    type: "function_call_output" as const,
                    call_id: "call_123",
                    output: "Sunny, 25°C",
                },
                {role: "user", content: "Thanks"},
            ],
        };

        const result = mapResponsesRequestToChatCompletion(request);

        expect(result.messages).toHaveLength(4);

        // user message
        expect(result.messages[0].role).toBe("user");

        // assistant message with tool_calls (from function_call)
        expect(result.messages[1].role).toBe("assistant");
        expect(result.messages[1].tool_calls).toHaveLength(1);
        expect(result.messages[1].tool_calls![0]).toEqual({
            index: 0,
            id: "call_123",
            type: "function",
            function: {name: "get_weather", arguments: "{\"location\": \"Paris\"}"},
        });

        // tool response
        expect(result.messages[2].role).toBe("tool");
        expect(result.messages[2].content).toBe("Sunny, 25°C");
        expect(result.messages[2].tool_call_id).toBe("call_123");

        // next user message
        expect(result.messages[3].role).toBe("user");
    });

    it("should group consecutive function_call items into one assistant message", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: [
                {role: "user", content: "Run two tools"},
                {
                    type: "function_call" as const,
                    id: "fc_1",
                    call_id: "call_1",
                    name: "tool_a",
                    arguments: "{}",
                },
                {
                    type: "function_call" as const,
                    id: "fc_2",
                    call_id: "call_2",
                    name: "tool_b",
                    arguments: "{}",
                },
            ],
        };

        const result = mapResponsesRequestToChatCompletion(request);

        expect(result.messages).toHaveLength(2);
        expect(result.messages[1].role).toBe("assistant");
        expect(result.messages[1].tool_calls).toHaveLength(2);
    });

    it("should pass through reasoning effort", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: "Think hard",
            reasoning: {effort: "high"},
        };

        const result = mapResponsesRequestToChatCompletion(request);
        expect(result.reasoning).toEqual({effort: "high"});
    });

    it("should pass through temperature", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-flash",
            input: "Test",
            temperature: 0.5,
        };

        const result = mapResponsesRequestToChatCompletion(request);
        expect(result.temperature).toBe(0.5);
    });

    it("should handle message with type field explicitly", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: [
                {type: "message" as const, role: "user", content: "Hello with explicit type"},
            ],
        };

        const result = mapResponsesRequestToChatCompletion(request);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toEqual({role: "user", content: "Hello with explicit type"});
    });

    it("should handle empty input array", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: [],
        };

        const result = mapResponsesRequestToChatCompletion(request);
        expect(result.messages).toHaveLength(0);
    });

    it("should handle tool without description or parameters", () => {
        const request: Responses.ResponsesRequest = {
            model: "gemini-2.5-pro",
            input: "Test",
            tools: [
                {type: "function", name: "simple_tool"},
            ],
        };

        const result = mapResponsesRequestToChatCompletion(request);
        expect(result.tools![0]).toEqual({
            type: "function",
            function: {
                name: "simple_tool",
                description: "",
                parameters: {type: "object"},
            },
        });
    });
});

describe("buildResponseObject", () => {
    it("should build response with text content", () => {
        const completion = {
            content: "Hello!",
            usage: {inputTokens: 10, outputTokens: 5},
        };

        const result = buildResponseObject("gemini-2.5-flash", completion);

        expect(result.object).toBe("response");
        expect(result.model).toBe("gemini-2.5-flash");
        expect(result.status).toBe("completed");
        expect(result.output).toHaveLength(1);
        expect(result.output[0].type).toBe("message");

        const msg = result.output[0] as Responses.ResponseOutputMessage;
        expect(msg.role).toBe("assistant");
        expect(msg.content).toHaveLength(1);
        expect(msg.content[0].type).toBe("output_text");
        expect(msg.content[0].text).toBe("Hello!");

        expect(result.usage).toEqual({
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
        });
    });

    it("should build response with tool calls", () => {
        const completion = {
            content: "",
            tool_calls: [
                {
                    index: 0,
                    id: "call_abc",
                    type: "function" as const,
                    function: {name: "get_weather", arguments: "{\"location\":\"Paris\"}"},
                },
            ],
        };

        const result = buildResponseObject("gemini-2.5-pro", completion);

        // No message output because content is empty
        const fcItems = result.output.filter((o) => o.type === "function_call");
        expect(fcItems).toHaveLength(1);

        const fc = fcItems[0] as Responses.ResponseOutputFunctionCall;
        expect(fc.call_id).toBe("call_abc");
        expect(fc.name).toBe("get_weather");
        expect(fc.arguments).toBe("{\"location\":\"Paris\"}");
        expect(fc.status).toBe("completed");
    });

    it("should build response with both text and tool calls", () => {
        const completion = {
            content: "Let me check the weather.",
            tool_calls: [
                {
                    index: 0,
                    id: "call_xyz",
                    type: "function" as const,
                    function: {name: "get_weather", arguments: "{}"},
                },
            ],
        };

        const result = buildResponseObject("gemini-2.5-pro", completion);

        expect(result.output).toHaveLength(2);
        expect(result.output[0].type).toBe("message");
        expect(result.output[1].type).toBe("function_call");
    });

    it("should handle missing usage", () => {
        const completion = {content: "Hello"};

        const result = buildResponseObject("gemini-2.5-flash", completion);

        expect(result.usage).toBeUndefined();
    });

    it("should generate valid IDs", () => {
        const completion = {content: "test"};
        const result = buildResponseObject("gemini-2.5-flash", completion);

        expect(result.id).toMatch(/^resp_/);
        const msg = result.output[0] as Responses.ResponseOutputMessage;
        expect(msg.id).toMatch(/^msg_/);
    });
});
