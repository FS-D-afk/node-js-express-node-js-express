const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { csrfProtectionAfterMultipart } = require('./middleware/csrf');
const { randomToken } = require('./utils/tokens');

const projectRoot = path.resolve(__dirname, '..');
const uploadRoot = path.join(projectRoot, 'data', 'uploads');
const proofDir = path.join(uploadRoot, 'proofs');
const publicDir = path.join(projectRoot, 'public', 'uploads');
const qrDir = path.join(publicDir, 'qr');
const productDetailDir = path.join(publicDir, 'product-details');

for (const dir of [proofDir, qrDir, productDetailDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

function proofFileName(fileOrPath) {
  const value = typeof fileOrPath === 'object' && fileOrPath
    ? fileOrPath.filename || fileOrPath.path
    : fileOrPath;
  const normalized = String(value || '').replace(/\\/g, '/');
  const fileName = path.posix.basename(normalized);
  return fileName && fileName !== '.' && fileName !== '..' ? fileName : '';
}

function toStoredProofPath(fileOrPath) {
  const fileName = proofFileName(fileOrPath);
  if (!fileName) throw new Error('付款截图路径无效。');
  return path.posix.join('data', 'uploads', 'proofs', fileName);
}

function resolveProofPath(storedPath) {
  const fileName = proofFileName(storedPath);
  return fileName ? path.join(proofDir, fileName) : '';
}

function isSupportedImageFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 12) return false;

    const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isBmp = buffer[0] === 0x42 && buffer[1] === 0x4d;
    const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';

    return isPng || isJpeg || isBmp || isWebp;
  } catch (error) {
    return false;
  }
}

function imageFilter(req, file, cb) {
  if (!/^image\/(png|jpe?g|webp|bmp)$/i.test(file.mimetype)) {
    cb(new Error('请上传 PNG、JPG、WEBP 或 BMP 图片。'));
    return;
  }
  cb(null, true);
}

function protectMultipartUpload(upload) {
  return {
    single(fieldName) {
      const parseUpload = upload.single(fieldName);
      return (req, res, next) => {
        parseUpload(req, res, (uploadError) => {
          csrfProtectionAfterMultipart(req, res, () => next(uploadError || undefined));
        });
      };
    },
  };
}

const proofUpload = protectMultipartUpload(multer({
  storage: multer.diskStorage({
    destination: proofDir,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `${Date.now()}-${randomToken(8)}${ext}`);
    },
  }),
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}));

const qrUpload = protectMultipartUpload(multer({
  storage: multer.diskStorage({
    destination: qrDir,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `wechat-${Date.now()}${ext}`);
    },
  }),
  fileFilter: imageFilter,
  limits: { fileSize: 3 * 1024 * 1024 },
}));

const productDetailUpload = protectMultipartUpload(multer({
  storage: multer.diskStorage({
    destination: productDetailDir,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `product-detail-${Date.now()}${ext}`);
    },
  }),
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}));

module.exports = {
  proofUpload,
  qrUpload,
  productDetailUpload,
  isSupportedImageFile,
  toStoredProofPath,
  resolveProofPath,
};