// GraphQL module: AI Layer (PRD §9.4-9.5, §11.3).
// AI Crop Doctor (photo -> disease detection) -> product match -> Smart Advisory
// and auto-generated CRM leads for sales follow-up.

import { query } from '../../db/index.js';
import { assertAuth, assertRole } from '../context.js';
import { httpError, logActivity, num, isoDate } from '../helpers.js';
import { diagnoseCrop, generateAdvisory as genAdvisory, aiChannelStatus, embedSample, cosineSim } from '../../services/ai/index.js';
import { upsertSample, deleteSamples, querySimilar, vectorStoreStatus, pineconeConfigured } from '../../services/ai/pinecone.js';
import { sendEmail } from '../../services/notify/email.js';

export const aiTypeDefs = /* GraphQL */ `
  type ProductRef { id: ID!, name: String! }

  type CropDiagnosis {
    id: ID!
    sessionNo: String!
    farmerId: ID
    farmerName: String
    crop: String!
    imageUrl: String
    detectedDisease: String
    pathogen: String
    confidence: Float
    severity: String
    symptoms: String
    recommendation: String
    recommendedProducts: [ProductRef!]!
    source: String!
    gpsLat: Float
    gpsLng: Float
    hasLead: Boolean!
    createdAt: DateTime!
  }

  type Advisory {
    id: ID!
    advisoryNo: String!
    diagnosisId: ID
    farmerId: ID
    farmerName: String
    crop: String!
    disease: String
    type: String!
    title: String!
    body: String!
    recommendedProducts: [ProductRef!]!
    status: String!
    source: String!
    createdAt: DateTime!
    sentAt: DateTime
  }

  type CrmLead {
    id: ID!
    leadNo: String!
    diagnosisId: ID
    farmerId: ID
    farmerName: String
    farmerPhone: String
    crop: String
    disease: String
    recommendedProducts: [ProductRef!]!
    priorPurchase: Boolean!
    assignedTo: ID
    assignedName: String
    status: String!
    notes: String
    createdAt: DateTime!
  }

  type AiStats {
    sessions: Int!
    advisories: Int!
    leads: Int!
    openLeads: Int!
    converted: Int!
    conversionRate: Float!
    highSeverity: Int!
    provider: String!
    configured: Boolean!
  }

  type AiTrainingSample { id: ID!, imageUrl: String!, caption: String, createdAt: DateTime! }
  type AiTrainingClass {
    id: ID!
    classNo: String!
    crop: String!
    disease: String!
    pathogen: String
    description: String
    symptoms: String
    treatment: String
    recommendedProducts: [ProductRef!]!
    sampleCount: Int!
    samples: [AiTrainingSample!]!
    isActive: Boolean!
    createdAt: DateTime!
  }
  type VectorStoreStatus { provider: String!, configured: Boolean!, ready: Boolean!, index: String!, namespace: String!, vectorCount: Int }
  type ReindexResult { total: Int!, processed: Int!, failed: Int! }
  type TrainingStats { classes: Int!, samples: Int!, crops: Int!, aiConfigured: Boolean!, model: String!, embeddingModel: String!, vectorStore: VectorStoreStatus! }

  input TrainingClassInput { crop: String!, disease: String!, pathogen: String, description: String, symptoms: String, treatment: String, productIds: [ID!] }
  input TrainingSampleInput { imageUrl: String!, imageKey: String, caption: String }

  type NameCount { label: String!, count: Int! }
  type DistrictDisease { district: String!, disease: String!, count: Int! }
  type AiAnalytics {
    sessions: Int!
    advisories: Int!
    leads: Int!
    converted: Int!
    conversionRate: Float!
    advisoriesSent: Int!
    advisoriesRead: Int!
    sendRate: Float!
    highSeverity: Int!
    topDiseases: [NameCount!]!
    topCrops: [NameCount!]!
    severityBreakdown: [NameCount!]!
    diagnosesTrend: [NameCount!]!
    leadFunnel: [NameCount!]!
    diseasesByDistrict: [DistrictDisease!]!
  }

  input RunDiagnosisInput { farmerId: ID, crop: String!, imageUrl: String, gpsLat: Float, gpsLng: Float }
  input GenerateAdvisoryInput { diagnosisId: ID, farmerId: ID, crop: String!, disease: String, type: String = "CURATIVE" }
  input UpdateAdvisoryInput { crop: String!, disease: String, type: String!, title: String!, body: String!, farmerId: ID }

  extend type Query {
    cropDiagnoses(search: String, limit: Int = 100): [CropDiagnosis!]!
    cropDiagnosis(id: ID!): CropDiagnosis
    advisories(status: String, limit: Int = 100): [Advisory!]!
    crmLeads(status: String, limit: Int = 100): [CrmLead!]!
    aiStats: AiStats!
    aiAnalytics(months: Int = 6): AiAnalytics!
    trainingClasses(search: String, crop: String): [AiTrainingClass!]!
    trainingClass(id: ID!): AiTrainingClass
    trainingStats: TrainingStats!
    knownDiseases(crop: String): [String!]!
  }

  extend type Mutation {
    runCropDiagnosis(input: RunDiagnosisInput!): CropDiagnosis!
    generateAdvisory(input: GenerateAdvisoryInput!): Advisory!
    updateAdvisory(id: ID!, input: UpdateAdvisoryInput!): Advisory!
    deleteAdvisory(id: ID!): Boolean!
    deleteAdvisories(ids: [ID!]!): Int!
    createLeadFromDiagnosis(diagnosisId: ID!): CrmLead!
    assignLead(id: ID!, userId: ID!): CrmLead!
    updateLeadStatus(id: ID!, status: String!, notes: String): CrmLead!
    sendAdvisory(id: ID!): Advisory!

    createTrainingClass(input: TrainingClassInput!): AiTrainingClass!
    updateTrainingClass(id: ID!, input: TrainingClassInput!): AiTrainingClass!
    deleteTrainingClass(id: ID!): Boolean!
    addTrainingSample(classId: ID!, input: TrainingSampleInput!): AiTrainingSample!
    deleteTrainingSample(id: ID!): Boolean!
    reindexTrainingData: ReindexResult!
  }
`;

export const MAX_SAMPLES_PER_CLASS = 20;

const mapDiag = (r) => r && {
  id: r.id, sessionNo: r.session_no, farmerId: r.farmer_id, farmerName: r.farmer_name ?? null, crop: r.crop,
  imageUrl: r.image_url, detectedDisease: r.detected_disease, pathogen: r.pathogen, confidence: num(r.confidence),
  severity: r.severity, symptoms: r.symptoms, recommendation: r.recommendation, productIds: r.product_ids ?? [],
  source: r.source, gpsLat: num(r.gps_lat), gpsLng: num(r.gps_lng), createdAt: r.created_at,
};
const mapAdvisory = (r) => r && {
  id: r.id, advisoryNo: r.advisory_no, diagnosisId: r.diagnosis_id, farmerId: r.farmer_id, farmerName: r.farmer_name ?? null,
  crop: r.crop, disease: r.disease, type: r.type, title: r.title, body: r.body, productIds: r.product_ids ?? [],
  status: r.status, source: r.source, createdAt: r.created_at, sentAt: r.sent_at,
};
const mapLead = (r) => r && {
  id: r.id, leadNo: r.lead_no, diagnosisId: r.diagnosis_id, farmerId: r.farmer_id, farmerName: r.farmer_name ?? null,
  farmerPhone: r.farmer_phone ?? null, crop: r.crop, disease: r.disease, productIds: r.product_ids ?? [],
  priorPurchase: r.prior_purchase, assignedTo: r.assigned_to, assignedName: r.assigned_name ?? null,
  status: r.status, notes: r.notes, createdAt: r.created_at,
};

const mapClass = (r) => r && {
  id: r.id, classNo: r.class_no, crop: r.crop, disease: r.disease, pathogen: r.pathogen,
  description: r.description, symptoms: r.symptoms, treatment: r.treatment, productIds: r.product_ids ?? [],
  isActive: r.is_active, createdAt: r.created_at,
};

// Retrieval-augmented reference selection (RAG): rank the trained photos for a
// crop by visual-embedding similarity to the farmer's photo and return the most
// relevant ones. Retrieval ladder, best → simplest:
//   1. Pinecone vector search (scales to large training sets)
//   2. Postgres + in-memory cosine over cached Gemini embeddings
//   3. Most-recent labelled examples (still grounds the model, just not ranked)
async function getTrainingReferences(crop, queryImageUrl) {
  // Embed the farmer's photo once; reused by both the Pinecone and in-memory paths.
  const q = queryImageUrl ? await embedSample(queryImageUrl, crop, crop) : null;

  // ── 1) Pinecone managed vector search ──────────────────────────────────────
  if (q?.vector && pineconeConfigured) {
    const matches = await querySimilar(q.vector, { crop, topK: 4 });
    if (matches?.length) {
      // Pinecone holds lightweight metadata; resolve the image URLs from Postgres
      // (data: URLs are too large for vector metadata) preserving the ranked order.
      const ids = matches.map((m) => m.id);
      const { rows } = await query('SELECT id, image_url, vision_caption FROM ai_training_samples WHERE id = ANY($1)', [ids]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const references = matches.map((m) => {
        const r = byId.get(m.id);
        if (!r) return null;
        return { imageUrl: r.image_url, caption: r.vision_caption ?? m.metadata.caption ?? null, disease: m.metadata.disease ?? null, pathogen: m.metadata.pathogen ?? null };
      }).filter(Boolean);
      if (references.length) return { references, retrieval: 'pinecone', topScore: Math.round((matches[0].score ?? 0) * 100) / 100 };
    }
  }

  // ── 2) / 3) Postgres-backed fallback ───────────────────────────────────────
  const { rows } = await query(
    `SELECT s.image_url, s.vision_caption, s.embedding, c.disease, c.pathogen
     FROM ai_training_samples s JOIN ai_training_classes c ON c.id = s.class_id
     WHERE c.is_active AND c.crop ILIKE $1`,
    [crop],
  );
  if (!rows.length) return { references: [], retrieval: 'none', topScore: 0 };

  const embedded = rows.filter((r) => Array.isArray(r.embedding) && r.embedding.length);
  if (q?.vector && embedded.length) {
    const ranked = embedded
      .map((r) => ({ r, score: cosineSim(q.vector, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    return {
      references: ranked.map(({ r }) => ({ imageUrl: r.image_url, caption: r.vision_caption, disease: r.disease, pathogen: r.pathogen })),
      retrieval: 'embedding', topScore: Math.round((ranked[0]?.score ?? 0) * 100) / 100,
    };
  }
  // Most-recent labelled examples (still grounds the model, just not ranked).
  const recent = rows.slice(0, 6).map((r) => ({ imageUrl: r.image_url, caption: r.vision_caption, disease: r.disease, pathogen: r.pathogen }));
  return { references: recent, retrieval: 'recent', topScore: 0 };
}

// Build the retrieval label + Pinecone metadata for a sample, then embed and
// upsert it to both Postgres (cache) and Pinecone (vector store). Best-effort:
// never throws, so it can run in the background without blocking the upload.
async function indexSample(sampleId, imageUrl, cls) {
  const label = `${cls.crop} ${cls.disease}${cls.symptoms ? ` — ${cls.symptoms}` : ''}`;
  const emb = await embedSample(imageUrl, label, cls.crop);
  if (!emb?.vector) return false;
  await query('UPDATE ai_training_samples SET embedding=$2, vision_caption=$3 WHERE id=$1', [sampleId, JSON.stringify(emb.vector), emb.caption ?? null]);
  await upsertSample(sampleId, emb.vector, {
    classId: cls.id ?? null, crop: String(cls.crop).toLowerCase(), disease: cls.disease, pathogen: cls.pathogen ?? null, caption: emb.caption ?? null,
  });
  return true;
}

// A trained class matching the detected crop+disease (drives curated product recommendations).
async function matchedTrainedClass(crop, disease) {
  if (!disease) return null;
  const { rows } = await query(
    `SELECT product_ids FROM ai_training_classes WHERE is_active AND crop ILIKE $1 AND disease ILIKE '%'||$2||'%' LIMIT 1`,
    [crop, disease],
  );
  return rows[0] ?? null;
}

// Match company products to a disease/crop via the Product Master's target arrays.
async function matchProducts(disease, crop) {
  const { rows } = await query(
    `SELECT id, name FROM products WHERE is_active AND (
       ($1 <> '' AND EXISTS (SELECT 1 FROM unnest(target_diseases) td WHERE td ILIKE '%'||$1||'%'))
       OR ($2 <> '' AND EXISTS (SELECT 1 FROM unnest(target_crops) tc WHERE tc ILIKE '%'||$2||'%'))
     ) ORDER BY name LIMIT 5`,
    [disease || '', crop || ''],
  );
  if (rows.length) return rows;
  // Fallback so there is always something to recommend / sell.
  return (await query('SELECT id, name FROM products WHERE is_active ORDER BY created_at DESC LIMIT 3')).rows;
}

const seq = async (name) => (await query(`SELECT nextval('${name}') n`)).rows[0].n;

export function aiResolvers() {
  return {
    Query: {
      cropDiagnoses: async (_p, { search, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT d.*, f.name farmer_name FROM crop_diagnoses d LEFT JOIN farmers f ON f.id = d.farmer_id
           WHERE ($1::text IS NULL OR d.crop ILIKE '%'||$1||'%' OR d.detected_disease ILIKE '%'||$1||'%' OR d.session_no ILIKE '%'||$1||'%')
           ORDER BY d.created_at DESC LIMIT $2`,
          [search ?? null, limit],
        );
        return rows.map(mapDiag);
      },
      cropDiagnosis: async (_p, { id }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT d.*, f.name farmer_name FROM crop_diagnoses d LEFT JOIN farmers f ON f.id=d.farmer_id WHERE d.id=$1', [id]);
        return mapDiag(rows[0]);
      },
      advisories: async (_p, { status, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT a.*, f.name farmer_name FROM advisories a LEFT JOIN farmers f ON f.id = a.farmer_id
           WHERE ($1::text IS NULL OR a.status=$1) ORDER BY a.created_at DESC LIMIT $2`,
          [status ?? null, limit],
        );
        return rows.map(mapAdvisory);
      },
      crmLeads: async (_p, { status, limit }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT l.*, f.name farmer_name, f.phone farmer_phone, u.name assigned_name
           FROM crm_leads l LEFT JOIN farmers f ON f.id = l.farmer_id LEFT JOIN users u ON u.id = l.assigned_to
           WHERE ($1::text IS NULL OR l.status=$1) ORDER BY l.created_at DESC LIMIT $2`,
          [status ?? null, limit],
        );
        return rows.map(mapLead);
      },
      aiStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM crop_diagnoses)::int sessions,
                  (SELECT COUNT(*) FROM advisories)::int advisories,
                  (SELECT COUNT(*) FROM crm_leads)::int leads,
                  (SELECT COUNT(*) FROM crm_leads WHERE status IN ('NEW','CONTACTED'))::int open_leads,
                  (SELECT COUNT(*) FROM crm_leads WHERE status='CONVERTED')::int converted,
                  (SELECT COUNT(*) FROM crop_diagnoses WHERE severity='HIGH')::int high_severity`,
        );
        const r = rows[0];
        const st = aiChannelStatus();
        return {
          sessions: r.sessions, advisories: r.advisories, leads: r.leads, openLeads: r.open_leads,
          converted: r.converted, conversionRate: r.leads ? Math.round((r.converted / r.leads) * 1000) / 10 : 0,
          highSeverity: r.high_severity, provider: st.provider, configured: st.configured,
        };
      },
      aiAnalytics: async (_p, { months }, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const nc = (rows) => rows.map((r) => ({ label: r.label ?? 'Unknown', count: r.count }));
        const totals = (await query(
          `SELECT (SELECT COUNT(*) FROM crop_diagnoses)::int sessions,
                  (SELECT COUNT(*) FROM advisories)::int advisories,
                  (SELECT COUNT(*) FROM advisories WHERE status IN ('SENT','READ'))::int sent,
                  (SELECT COUNT(*) FROM advisories WHERE status='READ')::int read,
                  (SELECT COUNT(*) FROM crm_leads)::int leads,
                  (SELECT COUNT(*) FROM crm_leads WHERE status='CONVERTED')::int converted,
                  (SELECT COUNT(*) FROM crop_diagnoses WHERE severity='HIGH')::int high_severity`,
        )).rows[0];
        const [topDiseases, topCrops, severity, trend, leadFunnel, byDistrict] = await Promise.all([
          query("SELECT detected_disease label, COUNT(*)::int count FROM crop_diagnoses WHERE detected_disease IS NOT NULL GROUP BY 1 ORDER BY count DESC LIMIT 8"),
          query("SELECT crop label, COUNT(*)::int count FROM crop_diagnoses WHERE crop IS NOT NULL GROUP BY 1 ORDER BY count DESC LIMIT 8"),
          query("SELECT COALESCE(severity,'UNKNOWN') label, COUNT(*)::int count FROM crop_diagnoses GROUP BY 1 ORDER BY count DESC"),
          query(
            `WITH m AS (SELECT date_trunc('month', CURRENT_DATE) - (n || ' months')::interval AS mo FROM generate_series($1-1,0,-1) n)
             SELECT to_char(m.mo,'Mon') label, COUNT(d.id)::int count
             FROM m LEFT JOIN crop_diagnoses d ON date_trunc('month', d.created_at)=m.mo
             GROUP BY m.mo ORDER BY m.mo`,
            [months],
          ),
          query("SELECT status label, COUNT(*)::int count FROM crm_leads GROUP BY 1 ORDER BY count DESC"),
          query(
            `SELECT COALESCE(f.district,'Unknown') district, d.detected_disease disease, COUNT(*)::int count
             FROM crop_diagnoses d LEFT JOIN farmers f ON f.id=d.farmer_id
             WHERE d.detected_disease IS NOT NULL GROUP BY 1,2 ORDER BY count DESC LIMIT 40`,
          ),
        ]);
        return {
          sessions: totals.sessions, advisories: totals.advisories, leads: totals.leads, converted: totals.converted,
          conversionRate: totals.leads ? Math.round((totals.converted / totals.leads) * 1000) / 10 : 0,
          advisoriesSent: totals.sent, advisoriesRead: totals.read,
          sendRate: totals.advisories ? Math.round((totals.sent / totals.advisories) * 1000) / 10 : 0,
          highSeverity: totals.high_severity,
          topDiseases: nc(topDiseases.rows), topCrops: nc(topCrops.rows), severityBreakdown: nc(severity.rows),
          diagnosesTrend: nc(trend.rows), leadFunnel: nc(leadFunnel.rows),
          diseasesByDistrict: byDistrict.rows.map((r) => ({ district: r.district, disease: r.disease, count: r.count })),
        };
      },
      trainingClasses: async (_p, { search, crop }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query(
          `SELECT * FROM ai_training_classes
           WHERE ($1::text IS NULL OR disease ILIKE '%'||$1||'%' OR crop ILIKE '%'||$1||'%' OR class_no ILIKE '%'||$1||'%')
             AND ($2::text IS NULL OR crop ILIKE $2)
           ORDER BY created_at DESC`,
          [search ?? null, crop ?? null],
        );
        return rows.map(mapClass);
      },
      trainingClass: async (_p, { id }, ctx) => { assertAuth(ctx); const { rows } = await query('SELECT * FROM ai_training_classes WHERE id=$1', [id]); return mapClass(rows[0]); },
      knownDiseases: async (_p, { crop }, ctx) => {
        assertAuth(ctx);
        // Distinct disease names known to the system: trained classes + product target_diseases.
        const { rows } = await query(
          `SELECT DISTINCT d FROM (
             SELECT disease AS d, crop FROM ai_training_classes WHERE is_active
             UNION ALL
             SELECT unnest(target_diseases) AS d, NULL::text AS crop FROM products WHERE is_active
           ) x
           WHERE d IS NOT NULL AND btrim(d) <> '' AND ($1::text IS NULL OR x.crop IS NULL OR x.crop ILIKE $1)
           ORDER BY d`,
          [crop ?? null],
        );
        return rows.map((r) => r.d);
      },
      trainingStats: async (_p, _a, ctx) => {
        assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `SELECT (SELECT COUNT(*) FROM ai_training_classes WHERE is_active)::int classes,
                  (SELECT COUNT(*) FROM ai_training_samples)::int samples,
                  (SELECT COUNT(DISTINCT lower(crop)) FROM ai_training_classes WHERE is_active)::int crops`,
        );
        const st = aiChannelStatus();
        const vs = await vectorStoreStatus();
        return {
          ...rows[0], aiConfigured: st.configured, model: st.model, embeddingModel: st.embeddingModel,
          vectorStore: {
            provider: vs.provider, configured: vs.configured, ready: vs.ready,
            index: vs.index, namespace: vs.namespace, vectorCount: vs.vectorCount,
          },
        };
      },
    },

    Mutation: {
      runCropDiagnosis: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { references } = await getTrainingReferences(input.crop, input.imageUrl); // RAG grounding from Train AI Doctor
        const d = await diagnoseCrop({ crop: input.crop, imageUrl: input.imageUrl, references });
        // Prefer a trained class's curated products when the detected disease matches one.
        let prods = await matchProducts(d.disease, input.crop);
        const trained = await matchedTrainedClass(input.crop, d.disease);
        if (trained?.product_ids?.length) {
          const tp = await productRefs(trained.product_ids);
          if (tp.length) prods = tp;
        }
        const sessionNo = `AID-${String(await seq('diag_seq')).padStart(5, '0')}`;
        const { rows } = await query(
          `INSERT INTO crop_diagnoses (session_no, farmer_id, crop, image_url, detected_disease, pathogen, confidence, severity, symptoms, recommendation, product_ids, source, gps_lat, gps_lng, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [sessionNo, input.farmerId ?? null, input.crop, input.imageUrl ?? null, d.disease, d.pathogen, d.confidence, d.severity, d.symptoms, d.recommendation, prods.map((p) => p.id), d.source, input.gpsLat ?? null, input.gpsLng ?? null, a.sub],
        );
        await logActivity(a.sub, 'AI_DIAGNOSE', 'crop_diagnosis', rows[0].id, { disease: d.disease, source: d.source });
        const full = await query('SELECT d.*, f.name farmer_name FROM crop_diagnoses d LEFT JOIN farmers f ON f.id=d.farmer_id WHERE d.id=$1', [rows[0].id]);
        return mapDiag(full.rows[0]);
      },

      generateAdvisory: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const type = input.type === 'PREVENTIVE' ? 'PREVENTIVE' : 'CURATIVE';
        const adv = await genAdvisory({ crop: input.crop, disease: input.disease, type });
        // Recommend from the Product Master (target arrays), preferring a trained class's curated products.
        let prods = await matchProducts(input.disease, input.crop);
        const trained = await matchedTrainedClass(input.crop, input.disease);
        if (trained?.product_ids?.length) {
          const tp = await productRefs(trained.product_ids);
          if (tp.length) prods = tp;
        }
        const advisoryNo = `ADV-${String(await seq('adv_seq')).padStart(5, '0')}`;
        const { rows } = await query(
          `INSERT INTO advisories (advisory_no, diagnosis_id, farmer_id, crop, disease, type, title, body, product_ids, source, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [advisoryNo, input.diagnosisId ?? null, input.farmerId ?? null, input.crop, input.disease ?? null, type, adv.title, adv.body, prods.map((p) => p.id), adv.source, a.sub],
        );
        await logActivity(a.sub, 'AI_ADVISORY', 'advisory', rows[0].id, { type });
        const full = await query('SELECT a.*, f.name farmer_name FROM advisories a LEFT JOIN farmers f ON f.id=a.farmer_id WHERE a.id=$1', [rows[0].id]);
        return mapAdvisory(full.rows[0]);
      },

      updateAdvisory: async (_p, { id, input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const type = input.type === 'PREVENTIVE' ? 'PREVENTIVE' : 'CURATIVE';
        const { rows } = await query(
          'UPDATE advisories SET crop=$2, disease=$3, type=$4, title=$5, body=$6, farmer_id=$7 WHERE id=$1 RETURNING id',
          [id, input.crop, input.disease ?? null, type, input.title, input.body, input.farmerId ?? null],
        );
        if (!rows[0]) throw httpError('Advisory not found', 404);
        await logActivity(a.sub, 'UPDATE_ADVISORY', 'advisory', id);
        const full = await query('SELECT a.*, f.name farmer_name FROM advisories a LEFT JOIN farmers f ON f.id=a.farmer_id WHERE a.id=$1', [id]);
        return mapAdvisory(full.rows[0]);
      },
      deleteAdvisory: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rowCount } = await query('DELETE FROM advisories WHERE id=$1', [id]);
        if (!rowCount) throw httpError('Advisory not found', 404);
        await logActivity(a.sub, 'DELETE_ADVISORY', 'advisory', id);
        return true;
      },
      deleteAdvisories: async (_p, { ids }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        if (!ids?.length) return 0;
        const { rowCount } = await query('DELETE FROM advisories WHERE id = ANY($1)', [ids]);
        await logActivity(a.sub, 'DELETE_ADVISORIES', 'advisory', null, { count: rowCount });
        return rowCount;
      },

      createLeadFromDiagnosis: async (_p, { diagnosisId }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const d = (await query('SELECT * FROM crop_diagnoses WHERE id=$1', [diagnosisId])).rows[0];
        if (!d) throw httpError('Diagnosis not found', 404);
        const existing = await query('SELECT id FROM crm_leads WHERE diagnosis_id=$1', [diagnosisId]);
        if (existing.rows[0]) throw httpError('A lead already exists for this diagnosis', 409);
        const prior = d.farmer_id
          ? Boolean((await query('SELECT points_balance > 0 p FROM farmers WHERE id=$1', [d.farmer_id])).rows[0]?.p)
          : false;
        const leadNo = `LEAD-${String(await seq('lead_seq')).padStart(5, '0')}`;
        const { rows } = await query(
          `INSERT INTO crm_leads (lead_no, diagnosis_id, farmer_id, crop, disease, product_ids, prior_purchase)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [leadNo, diagnosisId, d.farmer_id, d.crop, d.detected_disease, d.product_ids ?? [], prior],
        );
        await logActivity(a.sub, 'CREATE_LEAD', 'crm_lead', rows[0].id, { leadNo });
        const full = await query('SELECT l.*, f.name farmer_name, f.phone farmer_phone, u.name assigned_name FROM crm_leads l LEFT JOIN farmers f ON f.id=l.farmer_id LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=$1', [rows[0].id]);
        return mapLead(full.rows[0]);
      },

      assignLead: async (_p, { id, userId }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query("UPDATE crm_leads SET assigned_to=$2, status=CASE WHEN status='NEW' THEN 'CONTACTED' ELSE status END, updated_at=now() WHERE id=$1 RETURNING id", [id, userId]);
        if (!rows[0]) throw httpError('Lead not found', 404);
        await logActivity(a.sub, 'ASSIGN_LEAD', 'crm_lead', id, { userId });
        const full = await query('SELECT l.*, f.name farmer_name, f.phone farmer_phone, u.name assigned_name FROM crm_leads l LEFT JOIN farmers f ON f.id=l.farmer_id LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=$1', [id]);
        return mapLead(full.rows[0]);
      },

      updateLeadStatus: async (_p, { id, status, notes }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        if (!['NEW', 'CONTACTED', 'CONVERTED', 'LOST'].includes(status)) throw httpError('Invalid lead status', 400);
        const { rows } = await query('UPDATE crm_leads SET status=$2, notes=COALESCE($3, notes), updated_at=now() WHERE id=$1 RETURNING id', [id, status, notes ?? null]);
        if (!rows[0]) throw httpError('Lead not found', 404);
        await logActivity(a.sub, 'UPDATE_LEAD', 'crm_lead', id, { status });
        const full = await query('SELECT l.*, f.name farmer_name, f.phone farmer_phone, u.name assigned_name FROM crm_leads l LEFT JOIN farmers f ON f.id=l.farmer_id LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=$1', [id]);
        return mapLead(full.rows[0]);
      },

      sendAdvisory: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const adv = (await query('SELECT a.*, f.email farmer_email, f.name farmer_name FROM advisories a LEFT JOIN farmers f ON f.id=a.farmer_id WHERE a.id=$1', [id])).rows[0];
        if (!adv) throw httpError('Advisory not found', 404);
        if (adv.farmer_email) {
          const text = `Dear ${adv.farmer_name ?? 'Farmer'},\n\n${adv.body}\n\nRegards,\nCropland Agritech India`;
          await sendEmail([adv.farmer_email], adv.title, text);
        }
        await query("UPDATE advisories SET status='SENT', sent_at=now() WHERE id=$1", [id]);
        await logActivity(a.sub, 'SEND_ADVISORY', 'advisory', id);
        const full = await query('SELECT a.*, f.name farmer_name FROM advisories a LEFT JOIN farmers f ON f.id=a.farmer_id WHERE a.id=$1', [id]);
        return mapAdvisory(full.rows[0]);
      },

      // ── Train AI Doctor ──
      createTrainingClass: async (_p, { input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const classNo = `AIC-${String(await seq('aiclass_seq')).padStart(4, '0')}`;
        const { rows } = await query(
          `INSERT INTO ai_training_classes (class_no, crop, disease, pathogen, description, symptoms, treatment, product_ids, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [classNo, input.crop, input.disease, input.pathogen ?? null, input.description ?? null, input.symptoms ?? null, input.treatment ?? null, input.productIds ?? [], a.sub],
        );
        await logActivity(a.sub, 'CREATE_TRAINING_CLASS', 'ai_training_class', rows[0].id, { classNo });
        return mapClass(rows[0]);
      },
      updateTrainingClass: async (_p, { id, input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rows } = await query(
          `UPDATE ai_training_classes SET crop=$2, disease=$3, pathogen=$4, description=$5, symptoms=$6, treatment=$7, product_ids=$8, updated_at=now() WHERE id=$1 RETURNING *`,
          [id, input.crop, input.disease, input.pathogen ?? null, input.description ?? null, input.symptoms ?? null, input.treatment ?? null, input.productIds ?? []],
        );
        if (!rows[0]) throw httpError('Training class not found', 404);
        await logActivity(a.sub, 'UPDATE_TRAINING_CLASS', 'ai_training_class', id);
        return mapClass(rows[0]);
      },
      deleteTrainingClass: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        // Capture sample ids before the cascade delete so we can purge their vectors.
        const sampleIds = (await query('SELECT id FROM ai_training_samples WHERE class_id=$1', [id])).rows.map((r) => r.id);
        const { rowCount } = await query('DELETE FROM ai_training_classes WHERE id=$1', [id]); // CASCADE removes samples
        if (!rowCount) throw httpError('Training class not found', 404);
        if (sampleIds.length) deleteSamples(sampleIds).catch(() => {}); // best-effort vector cleanup
        await logActivity(a.sub, 'DELETE_TRAINING_CLASS', 'ai_training_class', id);
        return true;
      },
      addTrainingSample: async (_p, { classId, input }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const cls = (await query('SELECT id, crop, disease, pathogen, symptoms FROM ai_training_classes WHERE id=$1', [classId])).rows[0];
        if (!cls) throw httpError('Training class not found', 404);
        const count = Number((await query('SELECT COUNT(*) n FROM ai_training_samples WHERE class_id=$1', [classId])).rows[0].n);
        if (count >= MAX_SAMPLES_PER_CLASS) throw httpError(`A class can hold at most ${MAX_SAMPLES_PER_CLASS} photos`, 400);
        const { rows } = await query(
          'INSERT INTO ai_training_samples (class_id, image_url, image_key, caption) VALUES ($1,$2,$3,$4) RETURNING id, image_url, caption, created_at',
          [classId, input.imageUrl, input.imageKey ?? null, input.caption ?? null],
        );
        await logActivity(a.sub, 'ADD_TRAINING_SAMPLE', 'ai_training_class', classId);
        // Best-effort: caption → embed → upsert to Postgres + Pinecone so this photo
        // can be matched against farmer queries. Never blocks the upload if AI is absent.
        indexSample(rows[0].id, input.imageUrl, cls).catch(() => {});
        return { id: rows[0].id, imageUrl: rows[0].image_url, caption: rows[0].caption, createdAt: rows[0].created_at };
      },
      deleteTrainingSample: async (_p, { id }, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'SALES');
        const { rowCount } = await query('DELETE FROM ai_training_samples WHERE id=$1', [id]);
        if (!rowCount) throw httpError('Sample not found', 404);
        deleteSamples(id).catch(() => {}); // best-effort vector cleanup
        await logActivity(a.sub, 'DELETE_TRAINING_SAMPLE', 'ai_training_sample', id);
        return true;
      },

      // Re-embed every active training photo and (re)upsert it to Pinecone. Use
      // after enabling Pinecone/Gemini or to repair drift. Runs synchronously so
      // the UI can report an exact processed/failed count.
      reindexTrainingData: async (_p, _a, ctx) => {
        const a = assertRole(ctx, 'SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN');
        const { rows } = await query(
          `SELECT s.id, s.image_url, c.id AS class_id, c.crop, c.disease, c.pathogen, c.symptoms
           FROM ai_training_samples s JOIN ai_training_classes c ON c.id = s.class_id
           WHERE c.is_active ORDER BY s.created_at`,
        );
        let processed = 0;
        let failed = 0;
        for (const r of rows) {
          try {
            const ok = await indexSample(r.id, r.image_url, { id: r.class_id, crop: r.crop, disease: r.disease, pathogen: r.pathogen, symptoms: r.symptoms });
            if (ok) processed += 1; else failed += 1;
          } catch { failed += 1; }
        }
        await logActivity(a.sub, 'REINDEX_TRAINING', 'ai_training', null, { processed, failed, total: rows.length });
        return { total: rows.length, processed, failed };
      },
    },

    CropDiagnosis: {
      recommendedProducts: (parent) => productRefs(parent.productIds),
      hasLead: async (parent) => Boolean((await query('SELECT 1 FROM crm_leads WHERE diagnosis_id=$1', [parent.id])).rows[0]),
    },
    Advisory: { recommendedProducts: (parent) => productRefs(parent.productIds) },
    CrmLead: { recommendedProducts: (parent) => productRefs(parent.productIds) },
    AiTrainingClass: {
      recommendedProducts: (parent) => productRefs(parent.productIds),
      sampleCount: async (parent) => Number((await query('SELECT COUNT(*) n FROM ai_training_samples WHERE class_id=$1', [parent.id])).rows[0].n),
      samples: async (parent) => {
        const { rows } = await query('SELECT id, image_url, caption, created_at FROM ai_training_samples WHERE class_id=$1 ORDER BY created_at', [parent.id]);
        return rows.map((r) => ({ id: r.id, imageUrl: r.image_url, caption: r.caption, createdAt: r.created_at }));
      },
    },
  };
}

async function productRefs(ids) {
  if (!ids?.length) return [];
  const { rows } = await query('SELECT id, name FROM products WHERE id = ANY($1)', [ids]);
  return rows;
}
