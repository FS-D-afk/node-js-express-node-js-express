const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { run } = require('../db');
const { nearlyEqualMoney } = require('../utils/money');
const { markPaid, markReview } = require('./orders');

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

  // 优先匹配带两位小数的金额，避免把状态栏时间、电量等整数误判为付款金额。
  const decimalPattern = new RegExp(`(?:^|[^\\d])${escapeRegExp(yuan)}\\.${escapeRegExp(cents)}(?!\\d)`);
  if (decimalPattern.test(compact)) {
    return targetAmount;
  }

  // OCR 偶尔会漏掉小数点；只有紧邻货币符号或金额关键词时才接受整数形式。
  if (cents === '00') {
    const amountContextPattern = new RegExp(
      `(?:￥|¥|人民币|支付金额|付款金额|实付金额|金额)[:：]?${escapeRegExp(yuan)}(?:元)?(?!\\d)`
    );
    if (amountContextPattern.test(compact)) {
      return targetAmount;
    }
  }

  // 兼容常规 OCR 输出，但只接受原文中明确出现小数的候选金额。
  const decimalCandidates = normalized.match(/(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{1,2}/g) || [];
  const matched = decimalCandidates
    .map((value) => Number(value.replace(/,/g, '')))
    .find((value) => nearlyEqualMoney(value, expectedAmount));

  return matched === undefined ? null : targetAmount;
}

// 保留这两个辅助函数，兼容旧代码和旧测试；新版自动通过不再依赖它们。
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

async function saveProof(order, file) {
  const fileHash = sha256File(file.path);

  let text = '';
  let ocrError = '';
  try {
    text = await recognizeText(file.path);
  } catch (error) {
    ocrError = error.stderr || error.message;
  }

  const matchedAmount = findMatchedAmount(text, order.pay_amount);
  const accepted = Boolean(matchedAmount);

  let reason;
  if (accepted) {
    reason = '识别金额与订单金额一致，自动通过';
  } else if (ocrError) {
    reason = `OCR 识别失败：${String(ocrError).slice(0, 180)}`;
  } else {
    reason = '未识别到与订单一致的支付金额';
  }

  const result = await run(
    `INSERT INTO payment_proofs
     (order_id, image_path, image_hash, ocr_text, recognized_amount, transaction_no, status, reason)
     VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
    [
      order.id,
      file.path,
      fileHash,
      text,
      matchedAmount || null,
      accepted ? 'accepted' : 'pending',
      reason,
    ]
  );
  const proofId = result.id;

  if (accepted) {
    await markPaid(order.id, proofId);
    return {
      status: 'accepted',
      reason: '付款金额校验成功，订单已自动发货。',
      proofId,
      text,
    };
  }

  await markReview(order.id);
  return {
    status: 'pending',
    reason: ocrError
      ? '截图识别失败，请确认图片清晰后重新上传；如仍失败，请联系管理员人工确认。'
      : `截图中未识别到订单金额（￥${Number(order.pay_amount).toFixed(2)}），请核对后重新上传。`,
    proofId,
    text,
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
