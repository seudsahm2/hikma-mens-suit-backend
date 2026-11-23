import multer from 'multer';
import { badRequest } from '../lib/http';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'];

/** In-memory image upload (resized with sharp before storing). */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    if (IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(badRequest('Only image files are allowed', 'FILE_TYPE'));
  },
});

/** Hero video upload (owner only). */
export const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (['video/mp4', 'video/webm'].includes(file.mimetype)) cb(null, true);
    else cb(badRequest('Upload an MP4 or WebM video', 'FILE_TYPE'));
  },
});
