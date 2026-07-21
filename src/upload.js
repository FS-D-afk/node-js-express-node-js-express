const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { randomToken } = require('./utils/tokens');

const uploadRoot = path.resolve('data/uploads');
const proofDir = path.join(uploadRoot, 'proofs');
const publicDir = path.resolve('public/uploads');
const qrDir = path.join(publicDir, 'qr');
const productDetailDir = path.join(publicDir, 'product-details');

for (const dir of [proofDir, qrDir, productDetailDir]) {
  fs.mkdirSync(dir, { recursive: true });
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

const proofUpload = multer({
  storage: multer.diskStorage({
    destination: proofDir,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `${Date.now()}-${randomToken(8)}${ext}`);
    },
  }),
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const qrUpload = multer({
  storage: multer.diskStorage({
    destination: qrDir,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `wechat-${Date.now()}${ext}`);
    },
  }),
  fileFilter: imageFilter,
  limits: { fileSize: 3 * 1024 * 1024 },
});

const productDetailUpload = multer({
  storage: multer.diskStorage({
    destination: productDetailDir,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `product-detail-${Date.now()}${ext}`);
    },
  }),
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = {
  proofUpload,
  qrUpload,
  productDetailUpload,
  isSupportedImageFile,
};
