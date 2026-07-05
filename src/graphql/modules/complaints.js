// GraphQL module: Complaint Management (PRD §9.7).
// Farmers raise complaints; admin/sales assign and resolve with a status timeline.

import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity } from '../helpers.js';
import { isAwsConfigured, getDownloadUrl } from '../../utils/aws.js';
import { env } from '../../config/env.js';
import { dispatch } from '../../services/notify/index.js';

export const complaintTypeDefs = /* GraphQL */ `
  type Complaint {
    id: ID!
    ticketNo: String!
    category: String!
    description: String
    status: String!
    priority: String!
    photoKey: String
    photoUrl: String
    farmerId: ID
    farmerName: String
    farmerCode: String
    farmerPhone: String
    village: String
    district: String
    distributorId: ID
    distributorName: String
    assignedToId: ID
    assignedToName: String
    resolutionNote: String
    resolvedAt: DateTime
    createdAt: DateTime!
    events: [ComplaintEvent!]!
  }

  type ComplaintEvent {
    eventType: String!
    detail: String
    actorName: String
    createdAt: DateTime!
  }

  type ComplaintStats { open: Int!, assigned: Int!, inProgress: Int!, resolved: Int!, total: Int! }
  type AssignableUser { id: ID!, name: String!, role: String! }

  input ComplaintInput {
    farmerId: ID
    distributorId: ID
    category: String!
    description: String
    priority: String
    photoKey: String
  }

  extend type Query {
    complaints(status: String, category: String, search: String, limit: Int = 100): [Complaint!]!
    complaint(id: ID!): Complaint
    complaintStats: ComplaintStats!
    assignableUsers: [AssignableUser!]!
  }

  input ComplaintEditInput { category: String, description: String, priority: String }

  extend type Mutation {
    createComplaint(input: ComplaintInput!): Complaint!
    assignComplaint(id: ID!, userId: ID!): Complaint!
    setComplaintStatus(id: ID!, status: String!, resolutionNote: String): Complaint!
    addComplaintNote(id: ID!, note: String!): Complaint!
    updateComplaint(id: ID!, input: ComplaintEditInput!): Complaint!
    deleteComplaint(id: ID!): Boolean!
  }
`;

const SELECT = `
  SELECT c.*, f.name farmer_name, f.farmer_code, f.phone farmer_phone, f.village, f.district, f.fcm_token,
         d.name distributor_name, u.name assigned_name
  FROM complaints c
  LEFT JOIN farmers f ON f.id = c.farmer_id
  LEFT JOIN distributors d ON d.id = c.distributor_id
  LEFT JOIN users u ON u.id = c.assigned_to
`;

const map = (r) =>
  r && {
    id: r.id,
    ticketNo: r.ticket_no,
    category: r.category,
    description: r.description,
    status: r.status,
    priority: r.priority,
    photoKey: r.photo_s3_key,
    farmerId: r.farmer_id,
    farmerName: r.farmer_name,
    farmerCode: r.farmer_code,
    farmerPhone: r.farmer_phone,
    village: r.village,
    district: r.district,
    distributorId: r.distributor_id,
    distributorName: r.distributor_name,
    assignedToId: r.assigned_to,
    assignedToName: r.assigned_name,
    resolutionNote: r.resolution_note,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    _fcmToken: r.fcm_token,
    _farmerPhone: r.farmer_phone,
  };

async function addEvent(complaintId, type, detail, actorId) {
  await query(
    `INSERT INTO complaint_events (complaint_id, event_type, detail, actor_id) VALUES ($1,$2,$3,$4)`,
    [complaintId, type, detail ?? null, actorId ?? null],
  );
}

// Best-effort: tell the farmer their complaint status changed (push + SMS).
async function notifyFarmer(row, title, body) {
  try {
    const tokens = row._fcmToken ? [row._fcmToken] : [];
    const phones = row._farmerPhone ? [row._farmerPhone] : [];
    if (!tokens.length && !phones.length) return;
    await dispatch({ channels: ['PUSH', 'SMS'], title, body, tokens, phones });
  } catch {
    /* swallow */
  }
}

export function complaintResolvers() {
  return {
    Query: {
      complaints: async (_p, { status, category, search, limit }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `${SELECT}
           WHERE ($1::text IS NULL OR c.status = $1::complaint_status)
             AND ($2::text IS NULL OR c.category = $2)
             AND ($3::text IS NULL OR c.ticket_no ILIKE '%' || $3 || '%' OR f.name ILIKE '%' || $3 || '%' OR f.farmer_code ILIKE '%' || $3 || '%')
           ORDER BY c.created_at DESC LIMIT $4`,
          [status ?? null, category ?? null, search ?? null, limit],
        );
        return rows.map(map);
      },
      complaint: async (_p, { id }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(`${SELECT} WHERE c.id = $1`, [id]);
        return map(rows[0]);
      },
      complaintStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT COUNT(*)::int total,
             COUNT(*) FILTER (WHERE status='OPEN')::int open,
             COUNT(*) FILTER (WHERE status='ASSIGNED')::int assigned,
             COUNT(*) FILTER (WHERE status='IN_PROGRESS')::int in_progress,
             COUNT(*) FILTER (WHERE status='RESOLVED')::int resolved
           FROM complaints`,
        );
        const r = rows[0];
        return { total: r.total, open: r.open, assigned: r.assigned, inProgress: r.in_progress, resolved: r.resolved };
      },
      assignableUsers: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          "SELECT id, name, role FROM users WHERE is_active AND role IN ('SUPER_ADMIN','ADMIN','SUB_ADMIN','SALES') ORDER BY name",
        );
        return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
      },
    },

    Mutation: {
      createComplaint: async (_p, { input }, ctx) => {
        const actor = assertAuth(ctx);
        const seq = (await query("SELECT nextval('complaint_seq') AS n")).rows[0].n;
        const ticketNo = `CMP-${String(seq).padStart(6, '0')}`;
        const { rows } = await query(
          `INSERT INTO complaints (ticket_no, farmer_id, distributor_id, category, description, priority, photo_s3_key, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [ticketNo, input.farmerId ?? null, input.distributorId ?? null, input.category, input.description ?? null, input.priority ?? 'NORMAL', input.photoKey ?? null, actor.sub],
        );
        await addEvent(rows[0].id, 'CREATED', `Complaint ${ticketNo} logged`, actor.sub);
        await logActivity(actor.sub, 'CREATE_COMPLAINT', 'complaint', rows[0].id, { ticketNo });
        const full = await query(`${SELECT} WHERE c.id = $1`, [rows[0].id]);
        return map(full.rows[0]);
      },

      assignComplaint: async (_p, { id, userId }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const u = await query('SELECT name FROM users WHERE id = $1', [userId]);
        if (!u.rows[0]) throw httpError('User not found', 404);
        const { rowCount } = await query(
          "UPDATE complaints SET assigned_to=$2, status=CASE WHEN status='OPEN' THEN 'ASSIGNED' ELSE status END, updated_at=now() WHERE id=$1",
          [id, userId],
        );
        if (!rowCount) throw httpError('Complaint not found', 404);
        await addEvent(id, 'ASSIGNED', `Assigned to ${u.rows[0].name}`, actor.sub);
        await logActivity(actor.sub, 'ASSIGN_COMPLAINT', 'complaint', id, { userId });
        const full = await query(`${SELECT} WHERE c.id = $1`, [id]);
        return map(full.rows[0]);
      },

      setComplaintStatus: async (_p, { id, status, resolutionNote }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const allowed = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED'];
        if (!allowed.includes(status)) throw httpError('Invalid status', 400);
        const resolvedAt = status === 'RESOLVED' ? new Date() : null;
        const { rows } = await query(
          `UPDATE complaints SET status=$2::complaint_status, resolution_note=COALESCE($3, resolution_note),
             resolved_at=$4, updated_at=now() WHERE id=$1 RETURNING ticket_no`,
          [id, status, resolutionNote ?? null, resolvedAt],
        );
        if (!rows[0]) throw httpError('Complaint not found', 404);
        await addEvent(id, 'STATUS', `Status → ${status}${resolutionNote ? ` · ${resolutionNote}` : ''}`, actor.sub);
        await logActivity(actor.sub, 'COMPLAINT_STATUS', 'complaint', id, { status });
        const full = await query(`${SELECT} WHERE c.id = $1`, [id]);
        await notifyFarmer(full.rows[0], `Complaint ${rows[0].ticket_no}`, `Your complaint status is now ${status.replace('_', ' ')}.`);
        return map(full.rows[0]);
      },

      addComplaintNote: async (_p, { id, note }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const c = await query('SELECT id FROM complaints WHERE id = $1', [id]);
        if (!c.rows[0]) throw httpError('Complaint not found', 404);
        await addEvent(id, 'NOTE', note, actor.sub);
        const full = await query(`${SELECT} WHERE c.id = $1`, [id]);
        return map(full.rows[0]);
      },

      updateComplaint: async (_p, { id, input }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `UPDATE complaints SET category=COALESCE($2,category), description=COALESCE($3,description), priority=COALESCE($4,priority), updated_at=now()
           WHERE id=$1 RETURNING id`,
          [id, input.category ?? null, input.description ?? null, input.priority ?? null],
        );
        if (!rows[0]) throw httpError('Complaint not found', 404);
        await addEvent(id, 'NOTE', 'Complaint details edited', actor.sub);
        await logActivity(actor.sub, 'UPDATE_COMPLAINT', 'complaint', id);
        const full = await query(`${SELECT} WHERE c.id = $1`, [id]);
        return map(full.rows[0]);
      },

      deleteComplaint: async (_p, { id }, ctx) => {
        const actor = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN');
        const { rowCount } = await query('DELETE FROM complaints WHERE id = $1', [id]);
        if (!rowCount) throw httpError('Complaint not found', 404);
        await logActivity(actor.sub, 'DELETE_COMPLAINT', 'complaint', id);
        return true;
      },
    },

    Complaint: {
      photoUrl: async (parent) => {
        if (!parent.photoKey) return null;
        if (env.aws.s3PublicBaseUrl) return `${env.aws.s3PublicBaseUrl.replace(/\/$/, '')}/${parent.photoKey}`;
        if (!isAwsConfigured) return null;
        try {
          return await getDownloadUrl(parent.photoKey, 3600);
        } catch {
          return null;
        }
      },
      events: async (parent) => {
        const { rows } = await query(
          `SELECT e.event_type, e.detail, e.created_at, u.name actor_name
           FROM complaint_events e LEFT JOIN users u ON u.id = e.actor_id
           WHERE e.complaint_id = $1 ORDER BY e.created_at ASC`,
          [parent.id],
        );
        return rows.map((r) => ({ eventType: r.event_type, detail: r.detail, actorName: r.actor_name, createdAt: r.created_at }));
      },
    },
  };
}
