function createConfig(env = process.env) {
  return {
    LINE_CHANNEL_ACCESS_TOKEN: env.LINE_CHANNEL_ACCESS_TOKEN,
    LINE_CHANNEL_SECRET: env.LINE_CHANNEL_SECRET,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    STRAVA_CLIENT_ID: env.STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET: env.STRAVA_CLIENT_SECRET,
    RAPIDAPI_KEY: env.RAPIDAPI_KEY,
    SERVER_URL: env.SERVER_URL || "https://strava-line-bot-production.up.railway.app",
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
  };
}

function createDbSsl(env = process.env) {
  if (env.DATABASE_SSL === "false") return false;

  return {
    rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
    ...(env.DATABASE_CA_CERT
      ? { ca: env.DATABASE_CA_CERT.replace(/\\n/g, "\n") }
      : {}),
  };
}

function validateConfig(config, env = process.env) {
  const required = [
    ["LINE_CHANNEL_ACCESS_TOKEN", config.LINE_CHANNEL_ACCESS_TOKEN],
    ["LINE_CHANNEL_SECRET", config.LINE_CHANNEL_SECRET],
    ["ANTHROPIC_API_KEY", config.ANTHROPIC_API_KEY],
    ["DATABASE_URL", env.DATABASE_URL],
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  const missingStrava = [
    ["STRAVA_CLIENT_ID", config.STRAVA_CLIENT_ID],
    ["STRAVA_CLIENT_SECRET", config.STRAVA_CLIENT_SECRET],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missingStrava.length > 0) {
    console.warn(
      `Strava integration is disabled until these variables are set: ${missingStrava.join(", ")}`
    );
  }

  if (!config.TOKEN_ENCRYPTION_KEY) {
    const message =
      "TOKEN_ENCRYPTION_KEY is required in production to encrypt Strava tokens at rest.";
    if (env.NODE_ENV === "production") {
      throw new Error(message);
    }
    console.warn(
      `${message} Development mode will remain backward-compatible plaintext.`
    );
  }
}

module.exports = {
  createConfig,
  createDbSsl,
  validateConfig,
};
