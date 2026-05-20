function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const status = error?.response?.status;
  if (!status) return true;
  return status === 429 || status >= 500;
}

async function withRetry(fn, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 250,
    maxDelayMs = 2000,
    shouldRetry = isRetryableError,
    onRetry = null,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error)) break;

      const delayMs = Math.min(baseDelayMs * (2 ** attempt), maxDelayMs);
      if (onRetry) {
        onRetry(error, { attempt: attempt + 1, delayMs });
      }
      await sleep(delayMs);
    }
  }

  throw lastError;
}

module.exports = { withRetry };
