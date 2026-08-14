import { zstdDecompressSync } from "node:zlib";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = ".test/home/sessions/--C-Users-14023-Desktop-oh-my-opencode-cohub-dsh-port--";
for (const sid of readdirSync(root)) {
  const f = join(root, sid, "session.jsonl.zstd");
  const text = zstdDecompressSync(readFileSync(f)).toString("utf8");
  console.log(JSON.parse(text));
}
