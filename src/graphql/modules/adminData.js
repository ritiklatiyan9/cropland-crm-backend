// GraphQL module: Admin data management — factory-reset the whole database.
//
// clearAllData wipes every module's data (orders, inventory, finance, GST, CRM,
// manufacturing, …) while preserving admin login accounts (SUPER_ADMIN / ADMIN)
// and role permissions so admins can still sign in and use the app afterwards.

import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../../db/index.js';
import { assertRole } from '../context.js';
import { httpError, logActivity } from '../helpers.js';

// Tables that survive the wipe. `users` is trimmed to admin roles afterwards;
// `branches` is excluded from TRUNCATE (users.branch_id references it, so a
// CASCADE would wipe users too) and cleared with DELETE instead; company_settings
// is a singleton row (id = 1) that the settings page UPDATEs, so it is reset to
// defaults rather than left empty.
const KEEP_TABLES = ['users', 'branches', 'role_permissions', 'company_settings'];
// Accounts that survive the wipe; only SUPER_ADMIN may trigger it.
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

export const adminDataTypeDefs = /* GraphQL */ `
  type ClearAllDataResult {
    ok: Boolean!
    clearedTables: Int!
    deletedUsers: Int!
    keptAdmins: Int!
  }

  extend type Mutation {
    "Factory reset: wipe all data in every module, keeping only admin accounts. Requires the caller's password."
    clearAllData(password: String!): ClearAllDataResult!
  }
`;

export function adminDataResolvers(app) {
  return {
    Mutation: {
      clearAllData: async (_p, { password }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN');

        const { rows } = await query('SELECT password_hash FROM users WHERE id = $1 AND is_active', [actor.sub]);
        if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
          throw httpError('Password is incorrect', 400);
        }

        const result = await withTransaction(async (client) => {
          const { rows: tableRows } = await client.query(
            `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ALL($1)`,
            [KEEP_TABLES],
          );
          const tables = tableRows.map((r) => `"${r.tablename}"`);
          if (tables.length) {
            await client.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
          }

          const del = await client.query('DELETE FROM users WHERE role <> ALL($1)', [ADMIN_ROLES]);
          await client.query('DELETE FROM branches');
          await client.query('DELETE FROM company_settings');
          await client.query('INSERT INTO company_settings (id) VALUES (1)');

          // Standalone document-number sequences (invoice_seq, order_seq, …) are not
          // owned by any column, so RESTART IDENTITY doesn't touch them.
          const { rows: seqRows } = await client.query(
            `SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind = 'S' AND n.nspname = 'public'`,
          );
          for (const { relname } of seqRows) {
            await client.query(`ALTER SEQUENCE "${relname}" RESTART WITH 1`);
          }

          // Abort (and roll everything back) if the wipe would lock every admin out.
          const { rows: adminRows } = await client.query(
            'SELECT COUNT(*)::int AS n FROM users WHERE role = ANY($1) AND is_active',
            [ADMIN_ROLES],
          );
          if (!adminRows[0].n) throw httpError('Refusing to clear: no active admin account would remain', 409);

          return { ok: true, clearedTables: tables.length, deletedUsers: del.rowCount, keptAdmins: adminRows[0].n };
        });

        // Best-effort cache flush so stale lookups don't resurface wiped data.
        try {
          await app.redis.flushdb();
        } catch (err) {
          app.log.warn({ err }, 'redis flush after clearAllData failed');
        }

        await logActivity(actor.sub, 'CLEAR_ALL_DATA', 'database', null, result);
        return result;
      },
    },
  };
}
