import express from "express";
import path from "node:path";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import {
    dashboardStore,
    SUPPORTED_MODELS,
} from "./store.js";
import {requireDashboardAuth} from "./security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dashboardDistDir = path.resolve(__dirname, "../../dashboard/dist");

export function createDashboardRouter(): express.Router {
    const router = express.Router();

    router.post("/api/auth/register", (req, res) => {
        const {email, password} = req.body as {email?: string; password?: string};
        if (!email || !password || password.length < 8) {
            return res.status(400).json({error: "email and strong password (>= 8 chars) are required"});
        }

        try {
            const {user, verificationCode} = dashboardStore.createUser(email, password);
            return res.status(201).json({
                user: {
                    id: user.id,
                    email: user.email,
                    isAdmin: user.isAdmin,
                    isVerified: user.isVerified,
                },
                oneTimeCode: verificationCode,
                instruction: "Press 'c' in the server console and enter this one-time code to verify admin access.",
                otpExpiresInSeconds: 600,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Registration failed";
            return res.status(409).json({error: message});
        }
    });

    router.post("/api/auth/login", (req, res) => {
        const {email, password} = req.body as {email?: string; password?: string};
        if (!email || !password) {
            return res.status(400).json({error: "email and password are required"});
        }

        const authResult = dashboardStore.authenticate(email, password);
        if (!authResult) {
            return res.status(401).json({error: "Invalid credentials"});
        }

        if (authResult.requiresVerification) {
            return res.status(403).json({
                error: "Account requires OTP verification in server console",
                requiresVerification: true,
                oneTimeCode: authResult.otpCode,
                instruction: "Press 'c' in the server console and enter this one-time code to verify admin access.",
                otpExpiresInSeconds: 600,
            });
        }

        const session = dashboardStore.createSession(authResult.user.id);
        return res.json({
            token: session.token,
            user: {
                id: authResult.user.id,
                email: authResult.user.email,
                isAdmin: authResult.user.isAdmin,
                isVerified: authResult.user.isVerified,
            },
        });
    });

    router.post("/api/auth/logout", requireDashboardAuth, (req, res) => {
        const auth = req.header("authorization")!;
        dashboardStore.revokeSession(auth.slice(7).trim());
        res.status(204).send();
    });

    router.get("/api/me", requireDashboardAuth, (req, res) => {
        const user = req.dashboardUser!;
        res.json({
            id: user.id,
            email: user.email,
            isAdmin: user.isAdmin,
            isVerified: user.isVerified,
        });
    });

    router.get("/api/keys", requireDashboardAuth, (_req, res) => {
        const keys = dashboardStore.listApiKeys().map((k) => ({
            id: k.id,
            name: k.name,
            maskedKey: `${k.keyPrefix}...${k.keySuffix}`,
            createdAt: k.createdAt,
            updatedAt: k.updatedAt,
            lastUsedAt: k.lastUsedAt,
            isActive: k.isActive,
            ownerUserId: k.ownerUserId,
        }));
        res.json({data: keys});
    });

    router.post("/api/keys", requireDashboardAuth, (req, res) => {
        const {name} = req.body as {name?: string};
        if (!name || !name.trim()) {
            return res.status(400).json({error: "name is required"});
        }

        const {record, plaintext} = dashboardStore.createApiKey(name.trim(), req.dashboardUser!.id);
        return res.status(201).json({
            id: record.id,
            name: record.name,
            key: plaintext,
            maskedKey: `${record.keyPrefix}...${record.keySuffix}`,
        });
    });


    router.get("/api/keys/:id/secret", requireDashboardAuth, (req, res) => {
        const plaintext = dashboardStore.getApiKeyPlaintext(req.params.id);
        if (!plaintext) {
            return res.status(404).json({error: "API key secret is unavailable"});
        }

        return res.json({key: plaintext});
    });

    router.patch("/api/keys/:id", requireDashboardAuth, (req, res) => {
        const patch = req.body as {name?: string; isActive?: boolean};
        const updated = dashboardStore.updateApiKey(req.params.id, patch);
        if (!updated) {
            return res.status(404).json({error: "API key not found"});
        }

        return res.json({
            id: updated.id,
            name: updated.name,
            isActive: updated.isActive,
        });
    });

    router.delete("/api/keys/:id", requireDashboardAuth, (req, res) => {
        const deleted = dashboardStore.deleteApiKey(req.params.id);
        if (!deleted) {
            return res.status(404).json({error: "API key not found"});
        }
        return res.status(204).send();
    });

    router.get("/api/models", requireDashboardAuth, (_req, res) => {
        res.json({
            object: "list",
            data: dashboardStore.listModelStatus().map((m) => ({
                id: m.id,
                enabled: m.enabled,
                object: "model",
                owned_by: "Google",
                created: 1770726718,
            })),
        });
    });

    router.patch("/api/models/:id", requireDashboardAuth, (req, res) => {
        const model = req.params.id;
        const {enabled} = req.body as {enabled?: boolean};

        if (!SUPPORTED_MODELS.includes(model as (typeof SUPPORTED_MODELS)[number])) {
            return res.status(400).json({error: "Unknown model"});
        }

        if (typeof enabled !== "boolean") {
            return res.status(400).json({error: "enabled boolean is required"});
        }

        dashboardStore.setModelEnabled(model, enabled);
        return res.json({id: model, enabled});
    });

    router.get("/api/usage", requireDashboardAuth, (_req, res) => {
        res.json(dashboardStore.getUsageSummary());
    });

    if (fs.existsSync(dashboardDistDir)) {
        router.use(express.static(dashboardDistDir));
        router.get("/{*path}", (_req, res) => {
            res.sendFile(path.join(dashboardDistDir, "index.html"));
        });
    } else {
        router.get("/", (_req, res) => {
            res.type("text/plain").send("Dashboard UI is not built yet. Run: npm run dashboard:build");
        });
    }

    return router;
}
