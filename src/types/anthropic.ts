export type Role = "user" | "assistant";

export type TextContent = {
    type: "text";
    text: string;
};

export type ImageContent = {
    type: "image";
    source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
    };
};

export type Content = TextContent | ImageContent;

export type Message = {
    role: Role;
    content: string | RequestContent[];
};

export type SystemMessage = {
    text: string;
    type: "text";
};

export type Tool = {
    name: string;
    description: string;
    input_schema: object;
};

export type ToolChoice = "auto" | "any" | {type: "tool"; name: string};

export type ToolUse = {
    type: "tool_use";
    id: string;
    name: string;
    input: object;
};

export type ToolResult = {
    type: "tool_result";
    tool_use_id: string;
    content?: string | Content[];
    is_error?: boolean;
};

export type MessageContent = TextContent | ImageContent | ToolUse | ToolResult;

// For messages in the request
export type RequestContent = TextContent | ImageContent;

export type MessagesRequest = {
    model: string;
    max_tokens: number;
    messages: Message[];
    system?: SystemMessage[];
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: string[];
    stream?: boolean;
    tools?: Tool[];
    tool_choice?: ToolChoice;
};

export type Usage = {
    input_tokens: number;
    output_tokens: number;
};

export type MessagesResponse = {
    id: string;
    type: "message";
    role: "assistant";
    content: MessageContent[];
    model: string;
    stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
    stop_sequence?: string;
    usage: Usage;
};

export type StreamEvent = {
    type: "message_start" | "content_block_start" | "content_block_delta" | "content_block_stop" | "message_delta" | "message_stop";
};

export type MessageStartEvent = StreamEvent & {
    type: "message_start";
    message: Omit<MessagesResponse, "content"> & {content: []};
};

export type ContentBlockStartEvent = StreamEvent & {
    type: "content_block_start";
    index: number;
    content_block: MessageContent;
};

export type ContentBlockDeltaEvent = StreamEvent & {
    type: "content_block_delta";
    index: number;
    delta: {
        type: "text_delta" | "input_json_delta";
        text?: string;
        partial_json?: string;
    };
};

export type ContentBlockStopEvent = StreamEvent & {
    type: "content_block_stop";
    index: number;
};

export type MessageDeltaEvent = StreamEvent & {
    type: "message_delta";
    delta: {
        stop_reason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
        stop_sequence?: string;
    };
    usage?: {
        output_tokens: number;
    };
};

export type MessageStopEvent = StreamEvent & {
    type: "message_stop";
};

export type AnthropicError = {
    type: "error";
    error: {
        type: "invalid_request_error" | "authentication_error" | "permission_error" | "not_found_error" | "rate_limit_error" | "api_error" | "overloaded_error";
        message: string;
    };
};
