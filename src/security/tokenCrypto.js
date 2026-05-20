const crypto = require("crypto");

function createTokenCrypto({ encryptionKey }) {
  function getTokenCipherKey() {
    if (!encryptionKey) return null;
    return crypto.createHash("sha256").update(encryptionKey).digest();
  }

  function encryptSecret(value) {
    if (!value) return value;

    const key = getTokenCipherKey();
    if (!key) return value;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(String(value), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
  }

  function decryptSecret(value) {
    if (!value || !String(value).startsWith("enc:v1:")) return value;

    const key = getTokenCipherKey();
    if (!key) {
      throw new Error("TOKEN_ENCRYPTION_KEY is required to decrypt stored Strava tokens");
    }

    const [, , ivB64, tagB64, encryptedB64] = String(value).split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(encryptedB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  function encryptTokenData(tokenData) {
    return {
      ...tokenData,
      access_token: encryptSecret(tokenData.access_token),
      refresh_token: encryptSecret(tokenData.refresh_token),
    };
  }

  function decryptTokenData(tokenData) {
    if (!tokenData) return null;

    return {
      access_token: decryptSecret(tokenData.access_token),
      refresh_token: decryptSecret(tokenData.refresh_token),
      expires_at: parseInt(tokenData.expires_at, 10),
    };
  }

  return { encryptSecret, decryptSecret, encryptTokenData, decryptTokenData };
}

module.exports = { createTokenCrypto };
