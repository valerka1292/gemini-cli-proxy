import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";

export const SUPPORTED_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-lite-preview",
    "gemini-3-pro-high",
    "gemini-3-pro",
    "gemini-3-pro-preview",
    "gemini-3-flash",
    "gemini-3-flash-preview",
    "gemini-3",
] as const;

export type StoredUser = {
    id: string;
    email: string;
    passwordHash: string;
    passwordSalt: string;
    isAdmin: boolean;
    isVerified: boolean;
    createdAt: number;
};

export type Session = {
    token: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
};

export type ApiKeyRecord = {
    id: string;
    name: string;
    keyPrefix: string;
    keySuffix: string;
    hashedKey: string;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number | null;
    ownerUserId: string;
    isActive: boolean;
};

export type LoginResult = {
    user: StoredUser;
    requiresVerification: boolean;
    otpCode?: string;
};

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const OTP_TTL_MS = 1000 * 60 * 10;
const DB_PATH = process.env.GEMINI_PROXY_DASHBOARD_DB_PATH ?? path.join(os.homedir(), ".gemini-cli-proxy", "dashboard.sqlite");

function now() {
    return Date.now();
}

function ensureDir(filePath: string) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }
}

class DashboardStore {
    private db: Database.Database;

    constructor() {
        ensureDir(DB_PATH);
        this.db = new Database(DB_PATH);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                is_verified INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS otp_codes (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                code TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                used_at INTEGER,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                key_prefix TEXT NOT NULL,
                key_suffix TEXT NOT NULL,
                hashed_key TEXT UNIQUE NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_used_at INTEGER,
                owner_user_id TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS model_policies (
                model_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_events (
                id TEXT PRIMARY KEY,
                api_key_id TEXT NOT NULL,
                model TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                status_code INTEGER NOT NULL,
                FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
            CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
            CREATE INDEX IF NOT EXISTS idx_otp_code ON otp_codes(code);
            CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);
        `);

        const insertModelPolicy = this.db.prepare("INSERT OR IGNORE INTO model_policies (model_id, enabled) VALUES (?, 1)");
        for (const model of SUPPORTED_MODELS) {
            insertModelPolicy.run(model);
        }
    }

    private mapUser(row: {
        id: string;
        email: string;
        password_hash: string;
        password_salt: string;
        is_admin: number;
        is_verified: number;
        created_at: number;
    }): StoredUser {
        return {
            id: row.id,
            email: row.email,
            passwordHash: row.password_hash,
            passwordSalt: row.password_salt,
            isAdmin: Boolean(row.is_admin),
            isVerified: Boolean(row.is_verified),
            createdAt: row.created_at,
        };
    }

    private generateOtpForUser(userId: string): string {
        const code = `${Math.floor(100000 + Math.random() * 900000)}`;
        const ts = now();

        this.db.prepare("UPDATE otp_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(ts, userId);
        this.db.prepare(
            "INSERT INTO otp_codes (id, user_id, code, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)",
        ).run(`otp_${crypto.randomUUID().replaceAll("-", "")}`, userId, code, ts, ts + OTP_TTL_MS);

        return code;
    }

    createUser(email: string, password: string): {user: StoredUser; verificationCode: string} {
        const normalized = email.trim().toLowerCase();
        const existing = this.db.prepare("SELECT id FROM users WHERE email = ?").get(normalized);
        if (existing) {
            throw new Error("User with this email already exists");
        }

        const salt = crypto.randomBytes(16).toString("hex");
        const hash = crypto.scryptSync(password, salt, 64).toString("hex");
        const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;

        this.db.prepare(
            "INSERT INTO users (id, email, password_hash, password_salt, is_admin, is_verified, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
        ).run(userId, normalized, hash, salt, now());

        const verificationCode = this.generateOtpForUser(userId);
        const user = this.getUserById(userId);
        if (!user) throw new Error("Failed to create user");
        return {user, verificationCode};
    }

    private getUserById(userId: string): StoredUser | null {
        const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as {
            id: string;
            email: string;
            password_hash: string;
            password_salt: string;
            is_admin: number;
            is_verified: number;
            created_at: number;
        } | undefined;

        return row ? this.mapUser(row) : null;
    }

    verifyUserByCode(code: string): StoredUser | null {
        const row = this.db.prepare(`
            SELECT o.user_id
            FROM otp_codes o
            WHERE o.code = ? AND o.used_at IS NULL AND o.expires_at >= ?
            ORDER BY o.created_at DESC
            LIMIT 1
        `).get(code, now()) as {user_id: string} | undefined;

        if (!row) return null;

        const ts = now();
        this.db.prepare("UPDATE otp_codes SET used_at = ? WHERE user_id = ? AND code = ? AND used_at IS NULL").run(ts, row.user_id, code);
        this.db.prepare("UPDATE users SET is_verified = 1, is_admin = 1 WHERE id = ?").run(row.user_id);

        return this.getUserById(row.user_id);
    }

    authenticate(email: string, password: string): LoginResult | null {
        const normalized = email.trim().toLowerCase();
        const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalized) as {
            id: string;
            email: string;
            password_hash: string;
            password_salt: string;
            is_admin: number;
            is_verified: number;
            created_at: number;
        } | undefined;

        if (!row) return null;
        const hash = crypto.scryptSync(password, row.password_salt, 64).toString("hex");
        if (hash !== row.password_hash) return null;

        const user = this.mapUser(row);

        if (!user.isVerified) {
            const otpCode = this.generateOtpForUser(user.id);
            return {
                user,
                requiresVerification: true,
                otpCode,
            };
        }

        return {
            user,
            requiresVerification: false,
        };
    }

    createSession(userId: string): Session {
        const session: Session = {
            token: crypto.randomBytes(32).toString("hex"),
            userId,
            createdAt: now(),
            expiresAt: now() + SESSION_TTL_MS,
        };

        this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
        this.db.prepare(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        ).run(session.token, session.userId, session.createdAt, session.expiresAt);

        return session;
    }

    getUserBySession(token: string): StoredUser | null {
        const row = this.db.prepare(`
            SELECT u.*
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > ?
            LIMIT 1
        `).get(token, now()) as {
            id: string;
            email: string;
            password_hash: string;
            password_salt: string;
            is_admin: number;
            is_verified: number;
            created_at: number;
        } | undefined;

        return row ? this.mapUser(row) : null;
    }

    revokeSession(token: string): void {
        this.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    }

    hashApiKey(rawKey: string): string {
        return crypto.createHash("sha256").update(rawKey).digest("hex");
    }

    createApiKey(name: string, ownerUserId: string): {record: ApiKeyRecord; plaintext: string} {
        const plaintext = `sk-proxy-${crypto.randomBytes(20).toString("hex")}`;
        const record: ApiKeyRecord = {
            id: `key_${crypto.randomUUID().replaceAll("-", "")}`,
            name,
            keyPrefix: plaintext.slice(0, 8),
            keySuffix: plaintext.slice(-4),
            hashedKey: this.hashApiKey(plaintext),
            createdAt: now(),
            updatedAt: now(),
            lastUsedAt: null,
            ownerUserId,
            isActive: true,
        };

        this.db.prepare(`
            INSERT INTO api_keys (id, name, key_prefix, key_suffix, hashed_key, created_at, updated_at, last_used_at, owner_user_id, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)
        `).run(
            record.id,
            record.name,
            record.keyPrefix,
            record.keySuffix,
            record.hashedKey,
            record.createdAt,
            record.updatedAt,
            record.ownerUserId,
        );

        return {record, plaintext};
    }

    listApiKeys(): ApiKeyRecord[] {
        const rows = this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as Array<{
            id: string;
            name: string;
            key_prefix: string;
            key_suffix: string;
            hashed_key: string;
            created_at: number;
            updated_at: number;
            last_used_at: number | null;
            owner_user_id: string;
            is_active: number;
        }>;

        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            keyPrefix: row.key_prefix,
            keySuffix: row.key_suffix,
            hashedKey: row.hashed_key,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastUsedAt: row.last_used_at,
            ownerUserId: row.owner_user_id,
            isActive: Boolean(row.is_active),
        }));
    }

    updateApiKey(id: string, patch: Partial<Pick<ApiKeyRecord, "name" | "isActive">>): ApiKeyRecord | null {
        const existing = this.listApiKeys().find((k) => k.id === id);
        if (!existing) return null;

        const name = typeof patch.name === "string" ? patch.name : existing.name;
        const isActive = typeof patch.isActive === "boolean" ? patch.isActive : existing.isActive;
        const updatedAt = now();

        this.db.prepare("UPDATE api_keys SET name = ?, is_active = ?, updated_at = ? WHERE id = ?").run(
            name,
            isActive ? 1 : 0,
            updatedAt,
            id,
        );

        return {
            ...existing,
            name,
            isActive,
            updatedAt,
        };
    }

    deleteApiKey(id: string): boolean {
        const result = this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
        return result.changes > 0;
    }

    validateApiKey(rawKey: string): ApiKeyRecord | null {
        const hashed = this.hashApiKey(rawKey);
        const row = this.db.prepare("SELECT * FROM api_keys WHERE hashed_key = ? AND is_active = 1 LIMIT 1").get(hashed) as {
            id: string;
            name: string;
            key_prefix: string;
            key_suffix: string;
            hashed_key: string;
            created_at: number;
            updated_at: number;
            last_used_at: number | null;
            owner_user_id: string;
            is_active: number;
        } | undefined;

        if (!row) return null;

        const lastUsed = now();
        this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(lastUsed, row.id);

        return {
            id: row.id,
            name: row.name,
            keyPrefix: row.key_prefix,
            keySuffix: row.key_suffix,
            hashedKey: row.hashed_key,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastUsedAt: lastUsed,
            ownerUserId: row.owner_user_id,
            isActive: Boolean(row.is_active),
        };
    }

    isModelEnabled(model: string): boolean {
        const row = this.db.prepare("SELECT enabled FROM model_policies WHERE model_id = ?").get(model) as {enabled: number} | undefined;
        if (!row) return false;
        return Boolean(row.enabled);
    }

    setModelEnabled(model: string, enabled: boolean): void {
        this.db.prepare("INSERT OR REPLACE INTO model_policies (model_id, enabled) VALUES (?, ?)").run(model, enabled ? 1 : 0);
    }

    listModelStatus(): Array<{id: string; enabled: boolean}> {
        const rows = this.db.prepare("SELECT model_id, enabled FROM model_policies").all() as Array<{model_id: string; enabled: number}>;
        const map = new Map(rows.map((r) => [r.model_id, Boolean(r.enabled)]));
        return SUPPORTED_MODELS.map((modelId) => ({id: modelId, enabled: map.get(modelId) ?? true}));
    }

    addUsageRecord(record: {
        apiKeyId: string;
        model: string;
        endpoint: string;
        inputTokens: number;
        outputTokens: number;
        statusCode: number;
    }) {
        this.db.prepare(`
            INSERT INTO usage_events (id, api_key_id, model, endpoint, input_tokens, output_tokens, timestamp, status_code)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            `usage_${crypto.randomUUID().replaceAll("-", "")}`,
            record.apiKeyId,
            record.model,
            record.endpoint,
            record.inputTokens,
            record.outputTokens,
            now(),
            record.statusCode,
        );
    }

    getUsageSummary() {
        const total = this.db.prepare(`
            SELECT
                COUNT(*) AS total_requests,
                COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens
            FROM usage_events
        `).get() as {total_requests: number; total_input_tokens: number; total_output_tokens: number};

        const byModelRows = this.db.prepare(`
            SELECT model, COUNT(*) as requests, COALESCE(SUM(input_tokens),0) as input_tokens, COALESCE(SUM(output_tokens),0) as output_tokens
            FROM usage_events
            GROUP BY model
        `).all() as Array<{model: string; requests: number; input_tokens: number; output_tokens: number}>;

        const byModelMap = new Map(byModelRows.map((r) => [r.model, r]));
        const byModel = SUPPORTED_MODELS.map((model) => {
            const row = byModelMap.get(model);
            return {
                model,
                requests: row?.requests ?? 0,
                inputTokens: row?.input_tokens ?? 0,
                outputTokens: row?.output_tokens ?? 0,
            };
        });

        const byDay = this.db.prepare(`
            SELECT
                strftime('%Y-%m-%d', datetime(timestamp / 1000, 'unixepoch')) AS day,
                COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
            FROM usage_events
            GROUP BY day
            ORDER BY day ASC
        `).all() as Array<{day: string; requests: number; input_tokens: number; output_tokens: number}>;

        const byEndpoint = this.db.prepare(`
            SELECT endpoint, COUNT(*) AS requests
            FROM usage_events
            GROUP BY endpoint
            ORDER BY requests DESC
        `).all() as Array<{endpoint: string; requests: number}>;

        const byApiKey = this.db.prepare(`
            SELECT
                k.id AS id,
                k.name AS name,
                COUNT(u.id) AS requests,
                COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(u.output_tokens), 0) AS output_tokens
            FROM usage_events u
            JOIN api_keys k ON k.id = u.api_key_id
            GROUP BY k.id, k.name
            ORDER BY requests DESC
        `).all() as Array<{id: string; name: string; requests: number; input_tokens: number; output_tokens: number}>;

        const recent = this.db.prepare(`
            SELECT id, api_key_id, model, endpoint, input_tokens, output_tokens, timestamp, status_code
            FROM usage_events
            ORDER BY timestamp DESC
            LIMIT 200
        `).all();

        return {
            totalRequests: total.total_requests,
            totalInputTokens: total.total_input_tokens,
            totalOutputTokens: total.total_output_tokens,
            byModel,
            byDay: byDay.map((d) => ({
                day: d.day,
                requests: d.requests,
                inputTokens: d.input_tokens,
                outputTokens: d.output_tokens,
            })),
            byEndpoint,
            byApiKey: byApiKey.map((k) => ({
                id: k.id,
                name: k.name,
                requests: k.requests,
                inputTokens: k.input_tokens,
                outputTokens: k.output_tokens,
            })),
            recent,
        };
    }
}

export const dashboardStore = new DashboardStore();
export const dashboardDbPath = DB_PATH;
