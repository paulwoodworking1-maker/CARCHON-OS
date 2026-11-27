'use strict';
// Fichiers déposés (photos, plans, PDF, vocaux) : data/uploads/<nom aléatoire>.<ext>
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('./db');

const ALLOWED = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|audio\/.+|video\/(mp4|quicktime|webm))$/;
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/webm': '.webm', 'audio/ogg': '.ogg',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
// Jamais d'extension que le navigateur exécuterait (.html, .svg, .js…) : le type annoncé par l'envoyeur n'est pas fiable.
const SAFE_EXT = new Set(Object.values(EXT));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const guess = path.extname(file.originalname).toLowerCase();
      const ext = EXT[file.mimetype] || (SAFE_EXT.has(guess) ? guess : '.bin');
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    },
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.test(file.mimetype)),
});

// Fichiers techniques (vues 3D, nomenclatures, chiffrages) : on accepte selon l'extension.
const DOC_EXT = /\.(pdf|png|jpe?g|webp|gif|csv|txt|tsv|xlsx|xls|3dm|step|stp|dxf|dwg|skp|f3d|stl|obj|igs|iges|zip)$/i;
const uploadDocs = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + (path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.bin')),
  }),
  limits: { fileSize: 60 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, DOC_EXT.test(file.originalname) || ALLOWED.test(file.mimetype)),
});

const fileUrl = (name) => (name ? `/fichiers/${encodeURIComponent(name)}` : '');
const filePath = (name) => path.join(UPLOAD_DIR, path.basename(name));
const isImage = (name) => /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name || '');
// Envoie un fichier déposé : affiché s'il est sûr (image, PDF, son, vidéo), sinon téléchargé.
function sendUpload(res, f) {
  res.set('X-Content-Type-Options', 'nosniff');
  if (!SAFE_EXT.has(path.extname(f).toLowerCase())) res.attachment(path.basename(f));
  res.sendFile(f);
}

module.exports = { upload, uploadDocs, fileUrl, filePath, isImage, sendUpload };
