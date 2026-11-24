'use strict';
// Fichiers déposés (photos, plans, PDF, vocaux) : data/uploads/<nom aléatoire>.<ext>
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('./db');

const ALLOWED = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|audio\/.+|video\/(mp4|quicktime|webm))$/;
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf' };

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = EXT[file.mimetype] || (path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.bin');
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.test(file.mimetype)),
});

const fileUrl = (name) => (name ? `/fichiers/${encodeURIComponent(name)}` : '');
const filePath = (name) => path.join(UPLOAD_DIR, path.basename(name));
const isImage = (name) => /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name || '');

module.exports = { upload, fileUrl, filePath, isImage };
