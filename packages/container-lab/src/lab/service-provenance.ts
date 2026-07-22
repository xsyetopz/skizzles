import type {
  PhysicalServiceCapability,
  PhysicalServiceRegistration,
  PhysicalServiceSurface,
} from "./physical/capability.ts";
import { synchronizeCandidateWorkspace } from "./physical/workspace.ts";

export type { PhysicalServiceCapability } from "./physical/capability.ts";

interface PhysicalServiceRecord {
  readonly capability: PhysicalServiceCapability;
  readonly exposedRun: PhysicalServiceSurface["run"];
  readonly exposedDestroyLab: PhysicalServiceSurface["destroyLab"];
  readonly exposedListLabs: PhysicalServiceSurface["listLabs"];
  claimed: boolean;
}

const physicalServices = new WeakMap<object, PhysicalServiceRecord>();

export function markPhysicalService(
  service: PhysicalServiceSurface,
  registration: PhysicalServiceRegistration,
): void {
  const capability: PhysicalServiceCapability = Object.freeze({
    ...registration,
    synchronizeCandidates: async (
      input: Parameters<PhysicalServiceCapability["synchronizeCandidates"]>[0],
    ) =>
      await synchronizeCandidateWorkspace({
        roots: registration.roots,
        owner: registration.owner,
        ...input,
      }),
  });
  physicalServices.set(service, {
    capability,
    exposedRun: service.run,
    exposedDestroyLab: service.destroyLab,
    exposedListLabs: service.listLabs,
    claimed: false,
  });
}

export function claimPhysicalService(
  service: PhysicalServiceSurface,
): PhysicalServiceCapability | undefined {
  const record = physicalServices.get(service);
  if (
    record === undefined ||
    record.claimed ||
    service.owner !== record.capability.owner ||
    service.roots !== record.capability.roots ||
    service.roots.stateRoot !== record.capability.roots.stateRoot ||
    service.roots.runtimeRoot !== record.capability.roots.runtimeRoot ||
    service.run !== record.exposedRun ||
    service.destroyLab !== record.exposedDestroyLab ||
    service.listLabs !== record.exposedListLabs
  ) {
    return;
  }
  record.claimed = true;
  Object.freeze(service.roots);
  Object.freeze(service);
  return record.capability;
}
