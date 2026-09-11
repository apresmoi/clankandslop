#!/usr/bin/env node
// Fails when an agent's compiled Daimon instructions would not fit Daimon's
// public config limit, and when an agent Spawnfile is not a well-formed
// manifest.
//
// WHY THIS EXISTS
// ---------------
// Nothing in CI ever built the organization. `# The floor` — a preamble the
// briefs carried verbatim — grew across eight merges until caslon compiled to
// 17,125 bytes against a 16,384-byte ceiling, and the first thing that noticed
// was a deploy. The same window merged an unescaped `"` inside brass's
// double-quoted schedule prompt, which terminated the scalar early and made the
// manifest unparseable. Both are checkable from a bare checkout, so they are
// checked here rather than nowhere.
//
// WHAT IT CHECKS, AND HOW IT MATCHES THE COMPILER
// -----------------------------------------------
// Spawnfile 0.1.17 builds a Daimon agent's instructions in
// src/runtime/daimon/config.ts as
//
//   node.docs.map((d) => `# ${d.role}\n\n${d.content}`).join("\n\n").trim()
//
// and refuses the organization when that exceeds DAIMON_MAX_INSTRUCTION_BYTES
// (16,384 bytes) or DAIMON_MAX_INSTRUCTION_CODEPOINTS. `node.docs` is the
// `workspace.docs` map in the agent's Spawnfile, so every declared doc counts,
// not just AGENTS.md. The Daimon adapter also declares
// `systemInstructionSurface.placement: "append_pointer"`, which appends a
// team-context block of up to ~251 bytes, so the budget enforced here is the
// ceiling minus that allowance.
//
// This is a byte budget, not a compile. A real `spawnfile compile` additionally
// needs a pinned Daimon runtime image whose capability receipt attests the
// compiler's contract manifest — i.e. Docker and a registry — which a GitHub
// runner does not have. The instruction ceiling is the part that is a pure
// function of the tracked tree, and it is the part that broke.
//
// THE YAML SUBSET
// ---------------
// The repository has no YAML dependency and CI never installs the root
// package, so the manifests are parsed here by a deliberately small reader that
// covers exactly what these twelve manifests use: block mappings, block
// sequences (including compact `- key: value` items), flow mappings and
// sequences, comments, and single-line double-quoted and plain scalars. It is
// fail-closed: anything it does not recognise — a tab, a block scalar, an
// anchor, a quoted scalar that does not close on its own line, content trailing
// a closed scalar — is an error rather than a guess. A future manifest that
// legitimately needs one of those constructs should extend this reader; it must
// not be allowed to pass unparsed.
//
//   node agentic-org/scripts/check-instruction-budget.mjs
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const DAIMON_MAX_INSTRUCTION_BYTES = 16_384;
export const DAIMON_MAX_INSTRUCTION_CODEPOINTS = 16_384;
// `append_pointer` appends a team-context block to the system instructions.
export const DAIMON_APPEND_POINTER_ALLOWANCE = 251;
export const INSTRUCTION_BUDGET_BYTES = DAIMON_MAX_INSTRUCTION_BYTES - DAIMON_APPEND_POINTER_ALLOWANCE;

const orgRoot = path.resolve(import.meta.dirname, '..');

export class ManifestParseError extends Error {}

const fail = (line, message) => { throw new ManifestParseError(`line ${line}: ${message}`); };

/** Index of the first `#` that starts a comment, or -1. Quotes are respected. */
function commentIndex(text, line) {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '\\') { index += 1; continue; }
      if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === '#' && (index === 0 || /\s/u.test(text[index - 1]))) return index;
  }
  if (quoted) fail(line, 'double-quoted scalar is not closed on its own line');
  return -1;
}

/** Physical lines reduced to significant `{ indent, text, line }` records. */
function readLines(source) {
  const out = [];
  const raw = source.split('\n');
  for (let index = 0; index < raw.length; index += 1) {
    const line = index + 1;
    const text = raw[index];
    if (text.includes('\t')) fail(line, 'tab in indentation is not permitted');
    if (/^(---|\.\.\.)\s*$/u.test(text)) fail(line, 'document markers are not supported');
    const comment = commentIndex(text, line);
    const body = (comment < 0 ? text : text.slice(0, comment)).replace(/\s+$/u, '');
    if (body.trim() === '') continue;
    const indent = body.length - body.trimStart().length;
    if (indent % 2 !== 0) fail(line, `indent of ${indent} is not a multiple of two`);
    out.push({ indent, line, text: body.slice(indent) });
  }
  return out;
}

/** Splits `- key: value` items so a sequence item is always its own block. */
function expandCompactItems(lines) {
  const out = [];
  for (const entry of lines) {
    if (entry.text === '-') fail(entry.line, 'empty sequence item is not supported');
    if (!entry.text.startsWith('- ')) { out.push(entry); continue; }
    const rest = entry.text.slice(2);
    out.push({ indent: entry.indent, line: entry.line, text: '-' });
    out.push({ indent: entry.indent + 2, line: entry.line, text: rest });
  }
  return out;
}

const FLOW_TERMINATORS = new Set([',', '}', ']']);

/** YAML 1.2 core-schema resolution for a plain (unquoted) scalar. */
function resolvePlain(scalar) {
  if (/^(null|Null|NULL|~)$/u.test(scalar)) return null;
  if (/^(true|True|TRUE)$/u.test(scalar)) return true;
  if (/^(false|False|FALSE)$/u.test(scalar)) return false;
  if (/^[-+]?[0-9]+$/u.test(scalar)) return Number(scalar);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/u.test(scalar)) return Number(scalar);
  return scalar;
}

/** Reads one flow-context node starting at `start`; returns `[value, end]`. */
function readFlow(text, start, line) {
  let index = start;
  while (text[index] === ' ') index += 1;
  const character = text[index];
  if (character === '{' || character === '[') {
    const isMap = character === '{';
    const close = isMap ? '}' : ']';
    const collection = isMap ? {} : [];
    index += 1;
    for (;;) {
      while (text[index] === ' ') index += 1;
      if (index >= text.length) fail(line, 'unterminated flow collection');
      if (text[index] === close) return [collection, index + 1];
      if (isMap) {
        const colon = text.indexOf(': ', index);
        if (colon < 0) fail(line, 'flow mapping entry has no "key: value"');
        const key = text.slice(index, colon).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(key)) fail(line, `unsupported flow mapping key ${JSON.stringify(key)}`);
        if (key in collection) fail(line, `duplicate key ${key}`);
        const [value, end] = readFlow(text, colon + 2, line);
        collection[key] = value;
        index = end;
      } else {
        const [value, end] = readFlow(text, index, line);
        collection.push(value);
        index = end;
      }
      while (text[index] === ' ') index += 1;
      if (text[index] === ',') { index += 1; continue; }
      if (text[index] === close) return [collection, index + 1];
      fail(line, `expected "," or "${close}" in flow collection`);
    }
  }
  if (character === '"') {
    let value = '';
    index += 1;
    for (;;) {
      if (index >= text.length) fail(line, 'double-quoted scalar is not closed on its own line');
      const current = text[index];
      if (current === '\\') {
        const escaped = text[index + 1];
        if (escaped === undefined) fail(line, 'trailing escape in double-quoted scalar');
        value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
        index += 2;
        continue;
      }
      if (current === '"') return [value, index + 1];
      value += current;
      index += 1;
    }
  }
  if (character === "'" || character === '&' || character === '*' || character === '!' || character === '|' || character === '>') {
    fail(line, `unsupported YAML construct "${character}"`);
  }
  let end = index;
  while (end < text.length && !FLOW_TERMINATORS.has(text[end])) end += 1;
  const scalar = text.slice(index, end).replace(/\s+$/u, '');
  if (scalar === '') fail(line, 'empty scalar');
  return [resolvePlain(scalar), end];
}

/** Parses a value written on the same line as its key or sequence dash. */
function readInlineValue(text, line) {
  const [value, end] = readFlow(text, 0, line);
  const trailing = text.slice(end).trim();
  if (trailing !== '') {
    // Truncated: the commonest cause is an unescaped `"` inside a long
    // double-quoted schedule prompt, and the whole prompt is not a useful
    // error message.
    fail(line, `unexpected content after value: ${JSON.stringify(trailing.slice(0, 60))}${trailing.length > 60 ? '…' : ''}`);
  }
  return value;
}

const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*):(?: (.*))?$/u;

/** A block node, or a flow/quoted node written on one line at this indent. */
function parseNode(lines, cursor, indent) {
  const entry = lines[cursor.index];
  if (entry && entry.indent === indent && /^[{["]/u.test(entry.text)) {
    cursor.index += 1;
    return readInlineValue(entry.text, entry.line);
  }
  return parseBlock(lines, cursor, indent);
}

function parseBlock(lines, cursor, indent) {
  if (cursor.index >= lines.length || lines[cursor.index].indent !== indent) {
    fail(lines[cursor.index - 1]?.line ?? 1, 'expected an indented block');
  }
  if (lines[cursor.index].text === '-') {
    const items = [];
    while (cursor.index < lines.length && lines[cursor.index].indent === indent && lines[cursor.index].text === '-') {
      cursor.index += 1;
      items.push(parseNode(lines, cursor, indent + 2));
    }
    return items;
  }
  const map = {};
  while (cursor.index < lines.length && lines[cursor.index].indent === indent) {
    const entry = lines[cursor.index];
    if (entry.text === '-') fail(entry.line, 'sequence item inside a mapping at the same indent');
    const match = KEY.exec(entry.text);
    if (!match) fail(entry.line, `not a "key: value" mapping entry: ${JSON.stringify(entry.text)}`);
    const [, key, inline] = match;
    if (key in map) fail(entry.line, `duplicate key ${key}`);
    cursor.index += 1;
    if (inline === undefined) {
      const next = lines[cursor.index];
      if (!next || next.indent <= indent) fail(entry.line, `key ${key} has neither a value nor an indented block`);
      map[key] = parseNode(lines, cursor, next.indent);
    } else {
      map[key] = readInlineValue(inline, entry.line);
    }
  }
  if (cursor.index < lines.length && lines[cursor.index].indent > indent) {
    fail(lines[cursor.index].line, 'unexpected indentation');
  }
  return map;
}

/** Parses the YAML subset these manifests are written in. Fail-closed. */
export function parseManifest(source) {
  const lines = expandCompactItems(readLines(source));
  if (lines.length === 0) throw new ManifestParseError('manifest is empty');
  if (lines[0].indent !== 0) fail(lines[0].line, 'document does not start at indent zero');
  const cursor = { index: 0 };
  const value = parseNode(lines, cursor, 0);
  if (cursor.index !== lines.length) fail(lines[cursor.index].line, 'unparsed trailing content');
  return value;
}

export const listAgents = (root = orgRoot) =>
  readdirSync(path.join(root, 'agents'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

/**
 * The instructions Spawnfile would compile for one agent, byte-for-byte:
 * every declared `workspace.docs` entry, in Spawnfile's resolved role order.
 */
export function agentInstructions(agent, root = orgRoot) {
  const directory = path.join(root, 'agents', agent);
  const manifest = parseManifest(readFileSync(path.join(directory, 'Spawnfile'), 'utf8'));
  const docs = manifest.workspace?.docs;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs)) {
    throw new ManifestParseError(`agents/${agent}/Spawnfile declares no workspace.docs mapping`);
  }
  const roles = ['heartbeat', 'identity', 'memory', 'soul', 'system'];
  if (Object.keys(docs).some(role => !roles.includes(role) && role !== 'extras')) {
    throw new ManifestParseError(`agents/${agent}/Spawnfile declares an unsupported workspace.docs role`);
  }
  const resolved = [
    ...roles.filter(role => docs[role]).map(role => [role, docs[role]]),
    ...Object.entries(docs.extras ?? {}).map(([name, file]) => [`extras.${name}`, file])
  ];
  const rendered = resolved
    .map(([role, file]) => `# ${role}\n\n${readFileSync(path.join(directory, file), 'utf8')}`)
    .join('\n\n')
    .trim();
  return { docs, documentFiles: resolved.map(([, file]) => file), instructions: rendered };
}

/** Every way the twelve briefs would fail to compile, as plain sentences. */
export function instructionBudgetFindings(root = orgRoot) {
  const findings = [];
  const rows = [];
  for (const agent of listAgents(root)) {
    let resolved;
    try {
      resolved = agentInstructions(agent, root);
    } catch (error) {
      findings.push(`agents/${agent}/Spawnfile is not a usable manifest — ${error.message}`);
      continue;
    }
    const bytes = Buffer.byteLength(resolved.instructions, 'utf8');
    const codepoints = [...resolved.instructions].length;
    rows.push({ agent, bytes, codepoints, docs: resolved.documentFiles });
    if (bytes > INSTRUCTION_BUDGET_BYTES) {
      findings.push(`${agent} compiles to ${bytes} instruction bytes, ${bytes - INSTRUCTION_BUDGET_BYTES} over the ${INSTRUCTION_BUDGET_BYTES}-byte budget (${DAIMON_MAX_INSTRUCTION_BYTES} ceiling less ${DAIMON_APPEND_POINTER_ALLOWANCE} bytes of appended team context)`);
    }
    if (codepoints > DAIMON_MAX_INSTRUCTION_CODEPOINTS - DAIMON_APPEND_POINTER_ALLOWANCE) {
      findings.push(`${agent} compiles to ${codepoints} instruction codepoints, over the ${DAIMON_MAX_INSTRUCTION_CODEPOINTS} ceiling`);
    }
  }
  return { findings, rows };
}

function main() {
  const { findings, rows } = instructionBudgetFindings();
  for (const row of rows) {
    console.log(`${row.agent.padEnd(11)} ${String(row.bytes).padStart(6)} bytes  ${String(INSTRUCTION_BUDGET_BYTES - row.bytes).padStart(6)} headroom  ${row.docs.join(', ')}`);
  }
  if (findings.length > 0) {
    console.error(`\nDaimon instruction budget exceeded — ${findings.length} finding(s):\n`);
    for (const finding of findings) console.error(`  ✗ ${finding}`);
    console.error('\nShared prose belongs in a workspace document the agents read as a file — see');
    console.error('agentic-org/FLOOR.md and agents/caslon/PAGES.md — not copied into every brief.');
    process.exitCode = 1;
    return;
  }
  console.log(`\ninstruction budget OK — ${rows.length} agents, worst headroom ${Math.min(...rows.map((row) => INSTRUCTION_BUDGET_BYTES - row.bytes))} bytes.`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
