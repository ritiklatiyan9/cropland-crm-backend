// Presigned S3 upload endpoint — clients request a URL then PUT directly to S3.
// Keeps large binaries (COA, MSDS, complaint photos, invoices) off the API server.

import { randomUUID } from 'node:crypto';
import { getUploadUrl, getDownloadUrl, uploadObject, isAwsConfigured } from '../utils/aws.js';

export default async function uploadRoutes(fastify) {
  // Folders clients may upload (compressed) images into.
  const ALLOWED_FOLDERS = new Set(['avatars', 'products', 'uploads', 'training']);

  // POST /uploads/image  { dataUrl, filename, folder }
  // Accepts a (client-side compressed) data URL, stores it in S3, returns the key.
  // (/uploads/avatar kept as a backward-compatible alias.)
  async function handleImageUpload(request, reply) {
    if (!isAwsConfigured) {
      return reply
        .code(503)
        .send({ error: 'Image storage is not configured (set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).' });
    }
    const { dataUrl, filename = 'image.jpg', folder = 'uploads' } = request.body ?? {};
    const prefix = ALLOWED_FOLDERS.has(folder) ? folder : 'uploads';
    const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl ?? '');
    if (!match) {
      return reply.code(400).send({ error: 'dataUrl must be a base64 image data URL' });
    }
    const [, contentType, base64] = match;
    const body = Buffer.from(base64, 'base64');
    if (body.length > 5 * 1024 * 1024) {
      return reply.code(413).send({ error: 'Image too large (max 5MB after compression)' });
    }
    const { key, url } = await uploadObject({ body, contentType, prefix, filename });
    return { key, url };
  }

  fastify.post('/uploads/image', { preHandler: fastify.authenticate, bodyLimit: 8 * 1024 * 1024 }, handleImageUpload);
  fastify.post('/uploads/avatar', { preHandler: fastify.authenticate, bodyLimit: 8 * 1024 * 1024 }, (req, reply) => {
    req.body = { ...(req.body ?? {}), folder: 'avatars' };
    return handleImageUpload(req, reply);
  });

  // Documents (non-image) clients may presign, and the content-types permitted.
  // An open prefix/content-type let a client upload web-served HTML (stored XSS).
  const ALLOWED_DOC_FOLDERS = new Set([...ALLOWED_FOLDERS, 'documents', 'coa', 'msds', 'invoices', 'complaints']);
  const ALLOWED_CONTENT_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/pdf', 'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ]);

  // POST /uploads/presign  { prefix, filename, contentType }
  fastify.post(
    '/uploads/presign',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { prefix = 'uploads', filename = '', contentType } = request.body ?? {};
      if (!contentType) {
        return reply.code(400).send({ error: 'contentType is required' });
      }
      if (!ALLOWED_DOC_FOLDERS.has(prefix)) {
        return reply.code(400).send({ error: `prefix must be one of: ${[...ALLOWED_DOC_FOLDERS].join(', ')}` });
      }
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        return reply.code(400).send({ error: 'contentType not allowed' });
      }
      // Sanitise the extension: alphanumeric only, so a crafted filename can't smuggle a path or a second dot.
      const rawExt = filename.includes('.') ? filename.split('.').pop() : '';
      const ext = /^[a-zA-Z0-9]{1,8}$/.test(rawExt) ? `.${rawExt.toLowerCase()}` : '';
      const key = `${prefix}/${randomUUID()}${ext}`;
      const uploadUrl = await getUploadUrl(key, contentType);
      return { key, uploadUrl };
    },
  );

  // GET /uploads/download-url?key=...  -> time-limited GET URL for a private object.
  // Only keys under known object folders are allowed, blocking traversal / probing
  // of arbitrary bucket paths. Staff can read any allowed key; the app tokens too,
  // but the key namespace here is non-sensitive (product/complaint/COA assets).
  fastify.get(
    '/uploads/download-url',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      const { key } = request.query ?? {};
      if (!key) return reply.code(400).send({ error: 'key is required' });
      const folder = String(key).split('/')[0];
      if (String(key).includes('..') || !ALLOWED_DOC_FOLDERS.has(folder)) {
        return reply.code(400).send({ error: 'Invalid object key' });
      }
      return { url: await getDownloadUrl(key) };
    },
  );
}
