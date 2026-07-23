function toCents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function fromCents(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function nearlyEqualMoney(a, b) {
  return Math.abs(toCents(a) - toCents(b)) <= 0;
}

function formatMoney(amount) {
  return Number(amount || 0).toFixed(2);
}

module.exports = {
  toCents,
  fromCents,
  nearlyEqualMoney,
  formatMoney,
};
