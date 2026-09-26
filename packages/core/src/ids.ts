import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';

/** DeepBlame's own namespace, so the same session always maps to the same uuid. */
const NAMESPACE = 'a8f5f167-0b4e-5f2b-9c3d-1e7a4b6c8d90';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** RFC 9562 version 5 uuid: deterministic, so two machines agree without talking. */
export function uuidV5(name: string, namespace: string = NAMESPACE): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Harness session ids are kept as they are when they already are uuids. */
export function sessionUuid(agent: string, session: string): string {
  return UUID.test(session) ? session.toLowerCase() : uuidV5(`${agent}:${session}`);
}

/** Stable per checkout, derived rather than stored, and not a readable path. */
export function worktreeId(root: string): string {
  let real = root;
  try {
    real = realpathSync.native(root);
  } catch {
    // A path we cannot resolve still hashes fine.
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

/** Identifies the machine across runs without putting its name in the ledger. */
export function hostId(): string {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    // Containers without a passwd entry: the hostname alone is enough.
  }
  return createHash('sha256').update(`${hostname()}\u0000${user}`).digest('hex').slice(0, 16);
}
