import { Instance } from '../../db/models';
export async function ownsFlowInstance(workspaceId: string, instanceId: unknown): Promise<boolean> {
  return !instanceId || Boolean(await Instance.exists({ _id: instanceId, workspaceId }));
}
