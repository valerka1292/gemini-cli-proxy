import * as Gemini from "../types/gemini.js";
import type { JsonSchema } from "../types/types.js";

export const mapModelToGemini = (model?: string): string => {
    if (model === undefined) {
        return Gemini.Model.Gemini25Pro;
    }

    // Strip [1m] or similar suffixes (e.g., gemini-3-pro-high[1m] -> gemini-3-pro-high)
    let cleanModel = model.replace(/\[\d+m\]$/, "");

    // Model alias mapping - maps custom names to valid API model names
    const modelAliases: Record<string, string> = {
        // Gemini 3 Pro variants
        "gemini-3-pro-high": "gemini-3-pro-preview",
        "gemini-3-pro": "gemini-3-pro-preview",
        "gemini-3-pro-preview": "gemini-3-pro-preview",

        // Gemini 3 Flash variants
        "gemini-3-flash": "gemini-3-flash-preview",
        "gemini-3-flash-preview": "gemini-3-flash-preview",
        "gemini-3": "gemini-3-flash-preview",

        // Gemini 2.5 Flash variants
        "gemini-2.5-flash-lite": "gemini-2.5-flash-lite-preview",
        "gemini-2.5-flash-lite-preview": "gemini-2.5-flash-lite-preview",
        "gemini-2.5-flash": "gemini-2.5-flash",

        // Gemini 2.5 Pro
        "gemini-2.5-pro": "gemini-2.5-pro",
    };

    // Check for alias mapping first
    if (modelAliases[cleanModel]) {
        return modelAliases[cleanModel];
    }

    // Check if the model string is one of the valid enum values
    const validModels = Object.values(Gemini.Model) as string[];
    if (validModels.includes(cleanModel)) {
        return cleanModel;
    }

    // If model starts with "gemini-", pass it through as-is
    if (cleanModel.startsWith("gemini-")) {
        return cleanModel;
    }

    // For non-Gemini model names (e.g., Claude model aliases), use default
    return Gemini.Model.Gemini25Pro;
};

export const mapJsonSchemaToGemini = (schema: JsonSchema | unknown): JsonSchema => {
    if (!schema || typeof schema !== "object") {
        return schema as JsonSchema;
    }

    const schemaObj = schema as JsonSchema;

    // Handle definitions by inlining them
    if (schemaObj.definitions) {
        const resolved = resolveJsonSchemaDefinitions(schemaObj, schemaObj.definitions);
        return convertJsonSchemaObject(resolved);
    }

    // Convert the schema recursively
    return convertJsonSchemaObject(schemaObj);
};

const resolveJsonSchemaDefinitions = (schema: JsonSchema, definitions: Record<string, JsonSchema>): JsonSchema => {
    if (!schema || typeof schema !== "object") {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => resolveJsonSchemaDefinitions(item as JsonSchema, definitions)) as unknown as JsonSchema;
    }

    const result: JsonSchema = {};

    for (const [key, value] of Object.entries(schema)) {
        if (key === "definitions") {
            continue;
        }

        if (key === "$ref" && typeof value === "string") {
            const refPath = value.replace("#/definitions/", "");
            if (definitions[refPath]) {
                return resolveJsonSchemaDefinitions(definitions[refPath], definitions);
            }
        } else if (key === "allOf" && Array.isArray(value)) {
            for (const item of value) {
                const resolved = resolveJsonSchemaDefinitions(item, definitions);
                Object.assign(result, resolved);
            }
        } else {
            result[key] = resolveJsonSchemaDefinitions(value as JsonSchema, definitions);
        }
    }

    return result;
};

const UNSUPPORTED_KEYWORDS = [
    "exclusiveMinimum",
    "exclusiveMaximum",
    "propertyNames",
    "minProperties",
    "maxProperties",
    "default",
    // "const", // Handled manually
    "$schema",
    "$id",
    "additionalProperties",
    "title",
    "examples",
    "definitions"
];

const convertJsonSchemaObject = (schema: JsonSchema): JsonSchema => {
    if (!schema || typeof schema !== "object") {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => convertJsonSchemaObject(item as JsonSchema)) as unknown as JsonSchema;
    }

    const result: JsonSchema = {};

    // Fix: Enforce string type for enums as required by Google Cloud API
    if (Array.isArray(schema.enum)) {
        result.type = "string";
        result.enum = schema.enum.map(val => String(val));
    }

    // Handle const as single-value enum
    if ("const" in schema) {
        const constVal = (schema as any).const;
        if (constVal !== undefined) {
            const valType = typeof constVal;
            if (valType === "string") result.type = "string";
            else if (valType === "number") result.type = "number";
            else if (valType === "boolean") result.type = "boolean";
            else result.type = "string"; // fallback

            result.enum = [String(constVal)];
        }
    }

    for (const [key, value] of Object.entries(schema)) {
        if (UNSUPPORTED_KEYWORDS.includes(key)) {
            continue;
        }

        // If enum handled above, skip type and enum processing from original schema
        if ((key === "type" || key === "enum") && (Array.isArray(schema.enum) || "const" in schema)) {
            continue;
        }

        // Skip const as we handled it
        if (key === "const") continue;

        if (key === "type" && Array.isArray(value)) {
            const nonNullTypes = value.filter(t => t !== "null");
            if (nonNullTypes.length === 1) {
                result.type = nonNullTypes[0];
                if (value.includes("null")) {
                    result.nullable = true;
                }
            } else {
                result.type = nonNullTypes[0] || "string";
            }
        } else if (key === "properties" && typeof value === "object" && value !== null) {
            result.properties = {};
            for (const [propKey, propValue] of Object.entries(value)) {
                result.properties[propKey] = convertJsonSchemaObject(propValue as JsonSchema);
            }
        } else if (key === "items" && typeof value === "object" && value !== null) {
            result.items = convertJsonSchemaObject(value as JsonSchema);
        } else if (key === "allOf" && Array.isArray(value)) {
            for (const item of value) {
                const converted = convertJsonSchemaObject(item);
                Object.assign(result, converted);
            }
        } else if ((key === "oneOf" || key === "anyOf") && Array.isArray(value)) {
            const localVal = (value ?? []);
            const constValues = localVal
                .filter(item => item && typeof item === "object" && "const" in item)
                .map(item => (item as JsonSchema).const);

            if (constValues.length === localVal.length && constValues.length > 0) {
                result.type = "string";
                result.enum = constValues.map(String);
            } else {
                // Pick the first one that has a type
                const firstType = localVal.find(item => item && typeof item === "object" && item.type);
                result.type = (firstType as JsonSchema)?.type || "string";

                // If it's an object type, we lose properties here unless we merge, 
                // but merging union types is complex. Gemini usually expects simple types.
                // If the union is "type: object" vs "type: string", we just picking one risks validation error.
                // But giving NO type is worse.
            }
        } else {
            result[key] = convertJsonSchemaObject(value as JsonSchema);
        }
    }

    return result;
};
