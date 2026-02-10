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

    const line = points
        .map((point, index) => {
            const x = index * step;
            const y = height - (point.requests / max) * (height - 18);
            return `${x},${y}`;
        })
        .join(" ");

    const bars = points.map((point, index) => {
        const x = index * step - 4;
        const barHeight = (point.requests / max) * (height - 18);
        const y = height - barHeight;
        return <rect key={`${point.day}-bar`} x={x} y={y} width="8" height={barHeight} fill="rgba(87, 96, 255, .35)" rx="2" />;
    });

    return (
        <div className="chart-wrap">
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="chart">
                {bars}
                <polyline points={line} fill="none" stroke="#8b5cf6" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
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
    const [activeSection, setActiveSection] = useState<Section>("keys");

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
                        <div className="dot" />
                        <h1>OpenGemini Dashboard</h1>
                    </div>
                    <p className="sub">Secure admin control panel</p>
                    <label>Email</label>
                    <input placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <label>Password</label>
                    <input placeholder="••••••••" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    <div className="actions">
                        <button onClick={login}>Sign in</button>
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
                <div className="logo">OG</div>
                <div className="side-title">OpenGemini Dashboard</div>
                <div className="menu">
                    <button className={`menu-item ${activeSection === "keys" ? "active" : ""}`} onClick={() => setActiveSection("keys")}>API keys</button>
                    <button className={`menu-item ${activeSection === "models" ? "active" : ""}`} onClick={() => setActiveSection("models")}>Models</button>
                    <button className={`menu-item ${activeSection === "usage" ? "active" : ""}`} onClick={() => setActiveSection("usage")}>Usage</button>
                </div>
                <button className="secondary" onClick={() => { localStorage.removeItem(tokenKey); setToken(""); }}>Log out</button>
            </aside>
            <main className="content">
                <header className="topbar">
                    <h2>OpenGemini Dashboard</h2>
                    <div>{user.email}</div>
                </header>

                {activeSection === "keys" && (
                    <section className="card">
                        <div className="row-between">
                            <h3>API keys</h3>
                            <button onClick={createKey}>+ Create new secret key</button>
                        </div>
                        {createdKey && <div className="banner">Save this key now: <code>{createdKey}</code></div>}
                        <table>
                            <thead><tr><th>NAME</th><th>STATUS</th><th>SECRET KEY</th><th>CREATED</th><th>LAST USED</th><th></th></tr></thead>
                            <tbody>
                            {apiKeys.map((k) => <tr key={k.id}><td>{k.name}</td><td>{k.isActive ? "Active" : "Disabled"}</td><td>{k.maskedKey}</td><td>{new Date(k.createdAt).toLocaleDateString()}</td><td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}</td><td><button className="danger" onClick={() => deleteKey(k.id)}>Delete</button></td></tr>)}
                            </tbody>
                        </table>
                    </section>
                )}

                {activeSection === "models" && (
                    <section className="card">
                        <h3>Models policy</h3>
                        <div className="models-grid">
                            {models.map((m) => <label key={m.id} className="model-item"><span>{m.id}</span><input type="checkbox" checked={m.enabled} onChange={(e) => toggleModel(m.id, e.target.checked)} /></label>)}
                        </div>
                    </section>
                )}

                {activeSection === "usage" && usage && (
                    <>
                        <section className="card stats-grid">
                            <div className="stat"><span>Total requests</span><strong>{formatNumber(usage.totalRequests)}</strong></div>
                            <div className="stat"><span>Input tokens</span><strong>{formatNumber(usage.totalInputTokens)}</strong></div>
                            <div className="stat"><span>Output tokens</span><strong>{formatNumber(usage.totalOutputTokens)}</strong></div>
                        </section>

                        <section className="card">
                            <h3>Usage over time</h3>
                            <UsageChart points={usage.byDay} />
                        </section>

                        <section className="card split">
                            <div>
                                <h3>By API key</h3>
                                <table>
                                    <thead><tr><th>KEY</th><th>REQUESTS</th><th>INPUT</th><th>OUTPUT</th></tr></thead>
                                    <tbody>{usage.byApiKey.map((k) => <tr key={k.id}><td>{k.name}</td><td>{k.requests}</td><td>{k.inputTokens}</td><td>{k.outputTokens}</td></tr>)}</tbody>
                                </table>
                            </div>
                            <div>
                                <h3>By endpoint</h3>
                                <table>
                                    <thead><tr><th>ENDPOINT</th><th>REQUESTS</th></tr></thead>
                                    <tbody>{usage.byEndpoint.map((e) => <tr key={e.endpoint}><td>{e.endpoint}</td><td>{e.requests}</td></tr>)}</tbody>
                                </table>
                            </div>
                        </section>
                    </>
                )}
            </main>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
