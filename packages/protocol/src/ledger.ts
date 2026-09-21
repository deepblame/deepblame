import * as z from 'zod';
import { SCHEMA_VERSION } from './run';

/** Contents of meta.json in the ledger's genesis commit. */
export const LedgerMetaSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  created_at: z.iso.datetime({ offset: true }),
  created_by: z.string().min(1),
});

export type LedgerMeta = z.infer<typeof LedgerMetaSchema>;
