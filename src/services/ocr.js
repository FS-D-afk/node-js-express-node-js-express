const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { get, run } = require('../db');
const { toStoredProofPath } = require('../upload');
const { nearlyEqualMoney } = require('../utils/money');
const { markReview } = require('./orders');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout.toString('utf8'));
      }
    });
  });
}

async function recognizeText(imagePath) {
  if (process.env.OCR_COMMAND) {
    const command = process.env.OCR_COMMAND.replace('{file}', imagePath);
    const [bin, ...args] = command.split(' ');
    return execFilePromise(bin, args);
  }

  if (process.platform === 'win32') {
    const script = path.resolve(__dirname, '..', '..', 'scripts', 'windows-ocr.ps1');
    return execFilePromise('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      imagePath,
    ]);
  }

  return '';
}

function normalizeOcrText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[Oo]/g, '0')
    .replace(/[，,]/g, ',')
    .replace(/[。．·]/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactOcrText(text) {
  return normalizeOcrText(text).replace(/\s+/g, '');
}

function extractAmounts(text) {
  const normalized = normalizeOcrText(text)
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '')
    .replace(/\u00a0/g, ' ');

  const matches = normalized.match(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/g) || [];
  const seen = new Set();

  return matches
    .map((match) => match.replace(/,/g, ''))
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => value.toFixed(2))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchedAmount(text, expectedAmount) {
  const targetAmount = Number(expectedAmount || 0).toFixed(2);
  const [yuan, cents] = targetAmount.split('.');
  const normalized = normalizeOcrText(text);
  const compact = compactOcrText(text);

  const decimalPattern = new RegExp(`(?:^|[^\\d])${escapeRegExp(yuan)}\\.${escapeRegExp(cents)}(?!\\d)`);
  if (decimalPattern.test(compact)) {
    return targetAmount;
  }

  if (cents === '00') {
    const amountContextPattern = new RegExp(
      `(?:￥|¥|人民币|支付金额|付款金额|实付金额|金额)[:：]?${escapeRegExp(yuan)}(?:元)?(?!\\d)`
    );
    if (amountContextPattern.test(compact)) {
      return targetAmount;
    }
  }

  const decimalCandidates = normalized.match(/(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{1,2}/g) || [];
  const matched = decimalCandidates
    .map((value) => Number(value.replace(/,/g, '')))
    .find((value) => nearlyEqualMoney(value, expectedAmount));

  return matched === undefined ? null : targetAmount;
}

function hasPaymentSuccess(text) {
  const compact = compactOcrText(text);
  return /(支付成功|交易成功|付款成功|已支付|对方已收款)/.test(compact);
}

function extractTransactionNo(text) {
  const raw = String(text || '').normalize('NFKC');
  const compact = compactOcrText(raw);
  const hasTransactionLabel = /(转账单号|交易单号|微信支付订单号|商户单号)/.test(compact);
  if (!hasTransactionLabel) return null;

  const matches = raw.match(/[0-9Oo](?:\s*[0-9Oo]){19,39}/g) || [];
  const candidates = [...new Set(matches
    .map((value) => value.replace(/\s+/g, '').replace(/[Oo]/g, '0'))
    .filter((value) => /^\d{20,40}$/.test(value)))];

  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

async function saveProof(order, file, { recognize = recognizeText } = {}) {
  const fileHash = sha256File(file.path);
  const previousProof = await get(
    'SELECT id, order_id FROM payment_proofs WHERE image_hash = ? ORDER BY id DESC LIMIT 1',
    [fileHash]
  );
  const reusedAcrossOrders = Boolean(
    previousProof && Number(previousProof.order_id) !== Number(order.id)
  );

  let text = '';
  let ocrError = '';
  try {
    text = await recognize(file.path);
  } catch (error) {
    ocrError = error.stderr || error.message;
  }

  const matchedAmount = findMatchedAmount(text, order.pay_amount);
  const transactionNo = extractTransactionNo(text) || '';

  let reason;
  if (ocrError) {
    reason = `OCR 识别失败，等待人工审核：${String(ocrError).slice(0, 180)}`;
  } else if (matchedAmount) {
    reason = '已识别到与订单一致的金额，等待管理员确认';
  } else {
    reason = '未识别到与订单一致的支付金额，等待人工审核';
  }
  if (reusedAcrossOrders) {
    reason += '；警告：该截图曾用于其他订单';
  }

  const result = await run(
    `INSERT INTO payment_proofs
     (order_id, image_path, image_hash, ocr_text, recognized_amount, transaction_no, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      order.id,
      toStoredProofPath(file),
      fileHash,
      text,
      matchedAmount || null,
      transactionNo,
      reason,
    ]
  );

  await markReview(order.id);

  let userMessage;
  if (matchedAmount) {
    userMessage = '已识别到与订单一致的金额，截图已提交，等待管理员确认。';
  } else if (ocrError) {
    userMessage = '截图已提交，但自动识别失败，请等待管理员人工审核。';
  } else {
    userMessage = `截图已提交，但未识别到订单金额（￥${Number(order.pay_amount).toFixed(2)}），请等待管理员人工审核。`;
  }

  return {
    status: 'pending',
    reason: userMessage,
    proofId: result.id,
    text,
    matchedAmount,
    transactionNo,
    reusedAcrossOrders,
  };
}

module.exports = {
  saveProof,
  extractAmounts,
  findMatchedAmount,
  extractTransactionNo,
  hasPaymentSuccess,
  recognizeText,
};
