const crypto = require("crypto");

function normalizeNumber(value, decimals = 3) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(decimals) : "0";
}

function createActivityFingerprint(activity = {}) {
  const raw = [
    activity.source || "manual",
    activity.date ? new Date(activity.date).toISOString().slice(0, 19) : "",
    normalizeNumber(activity.distance),
    normalizeNumber(activity.pace),
    normalizeNumber(activity.duration),
    normalizeNumber(activity.elevGain),
  ].join("|");

  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function createContentFingerprint(prefix, content) {
  return `${prefix}:${crypto.createHash("sha256").update(String(content)).digest("hex").slice(0, 24)}`;
}

module.exports = {
  createActivityFingerprint,
  createContentFingerprint,
};
