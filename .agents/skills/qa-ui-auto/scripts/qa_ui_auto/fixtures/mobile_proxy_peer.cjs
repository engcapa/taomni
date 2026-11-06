// Authenticated loopback CONNECT/SOCKS fixtures. Reject every other destination.
const net = require("node:net");
const http = require("node:http");
exports.start = async (targetPort, record) => {
  const sockets = new Set();
  const own = socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); return socket; };
  const tunnel = (socket, bytes, ready) => {
    const upstream = own(net.connect(targetPort, "127.0.0.1", () => {
      ready(); if (bytes.length) upstream.write(bytes);
      socket.pipe(upstream); upstream.pipe(socket);
    }));
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  };
  const connect = http.createServer();
  connect.on("connect", (request, socket, head) => {
    own(socket);
    if (request.url !== `127.0.0.1:${targetPort}` || request.headers["proxy-authorization"] !== "Basic " + Buffer.from("qa-proxy-user:qa-proxy-secret").toString("base64")) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return;
    }
    record({ event: "proxy-authenticated", kind: "http" });
    tunnel(socket, head, () => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
  });
  const socks = net.createServer(socket => {
    own(socket); let phase = 0, data = Buffer.alloc(0);
    const read = chunk => {
      data = Buffer.concat([data, chunk]);
      if (phase === 0) {
        if (data.length < 2 || data.length < 2 + data[1]) return;
        const methods = data.subarray(2, 2 + data[1]);
        if (data[0] !== 5 || !methods.includes(2)) { socket.end(Buffer.from([5, 255])); return; }
        data = data.subarray(2 + data[1]); phase = 1; socket.write(Buffer.from([5, 2]));
      }
      if (phase === 1) {
        if (data.length < 2 || data.length < 3 + data[1]) return;
        const u = data[1], p = data[2 + u]; if (data.length < 3 + u + p) return;
        if (data[0] !== 1 || data.subarray(2, 2 + u).toString() !== "qa-proxy-user" || data.subarray(3 + u, 3 + u + p).toString() !== "qa-proxy-secret") { socket.end(Buffer.from([1, 1])); return; }
        data = data.subarray(3 + u + p); phase = 2; socket.write(Buffer.from([1, 0]));
      }
      if (phase === 2) {
        if (data.length < 5) return;
        const type = data[3], len = type === 1 ? 4 : type === 3 ? 1 + data[4] : 16;
        if (data.length < 4 + len + 2) return;
        const host = type === 1 ? [...data.subarray(4, 8)].join(".") : type === 3 ? data.subarray(5, 4 + len).toString() : "invalid";
        if (data[1] !== 1 || host !== "127.0.0.1" || data.readUInt16BE(4 + len) !== targetPort) { socket.destroy(); return; }
        socket.removeListener("data", read); phase = 3;
        record({ event: "proxy-authenticated", kind: "socks5" });
        tunnel(socket, data.subarray(4 + len + 2), () => socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])));
      }
    };
    socket.on("data", read);
  });
  await Promise.all([connect, socks].map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
  return { httpPort: connect.address().port, socksPort: socks.address().port, close() { for (const socket of sockets) socket.destroy(); connect.close(); socks.close(); } };
};
