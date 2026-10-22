export type SessionMutationBody = {
  apiKey: string;
  hostPublicKey?: string | null;
  hostX25519Key?: string | null;
  tempKey?: string;
  online?: boolean | number;
  tunnelUrl?: string;
  localIp?: string | null;
  expiryMinutes?: number;
  ts?: number;
  sig?: string;
};

export type StoredHostKey = { hostPublicKey: string | null };
