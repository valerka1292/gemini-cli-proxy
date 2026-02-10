/**
 * OpenAI Responses API types
 * https://platform.openai.com/docs/api-reference/responses
 */

// ─── Request types ───

export type ResponsesRequest = {
    model: string;
    input: string | ResponseInputItem[];
    instructions?: string;
    stream?: boolean;
    tools?: ResponseTool[];
    tool_choice?: ResponseToolChoice;
    temperature?: number;
    max_output_tokens?: number;
    reasoning?: {
        effort?: "low" | "medium" | "high";
    };
};

export type ResponseToolChoice = "none" | "auto" | "required" | {type: "function"; name: string};

export type ResponseTool = {
    type: "function";
    name: string;
    description?: string;
    parameters?: object;
    strict?: boolean;
};

// ─── Input item types ───

export type ResponseInputItem =
    | EasyInputMessage
    | ResponseFunctionToolCall
    | FunctionCallOutput;

export type EasyInputMessage = {
    type?: "message";
    role: "user" | "assistant" | "system" | "developer";
    content: string | ResponseInputContent[];
};

export type ResponseInputContent =
    | ResponseInputText
    | ResponseInputImage;

export type ResponseInputText = {
    type: "input_text";
    text: string;
};

export type ResponseInputImage = {
    type: "input_image";
    image_url: string;
    detail?: "low" | "high" | "auto";
};

export type ResponseFunctionToolCall = {
    type: "function_call";
    id: string;
    call_id: string;
    name: string;
    arguments: string;
};

export type FunctionCallOutput = {
    type: "function_call_output";
    call_id: string;
    output: string;
};

// ─── Output / Response types ───

export type ResponseObject = {
    id: string;
    object: "response";
    created_at: number;
    model: string;
    status: "completed" | "failed" | "in_progress" | "incomplete";
    output: ResponseOutputItem[];
    usage?: ResponseUsage;
    error?: {
        code: string;
        message: string;
    } | null;
};

export type ResponseUsage = {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
};

export type ResponseOutputItem =
    | ResponseOutputMessage
    | ResponseOutputFunctionCall;

export type ResponseOutputMessage = {
    type: "message";
    id: string;
    status: "completed" | "in_progress";
    role: "assistant";
    content: ResponseOutputContent[];
};

export type ResponseOutputContent = ResponseOutputText;

export type ResponseOutputText = {
    type: "output_text";
    text: string;
    annotations: unknown[];
};

export type ResponseOutputFunctionCall = {
    type: "function_call";
    id: string;
    call_id: string;
    name: string;
    arguments: string;
    status: "completed" | "in_progress";
};

// ─── Streaming event types ───

export type ResponseStreamEvent =
    | {type: "response.created"; response: ResponseObject}
    | {type: "response.in_progress"; response: ResponseObject}
    | {type: "response.completed"; response: ResponseObject}
    | {type: "response.output_item.added"; output_index: number; item: ResponseOutputItem}
    | {type: "response.output_item.done"; output_index: number; item: ResponseOutputItem}
    | {type: "response.content_part.added"; output_index: number; content_index: number; part: ResponseOutputContent}
    | {type: "response.content_part.done"; output_index: number; content_index: number; part: ResponseOutputContent}
    | {type: "response.output_text.delta"; output_index: number; content_index: number; delta: string}
    | {type: "response.output_text.done"; output_index: number; content_index: number; text: string}
    | {type: "response.function_call_arguments.delta"; output_index: number; delta: string}
    | {type: "response.function_call_arguments.done"; output_index: number; arguments: string};
