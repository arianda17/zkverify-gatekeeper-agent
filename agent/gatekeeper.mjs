// Proof Gatekeeper decision logic + Groth16 proof generation.
// Circuit inputs (reverse-engineered by probing gatekeeper.wasm signal table):
//   decision, minimum, publicBalance, expiryBlock, currentBlock, recipient,
//   conditionRecipient, amount, maxTransfer, registeredVkHash, proofVkHash,
//   taskId, salt  (13 inputs; 13 public signals)
// Public signals order (from fullProve output):
//   [0]=commitment hash (circuit-derived, includes salt), [1]=registeredVkHash,
//   [2]=proofVkHash, [3]=minimum, [4]=publicBalance, [5]=expiryBlock,
//   [6]=currentBlock, [7]=recipient, [8]=conditionRecipient, [9]=amount,
//   [10]=maxTransfer, [11]=decision, [12]=taskId
import { groth16 } from 'snarkjs';
import { keccak256, toUtf8Bytes } from 'ethers';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIELD = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
const WASM = path.join(__dirname, '..', 'circuits', 'gatekeeper.wasm');
const ZKEY = path.join(__dirname, '..', 'circuits', 'gatekeeper_final.zkey');

export const VK_HASH_MODE = process.env.VK_HASH_MODE || 'modp'; // 'modp' | 'keccak' (raw vk bytes) | 'keccak-text' (utf8 of hex string)
export const TASK_ID_MODE = process.env.TASK_ID_MODE || 'keccak'; // 'keccak' | 'hex' | 'suffix' | 'keccak-uuid'

export function toField(hexOrBig) {
  const v = typeof hexOrBig === 'string'
    ? (hexOrBig.startsWith('0x') ? BigInt(hexOrBig) : BigInt(hexOrBig))
    : BigInt(hexOrBig);
  return (v % FIELD).toString();
}

export function vkToField(vkHex) {
  // 'keccak' = keccak256 of the RAW vk bytes (ethers/viem keccak256(hex) idiom).
  // This is the platform's expected encoding (signal names are *Hash; R03
  // proved modp fails: every round proof rejected, practice is crypto-only
  // and never validates encodings). 'keccak-text' = keccak256 of the
  // lowercase hex string as UTF-8 (previous keccak behaviour, kept as fallback).
  if (VK_HASH_MODE === 'keccak') {
    const hex = String(vkHex).toLowerCase().replace(/^0x/, '');
    return toField(keccak256('0x' + hex));
  }
  if (VK_HASH_MODE === 'keccak-text') return toField(keccak256(toUtf8Bytes(String(vkHex).toLowerCase())));
  return toField(vkHex);
}

export function taskIdToField(taskId) {
  if (TASK_ID_MODE === 'keccak-uuid') {
    // Strip the round/practice namespace prefix ("R04_", "practice_") and
    // keccak256 only the UUID part. R04 proved keccak256(full task_id) fails;
    // the platform's internal task identity is the bare UUID.
    const s = String(taskId);
    const i = s.indexOf('_');
    const uuid = i >= 0 ? s.slice(i + 1) : s;
    return toField(keccak256(toUtf8Bytes(uuid)));
  }
  if (TASK_ID_MODE === 'hex') {
    return toField('0x' + Buffer.from(taskId, 'utf8').toString('hex').slice(0, 62));
  }
  if (TASK_ID_MODE === 'suffix') {
    const m = String(taskId).match(/([0-9a-f]+)$/i);
    return toField('0x' + (m ? m[1] : '0'));
  }
  // default: keccak256(task_id) mod p
  return toField(keccak256(toUtf8Bytes(String(taskId))));
}

// Deterministic decision per the trap encyclopedia (build page).
// Returns { decision: 'APPROVE'|'REJECT', reason_code }.
export function decide(input) {
  const registeredVk = String(input.registered_vk || '').toLowerCase();
  const proofVk = String(input.proof_vk || '').toLowerCase();
  const minimum = BigInt(input.minimum);
  const publicBalance = BigInt(input.public_balance);
  const expiryBlock = BigInt(input.expiry_block);
  const currentBlock = BigInt(input.current_block);
  const recipient = String(input.recipient || '').toLowerCase();
  const conditionRecipient = String(input.condition_recipient || '').toLowerCase();
  const amount = BigInt(input.amount);
  const maxTransfer = BigInt(input.max_transfer);

  if (proofVk !== registeredVk) return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' };
  if (publicBalance < minimum) return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' };
  if (recipient !== conditionRecipient) return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' };
  if (currentBlock > expiryBlock) return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION' };
  if (amount > maxTransfer) return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW' };
  return { decision: 'APPROVE', reason_code: 'VALID_CONDITION' };
}

export function buildCircuitInput(task, decision01, salt) {
  const input = task.input;
  return {
    decision: String(decision01),
    minimum: String(BigInt(input.minimum)),
    publicBalance: String(BigInt(input.public_balance)),
    expiryBlock: String(BigInt(input.expiry_block)),
    currentBlock: String(BigInt(input.current_block)),
    recipient: toField(input.recipient),
    conditionRecipient: toField(input.condition_recipient),
    amount: String(BigInt(input.amount)),
    maxTransfer: String(BigInt(input.max_transfer)),
    registeredVkHash: vkToField(input.registered_vk),
    proofVkHash: vkToField(input.proof_vk),
    taskId: taskIdToField(task.task_id),
    salt: String(salt),
  };
}

export async function prove(task, decision01) {
  const salt = BigInt('0x' + crypto.randomBytes(16).toString('hex')).toString();
  const circuitInput = buildCircuitInput(task, decision01, salt);
  const { proof, publicSignals } = await groth16.fullProve(circuitInput, WASM, ZKEY);
  return { proof, publicSignals };
}
