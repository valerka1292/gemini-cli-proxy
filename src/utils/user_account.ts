/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {promises as fsp, existsSync, readFileSync} from "node:fs";
import * as path from "node:path";
import {getGoogleAccountsCachePath} from "./paths.js";

interface UserAccounts {
    active: string | null;
    old: string[];
}

/**
 * Read the accounts information from the cache file
 * @param filePath Path to the accounts cache file
 * @returns Object containing account information
 */
async function readAccounts(filePath: string): Promise<UserAccounts> {
    try {
        const content = await fsp.readFile(filePath, "utf-8");
        if (!content.trim()) {
            return {active: null, old: []};
        }
        return JSON.parse(content) as UserAccounts;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            // File doesn't exist, which is fine.
            return {active: null, old: []};
        }
        // File is corrupted or not valid JSON, start with a fresh object.
        console.debug("Could not parse accounts file, starting fresh.", error);
        return {active: null, old: []};
    }
}

/**
 * Cache a Google account email
 * @param email The email address to cache
 */
export async function cacheGoogleAccount(email: string): Promise<void> {
    const filePath = getGoogleAccountsCachePath();
    await fsp.mkdir(path.dirname(filePath), {recursive: true});

    const accounts = await readAccounts(filePath);

    if (accounts.active && accounts.active !== email) {
        if (!accounts.old.includes(accounts.active)) {
            accounts.old.push(accounts.active);
        }
    }

    // If the new email was in the old list, remove it
    accounts.old = accounts.old.filter((oldEmail) => oldEmail !== email);

    accounts.active = email;
    await fsp.writeFile(filePath, JSON.stringify(accounts, null, 2), "utf-8");
}

/**
 * Get the cached Google account email
 * @returns The cached email or null if none is cached
 */
export function getCachedGoogleAccount(): string | null {
    try {
        const filePath = getGoogleAccountsCachePath();
        if (existsSync(filePath)) {
            const content = readFileSync(filePath, "utf-8").trim();
            if (!content) {
                return null;
            }
            const accounts: UserAccounts = JSON.parse(content);
            return accounts.active;
        }
        return null;
    } catch (error) {
        console.debug("Error reading cached Google Account:", error);
        return null;
    }
}

/**
 * Clear the cached Google account
 */
export async function clearCachedGoogleAccount(): Promise<void> {
    const filePath = getGoogleAccountsCachePath();
    if (!existsSync(filePath)) {
        return;
    }

    const accounts = await readAccounts(filePath);

    if (accounts.active) {
        if (!accounts.old.includes(accounts.active)) {
            accounts.old.push(accounts.active);
        }
        accounts.active = null;
    }

    await fsp.writeFile(filePath, JSON.stringify(accounts, null, 2), "utf-8");
}