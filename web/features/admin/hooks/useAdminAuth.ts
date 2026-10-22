"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_API } from "../constants";
import { useAdminApi } from "./useAdminApi.js";

export interface AdminUser {
  id: string;
  username: string;
  modeId: string | null;
  modeName: string | null;
  permissions: unknown[];
  otaEnabled: boolean;
}

interface UseAdminAuthOptions {
  redirectIfUnauthed?: boolean;
}

export function useAdminAuth({ redirectIfUnauthed = true }: UseAdminAuthOptions = {}) {
  const router = useRouter();
  const { get, post } = useAdminApi();
  const [me, setMe] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = useCallback(async () => {
    try {
      const data = await get(ADMIN_API.me) as AdminUser;
      setMe(data);
    } catch {
      setMe(null);
      if (redirectIfUnauthed) router.replace("/admin/login");
    } finally {
      setLoading(false);
    }
  }, [get, redirectIfUnauthed, router]);

  useEffect(() => { fetchMe(); }, [fetchMe]);

  const logout = useCallback(async () => {
    await post(ADMIN_API.logout, {});
    router.replace("/admin/login");
  }, [post, router]);

  const can = useCallback((perm: string) => Array.isArray(me?.permissions) && me.permissions.includes(perm), [me]);

  return { me, loading, logout, can, refresh: fetchMe };
}
