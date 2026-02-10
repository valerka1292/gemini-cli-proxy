export enum Model {
    Gemini25Flash = "gemini-2.5-flash",
    Gemini25Pro = "gemini-2.5-pro",
    Gemini25FlashLite = "gemini-2.5-flash-lite",
    Gemini25FlashLitePreview = "gemini-2.5-flash-lite-preview",
    Gemini3ProHigh = "gemini-3-pro-high",
    Gemini3Pro = "gemini-3-pro",
    Gemini3ProPreview = "gemini-3-pro-preview",
    Gemini3Flash = "gemini-3-flash",
    Gemini3FlashPreview = "gemini-3-flash-preview",
    Gemini3 = "gemini-3",
}

export type ChatCompletionRequestBody = {
    contents: ChatMessage[];
    systemInstruction?: SystemInstruction;
    tools?: {
        functionDeclarations: FunctionDeclaration[] | undefined;
    }[];
    toolConfig?: ToolConfig;
    generationConfig?: {
        temperature?: number;
        thinkingConfig?: ThinkingConfig;
        maxOutputTokens?: number;
        candidateCount?: number;
    };
};

export type ChatCompletionRequest = {
    model: string; // Can be any Gemini model name, not just enum values
    project: string;
    request: ChatCompletionRequestBody;
};

export type SystemInstruction = {
    parts: TextPart[];
};
export type ToolConfig = {
    functionCallingConfig: {
        mode: "AUTO" | "ANY" | "NONE";
        allowedFunctionNames?: string[];
    };
};

export type FunctionDeclaration = {
    name: string;
    description: string;
    parameters: object;
};

export type InlineDataPart = {
    inlineData: {
        mimeType: string;
        data: string;
    };
};

export type FunctionCall = {
    name: string;
    args: object;
};

export type FunctionCallPart = {
    functionCall: FunctionCall;
};

export type FunctionResponsePart = {
    functionResponse: {
        name: string;
        response: object;
    };
};

export type TextPart = {
    text: string;
    thought?: boolean;
};

export type Part =
    | (TextPart & { thoughtSignature?: string; thought_signature?: string; thought?: boolean })
    | (InlineDataPart & { thoughtSignature?: string; thought_signature?: string })
    | (FunctionCallPart & { thoughtSignature?: string; thought_signature?: string })
    | (FunctionResponsePart & { thoughtSignature?: string; thought_signature?: string });

export type ThinkingConfig = {
    thinkingBudget?: number;
    includeThoughts?: boolean;
    thinkingLevel?: number | string;
};

export type ChatMessage = {
    role: string;
    parts: Part[];
};

// Gemini API response types
export type Candidate = {
    content?: {
        parts?: Part[];
    };
    finishReason?: string;
};

export type UsageMetadata = {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
};

export type Response = {
    response?: {
        candidates?: Candidate[];
        usageMetadata?: UsageMetadata;
    };
};

export type ProjectDiscoveryResponse = {
    cloudaicompanionProject?: string;
    allowedTiers: Array<{
        id: string;
        isDefault?: boolean;
    }> | undefined;
};

export type OnboardUserResponse = {
    done?: boolean;
    response?: {
        cloudaicompanionProject?: {
            id: string;
        };
    }
};
