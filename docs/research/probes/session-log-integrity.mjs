#!/usr/bin/env node
/**
 * Research probe: validate stored Session logs under one or more `DSH_HOME`
 * roots, independently of the Harness.
 *
 * The JSONL backend appends one Zstandard frame per durable batch, so a log is
 * a concatenation of frames carrying JSONL events. This probe decompresses
 * every frame it can find (candidate boundaries are located by the zstd magic
 * number), parses every line as JSON, and checks that each log's header `id`
 * matches its directory name. `zstdDecompressSync` stops at the first frame,
 * hence the per-frame loop.
 *
 * Usage:
 *   <node> session-log-integrity.mjs <dsh-home> [<dsh-home> ...]
 *
 * Exit status: 0 when every decodable line parses and every header matches its
 * directory; 1 otherwise. An undecodable frame candidate is reported as a
 * warning and does not fail the run: a magic number can also occur inside
 * compressed payload, and a genuinely torn final frame is exactly what the
 * backend repairs on the next write. Read the per-log line to judge.
 *
 * Output lines carry only session id prefixes, frame/event counts and event
 * type tallies; no message text.
 */

import { zstdDecompressSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Candidate frame starts: every magic-number occurrence. */
function frameOffsets(buffer) {
  const offsets = [];
  let at = buffer.indexOf(MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = buffer.indexOf(MAGIC, at + MAGIC.length);
  }
  return offsets;
}

/** Decode each candidate frame separately; keep failures identifiable. */
function decodeFrames(buffer) {
  const offsets = frameOffsets(buffer);
  return offsets.map((start, index) => {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      return { text: zstdDecompressSync(buffer.subarray(start, end)).toString('utf8') };
    } catch (error) {
      return { error: error.message, start, end };
    }
  });
}

/** One stored log: decoded lines and their event-type tally. */
function inspectLog(path, dirName) {
  const frames = decodeFrames(readFileSync(path));
  const decoded = frames.filter((frame) => frame.text !== undefined);
  const undecodable = frames.length - decoded.length;
  const lines = decoded.flatMap((frame) => frame.text.split('\n')).filter((line) => line.trim() !== '');
  const types = {};
  let parseErrors = 0;
  let headerId;
  for (const [index, line] of lines.entries()) {
    try {
      const event = JSON.parse(line);
      types[event.type] = (types[event.type] ?? 0) + 1;
      if (index === 0) headerId = event.id;
    } catch {
      parseErrors += 1;
    }
  }
  return { frames: frames.length, undecodable, lines: lines.length, types, parseErrors, headerId, idMatchesDir: headerId === dirName };
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: session-log-integrity.mjs <dsh-home> [<dsh-home> ...]');
  process.exit(2);
}

let logs = 0;
let frames = 0;
let events = 0;
let bad = 0;
for (const root of roots) {
  const sessionsRoot = join(root, 'sessions');
  let slugs;
  try {
    slugs = readdirSync(sessionsRoot);
  } catch {
    continue; // no sessions under this root
  }
  for (const slug of slugs) {
    for (const dirName of readdirSync(join(sessionsRoot, slug))) {
      const sessionDir = join(sessionsRoot, slug, dirName);
      for (const file of readdirSync(sessionDir).filter((name) => name.endsWith('.zstd'))) {
        const path = join(sessionDir, file);
        const result = inspectLog(path, dirName);
        logs += 1;
        frames += result.frames;
        events += result.lines;
        const failed = result.parseErrors > 0 || !result.idMatchesDir;
        if (failed) bad += 1;
        console.log(
          `${failed ? 'BAD ' : 'OK  '} ${dirName.slice(0, 20)} bytes=${statSync(path).size}` +
            ` frames=${result.frames} undecodable=${result.undecodable} events=${result.lines}` +
            ` parseErrors=${result.parseErrors} headerIdMatchesDir=${result.idMatchesDir}` +
            ` types=${JSON.stringify(result.types)}`,
        );
      }
    }
  }
}
console.log(`logs=${logs} frames=${frames} events=${events} bad=${bad}`);
process.exit(bad === 0 ? 0 : 1);
