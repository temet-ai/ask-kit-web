import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import find from "../scripts/find.mjs";
import { make } from "../web.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "web-watch-"));
try {
  fs.writeFileSync(path.join(tmp, "watch.md"), "# Watch\n\n## Roster\nOne patrol per shift.\n");
  fs.writeFileSync(path.join(tmp, "clacks.md"), "# Clacks\n\n## Roster\nTwo patrols per shift.\n");
  const web = make({ settings: { WORKDIR: tmp } });
  const single = await find({ web }, { url: "watch.md", words: "patrol" });
  assert.equal(single.matches, 1);
  const batch = await find({ web }, { urls: ["watch.md", "clacks.md", "watch.md"], words: "patrol" });
  assert.equal(batch.read.length, 2);
  assert.ok(batch.read.every((r) => r.matches === 1 && r.passages[0].under.endsWith("Roster")));
  assert.deepEqual(batch.notRead, []);

  let running = 0, peak = 0;
  const calls = [];
  const stub = { async find(url, words, options) {
    calls.push({ url, words, options });
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setImmediate(resolve));
    running--;
    if (url.endsWith("/2")) throw new Error("page unavailable");
    return { url, matches: 1, passages: [{ line: 3, under: "Roster", text: "One patrol" }] };
  } };
  const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
  const capped = await find({ web: stub }, { urls, words: "patrol", max: 99 });
  assert.equal(calls.length, 8);
  assert.equal(peak, 8);
  assert.ok(calls.every((c) => c.options.max === 8));
  assert.deepEqual(capped.notRead, urls.slice(8));
  assert.equal(capped.read[2].error, "page unavailable");
  assert.deepEqual(capped.read[2].passages, []);
  assert.equal(capped.read[3].matches, 1);
  for (const urls of [[], "https://example.com", [null], [""]]) await assert.rejects(find({ web: stub }, { urls, words: "patrol" }), /non-empty array/);
  console.log("ok: find compares bounded page batches and preserves per-page errors");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
