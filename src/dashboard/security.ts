import type express from "express";
import readline from "node:readline";
import {dashboardStore, SUPPORTED_MODELS, type StoredUser} from "./store.js";

declare global {
    namespace Express {
        interface Request {
            dashboardUser?: StoredUser;
            proxyApiKeyId?: string;
        }
    }
}

let verificationListenerInitialized = false;

function promptCodeFromConsole(): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question("Enter one-time verification code: ", (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

export function initConsoleVerificationListener(logger: {info: (message: string) => void; warn: (message: string) => void}): void {
    if (verificationListenerInitialized) return;
    if (!process.stdin.isTTY) {
        logger.warn("Console verification listener skipped: stdin is not a TTY.");
        return;
    }

    verificationListenerInitialized = true;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    logger.info("Console verification active: press 'c' anytime to verify pending registration code.");

    process.stdin.on("data", async (key: string) => {
        if (key === "\u0003") {
            process.exit(0);
        }
        if (key.toLowerCase() !== "c") return;

        process.stdin.setRawMode(false);
        try {
            const code = await promptCodeFromConsole();
            const user = dashboardStore.verifyUserByCode(code);
            if (!user) {
                logger.warn("Verification failed: invalid one-time code.");
            } else {
                logger.info(`User ${user.email} verified and promoted to admin.`);
            }
        } finally {
            process.stdin.setRawMode(true);
            process.stdin.resume();
        }
    });
}

function extractBearer(req: express.Request): string | null {
    const auth = req.header("authorization") ?? "";
    if (!auth.toLowerCase().startsWith("bearer ")) return null;
    return auth.slice(7).trim();
}

export function requireDashboardAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const token = extractBearer(req);
    if (!token) {
        return res.status(401).json({error: "Missing dashboard bearer token"});
    }

    const user = dashboardStore.getUserBySession(token);
    if (!user) {
        return res.status(401).json({error: "Invalid or expired dashboard session"});
    }

    if (!user.isAdmin || !user.isVerified) {
        return res.status(403).json({
            error: "User is not verified as admin. Press 'c' in server console and enter your one-time code.",
        });
    }

    req.dashboardUser = user;
    return next();
}

function extractProxyKey(req: express.Request): string | null {
    const bearer = extractBearer(req);
    if (bearer) return bearer;
    const headerKey = req.header("x-api-key") ?? req.header("api-key");
    return headerKey?.trim() || null;
}

export function requireProxyApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    const key = extractProxyKey(req);
    if (!key) {
        return res.status(401).json({
            error: {
                message: "Missing API key. Use Authorization: Bearer sk-proxy-... or x-api-key header.",
                type: "invalid_api_key",
            },
        });
    }

    const record = dashboardStore.validateApiKey(key);
    if (!record) {
        return res.status(401).json({
            error: {
                message: "Invalid API key provided. Dummy keys are not accepted.",
                type: "invalid_api_key",
            },
        });
    }

    req.proxyApiKeyId = record.id;
    return next();
}

export function assertModelEnabled(model: string): {allowed: true} | {allowed: false; message: string} {
    if (!SUPPORTED_MODELS.includes(model as (typeof SUPPORTED_MODELS)[number])) {
        return {
            allowed: false,
            message: `Model '${model}' is not in the supported Gemini model list.`,
        };
    }

    if (!dashboardStore.isModelEnabled(model)) {
        return {
            allowed: false,
            message: `Access forbidden: model '${model}' is disabled by dashboard policy.`,
        };
    }

    return {allowed: true};
}

export function recordUsageFromRequest(req: express.Request, statusCode: number, usage?: {inputTokens?: number; outputTokens?: number}) {
    const apiKeyId = req.proxyApiKeyId;
    if (!apiKeyId) return;

    const body = req.body as {model?: string} | undefined;
    const model = body?.model ?? "unknown";

    dashboardStore.addUsageRecord({
        apiKeyId,
        model,
        endpoint: req.originalUrl,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        statusCode,
    });
}
