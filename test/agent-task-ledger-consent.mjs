import assert from "node:assert/strict";
import { createAgentTaskLedger } from "../src/agent-task-ledger.mjs";

const quotaProvider = async () => ({
  status: "ok",
  observedAt: new Date().toISOString(),
  usage: { status: "ok" },
  rateLimits: { status: "ok", limits: [] },
});

const gate = createAgentTaskLedger({ mode: "always", quotaProvider });
const payload = {
  prompt: "consent hardening probe",
  cwd: "/tmp/project",
  model: null,
  permissionProfile: ":read-only",
};

const first = await gate.authorize({
  action: "start",
  requestId: "req-consent-hardening-1",
  payload,
});
assert.equal(first.authorized, false);
assert.equal(first.duplicate, false);
assert.equal(first.consent.status, "required");
assert.match(first.consent.consentRef, /^consent_/);
assert.match(first.consent.message, /does not authorize/i);

const replayWithoutApproval = await gate.authorize({
  action: "start",
  requestId: "req-consent-hardening-1",
  payload,
  consentRef: first.consent.consentRef,
});
assert.equal(replayWithoutApproval.authorized, false, "replaying a consentRef through prepare/authorize must never self-approve");
assert.equal(replayWithoutApproval.duplicate, true);
assert.equal(replayWithoutApproval.consent.consentRef, first.consent.consentRef);

assert.throws(
  () => gate.approveConsent({
    action: "start",
    requestId: "req-consent-hardening-1",
    payload,
    consentRef: "consent_wrong",
  }),
  /does not match/i,
);

const approved = gate.approveConsent({
  action: "start",
  requestId: "req-consent-hardening-1",
  payload,
  consentRef: first.consent.consentRef,
});
assert.equal(approved.authorized, true);
assert.equal(approved.duplicate, false);

const approvedAgain = gate.approveConsent({
  action: "start",
  requestId: "req-consent-hardening-1",
  payload,
  consentRef: first.consent.consentRef,
});
assert.equal(approvedAgain.authorized, true);
assert.equal(approvedAgain.duplicate, true);

const offGate = createAgentTaskLedger({ mode: "off" });
const off = await offGate.authorize({ action: "start", requestId: "req-off", payload });
assert.equal(off.authorized, true);
assert.equal(off.mode, "off");

console.log("agent task ledger consent hardening PASS");
