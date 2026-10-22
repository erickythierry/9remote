import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";
import { requireAdmin } from "@/features/admin/lib/guard";
import { PERMISSIONS } from "@/features/admin/constants";
import { promoteUpdate } from "@/features/ota/lib/updateService.js";

export function OPTIONS() { return optionsResponse(); }

// Republish an existing update as a new row (new id + buildNumber), reusing
// the old assets, then point the channel at it. Used for rollback.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { error, env } = await requireAdmin(request, PERMISSIONS.otaManage);
    if (error) return error;

    const updateGroup = await promoteUpdate(env, (await params).id);
    return jsonOk({ success: true, id: updateGroup.id, buildNumber: updateGroup.buildNumber });
  } catch (e) {
    return jsonError((e as Error | null)?.message || String(e), 500);
  }
}
