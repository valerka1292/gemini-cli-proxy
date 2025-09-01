export type JsonSchema = Record<string, unknown> & {
    definitions?: Record<string, JsonSchema>;
    $ref?: string;
    allOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    const?: unknown;
    enum?: unknown[];
    additionalProperties?: boolean | JsonSchema;
    required?: string[];
    nullable?: boolean;
};