import multer from 'multer';
import { Request } from 'express';

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const MATERIAL_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
  'application/pdf',
  'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const imageFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (IMAGE_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, WEBP and HEIC images are allowed'));
  }
};

const materialFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (MATERIAL_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type'));
  }
};

// Store in memory, then upload to Supabase Storage
export const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: imageFilter,
}).single('photo');

export const uploadMultiple = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: imageFilter,
}).array('photos', 5);

// For training materials — accepts images + PDFs + videos + docs, field name 'file'
export const uploadMaterial = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB for videos
  fileFilter: materialFilter,
}).single('file');
