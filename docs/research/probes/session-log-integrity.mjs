#!/usr/bin/env node
/**
 * Research probe: validate stored Session logs under one or more `DSH_HOME`
 * roots, independently of the Harness.
 *
 * The JSONL backend appends one Zstandard frame per durable batch, so a log is
 * a concatenation of frames carrying JSONL events. This probe walks the frames
 * by their documented structure (RFC 8878 frame header plus block headers)
 * instead of scanning for frame magics: `zstdDecompressSync` returns partial
 * output for a truncated frame rather than throwing, and a magic number can
 * also occur inside compressed payload, so neither decoding success nor a
 * magic scan can tell a real frame boundary from an accidental one. Every
 * frame found is then decompressed and every line parsed as JSON, and each
 * log's header `id` must match its directory name.
 *
 * Usage:
 *   <node> session-log-integrity.mjs <dsh-home> [<dsh-home> ...]
 *
 * Exit status: 0 only when every log is structurally whole, decodes, parses,
 * and carries a header matching its directory, and every given root could be
 * examined; 1 when any log shows damage (missing magic, truncated
 * header/block/checksum, failing decompression), a JSON parse error, a
 * header/directory mismatch, or a root that is missing, not a directory or
 * unreadable. A root that exists but has no `sessions` directory is reported as
 * a note, not a failure.
 *
 * Output lines carry only session id prefixes, byte/frame/event counts, event
 * type tallies and structural damage messages; no message text.
 */

import { zstdDecompressSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Dictionary_ID_Field sizes indexed by the descriptor's two low bits. */
const DICTIONARY_ID_SIZES = [0, 1, 2, 4];
/** Frame_Content_Size field sizes for FCS_Field_Size 1..3 (0 depends on Single_Segment_Flag). */
const CONTENT_SIZE_SIZES = [2, 4, 8];

/**
 * Walk the concatenated Zstandard frames structurally.
 * @param buffer - the whole log file.
 * @returns `{ ranges }` with one `[start, end)` per frame, or `{ ranges, error }`
 *   when the byte stream stops being a sequence of whole frames.
 */
function frameRanges(buffer) {
  const ranges = [];
  let position = 0;
  // Messages name the frame being walked: a damaged block header can declare a
  // body far past EOF, so a raw offset alone would be misleading.
  const frame = () => `frame at offset ${position}`;
  while (position < buffer.length) {
    if (!buffer.subarray(position, position + MAGIC.length).equals(MAGIC)) {
      return { ranges, error: `missing frame magic at offset ${position}` };
    }
    let at = position + MAGIC.length;
    if (at >= buffer.length) return { ranges, error: `${frame()}: truncated frame header` };
    const descriptor = buffer[at];
    at += 1;
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const contentChecksum = (descriptor >> 2) & 1;
    if (!singleSegment) at += 1; // Window_Descriptor
    at += DICTIONARY_ID_SIZES[descriptor & 3];
    at += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : CONTENT_SIZE_SIZES[contentSizeFlag - 1];
    if (at > buffer.length) return { ranges, error: `${frame()}: truncated frame header` };
    for (;;) {
      if (at + 3 > buffer.length) return { ranges, error: `${frame()}: truncated block header` };
      const header = buffer.readUIntLE(at, 3);
      at += 3;
      const lastBlock = header & 1;
      const blockType = (header >> 1) & 3;
      const blockSize = header >> 3;
      if (blockType === 3) return { ranges, error: `${frame()}: reserved block type` };
      // Raw and Compressed blocks carry `blockSize` bytes; an RLE block carries one byte.
      at += blockType === 1 ? 1 : blockSize;
      if (at > buffer.length) return { ranges, error: `${frame()}: block body extends past end of file` };
      if (lastBlock === 1) break;
    }
    if (contentChecksum === 1) at += 4;
    if (at > buffer.length) return { ranges, error: `${frame()}: truncated frame checksum` };
    ranges.push({ start: position, end: at });
    position = at;
  }
  return { ranges };
}

/** One stored log: decoded lines, their event-type tally, and any damage. */
function inspectLog(path, dirName) {
  const buffer = readFileSync(path);
  const { ranges, error } = frameRanges(buffer);
  const texts = [];
  let damage = error;
  for (const range of ranges) {
    try {
      texts.push(zstdDecompressSync(buffer.subarray(range.start, range.end)).toString('utf8'));
    } catch (decodeError) {
      damage ??= `frame at offset ${range.start} failed to decompress: ${decodeError.message}`;
    }
  }
  const lines = texts.flatMap((text) => text.split('\n')).filter((line) => line.trim() !== '');
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
  return {
    frames: ranges.length,
    events: lines.length,
    types,
    parseErrors,
    headerId,
    idMatchesDir: headerId === dirName,
    damage,
  };
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
/** A root that cannot be examined must not look like a clean check. */
const failRoot = (root, reason) => {
  bad += 1;
  console.log(`BAD  root ${root}: ${reason}`);
};
for (const root of roots) {
  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (error) {
    failRoot(root, `not readable (${error.code ?? error.message})`);
    continue;
  }
  if (!rootStat.isDirectory()) {
    failRoot(root, 'not a directory');
    continue;
  }
  const sessionsRoot = join(root, 'sessions');
  let slugs;
  try {
    slugs = readdirSync(sessionsRoot);
  } catch (error) {
    // A home that exists without a sessions directory simply has nothing yet;
    // any other failure (typo, permissions) is an unverified root.
    if (error.code === 'ENOENT') console.log(`note root ${root}: no sessions directory, nothing to check`);
    else failRoot(root, `sessions directory not readable (${error.code ?? error.message})`);
    continue;
  }
  for (const slug of slugs) {
    let dirNames;
    try {
      dirNames = readdirSync(join(sessionsRoot, slug));
    } catch (error) {
      failRoot(root, `session slug ${slug} not readable (${error.code ?? error.message})`);
      continue;
    }
    for (const dirName of dirNames) {
      const sessionDir = join(sessionsRoot, slug, dirName);
      const logFiles = readdirSync(sessionDir).filter((name) => name.endsWith('.zstd'));
      if (logFiles.length === 0) {
        // A session directory without any committed generation log means the
        // log is gone (or was never written); silently skipping it would report
        // a clean check over missing data.
        bad += 1;
        console.log(`BAD  ${dirName.slice(0, 20)} dir=${sessionDir}: no session log (.zstd) in the session directory`);
        continue;
      }
      for (const file of logFiles) {
        const path = join(sessionDir, file);
        const result = inspectLog(path, dirName);
        logs += 1;
        frames += result.frames;
        events += result.events;
        const failed = result.damage !== undefined || result.parseErrors > 0 || !result.idMatchesDir;
        if (failed) bad += 1;
        console.log(
          `${failed ? 'BAD ' : 'OK  '} ${dirName.slice(0, 20)} bytes=${statSync(path).size}` +
            ` frames=${result.frames} events=${result.events} parseErrors=${result.parseErrors}` +
            ` headerIdMatchesDir=${result.idMatchesDir}` +
            `${result.damage === undefined ? '' : ` damage="${result.damage}"`}` +
            ` types=${JSON.stringify(result.types)}`,
        );
      }
    }
  }
}
console.log(`logs=${logs} frames=${frames} events=${events} bad=${bad}`);
process.exit(bad === 0 ? 0 : 1);
