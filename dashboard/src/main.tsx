import React, {useEffect, useMemo, useState} from "react";
import {createRoot} from "react-dom/client";
import "./styles.css";

type User = {id: string; email: string; isAdmin: boolean; isVerified: boolean};
type ApiKey = {id: string; name: string; maskedKey: string; isActive: boolean; lastUsedAt: number | null; createdAt: number};
type ModelStatus = {id: string; enabled: boolean};
type UsageSummary = {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    byModel: Array<{model: string; requests: number; inputTokens: number; outputTokens: number}>;
    byDay: Array<{day: string; requests: number; inputTokens: number; outputTokens: number}>;
    byEndpoint: Array<{endpoint: string; requests: number}>;
    byApiKey: Array<{id: string; name: string; requests: number; inputTokens: number; outputTokens: number}>;
};

type Section = "keys" | "models" | "usage";
type NoticeTone = "info" | "success" | "error";
type Notice = {title: string; message: string; tone?: NoticeTone};

const tokenKey = "dashboard_token";

function formatNumber(value: number) {
    return new Intl.NumberFormat("en-US").format(value);
}

function Icon({path, className}: {path: string; className?: string}) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={path} />
        </svg>
    );
}

function Dialog({
    isOpen,
    title,
    children,
    onClose,
    onSubmit,
    submitLabel = "OK",
}: {
    isOpen: boolean;
    title: string;
    children: React.ReactNode;
    onClose: () => void;
    onSubmit?: () => void;
    submitLabel?: string;
}) {
    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h3>{title}</h3>
                {children}
                <div className="modal-actions">
                    <button className="secondary" onClick={onClose}>Cancel</button>
                    {onSubmit && <button className="primary" onClick={onSubmit}>{submitLabel}</button>}
                </div>
            </div>
        </div>
    );
}

function AlertModal({notice, onClose}: {notice: Notice | null; onClose: () => void}) {
    if (!notice) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className={`modal modal-notice ${notice.tone ? `tone-${notice.tone}` : ""}`} onClick={(e) => e.stopPropagation()}>
                <h3>{notice.title}</h3>
                <p>{notice.message}</p>
                <div className="modal-actions">
                    <button className="primary" onClick={onClose}>Got it</button>
                </div>
            </div>
        </div>
    );
}

function UsageChart({points}: {points: UsageSummary["byDay"]}) {
    if (!points.length) return <div className="empty">No usage data yet.</div>;

    const max = Math.max(...points.map((point) => point.requests), 1);
    const width = 860;
    const height = 260;
    const step = points.length > 1 ? width / (points.length - 1) : width;

    return (
        <div className="chart-wrap">
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="chart">
                {points.map((point, index) => {
                    const x = index * step - 10;
                    const barHeight = (point.requests / max) * (height - 24);
                    const y = height - barHeight;
                    return <rect key={`${point.day}-bar`} className="bar-hover" x={x} y={y} width="20" height={barHeight} fill="rgba(255,255,255,0.16)" rx="4" />;
                })}
            </svg>
            <div className="chart-footer">
                <span>{points[0]?.day}</span>
                <span>{points[points.length - 1]?.day}</span>
            </div>
        </div>
    );
}

function App() {
    const [token, setToken] = useState<string>(() => localStorage.getItem(tokenKey) ?? "");
    const [user, setUser] = useState<User | null>(null);
    const [activeSection, setActiveSection] = useState<Section>("usage");

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [otpMessage, setOtpMessage] = useState("");

    const [createdKey, setCreatedKey] = useState("");
    const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
    const [models, setModels] = useState<ModelStatus[]>([]);
    const [usage, setUsage] = useState<UsageSummary | null>(null);

    const [alertNotice, setAlertNotice] = useState<Notice | null>(null);
    const [isKeyModalOpen, setKeyModalOpen] = useState(false);
    const [newKeyName, setNewKeyName] = useState("");
    const [keyToDelete, setKeyToDelete] = useState<ApiKey | null>(null);

    const authHeaders = useMemo(() => ({Authorization: `Bearer ${token}`, "Content-Type": "application/json"}), [token]);

    const clearToken = () => {
        localStorage.removeItem(tokenKey);
        setToken("");
        setUser(null);
    };

    const copyText = async (text: string, successMessage: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setAlertNotice({title: "Copied", message: successMessage, tone: "success"});
        } catch {
            setAlertNotice({title: "Copy failed", message: "Unable to copy automatically. Please copy manually.", tone: "error"});
        }
    };

    const refreshAuthedData = async () => {
        const [meRes, keysRes, modelsRes, usageRes] = await Promise.all([
            fetch("/dashboard/api/me", {headers: authHeaders}),
            fetch("/dashboard/api/keys", {headers: authHeaders}),
            fetch("/dashboard/api/models", {headers: authHeaders}),
            fetch("/dashboard/api/usage", {headers: authHeaders}),
        ]);

        if (!meRes.ok) {
            clearToken();
            return;
        }

        setUser(await meRes.json());
        setApiKeys((await keysRes.json()).data ?? []);
        const modelPayload = await modelsRes.json();
        setModels((modelPayload.data ?? []).map((m: {id: string; enabled: boolean}) => ({id: m.id, enabled: m.enabled})));
        setUsage(await usageRes.json());
    };

    useEffect(() => {
        if (token) {
            refreshAuthedData().catch(console.error);
        }
    }, [token]);

    const login = async () => {
        setOtpMessage("");
        const res = await fetch("/dashboard/api/auth/login", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({email, password}),
        });
        const data = await res.json();

        if (res.status === 403 && data.requiresVerification) {
            setOtpMessage(`OTP: ${data.oneTimeCode}. Press 'c' in proxy console and enter code.`);
            return;
        }

        if (!res.ok) {
            setAlertNotice({title: "Sign in failed", message: data.error ?? "Login failed", tone: "error"});
            return;
        }

        localStorage.setItem(tokenKey, data.token);
        setToken(data.token);
    };

    const register = async () => {
        const res = await fetch("/dashboard/api/auth/register", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({email, password}),
        });
        const data = await res.json();
        if (!res.ok) {
            setAlertNotice({title: "Registration failed", message: data.error ?? "Register failed", tone: "error"});
            return;
        }
        setOtpMessage(`OTP: ${data.oneTimeCode}. Press 'c' in proxy console and enter code.`);
    };

    const initiateCreateKey = () => {
        setNewKeyName("Default key");
        setKeyModalOpen(true);
    };

    const confirmCreateKey = async () => {
        if (!newKeyName) return;

        setKeyModalOpen(false);
        const res = await fetch("/dashboard/api/keys", {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({name: newKeyName}),
        });
        const data = await res.json();
        if (!res.ok) {
            setAlertNotice({title: "Key creation failed", message: data.error ?? "Unable to create key", tone: "error"});
            return;
        }
        setCreatedKey(data.key);
        await refreshAuthedData();
    };

    const confirmDeleteKey = async () => {
        if (!keyToDelete) return;

        await fetch(`/dashboard/api/keys/${keyToDelete.id}`, {method: "DELETE", headers: authHeaders});
        setKeyToDelete(null);
        await refreshAuthedData();
        setAlertNotice({title: "API key revoked", message: `Key "${keyToDelete.name}" was deleted.`, tone: "info"});
    };

    const copyStoredKey = async (apiKey: ApiKey) => {
        const res = await fetch(`/dashboard/api/keys/${apiKey.id}/secret`, {headers: authHeaders});
        const data = await res.json();
        if (!res.ok || !data.key) {
            setAlertNotice({title: "Copy failed", message: data.error ?? "Unable to load key from database", tone: "error"});
            return;
        }

        await copyText(data.key, "API key copied");
    };


    const toggleModel = async (id: string, enabled: boolean) => {
        await fetch(`/dashboard/api/models/${id}`, {
            method: "PATCH",
            headers: authHeaders,
            body: JSON.stringify({enabled}),
        });
        await refreshAuthedData();
    };

    if (!token || !user) {
        return (
            <div className="auth-wrap">
                <div className="auth-panel">
                    <div className="auth-header"><h1>OpenGemini Dashboard</h1></div>
                    <label className="field-label">Email</label>
                    <input className="field-input" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <label className="field-label">Password</label>
                    <input className="field-input" placeholder="••••••••" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    <div className="actions">
                        <button className="primary" onClick={login}>Sign in</button>
                        <button className="secondary" onClick={register}>Create account</button>
                    </div>
                    {otpMessage && (
                        <div className="otp">
                            <strong>Verify account</strong>
                            <span>{otpMessage}</span>
                        </div>
                    )}
                </div>

                <AlertModal notice={alertNotice} onClose={() => setAlertNotice(null)} />
            </div>
        );
    }

    return (
        <div className="app-shell">
            <aside className="sidebar">
                <div className="project-line">
                    <div className="avatar">P</div>
                    <div>
                        <strong>Personal</strong>
                        <span>Default project</span>
                    </div>
                </div>

                <div className="menu-group">Manage</div>
                <button className={`menu-item ${activeSection === "usage" ? "active" : ""}`} onClick={() => setActiveSection("usage")}>
                    <Icon className="menu-icon" path="M3 3v18h18M8 14l3-3 2 2 5-5" /> Usage
                </button>
                <button className={`menu-item ${activeSection === "keys" ? "active" : ""}`} onClick={() => setActiveSection("keys")}>
                    <Icon className="menu-icon" path="M15 7a4 4 0 1 0-7.8 1.3L3 12.5V16h3.5l1.5-1.5V13h1.5l1.5-1.5V10h.3A4 4 0 0 0 15 7Z" /> API keys
                </button>
                <button className={`menu-item ${activeSection === "models" ? "active" : ""}`} onClick={() => setActiveSection("models")}>
                    <Icon className="menu-icon" path="M12 2l8 4.5v11L12 22 4 17.5v-11L12 2Zm0 0v20" /> Models
                </button>

                <div className="sidebar-footer">
                    <button className="token-action danger" onClick={clearToken}>
                        <Icon className="menu-icon" path="M6 6l12 12M18 6L6 18" /> Log out
                    </button>
                </div>
            </aside>

            <div className="content-wrap">
                <header className="top-nav">
                    <div className="top-links"><strong>Dashboard</strong><span>API Docs</span></div>
                    <div className="user-pill">{user.email.slice(0, 1).toUpperCase()}</div>
                </header>

                <main className="content-card">
                    {activeSection === "keys" && (
                        <section>
                            <div className="section-header">
                                <h2>API keys</h2>
                                <button className="primary" onClick={initiateCreateKey}><Icon className="button-icon" path="M12 5v14M5 12h14" />Create new secret key</button>
                            </div>
                            <p className="description">Manage secret keys for this project. Keep them secure and rotate regularly.</p>

                            {createdKey && (
                                <div className="banner">
                                    <div>
                                        <strong>Save this key now:</strong> <code>{createdKey}</code>
                                    </div>
                                    <button className="icon-btn" onClick={() => copyText(createdKey, "New API key copied") } title="Copy key">
                                        <Icon path="M9 9h11v11H9zM4 15V4h11" />
                                    </button>
                                </div>
                            )}

                            <table>
                                <thead>
                                    <tr>
                                        <th>NAME</th><th>STATUS</th><th>SECRET KEY</th><th>CREATED</th><th>LAST USED</th><th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {apiKeys.map((k) => (
                                        <tr key={k.id}>
                                            <td>{k.name}</td>
                                            <td><span className={`badge ${k.isActive ? "active" : "inactive"}`}>{k.isActive ? "Active" : "Disabled"}</span></td>
                                            <td className="masked-key">{k.maskedKey}</td>
                                            <td>{new Date(k.createdAt).toLocaleDateString()}</td>
                                            <td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "Never"}</td>
                                            <td className="actions-cell">
                                                <button className="icon-btn" onClick={() => copyStoredKey(k)} title="Copy API key">
                                                    <Icon path="M9 9h11v11H9zM4 15V4h11" />
                                                </button>
                                                <button className="icon-btn danger" onClick={() => setKeyToDelete(k)} title="Revoke key">
                                                    <Icon path="M3 6h18M8 6V4h8v2m-1 0v14H9V6" />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    )}

                    {activeSection === "usage" && usage && (
                        <section>
                            <div className="section-header"><h2>Usage</h2></div>
                            <div className="stats-grid">
                                <div className="stat-box"><span>Total requests</span><strong>{formatNumber(usage.totalRequests)}</strong></div>
                                <div className="stat-box"><span>Input tokens</span><strong>{formatNumber(usage.totalInputTokens)}</strong></div>
                                <div className="stat-box"><span>Output tokens</span><strong>{formatNumber(usage.totalOutputTokens)}</strong></div>
                            </div>
                            <div className="panel">
                                <h3>Activity</h3>
                                <UsageChart points={usage.byDay} />
                            </div>
                            <div className="two-columns">
                                <div className="panel">
                                    <h3>By model</h3>
                                    <table>
                                        <thead><tr><th>Model</th><th className="align-right">Requests</th></tr></thead>
                                        <tbody>
                                            {usage.byModel.filter((m) => m.requests > 0).map((m) => (
                                                <tr key={m.model}><td>{m.model}</td><td className="align-right">{m.requests}</td></tr>
                                            ))}
                                            {usage.byModel.every((m) => m.requests === 0) && <tr><td colSpan={2} className="empty-cell">No data</td></tr>}
                                        </tbody>
                                    </table>
                                </div>
                                <div className="panel">
                                    <h3>By API key</h3>
                                    <table>
                                        <thead><tr><th>Key name</th><th className="align-right">Usage</th></tr></thead>
                                        <tbody>{usage.byApiKey.map((k) => <tr key={k.id}><td>{k.name}</td><td className="align-right">{k.requests} reqs</td></tr>)}</tbody>
                                    </table>
                                </div>
                            </div>
                        </section>
                    )}

                    {activeSection === "models" && (
                        <section>
                            <div className="section-header"><h2>Model configuration</h2></div>
                            <p className="description">Enable or disable specific Gemini models for this proxy.</p>
                            <div className="models-grid">
                                {models.map((m) => (
                                    <label key={m.id} className="model-item">
                                        <span>{m.id}</span>
                                        <input type="checkbox" checked={m.enabled} onChange={(e) => toggleModel(m.id, e.target.checked)} />
                                    </label>
                                ))}
                            </div>
                        </section>
                    )}
                </main>
            </div>

            <Dialog
                isOpen={isKeyModalOpen}
                title="Create new API key"
                onClose={() => setKeyModalOpen(false)}
                onSubmit={confirmCreateKey}
                submitLabel="Create"
            >
                <p>Enter a name for this key to easily identify it later.</p>
                <input
                    autoFocus
                    placeholder="e.g. My App Key"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && confirmCreateKey()}
                />
            </Dialog>


            <Dialog
                isOpen={Boolean(keyToDelete)}
                title="Revoke API key"
                onClose={() => setKeyToDelete(null)}
                onSubmit={confirmDeleteKey}
                submitLabel="Revoke key"
            >
                <p>Are you sure you want to revoke <code>{keyToDelete?.name}</code>? This action cannot be undone.</p>
            </Dialog>

            <AlertModal notice={alertNotice} onClose={() => setAlertNotice(null)} />
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
