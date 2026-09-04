import type { BridgeContext } from "../server/context.js";
import type { EntitySet, ServiceModel } from "../metadata/model.js";
import type { Visibility } from "../odata/validate.js";
import type { RedactionPolicy } from "../odata/response.js";
import { matchesAny } from "../util/glob.js";

/** Everything a tool handler needs. Built once per bridge process. */
export interface ToolContext {
  bridge: BridgeContext;
  visibility: Visibility;
  policy: RedactionPolicy;
}

export function createToolContext(bridge: BridgeContext): ToolContext {
  const { entityAllow, entityDeny, redactFields } = bridge.config;
  const visibility: Visibility = {
    isVisible: (name) => {
      if (entityAllow && entityAllow.length > 0 && !matchesAny(entityAllow, name)) return false;
      if (matchesAny(entityDeny, name)) return false;
      return true;
    },
  };
  return { bridge, visibility, policy: { patterns: redactFields } };
}

export function visibleEntitySets(model: ServiceModel, tc: ToolContext): EntitySet[] {
  return model.entitySets.filter((s) => tc.visibility.isVisible(s.name));
}

/** Tool names must match ^[A-Za-z0-9_-]{1,64}$ on most clients. */
export function toolName(prefix: string, entityName: string): string {
  const safe = entityName.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${prefix}_${safe}`.slice(0, 64);
}
