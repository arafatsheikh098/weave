import type { FileMeta, Role } from "@weave/protocol";
import { del, get, keys, set } from "idb-keyval";

export interface User {
  id: string;
  username: string;
  displayName: string;
  color: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  mainFile: string;
  template: string | null;
  updatedAt: string;
  role: Role;
  members: number;
  online: number;
  people: { name: string; color: string }[];
}

export interface Member {
  id: string;
  username: string;
  displayName: string;
  color: string;
  role: Role;
}

export interface Project {
  id: string;
  name: string;
  mainFile: string;
  template: string | null;
  role: Role;
  files: FileMeta[];
  members: Member[];
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  kind: "latex" | "markdown";
  accent: string;
  files: string[];
  preview: string;
}

export interface Diagnostic {
  file: string;
  line: number | null;
  message: string;
  level: "error" | "warning";
}

export interface CompileResult {
  ok: boolean;
  pdf: string | null;
  diagnostics: Diagnostic[];
  log: string;
  ms: number;
  cached: boolean;
}

export interface VersionInfo {
  id: string;
  name: string;
  auto: boolean;
  createdAt: string;
  author: string | null;
  files: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : undefined,
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "You're offline, or the Weave server isn't reachable.");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/**
 * A GET whose last successful response is kept in IndexedDB. When the network is unreachable the
 * saved copy is returned instead, so the dashboard and editor can open offline.
 */
async function cachedGet<T>(path: string): Promise<T> {
  const key = `weave:api:${path}`;
  try {
    const data = await request<T>("GET", path);
    set(key, data).catch(() => {});
    return data;
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) {
      const saved = await get<T>(key).catch(() => undefined);
      if (saved !== undefined) return saved;
    }
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) {
      del(key).catch(() => {});
    }
    throw e;
  }
}

/**
 * On logout, forget offline copies so the next person on this browser doesn't see them.
 * Documents that still have unsynced edits are kept, so signing out never loses work; they sync
 * the next time their owner opens the project.
 */
export async function clearOfflineCache(): Promise<void> {
  const all = await keys().catch(() => [] as IDBValidKey[]);
  await Promise.all(
    all.map(async (k) => {
      const key = String(k);
      if (key.startsWith("weave:api:") || key.startsWith("weave:pdf:")) return del(k);
      if (key.startsWith("weave:file:")) {
        const saved = await get<{ outbox?: unknown[] }>(k).catch(() => undefined);
        if (!saved?.outbox?.length) return del(k);
      }
    }),
  ).catch(() => {});
}

export const api = {
  me: () => cachedGet<User>("/auth/me"),
  login: (username: string, password: string) => request<User>("POST", "/auth/login", { username, password }),
  register: (username: string, password: string, displayName: string) =>
    request<User>("POST", "/auth/register", { username, password, displayName }),
  logout: () => request<void>("POST", "/auth/logout"),

  templates: () => request<TemplateInfo[]>("GET", "/templates"),
  projects: () => cachedGet<ProjectSummary[]>("/projects"),
  createProject: (name: string, template: string) => request<{ id: string }>("POST", "/projects", { name, template }),
  project: (id: string) => cachedGet<Project>(`/projects/${id}`),
  updateProject: (id: string, patch: { name?: string; mainFile?: string }) => request("PATCH", `/projects/${id}`, patch),
  deleteProject: (id: string) => request<void>("DELETE", `/projects/${id}`),

  createFile: (id: string, path: string, text = "") => request<{ id: string }>("POST", `/projects/${id}/files`, { path, text }),
  upload: (id: string, file: File, dir = "") => {
    const form = new FormData();
    form.append("dir", dir);
    form.append("file", file);
    return request<{ id: string; path: string }>("POST", `/projects/${id}/upload`, form);
  },
  renameFile: (id: string, fileId: string, path: string) => request("PATCH", `/projects/${id}/files/${fileId}`, { path }),
  deleteFile: (id: string, fileId: string) => request<void>("DELETE", `/projects/${id}/files/${fileId}`),
  rawUrl: (id: string, fileId: string) => `/api/projects/${id}/files/${fileId}/raw`,

  invite: (id: string, role: "editor" | "viewer") => request<{ token: string }>("POST", `/projects/${id}/invites`, { role }),
  inviteInfo: (token: string) =>
    request<{ role: Role; projectId: string; projectName: string; invitedBy: string }>("GET", `/invites/${token}`),
  acceptInvite: (token: string) => request<{ projectId: string }>("POST", `/invites/${token}/accept`),
  setRole: (id: string, userId: string, role: "editor" | "viewer") => request("PATCH", `/projects/${id}/members/${userId}`, { role }),
  removeMember: (id: string, userId: string) => request<void>("DELETE", `/projects/${id}/members/${userId}`),

  versions: (id: string) => request<VersionInfo[]>("GET", `/projects/${id}/versions`),
  createVersion: (id: string, name: string) => request<{ id: string }>("POST", `/projects/${id}/versions`, { name }),
  version: (id: string, versionId: string) => request<{ files: { path: string; text: string }[] }>("GET", `/projects/${id}/versions/${versionId}`),
  restoreVersion: (id: string, versionId: string) => request("POST", `/projects/${id}/versions/${versionId}/restore`),

  compile: (id: string, manual = false) => request<CompileResult>("POST", `/projects/${id}/compile${manual ? "?manual=1" : ""}`),
};
