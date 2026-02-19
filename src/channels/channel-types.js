export function createIncomingMessage({ source, channelId, userId, sessionId = "" }) {
  return {
    source,
    channelId,
    userId,
    sessionId: String(sessionId || ""),
  };
}
