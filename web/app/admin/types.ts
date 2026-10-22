export type AdminAccount = {
  id: string;
  username: string;
  modeId: string;
  modeName: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
};
export type AccessMode = { id: string; name: string; permissions: string | string[] };
export type LoginActivityEntry = { username: string; ip: string; ok: number; reason: string; createdAt: string };
export type OtaItem = {
  id: string;
  buildNumber: number;
  channel: string;
  platform: string;
  runtimeVersion: string;
  createdAt: string;
  publishedAt: string | null;
  message: string | null;
  status: string;
  isServing: boolean;
};
export type TurnItem = { id: string; keyId: string; label: string; scope: string; enabled: number; lastUsedAt: string | null; secretTail: string };
