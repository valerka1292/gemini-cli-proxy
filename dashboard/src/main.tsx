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

const tokenKey = "dashboard_token";

function formatNumber(value: number) {
    return new Intl.NumberFormat("en-US").format(value);
}

function UsageChart({points}: {points: UsageSummary["byDay"]}) {
    if (!points.length) {
        return <div className="empty">No usage data yet.</div>;
    }

    const max = Math.max(...points.map((point) => point.requests), 1);
    const width = 820;
    const height = 230;
    const step = points.length > 1 ? width / (points.length - 1) : width;

    return (
        <div className="chart-wrap">
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="chart">
                {points.map((point, index) => {
                    const x = index * step - 4;
                    const barHeight = (point.requests / max) * (height - 18);
                    const y = height - barHeight;
                    return <rect key={`${point.day}-bar`} className="bar-hover" x={x} y={y} width="8" height={barHeight} fill="rgba(16,163,127,0.45)" rx="2" />;
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

    const authHeaders = useMemo(() => ({Authorization: `Bearer ${token}`, "Content-Type": "application/json"}), [token]);

    const refreshAuthedData = async () => {
        const [meRes, keysRes, modelsRes, usageRes] = await Promise.all([
            fetch("/dashboard/api/me", {headers: authHeaders}),
            fetch("/dashboard/api/keys", {headers: authHeaders}),
            fetch("/dashboard/api/models", {headers: authHeaders}),
            fetch("/dashboard/api/usage", {headers: authHeaders}),
        ]);

        if (!meRes.ok) {
            setUser(null);
            localStorage.removeItem(tokenKey);
            setToken("");
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
            alert(data.error ?? "Login failed");
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
            alert(data.error ?? "Register failed");
            return;
        }
        setOtpMessage(`OTP: ${data.oneTimeCode}. Press 'c' in proxy console and enter code.`);
    };

    const createKey = async () => {
        const name = prompt("API key name", "Default key");
        if (!name) return;
        const res = await fetch("/dashboard/api/keys", {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({name}),
        });
        const data = await res.json();
        if (!res.ok) {
            alert(data.error ?? "Unable to create key");
            return;
        }
        setCreatedKey(data.key);
        await refreshAuthedData();
    };

    const deleteKey = async (id: string) => {
        await fetch(`/dashboard/api/keys/${id}`, {method: "DELETE", headers: authHeaders});
        await refreshAuthedData();
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
                    <div className="auth-header">
                        <h1>OpenGemini Dashboard</h1>
                    </div>
                    <label>Email</label>
                    <input placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <label>Password</label>
                    <input placeholder="••••••••" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    <div className="actions">
                        <button className="primary" onClick={login}>Sign in</button>
                        <button className="secondary" onClick={register}>Create account</button>
                    </div>
                    {otpMessage && <div className="otp">{otpMessage}</div>}
                </div>
            </div>
        );
    }

    return (
        <div className="page">
            <aside className="sidebar">
                <div className="logo">
                    <div className="logo-icon">P</div>
                    Personal
                </div>

                <div className="menu-section">Manage</div>
                <button className={`menu-item ${activeSection === "usage" ? "active" : ""}`} onClick={() => setActiveSection("usage")}>
                    📊 Usage
                </button>
                <button className={`menu-item ${activeSection === "keys" ? "active" : ""}`} onClick={() => setActiveSection("keys")}>
                    🔑 API keys
                </button>

                <div className="menu-section">Configuration</div>
                <button className={`menu-item ${activeSection === "models" ? "active" : ""}`} onClick={() => setActiveSection("models")}>
                    🤖 Models
                </button>

                <div style={{marginTop: "auto"}}>
                    <button className="menu-item" onClick={() => { localStorage.removeItem(tokenKey); setToken(""); }}>Log out</button>
                </div>
            </aside>

            <main className="content">
                {activeSection === "keys" && (
                    <section>
                        <div className="row-between">
                            <div><h2>API keys</h2></div>
                            <button className="primary" onClick={createKey}>+ Create new secret key</button>
                        </div>
                        <p className="description">
                            Your secret API keys are listed below. Please note that we do not display your secret keys again after you generate them.
                            Do not share your API key with others.
                        </p>

                        {createdKey && (
                            <div className="banner" style={{marginBottom: 20, background: "#10261e", border: "1px solid #10a37f", color: "#fff"}}>
                                <strong>Save this key:</strong> <code style={{color: "#fff", background: "transparent"}}>{createdKey}</code>
                            </div>
                        )}

                        <table>
                            <thead>
                                <tr>
                                    <th style={{width: "25%"}}>NAME</th>
                                    <th style={{width: "15%"}}>STATUS</th>
                                    <th style={{width: "30%"}}>SECRET KEY</th>
                                    <th style={{width: "15%"}}>CREATED</th>
                                    <th style={{width: "15%"}}>LAST USED</th>
                                    <th></th>
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
                                        <td style={{textAlign: "right"}}><button className="danger" onClick={() => deleteKey(k.id)}>Revoke</button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </section>
                )}

                {activeSection === "usage" && usage && (
                    <section>
                        <div className="topbar"><h2>Usage</h2></div>

                        <div className="stats-header">
                            <div className="stat-box"><span>Requests</span><strong>{formatNumber(usage.totalRequests)}</strong></div>
                            <div className="stat-box"><span>Tokens Generated</span><strong>{formatNumber(usage.totalOutputTokens)}</strong></div>
                        </div>

                        <div className="card">
                            <h3>Activity</h3>
                            <div className="chart-container"><UsageChart points={usage.byDay} /></div>
                        </div>

                        <div className="row-between" style={{alignItems: "flex-start", gap: 40}}>
                            <div style={{flex: 1}}>
                                <h3>By Model</h3>
                                <table>
                                    <thead><tr><th>Model</th><th style={{textAlign: "right"}}>Requests</th></tr></thead>
                                    <tbody>
                                        {usage.byModel.filter((m) => m.requests > 0).map((m) => (
                                            <tr key={m.model}><td>{m.model}</td><td style={{textAlign: "right"}}>{m.requests}</td></tr>
                                        ))}
                                        {usage.byModel.every((m) => m.requests === 0) && <tr><td colSpan={2} style={{color: "#666", textAlign: "center"}}>No data</td></tr>}
                                    </tbody>
                                </table>
                            </div>
                            <div style={{flex: 1}}>
                                <h3>By API Key</h3>
                                <table>
                                    <thead><tr><th>Key Name</th><th style={{textAlign: "right"}}>Usage</th></tr></thead>
                                    <tbody>
                                        {usage.byApiKey.map((k) => (
                                            <tr key={k.id}><td>{k.name}</td><td style={{textAlign: "right"}}>{k.requests} reqs</td></tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </section>
                )}

                {activeSection === "models" && (
                    <section>
                        <div className="topbar">
                            <h2>Model Configuration</h2>
                            <div className="topbar-sub">Enable or disable specific Gemini models for this proxy.</div>
                        </div>
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
    );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
