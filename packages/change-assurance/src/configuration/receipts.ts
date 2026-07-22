import { digestBytes, digestValue } from "../digest.ts";
import type {
  ConfigurationRegistrationReceipt,
  ConfigurationRegistry,
  ConfigurationWriteReceipt,
} from "./contracts.ts";

export const AUTHENTIC_REGISTRIES = new WeakSet<object>();
export const AUTHENTIC_WRITES = new WeakSet<object>();
export const WRITE_BYTES = new WeakMap<object, Uint8Array>();

export function createWriteReceipt(input: {
  readonly registry: ConfigurationRegistry;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: ReturnType<typeof digestValue>;
  readonly registrations: readonly ConfigurationRegistrationReceipt[];
}): ConfigurationWriteReceipt {
  const registrationDigests = input.registrations.map(
    (registration) => registration.receiptDigest,
  );
  const registryDigest = input.registry.snapshot().registryDigest;
  const material = {
    path: input.path,
    materializedDigest: input.digest,
    registryDigest,
    registrationDigests,
  };
  const receipt: ConfigurationWriteReceipt = Object.freeze({
    ...material,
    registrationDigests: Object.freeze([...registrationDigests]),
    receiptDigest: digestValue(material),
  });
  AUTHENTIC_WRITES.add(receipt);
  WRITE_BYTES.set(receipt, new Uint8Array(input.bytes));
  return receipt;
}

export function receiptMatches(
  receipt: ConfigurationWriteReceipt,
  path: string,
  bytes: Uint8Array,
): boolean {
  if (receipt.path !== path) return false;
  const expected = WRITE_BYTES.get(receipt);
  return (
    expected !== undefined &&
    digestBytes(bytes) === receipt.materializedDigest &&
    digestBytes(expected) === digestBytes(bytes)
  );
}
