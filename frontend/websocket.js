(function () {
  window.createCrdtSocket = function createCrdtSocket({
    documentId,
    wsPort,
    getKnownIds,
    onOpen,
    onClose,
    onStatus,
    onSync,
    onOp,
    onError,
  }) {
    let reconnectDelayMs = 500;
    let reconnectTimer = null;
    let ws = null;

    function websocketUrl() {
      const url = new URL("/", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.hostname = location.hostname;
      url.port = wsPort === "same" ? location.port : wsPort;
      url.searchParams.set("document_id", documentId);
      return url.toString();
    }

    function isOpen() {
      return ws && ws.readyState === WebSocket.OPEN;
    }

    function send(message) {
      if (!isOpen()) return false;
      ws.send(JSON.stringify({ document_id: documentId, ...message }));
      return true;
    }

    function requestSync() {
      send({
        type: "sync-request",
        known_ids: getKnownIds(),
      });
    }

    function scheduleReconnect() {
      if (reconnectTimer) return;
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 8000);
      onStatus(`reconnecting in ${Math.round(delay / 1000)}s`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect() {
      if (
        ws &&
        (ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      onStatus("connecting");
      ws = new WebSocket(websocketUrl());

      ws.onopen = () => {
        reconnectDelayMs = 500;
        onOpen();
        requestSync();
      };

      ws.onclose = () => {
        onClose();
        scheduleReconnect();
      };

      ws.onerror = () => {
        onStatus("error");
      };

      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.document_id !== documentId) return;

        if (message.type === "sync") {
          onSync(message);
        } else if (message.type === "op") {
          onOp(message.op);
        } else if (message.type === "error") {
          onError(message.message);
        }
      };
    }

    return {
      connect,
      isOpen,
      requestSync,
      sendOp(op) {
        return send({ type: "op", op });
      },
    };
  };
})();
