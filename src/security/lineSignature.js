const crypto = require("crypto");

function isLineSignatureValid(req, channelSecret) {
  const signature = req.get("x-line-signature");
  if (!channelSecret || !signature || !req.rawBody) return false;

  const expectedSignature = crypto
    .createHmac("sha256", channelSecret)
    .update(req.rawBody)
    .digest("base64");

  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(signature);

  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

module.exports = { isLineSignatureValid };
