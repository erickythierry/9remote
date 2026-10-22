"use client";

import { useCallback, useEffect, useState } from "react";
import {
  GITHUB_API,
  GITHUB_ENDPOINTS,
  DEVCONTAINER_PATH,
  DEVCONTAINER_TEMPLATE,
  NREMOTE_SECRET_NAME,
  CODESPACE_POLL_INTERVAL_MS,
  CODESPACE_POLL_MAX_ATTEMPTS,
  CODESPACE_STATE
} from "@/shared/constants/github";
import { encryptForGithub, generateApiKey } from "../lib/encryptSecret";

const GITHUB_TOKEN_STORAGE_KEY = "9remote_github_token";
const TOKEN_CHANGE_EVENT = "9remote:githubTokenChange";

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url?: string;
  name?: string | null;
  [key: string]: unknown;
}

export interface GitHubCodespace {
  name: string;
  display_name?: string | null;
  state: string;
  repository?: {
    full_name: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    login: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function authHeaders(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function ghFetch<T = any>(token: string, endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${GITHUB_API}${endpoint}`, {
    ...options,
    headers: { ...authHeaders(token), ...((options.headers as Record<string, string>) || {}) }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status}: ${text || res.statusText}`);
  }
  return res.status === 204 ? (null as unknown as T) : res.json();
}

export function useGithub() {
  const isBrowser = typeof window !== "undefined";
  const [token, setTokenState] = useState<string>(() => {
    if (!isBrowser) return "";
    return localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || "";
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync across hook instances via custom event + storage event
  useEffect(() => {
    if (!isBrowser) return;
    const handler = () => {
      setTokenState(localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || "");
    };
    window.addEventListener(TOKEN_CHANGE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(TOKEN_CHANGE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, [isBrowser]);

  const setToken = useCallback((t: string) => {
    setTokenState(t);
    if (isBrowser) {
      if (t) localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, t);
      else localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
      window.dispatchEvent(new Event(TOKEN_CHANGE_EVENT));
    }
  }, [isBrowser]);

  const clearToken = useCallback(() => {
    setToken("");
  }, [setToken]);

  const getUser = useCallback(async (t: string = token): Promise<GitHubUser> => {
    return ghFetch<GitHubUser>(t, GITHUB_ENDPOINTS.user);
  }, [token]);

  const listCodespaces = useCallback(async (): Promise<GitHubCodespace[]> => {
    setLoading(true);
    setError(null);
    try {
      const data = await ghFetch<{ codespaces?: GitHubCodespace[] }>(token, GITHUB_ENDPOINTS.codespaces);
      return data.codespaces || [];
    } catch (e: any) {
      setError(e.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, [token]);

  const getCodespace = useCallback(async (name: string): Promise<GitHubCodespace> => {
    return ghFetch<GitHubCodespace>(token, GITHUB_ENDPOINTS.codespaceByName(name));
  }, [token]);

  const startCodespace = useCallback(async (name: string): Promise<any> => {
    return ghFetch(token, GITHUB_ENDPOINTS.startCodespace(name), { method: "POST" });
  }, [token]);

  const listRepos = useCallback(async (): Promise<GitHubRepo[]> => {
    return ghFetch<GitHubRepo[]>(token, GITHUB_ENDPOINTS.userReposList);
  }, [token]);

  const createCodespace = useCallback(async (owner: string, repo: string): Promise<GitHubCodespace> => {
    return ghFetch<GitHubCodespace>(token, GITHUB_ENDPOINTS.createCodespaceForRepo(owner, repo), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
  }, [token]);

  // Set NREMOTE_API_KEY codespace secret for a specific repo
  const setApiKeySecret = useCallback(async (repoId: number, apiKey: string): Promise<void> => {
    const pk = await ghFetch<{ key: string; key_id: string }>(token, GITHUB_ENDPOINTS.codespaceSecretsPublicKey);
    const encryptedValue = await encryptForGithub(pk.key, apiKey);
    await ghFetch(token, GITHUB_ENDPOINTS.codespaceSecret(NREMOTE_SECRET_NAME), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: pk.key_id,
        selected_repository_ids: [repoId]
      })
    });
  }, [token]);

  // Ensure repo has devcontainer.json with 9remote auto-start. Skip if user already has one.
  const ensureDevcontainer = useCallback(async (owner: string, repo: string): Promise<{ existed: boolean }> => {
    const endpoint = GITHUB_ENDPOINTS.repoContents(owner, repo, DEVCONTAINER_PATH);
    let exists = false;
    try {
      await ghFetch(token, endpoint);
      exists = true;
    } catch {
      // not found
    }
    if (exists) return { existed: true };
    const content = JSON.stringify(DEVCONTAINER_TEMPLATE, null, 2);
    await ghFetch(token, endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Add 9remote devcontainer",
        content: btoa(unescape(encodeURIComponent(content)))
      })
    });
    return { existed: false };
  }, [token]);

  // Wait until codespace state = Available
  const waitUntilAvailable = useCallback(async (name: string, onProgress?: (state: string) => void): Promise<GitHubCodespace> => {
    for (let i = 0; i < CODESPACE_POLL_MAX_ATTEMPTS; i++) {
      const cs = await getCodespace(name);
      onProgress?.(cs.state);
      if (cs.state === CODESPACE_STATE.available) return cs;
      await new Promise((r) => setTimeout(r, CODESPACE_POLL_INTERVAL_MS));
    }
    throw new Error("Codespace start timeout");
  }, [getCodespace]);

  return {
    token,
    setToken,
    clearToken,
    loading,
    error,
    getUser,
    listCodespaces,
    getCodespace,
    startCodespace,
    waitUntilAvailable,
    listRepos,
    createCodespace,
    ensureDevcontainer,
    setApiKeySecret,
    generateApiKey
  };
}
