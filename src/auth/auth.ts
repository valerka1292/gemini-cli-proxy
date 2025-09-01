/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    OAuth2Client,
    Credentials,
    CodeChallengeMethod,
} from "google-auth-library";
import * as http from "http";
import url from "url";
import crypto from "crypto";
import * as net from "net";
import open from "open";
import path from "node:path";
import {promises as fs} from "node:fs";
import {
    cacheGoogleAccount, 
    getCachedGoogleAccount, 
    clearCachedGoogleAccount 
} from "../utils/user_account.js";
import {getCachedCredentialPath} from "../utils/paths.js";
import readline from "node:readline";
import {Logger, getLogger} from "../utils/logger.js";
import chalk from "chalk";

// OAuth Client ID used to initiate OAuth2Client class.
const OAUTH_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";

// OAuth Secret value used to initiate OAuth2Client class.
// Note: It's ok to save this in git because this is an installed application
// as described here: https://developers.google.com/identity/protocols/oauth2#installed
const OAUTH_CLIENT_SECRET = "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";

// OAuth Scopes for Cloud Code authorization.
const OAUTH_SCOPE = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
];

const HTTP_REDIRECT = 301;
const SIGN_IN_SUCCESS_URL =
  "https://developers.google.com/gemini-code-assist/auth_success_gemini";
const SIGN_IN_FAILURE_URL =
  "https://developers.google.com/gemini-code-assist/auth_failure_gemini";

/**
 * An Authentication URL for updating the credentials of a OAuth2Client
 * as well as a promise that will resolve when the credentials have
 * been refreshed (or which throws error when refreshing credentials failed).
 */
interface OauthWebLogin {
    authUrl: string;
    loginCompletePromise: Promise<void>;
}

let userEmail: string | undefined;

/**
 * Set up Google authentication
 * @returns OAuth2Client with valid credentials
 */
export async function setupAuthentication(disableBrowserAuth: boolean): Promise<OAuth2Client> {
    const logger = getLogger("AUTH", chalk.blue);
    logger.info("setting up Google authentication...");
    logger.info("if you have not used gemini-cli before, you might be prompted to sign-in");
  
    const client = new OAuth2Client({
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
    });

    client.on("tokens", async (tokens: Credentials) => {
        await cacheCredentials(tokens);
    });

    // If there are cached creds on disk, they always take precedence
    if (await loadCachedCredentials(client)) {
    // Found valid cached credentials.
    // Check if we need to retrieve Google Account ID or Email
        if (!getCachedGoogleAccount()) {
            try {
                await fetchAndCacheUserInfo(client, logger);
            } catch {
                // Non-fatal, continue with existing auth.
            }
        }
        logger.info(`cached credentials loaded for: ${chalk.bold.underline(userEmail)}`);
        logger.info(`to use another account, remove ${chalk.underline("~/.gemini")} folder and restart server`);
        return client;
    }

    // Determine whether to use browser or code-based auth
    if (isBrowserLaunchSuppressed(disableBrowserAuth)) {
        let success = false;
        const maxRetries = 2;
        for (let i = 0; !success && i < maxRetries; i++) {
            success = await authWithUserCode(client, logger);
            if (!success) {
                logger.error(`Failed to authenticate with user code. ${i === maxRetries - 1 ? "" : "Retrying..."}`);
            }
        }
        if (!success) {
            process.exit(1);
        }
    } else {
        const webLogin = await authWithWeb(client, logger);

        logger.info("Google login required.");
        logger.info("Opening auth page, otherwise navigate to:");
        logger.info(`${webLogin.authUrl}`);
    
        try {
            // Attempt to open the authentication URL in the default browser.
            const childProcess = await open(webLogin.authUrl);

            // Attach an error handler to the returned child process.
            childProcess.on("error", (_) => {
                logger.error("Failed to open browser automatically. Please try running again with NO_BROWSER=true set.");
                process.exit(1);
            });
        } catch (err) {
            logger.error("Failed to open browser automatically. Please try running again with NO_BROWSER=true set.");
            if (err instanceof Error) {
                logger.error(err.message);
            }
            process.exit(1);
        }
    
        logger.info("Waiting for authentication...");
        await webLogin.loginCompletePromise;
        logger.info("Authentication complete.");
    }

    return client;
}

/**
 * Authenticate with user code flow (for headless environments)
 * @param client OAuth2Client instance
 * @param logger
 * @returns true if authentication was successful
 */
async function authWithUserCode(client: OAuth2Client, logger: Logger): Promise<boolean> {
    const redirectUri = "https://codeassist.google.com/authcode";
    const codeVerifier = await client.generateCodeVerifierAsync();
    const state = crypto.randomBytes(32).toString("hex");
    const authUrl: string = client.generateAuthUrl({
        redirect_uri: redirectUri,
        access_type: "offline",
        scope: OAUTH_SCOPE,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: codeVerifier.codeChallenge,
        state,
    });

    logger.info("Please visit the following URL to authorize the application:");
    logger.info(`${authUrl}\n`);

    const code = await new Promise<string>((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        logger.info("Enter auth code");
        rl.question("Code: ", (code) => {
            rl.close();
            resolve(code.trim());
        });
    });

    if (!code) {
        logger.error("Auth code is required");
        return false;
    }

    try {
        const {tokens} = await client.getToken({
            code,
            codeVerifier: codeVerifier.codeVerifier,
            redirect_uri: redirectUri,
        });
        client.setCredentials(tokens);
    } catch (_error) {
        return false;
    }
  
    return true;
}

/**
 * Authenticate with web-based flow
 * @param client OAuth2Client instance
 * @param logger
 * @returns Object containing auth URL and promise
 */
async function authWithWeb(client: OAuth2Client, logger: Logger): Promise<OauthWebLogin> {
    const port = await getAvailablePort();
    // The hostname used for the HTTP server binding (e.g., '0.0.0.0' in Docker).
    const host = process.env.OAUTH_CALLBACK_HOST || "localhost";
    // The `redirectUri` sent to Google's authorization server
    const redirectUri = `http://localhost:${port}/oauth2callback`;
    const state = crypto.randomBytes(32).toString("hex");
    const authUrl = client.generateAuthUrl({
        redirect_uri: redirectUri,
        access_type: "offline",
        scope: OAUTH_SCOPE,
        state,
    });

    const loginCompletePromise = new Promise<void>((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            try {
                if (req.url!.indexOf("/oauth2callback") === -1) {
                    res.writeHead(HTTP_REDIRECT, {Location: SIGN_IN_FAILURE_URL});
                    res.end();
                    reject(new Error("Unexpected request: " + req.url));
                }
                // acquire the code from the querystring, and close the web server.
                const qs = new url.URL(req.url!, "http://localhost:3000").searchParams;
                if (qs.get("error")) {
                    res.writeHead(HTTP_REDIRECT, {Location: SIGN_IN_FAILURE_URL});
                    res.end();

                    reject(new Error(`Error during authentication: ${qs.get("error")}`));
                } else if (qs.get("state") !== state) {
                    res.end("State mismatch. Possible CSRF attack");

                    reject(new Error("State mismatch. Possible CSRF attack"));
                } else if (qs.get("code")) {
                    const {tokens} = await client.getToken({
                        code: qs.get("code")!,
                        redirect_uri: redirectUri,
                    });
                    client.setCredentials(tokens);
                    // Retrieve and cache Google Account ID during authentication
                    try {
                        await fetchAndCacheUserInfo(client, logger);
                    } catch (err) {
                        logger.error("Failed to retrieve Google Account ID during authentication");
                        if (err instanceof Error) {
                            logger.error(err.message);
                        }
                        // Don't fail the auth flow if Google Account ID retrieval fails
                    }

                    res.writeHead(HTTP_REDIRECT, {Location: SIGN_IN_SUCCESS_URL});
                    res.end();
                    resolve();
                } else {
                    reject(new Error("No code found in request"));
                }
            } catch (e) {
                reject(e);
            } finally {
                server.close();
            }
        });
        server.listen(port, host);
    });

    return {
        authUrl,
        loginCompletePromise,
    };
}

/**
 * Get an available port for the OAuth callback server
 * @returns A port number
 */
function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        let port = 0;
        try {
            const portStr = process.env.OAUTH_CALLBACK_PORT;
            if (portStr) {
                port = parseInt(portStr, 10);
                if (isNaN(port) || port <= 0 || port > 65535) {
                    return reject(
                        new Error(`Invalid value for OAUTH_CALLBACK_PORT: "${portStr}" `),
                    );
                }
                return resolve(port);
            }
            const server = net.createServer();
            server.listen(0, () => {
                const address = server.address()! as net.AddressInfo;
                port = address.port;
            });
            server.on("listening", () => {
                server.close();
                server.unref();
            });
            server.on("error", (e) => reject(e));
            server.on("close", () => resolve(port));
        } catch (e) {
            reject(e);
        }
    });
}

/**
 * Load credentials from cache
 * @param client OAuth2Client instance
 * @returns true if valid credentials were loaded
 */
async function loadCachedCredentials(client: OAuth2Client): Promise<boolean> {
    try {
        const keyFile = getCachedCredentialPath();

        const creds = await fs.readFile(keyFile, "utf-8");
        client.setCredentials(JSON.parse(creds));

        // This will verify locally that the credentials look good.
        const {token} = await client.getAccessToken();
        if (!token) {
            return false;
        }

        // This will check with the server to see if it hasn't been revoked.
        const {email} = await client.getTokenInfo(token);
        userEmail = email;
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Cache credentials to disk
 * @param credentials OAuth credentials
 */
async function cacheCredentials(credentials: Credentials) {
    const filePath = getCachedCredentialPath();
    await fs.mkdir(path.dirname(filePath), {recursive: true});

    const credString = JSON.stringify(credentials, null, 2);
    await fs.writeFile(filePath, credString, {mode: 0o600});
}

/**
 * Clear cached credentials file
 */
export async function clearCachedCredentialFile() {
    try {
        await fs.rm(getCachedCredentialPath(), {force: true});
        // Clear the Google Account ID cache when credentials are cleared
        await clearCachedGoogleAccount();
    } catch (_) {
    /* empty */
    }
}

/**
 * Fetch and cache user information
 * @param client OAuth2Client instance
 * @param logger
 */
async function fetchAndCacheUserInfo(client: OAuth2Client, logger: Logger): Promise<void> {
    try {
        const {token} = await client.getAccessToken();
        if (!token) {
            return;
        }

        const response = await fetch(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            },
        );

        if (!response.ok) {
            logger.error(`Failed to fetch user info:: ${chalk.bold(response.status)} ${chalk.bold(response.statusText)}`);
            return;
        }

        const userInfo = await response.json() as {email?: string};
        if (userInfo.email) {
            await cacheGoogleAccount(userInfo.email);
        }
    } catch (err) {
        logger.error("Error retrieving user info:");
        if (err instanceof Error) {
            logger.error(err.message);
        }
    }
}

/**
 * Check if browser launch is suppressed
 * @returns true if browser launch should be suppressed
 */
function isBrowserLaunchSuppressed(disableBrowserAuth: boolean): boolean {
    // Check explicit NO_BROWSER flag
    if (disableBrowserAuth) {
        return true;
    }
  
    // Common environment variables used in CI/CD or other non-interactive shells.
    if (process.env.CI || process.env.DEBIAN_FRONTEND === "noninteractive") {
        return true;
    }

    // The presence of SSH_CONNECTION indicates a remote session.
    const isSSH = !!process.env.SSH_CONNECTION;

    // On Linux, the presence of a display server is a strong indicator of a GUI.
    if (process.platform === "linux") {
    // These are environment variables that can indicate a running compositor on Linux.
        const displayVariables = ["DISPLAY", "WAYLAND_DISPLAY", "MIR_SOCKET"];
        const hasDisplay = displayVariables.some((v) => !!process.env[v]);
        if (!hasDisplay) {
            return true;
        }
    }

    // If in an SSH session on a non-Linux OS (e.g., macOS), don't launch browser.
    if (isSSH && process.platform !== "linux") {
        return true;
    }

    return false;
}
