import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalHash } from './canonical-json.mjs';

const DIGEST = /^[0-9a-f]{64}$/u;

export class AuthorityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'AuthorityError';
    this.code = code;
  }
}

function fail(code) { throw new AuthorityError(code); }
function required(receipt, field, code, digest = false) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      typeof receipt[field] !== 'string' || receipt[field].length === 0 ||
      (digest && !DIGEST.test(receipt[field]))) fail(code);
}
function mismatch(actual, expected, code) { if (actual !== expected) fail(code); }

export function receiptDigest(receipt) { return canonicalHash(receipt); }

export function validateJudgeReceipt(receipt, expected) {
  required(receipt, 'runId', 'JUDGE_RECEIPT_RUN_ID_MISSING');
  required(receipt, 'nodeId', 'JUDGE_RECEIPT_NODE_ID_MISSING');
  required(receipt, 'acceptanceDigest', 'JUDGE_RECEIPT_ACCEPTANCE_DIGEST_MISSING', true);
  required(receipt, 'resultDigest', 'JUDGE_RECEIPT_RESULT_DIGEST_MISSING', true);
  required(receipt, 'judgeId', 'JUDGE_RECEIPT_JUDGE_ID_MISSING');
  required(receipt, 'nonce', 'JUDGE_RECEIPT_NONCE_MISSING');
  mismatch(receipt.runId, expected.runId, 'JUDGE_RECEIPT_RUN_ID_MISMATCH');
  mismatch(receipt.nodeId, expected.nodeId, 'JUDGE_RECEIPT_NODE_ID_MISMATCH');
  mismatch(receipt.acceptanceDigest, expected.acceptanceDigest, 'JUDGE_RECEIPT_ACCEPTANCE_DIGEST_MISMATCH');
  mismatch(receipt.resultDigest, expected.resultDigest, 'JUDGE_RECEIPT_RESULT_DIGEST_MISMATCH');
  if (expected.builderIds?.includes(receipt.judgeId)) fail('BUILDER_JUDGE_NOT_INDEPENDENT');
  if (!expected.judgeIds?.includes(receipt.judgeId)) fail('JUDGE_RECEIPT_JUDGE_ID_MISMATCH');
  mismatch(receipt.nonce, expected.nonce, 'JUDGE_RECEIPT_NONCE_MISMATCH');
  if (expected.consumedReceiptDigests?.has(receiptDigest(receipt)) || expected.consumedNonces?.has(receipt.nonce)) fail('RECEIPT_REPLAY');
  return Object.freeze({ ...receipt, receiptDigest: receiptDigest(receipt) });
}

export function validateHumanApproval(receipt, expected) {
  required(receipt, 'runId', 'HUMAN_APPROVAL_RUN_ID_MISSING');
  required(receipt, 'gateId', 'HUMAN_APPROVAL_GATE_ID_MISSING');
  required(receipt, 'actionDigest', 'HUMAN_APPROVAL_ACTION_DIGEST_MISSING', true);
  required(receipt, 'gateNonce', 'HUMAN_APPROVAL_GATE_NONCE_MISSING');
  mismatch(receipt.runId, expected.runId, 'HUMAN_APPROVAL_RUN_ID_MISMATCH');
  mismatch(receipt.gateId, expected.gateId, 'HUMAN_APPROVAL_GATE_ID_MISMATCH');
  mismatch(receipt.actionDigest, expected.actionDigest, 'HUMAN_APPROVAL_ACTION_DIGEST_MISMATCH');
  mismatch(receipt.gateNonce, expected.gateNonce, 'HUMAN_APPROVAL_GATE_NONCE_MISMATCH');
  if (expected.consumedReceiptDigests?.has(receiptDigest(receipt)) || expected.consumedNonces?.has(receipt.gateNonce)) fail('RECEIPT_REPLAY');
  return Object.freeze({ ...receipt, receiptDigest: receiptDigest(receipt) });
}

export async function withAuthorityLock(runDir, callback, timeoutMs = 10_000) {
  const lock = path.join(runDir, '.authority.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) fail('AUTHORITY_LOCK_TIMEOUT');
      await delay(10);
    }
  }
  try { return await callback(); } finally { fs.rmdirSync(lock); }
}

export function rejectCallerRole() { fail('CALLER_ROLE_AUTHORITY_FORBIDDEN'); }
export function rejectAuthentication() { fail('AUTHENTICATION_UNAVAILABLE'); }
