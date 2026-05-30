// fizzy-symphony v2 spike — public surface.
//
// A local, spec-driven operator cockpit for running Codex agents from Fizzy
// boards. This barrel re-exports the v2 contracts and entry points so the bin
// CLI and tests can import from a single place.

export * from "./core/types.ts";
export {
  STATUS_SCHEMA_VERSION
} from "./core/types.ts";
export {
  normalizeStatus,
  deriveFactoryState,
  countDirtyWorktrees,
  countPreservedWorktrees
} from "./core/status.ts";
export {
  listCapabilities,
  getCapability,
  deriveCapabilities
} from "./core/capabilities.ts";
export {
  validateCommand,
  checkCommandAvailability
} from "./core/commands.ts";
export {
  createEventLog,
  parseJsonlEvents
} from "./core/events.ts";

export { createFakeFizzyPort } from "./fizzy/fake.ts";
export { createFizzyAdapter } from "./fizzy/adapter.ts";
export { createFakeCodexRunner } from "./codex/fake.ts";
export { createCodexAdapter } from "./codex/adapter.ts";

export { createRuntime } from "./daemon/runtime.ts";
export type { SymphonyRuntime } from "./daemon/runtime.ts";
export { applyCommandToStatus } from "./daemon/apply-command.ts";
export { dispatchPortEffects } from "./daemon/port-effects.ts";
export {
  handleApiRequest,
  createApiServer
} from "./daemon/api.ts";

export { createCockpitModel } from "./cockpit/model.ts";
export { renderCockpitText, renderCapabilitiesText } from "./cockpit/renderer.ts";
export { startInteractiveCockpit } from "./cockpit/interactive.ts";

export { runCockpitCommand } from "./cli/cockpit.ts";
export { runCapabilitiesCommand } from "./cli/capabilities.ts";
