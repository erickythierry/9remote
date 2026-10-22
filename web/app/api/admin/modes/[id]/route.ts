import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS, PERMISSION_LIST } from "@/features/admin/constants";

const permissionList: readonly string[] = PERMISSION_LIST;

export function OPTIONS() { return optionsResponse(); }

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.modeManage);
    if (error) return error;
    const { id } = await params;
    const { name, permissions } = await request.json() as { name?: string; permissions?: string[] };
    const filtered = Array.isArray(permissions) ? permissions.filter((p) => permissionList.includes(p)) : null;
    await env.DB.prepare(`
      UPDATE modes SET
        name = COALESCE(?, name),
        permissions = COALESCE(?, permissions)
      WHERE id = ?
    `).bind(name ?? null, filtered ? JSON.stringify(filtered) : null, id).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError((e as Error | null)?.message || String(e), 500);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.modeManage);
    if (error) return error;
    const { id } = await params;
    const used = await env.DB.prepare("SELECT COUNT(*) AS c FROM admins WHERE modeId = ?").bind(id).first<{ c: number }>();
    if ((used?.c || 0) > 0) return jsonError("Mode is in use by admins", 400);
    await env.DB.prepare("DELETE FROM modes WHERE id = ?").bind(id).run();
    return jsonOk({ success: true });
  } catch (e) {
    return jsonError((e as Error | null)?.message || String(e), 500);
  }
}
