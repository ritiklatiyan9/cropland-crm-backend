// GraphQL module: User & Role Management (PRD §2, §4.1).

import bcrypt from 'bcryptjs';
import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, isoDate } from '../helpers.js';
import { isAwsConfigured, getDownloadUrl } from '../../utils/aws.js';
import { env } from '../../config/env.js';

export const userTypeDefs = /* GraphQL */ `
  enum UserRole {
    SUPER_ADMIN
    ADMIN
    SUB_ADMIN
    SALES
    DISTRIBUTOR
    FARMER
  }

  type Branch {
    id: ID!
    name: String!
    code: String
    state: String
    district: String
    isActive: Boolean!
    createdAt: DateTime!
  }

  type User {
    id: ID!
    name: String!
    email: String!
    phone: String
    role: UserRole!
    branchId: ID
    branch: Branch
    isActive: Boolean!
    twoFactorEnabled: Boolean!
    avatarKey: String
    avatarUrl: String
    designation: String
    employeeCode: String
    gender: String
    dateOfBirth: String
    address: String
    city: String
    state: String
    lastLoginAt: DateTime
    createdAt: DateTime!
  }

  type AuthPayload {
    accessToken: String!
    refreshToken: String!
    user: User!
  }

  type RolePermission {
    id: ID!
    role: UserRole!
    module: String!
    canCreate: Boolean!
    canRead: Boolean!
    canUpdate: Boolean!
    canDelete: Boolean!
  }

  type UserPermission {
    userId: ID!
    module: String!
    canCreate: Boolean!
    canRead: Boolean!
    canUpdate: Boolean!
    canDelete: Boolean!
    isOverride: Boolean!   # true if explicitly set for this user (overrides role)
  }

  type RoleCount {
    role: UserRole!
    count: Int!
  }

  type UserStats {
    total: Int!
    active: Int!
    inactive: Int!
    byRole: [RoleCount!]!
  }

  input CreateUserInput {
    name: String!
    email: String!
    phone: String
    password: String!
    role: UserRole!
    branchId: ID
    avatarKey: String
    designation: String
    employeeCode: String
    gender: String
    dateOfBirth: String
    address: String
    city: String
    state: String
  }

  input UpdateUserInput {
    name: String!
    phone: String
    role: UserRole!
    branchId: ID
    avatarKey: String
    designation: String
    employeeCode: String
    gender: String
    dateOfBirth: String
    address: String
    city: String
    state: String
  }

  input BranchInput {
    name: String!
    code: String
    state: String
    district: String
  }

  extend type Query {
    me: User
    users(role: UserRole, search: String, activeOnly: Boolean, limit: Int = 50, offset: Int = 0): [User!]!
    user(id: ID!): User
    userStats: UserStats!
    branches: [Branch!]!
    rolePermissions(role: UserRole): [RolePermission!]!
    userPermissions(userId: ID!): [UserPermission!]!
  }

  extend type Mutation {
    login(email: String!, password: String!): AuthPayload!
    refreshToken(refreshToken: String!): AuthPayload!
    createUser(input: CreateUserInput!): User!
    updateUser(id: ID!, input: UpdateUserInput!): User!
    setUserActive(id: ID!, isActive: Boolean!): User!
    resetUserPassword(id: ID!, newPassword: String!): Boolean!
    "Self-service: the signed-in user changes their own password (verifies the current one)."
    updateMyPassword(currentPassword: String!, newPassword: String!): Boolean!
    deleteUser(id: ID!): Boolean!
    createBranch(input: BranchInput!): Branch!
    setRolePermission(
      role: UserRole!
      module: String!
      canCreate: Boolean!
      canRead: Boolean!
      canUpdate: Boolean!
      canDelete: Boolean!
    ): RolePermission!
    setUserPermission(
      userId: ID!
      module: String!
      canCreate: Boolean!
      canRead: Boolean!
      canUpdate: Boolean!
      canDelete: Boolean!
    ): UserPermission!
    resetUserPermissions(userId: ID!): Boolean!
  }
`;

const mapUser = (r) =>
  r && {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    role: r.role,
    branchId: r.branch_id,
    isActive: r.is_active,
    twoFactorEnabled: r.two_factor_enabled,
    avatarKey: r.avatar_key,
    designation: r.designation,
    employeeCode: r.employee_code,
    gender: r.gender,
    dateOfBirth: isoDate(r.date_of_birth),
    address: r.address,
    city: r.city,
    state: r.state,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  };

const mapBranch = (r) =>
  r && {
    id: r.id,
    name: r.name,
    code: r.code,
    state: r.state,
    district: r.district,
    isActive: r.is_active,
    createdAt: r.created_at,
  };

const mapPerm = (r) => ({
  id: r.id,
  role: r.role,
  module: r.module,
  canCreate: r.can_create,
  canRead: r.can_read,
  canUpdate: r.can_update,
  canDelete: r.can_delete,
});

const mapUserPerm = (userId, module, src, isOverride) => ({
  userId,
  module,
  canCreate: src.can_create,
  canRead: src.can_read,
  canUpdate: src.can_update,
  canDelete: src.can_delete,
  isOverride,
});

function issueTokens(app, user) {
  const payload = { sub: user.id, role: user.role, email: user.email };
  const accessToken = app.jwt.sign(payload);
  const refreshToken = app.jwt.sign({ sub: user.id, type: 'refresh' }, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}

function profileValues(input) {
  return [
    input.designation ?? null,
    input.employeeCode ?? null,
    input.gender ?? null,
    input.dateOfBirth ?? null,
    input.address ?? null,
    input.city ?? null,
    input.state ?? null,
    input.avatarKey ?? null,
  ];
}

export function userResolvers(app) {
  return {
    Query: {
      me: async (_p, _a, ctx) => {
        if (!ctx.user) return null;
        const { rows } = await query('SELECT * FROM users WHERE id = $1', [ctx.user.sub]);
        return mapUser(rows[0]);
      },
      users: async (_p, { role, search, activeOnly, limit, offset }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `SELECT * FROM users
           WHERE ($1::text IS NULL OR role = $1::user_role)
             AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%')
             AND ($3::bool IS NULL OR is_active = $3)
           ORDER BY created_at DESC
           LIMIT $4 OFFSET $5`,
          [role ?? null, search ?? null, activeOnly ?? null, limit, offset],
        );
        return rows.map(mapUser);
      },
      user: async (_p, { id }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
        return mapUser(rows[0]);
      },
      userStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const totals = await query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE is_active)::int AS active,
                  COUNT(*) FILTER (WHERE NOT is_active)::int AS inactive
           FROM users`,
        );
        const byRole = await query(
          'SELECT role, COUNT(*)::int AS count FROM users GROUP BY role ORDER BY role',
        );
        return {
          total: totals.rows[0].total,
          active: totals.rows[0].active,
          inactive: totals.rows[0].inactive,
          byRole: byRole.rows.map((r) => ({ role: r.role, count: r.count })),
        };
      },
      branches: async (_p, _a, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT * FROM branches ORDER BY name ASC');
        return rows.map(mapBranch);
      },
      rolePermissions: async (_p, { role }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `SELECT * FROM role_permissions
           WHERE ($1::text IS NULL OR role = $1::user_role)
           ORDER BY role, module`,
          [role ?? null],
        );
        return rows.map(mapPerm);
      },
      // Effective per-module permissions for one user: their explicit override
      // where present, otherwise the default for their role.
      userPermissions: async (_p, { userId }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const u = (await query('SELECT role FROM users WHERE id = $1', [userId])).rows[0];
        if (!u) throw httpError('User not found', 404);
        const roleRows = (await query(
          'SELECT * FROM role_permissions WHERE role = $1::user_role ORDER BY module',
          [u.role],
        )).rows;
        const overrides = (await query('SELECT * FROM user_permissions WHERE user_id = $1', [userId])).rows;
        const ovMap = new Map(overrides.map((r) => [r.module, r]));
        return roleRows.map((rp) => {
          const ov = ovMap.get(rp.module);
          return mapUserPerm(userId, rp.module, ov ?? rp, Boolean(ov));
        });
      },
    },

    Mutation: {
      login: async (_p, { email, password }) => {
        const { rows } = await query('SELECT * FROM users WHERE email = $1 AND is_active = TRUE', [
          email.toLowerCase(),
        ]);
        const user = rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
          throw httpError('Invalid credentials', 401);
        }
        await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
        await logActivity(user.id, 'LOGIN', 'user', user.id);
        return { ...issueTokens(app, user), user: mapUser(user) };
      },
      refreshToken: async (_p, { refreshToken }) => {
        let decoded;
        try {
          decoded = app.jwt.verify(refreshToken);
        } catch {
          throw httpError('Invalid refresh token', 401);
        }
        const { rows } = await query('SELECT * FROM users WHERE id = $1 AND is_active = TRUE', [
          decoded.sub,
        ]);
        if (!rows[0]) throw httpError('User not found', 401);
        return { ...issueTokens(app, rows[0]), user: mapUser(rows[0]) };
      },
      createUser: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        if (input.password.length < 8) throw httpError('Password must be at least 8 characters', 400);
        const passwordHash = await bcrypt.hash(input.password, 10);
        let rows;
        try {
          ({ rows } = await query(
            `INSERT INTO users
               (name, email, phone, role, branch_id, password_hash,
                designation, employee_code, gender, date_of_birth, address, city, state, avatar_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [
              input.name,
              input.email.toLowerCase(),
              input.phone ?? null,
              input.role,
              input.branchId ?? null,
              passwordHash,
              ...profileValues(input),
            ],
          ));
        } catch (err) {
          if (err.code === '23505') throw httpError('A user with this email already exists', 409);
          throw err;
        }
        await logActivity(actor.sub, 'CREATE_USER', 'user', rows[0].id, { email: input.email });
        return mapUser(rows[0]);
      },
      updateUser: async (_p, { id, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `UPDATE users SET
             name=$2, phone=$3, role=$4, branch_id=$5,
             designation=$6, employee_code=$7, gender=$8, date_of_birth=$9,
             address=$10, city=$11, state=$12, avatar_key=$13, updated_at=now()
           WHERE id=$1 RETURNING *`,
          [id, input.name, input.phone ?? null, input.role, input.branchId ?? null, ...profileValues(input)],
        );
        if (!rows[0]) throw httpError('User not found', 404);
        await logActivity(actor.sub, 'UPDATE_USER', 'user', id);
        return mapUser(rows[0]);
      },
      setUserActive: async (_p, { id, isActive }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        if (id === actor.sub && !isActive) throw httpError('You cannot deactivate your own account', 400);
        const { rows } = await query(
          'UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1 RETURNING *',
          [id, isActive],
        );
        if (!rows[0]) throw httpError('User not found', 404);
        await logActivity(actor.sub, isActive ? 'ACTIVATE_USER' : 'DEACTIVATE_USER', 'user', id);
        return mapUser(rows[0]);
      },
      resetUserPassword: async (_p, { id, newPassword }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        if (newPassword.length < 8) throw httpError('Password must be at least 8 characters', 400);
        const passwordHash = await bcrypt.hash(newPassword, 10);
        const { rowCount } = await query(
          'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
          [id, passwordHash],
        );
        if (!rowCount) throw httpError('User not found', 404);
        await logActivity(actor.sub, 'RESET_PASSWORD', 'user', id);
        return true;
      },
      // Self-service password change for the signed-in user. Verifies the current
      // password before updating — no admin role required (any authenticated user).
      updateMyPassword: async (_p, { currentPassword, newPassword }, ctx) => {
        const actor = assertAuth(ctx);
        if (newPassword.length < 8) throw httpError('New password must be at least 8 characters', 400);
        if (currentPassword === newPassword) throw httpError('New password must be different from the current one', 400);
        const user = (await query('SELECT password_hash FROM users WHERE id = $1', [actor.sub])).rows[0];
        if (!user) throw httpError('User not found', 404);
        if (!(await bcrypt.compare(currentPassword, user.password_hash))) throw httpError('Current password is incorrect', 400);
        await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [actor.sub, await bcrypt.hash(newPassword, 10)]);
        await logActivity(actor.sub, 'CHANGE_PASSWORD', 'user', actor.sub);
        return true;
      },
      deleteUser: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        if (id === actor.sub) throw httpError('You cannot delete your own account', 400);
        const target = await query('SELECT role FROM users WHERE id = $1', [id]);
        if (!target.rows[0]) throw httpError('User not found', 404);
        if (target.rows[0].role === 'SUPER_ADMIN') {
          const { rows } = await query(
            "SELECT COUNT(*)::int AS n FROM users WHERE role = 'SUPER_ADMIN' AND is_active = TRUE",
          );
          if (rows[0].n <= 1) throw httpError('Cannot delete the last Super Admin', 400);
        }
        await query('DELETE FROM users WHERE id = $1', [id]);
        await logActivity(actor.sub, 'DELETE_USER', 'user', id);
        return true;
      },
      createBranch: async (_p, { input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rows } = await query(
          `INSERT INTO branches (name, code, state, district) VALUES ($1,$2,$3,$4) RETURNING *`,
          [input.name, input.code ?? null, input.state ?? null, input.district ?? null],
        );
        await logActivity(actor.sub, 'CREATE_BRANCH', 'branch', rows[0].id);
        return mapBranch(rows[0]);
      },
      setRolePermission: async (_p, args, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { role, module, canCreate, canRead, canUpdate, canDelete } = args;
        const { rows } = await query(
          `INSERT INTO role_permissions (role, module, can_create, can_read, can_update, can_delete)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (role, module) DO UPDATE SET
             can_create=EXCLUDED.can_create, can_read=EXCLUDED.can_read,
             can_update=EXCLUDED.can_update, can_delete=EXCLUDED.can_delete, updated_at=now()
           RETURNING *`,
          [role, module, canCreate, canRead, canUpdate, canDelete],
        );
        await logActivity(actor.sub, 'SET_PERMISSION', 'role_permission', rows[0].id, { role, module });
        return mapPerm(rows[0]);
      },
      setUserPermission: async (_p, args, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { userId, module, canCreate, canRead, canUpdate, canDelete } = args;
        if (!(await query('SELECT 1 FROM users WHERE id = $1', [userId])).rows[0]) throw httpError('User not found', 404);
        const { rows } = await query(
          `INSERT INTO user_permissions (user_id, module, can_create, can_read, can_update, can_delete)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (user_id, module) DO UPDATE SET
             can_create=EXCLUDED.can_create, can_read=EXCLUDED.can_read,
             can_update=EXCLUDED.can_update, can_delete=EXCLUDED.can_delete, updated_at=now()
           RETURNING *`,
          [userId, module, canCreate, canRead, canUpdate, canDelete],
        );
        await logActivity(actor.sub, 'SET_USER_PERMISSION', 'user_permission', rows[0].id, { userId, module });
        return mapUserPerm(userId, module, rows[0], true);
      },
      // Clears all overrides for a user, reverting them to their role defaults.
      resetUserPermissions: async (_p, { userId }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        await query('DELETE FROM user_permissions WHERE user_id = $1', [userId]);
        await logActivity(actor.sub, 'RESET_USER_PERMISSIONS', 'user', userId);
        return true;
      },
    },

    User: {
      branch: async (parent) => {
        if (!parent.branchId) return null;
        const { rows } = await query('SELECT * FROM branches WHERE id = $1', [parent.branchId]);
        return mapBranch(rows[0]);
      },
      avatarUrl: async (parent) => {
        if (!parent.avatarKey) return null;
        if (env.aws.s3PublicBaseUrl) {
          return `${env.aws.s3PublicBaseUrl.replace(/\/$/, '')}/${parent.avatarKey}`;
        }
        if (!isAwsConfigured) return null;
        try {
          return await getDownloadUrl(parent.avatarKey, 3600);
        } catch {
          return null;
        }
      },
    },
  };
}

export { mapUser, mapBranch };
