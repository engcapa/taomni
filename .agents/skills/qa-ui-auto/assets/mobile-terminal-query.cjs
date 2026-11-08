// Harmless raw TUI: query the cursor on resize, record actual PTY bytes on disk.
const fs = require("node:fs");
const target = process.argv[2];
const state = { ready: false, queries: [], replies: [], keys: [] };
const save = () => fs.writeFileSync(target, JSON.stringify(state));
const query = reason => {
  state.queries.push({ reason, cols: process.stdout.columns, rows: process.stdout.rows });
  save();
  process.stdout.write("\x1b[999;999H\x1b[6n");
};
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("A real PTY is required");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.on("resize", () => query("resize"));
let pending = "";
process.stdin.on("data", data => {
  pending += data.toString("utf8");
  // CPRs may cross read boundaries. Other input is just our q/d/z fixture keys.
  while (pending) {
    if (pending.startsWith("\x1b[")) {
      const reply = /^\x1b\[(\d+);(\d+)R/.exec(pending);
      if (!reply) break;
      state.replies.push({ rows: Number(reply[1]), cols: Number(reply[2]) });
      pending = pending.slice(reply[0].length);
    } else {
      const key = pending[0];
      pending = pending.slice(1);
      state.keys.push(key);
      if (key === "q") query("key");
      if (key === "z") {
        process.stdin.setRawMode(false);
        save();
        process.exit(0);
      }
    }
  }
  save();
});
state.ready = true;
save();
process.stdout.write("\r\nQA_QUERY_TUI_READY\r\n");
setTimeout(() => { process.stdin.setRawMode(false); process.exit(0); }, 90000);
