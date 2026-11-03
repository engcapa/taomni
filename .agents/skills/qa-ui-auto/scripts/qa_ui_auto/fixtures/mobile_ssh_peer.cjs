// Disposable loopback SSH peer, never an external account. It owns independent
// authentication/input receipts and a deterministic shell channel on every OS.
const { Server, utils } = require("ssh2");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const receipt = path.join(root, "mobile-ssh-peer.jsonl");
const record = value => fs.appendFileSync(receipt, JSON.stringify(value) + "\n");
const host = utils.generateKeyPairSync("ed25519");
const key = utils.generateKeyPairSync("ed25519", { passphrase: "qa-key-passphrase", cipher: "aes256-ctr" });
const keyPath = path.join(root, "mobile-encrypted-key");
fs.writeFileSync(keyPath, key.private, { mode: 0o600 });
const publicKey = utils.parseKey(key.public).getPublicSSH();
const clients = new Set();
const server = new Server({ hostKeys: [host.private] }, client => {
  clients.add(client);
  client.on("close", () => clients.delete(client));
  client.on("error", error => record({ event: "client-error", message: error.message }));
  client.on("authentication", ctx => {
    record({ event: "auth-attempt", username: ctx.username, method: ctx.method });
    if (ctx.username === "qa-phone-user" && ctx.method === "password" && ctx.password === "qa-temp-secret") return ctx.accept();
    if (ctx.username === "qa-key-user" && ctx.method === "publickey" && ctx.key.data.equals(publicKey)) {
      if (!ctx.signature || utils.parseKey(key.public).verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept();
    }
    if (ctx.username === "qa-otp-user" && ctx.method === "keyboard-interactive") {
      return ctx.prompt([{ prompt: "One-time code: ", echo: false }], "SSH OTP", "Disposable verification code", answers => {
        if (answers.length === 1 && answers[0] === "123456") ctx.accept(); else ctx.reject();
      });
    }
    ctx.reject(["password", "publickey", "keyboard-interactive"]);
  });
  client.on("ready", () => {
    record({ event: "authenticated" });
    client.on("session", accept => {
      const session = accept();
      session.on("pty", accept => accept());
      session.on("window-change", accept => accept?.());
      session.on("shell", accept => {
        const stream = accept();
        stream.write("\r\nQA_NATIVE_SSH_CONNECTED\r\n$ ");
        let pending = "";
        stream.on("data", data => {
          pending += data.toString("utf8");
          stream.write(data);
          if (pending.includes("QA_NATIVE_SSH_PING") && /[\r\n]/.test(pending.slice(pending.indexOf("QA_NATIVE_SSH_PING")))) {
            record({ event: "shell-input", marker: "QA_NATIVE_SSH_PING" });
            fs.writeFileSync(path.join(root, "mobile-ssh-input-marker.txt"), "QA_NATIVE_SSH_PING\n");
            stream.write("\r\nQA_NATIVE_SSH_PONG\r\n$ ");
            pending = "";
          }
          if (pending.length > 32768) pending = pending.slice(-16384);
        });
      });
    });
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port, keyPath }) + "\n"));
const close = () => { for (const client of clients) client.end(); server.close(() => process.exit(0)); };
process.on("SIGTERM", close); process.on("SIGINT", close);
