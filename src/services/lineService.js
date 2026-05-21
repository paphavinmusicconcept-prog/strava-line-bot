function createLineService({ axios, channelAccessToken, logger, withRetry }) {
  function lineErrorMeta(error) {
    return {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    };
  }

  function makeQuickReply(items) {
    return {
      items: items.map(i => ({
        type: "action",
        action: {
          type: "message",
          label: i.label,
          text: i.text,
        },
      })),
    };
  }

  async function pushMessage(userId, text, quickReply = null) {
    await withRetry(
      () => axios.post(
        "https://api.line.me/v2/bot/message/push",
        {
          to: userId,
          messages: [
            {
              type: "text",
              text,
              ...(quickReply ? { quickReply } : {}),
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${channelAccessToken}`,
          },
          timeout: 10000,
        }
      ),
      {
        onRetry: (error, meta) => logger.warn("Retrying LINE push message", {
          error: error.message,
          ...meta,
        }),
      }
    );
  }

  async function replyMessage(replyToken, messages) {
    try {
      await withRetry(
        () => axios.post(
          "https://api.line.me/v2/bot/message/reply",
          {
            replyToken,
            messages: Array.isArray(messages) ? messages : [messages],
          },
          {
            headers: {
              Authorization: `Bearer ${channelAccessToken}`,
            },
            timeout: 10000,
          }
        ),
        {
          onRetry: (error, meta) => logger.warn("Retrying LINE reply message", {
            ...lineErrorMeta(error),
            ...meta,
          }),
        }
      );
    } catch (error) {
      logger.error("LINE reply message failed", lineErrorMeta(error));
      throw error;
    }
  }

  async function pushFlexMessage(userId, flexContent) {
    await withRetry(
      () => axios.post(
        "https://api.line.me/v2/bot/message/push",
        {
          to: userId,
          messages: [flexContent],
        },
        {
          headers: {
            Authorization: `Bearer ${channelAccessToken}`,
          },
          timeout: 10000,
        }
      ),
      {
        onRetry: (error, meta) => logger.warn("Retrying LINE push flex", {
          error: error.message,
          ...meta,
        }),
      }
    );
  }

  async function replyText(replyToken, text, quickReply = null) {
    await replyMessage(replyToken, {
      type: "text",
      text,
      ...(quickReply ? { quickReply } : {}),
    });
  }

  async function replyFlex(replyToken, flexContent) {
    await replyMessage(replyToken, flexContent);
  }

  return {
    makeQuickReply,
    pushMessage,
    replyMessage,
    pushFlexMessage,
    replyText,
    replyFlex,
  };
}

module.exports = { createLineService };
