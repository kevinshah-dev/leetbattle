export function buildRealtimeSocketUrl(
  configuredUrl: string,
  ticket: string,
): URL {
  const socketUrl = new URL(configuredUrl);
  switch (socketUrl.protocol) {
    case "http:":
      socketUrl.protocol = "ws:";
      break;
    case "https:":
      socketUrl.protocol = "wss:";
      break;
    case "ws:":
    case "wss:":
      break;
    default:
      throw new TypeError("Realtime URL must use HTTP(S) or WebSocket");
  }
  socketUrl.pathname = `${socketUrl.pathname.replace(/\/$/, "")}/socket`;
  socketUrl.searchParams.set("ticket", ticket);
  return socketUrl;
}
