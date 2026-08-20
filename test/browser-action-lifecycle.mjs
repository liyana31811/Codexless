import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CodexBrowserExecutor } from "../src/codex-browser-executor.mjs";

const cwd = "/codexless-browser-lifecycle-fixture";
const tab = {
  providerTabId: "provider-a",
  title: "Fixture tab",
  url: "https://example.test/inbox",
  lastOpened: "2026-08-20T00:00:00.000Z",
};

const ok = (value) => ({ isError: false, text: JSON.stringify(value) });

class FakeWorkbench {
  generation = 1;
  uncertainClick = false;
  calls = [];

  async catalog({ kind }) {
    if (kind === "skills") {
      return { skills: [{ name: "chrome:control-chrome", path: "/fixture/chrome/skills/control-chrome/SKILL.md", enabled: true }] };
    }
    if (kind === "mcp") return { servers: [{ name: "node_repl", error: null, tools: [{ name: "js" }] }] };
    throw new Error(`unexpected catalog kind: ${kind}`);
  }

  async mcpCall(request) {
    this.calls.push(request);
    const title = request.arguments?.title;
    if (title === "Check connected browser backends") {
      return ok([{ name: "Chrome", family: "chrome", type: "extension" }]);
    }
    if (title === "List current Chrome tabs") return ok([tab]);
    if (title === "Prepare exact Chrome click") {
      return ok({
        title: tab.title,
        url: tab.url,
        count: 1,
        visible: true,
        enabled: true,
        resolvedKind: "role",
        resolvedRole: "button",
        resolvedClickBinding: null,
      });
    }
    if (title === "Execute prepared Chrome click") {
      if (this.uncertainClick) throw new Error("fixture transport lost after dispatch");
      return ok({ beforeUrl: tab.url, afterUrl: tab.url, afterTitle: tab.title, snapshot: "clicked" });
    }
    if (title === "Execute prepared Chrome new tab") {
      return ok({ requestedUrl: "https://example.test/new", afterUrl: "https://example.test/new", afterTitle: "New", snapshot: "opened" });
    }
    throw new Error(`unexpected Browser fixture call: ${title}`);
  }
}

function makeBrowser(workbench = new FakeWorkbench()) {
  return {
    workbench,
    browser: new CodexBrowserExecutor({ workbench, defaultCwd: cwd }),
  };
}

test("prepared refs are single-use and wrong-kind execution retains the original ref", async () => {
  const { workbench, browser } = makeBrowser();
  const listed = await browser.listTabs({ cwd });
  const prepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Send", cwd });

  await assert.rejects(
    () => browser.download({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => error?.code === "BROWSER_ACTION_REF_EXPIRED"
  );
  const clicked = await browser.click({ actionApprovalRef: prepared.actionApprovalRef });
  assert.equal(clicked.status, "clicked");
  assert.equal(workbench.calls.filter((call) => call.arguments?.title === "Execute prepared Chrome click").length, 1);
  await assert.rejects(
    () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => error?.code === "BROWSER_ACTION_REF_EXPIRED"
  );
  assert.equal(workbench.calls.filter((call) => call.arguments?.title === "Execute prepared Chrome click").length, 1);
});

test("transport uncertainty consumes the ref and never replays the mutation", async () => {
  const { workbench, browser } = makeBrowser();
  const listed = await browser.listTabs({ cwd });
  const prepared = await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Send", cwd });
  workbench.uncertainClick = true;

  await assert.rejects(
    () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => error?.code === "BROWSER_CLICK_RESULT_UNCERTAIN"
      && error?.nextActions?.[0]?.includes("Do not retry this click automatically")
  );
  assert.equal(workbench.calls.filter((call) => call.arguments?.title === "Execute prepared Chrome click").length, 1);
  await assert.rejects(
    () => browser.click({ actionApprovalRef: prepared.actionApprovalRef }),
    (error) => error?.code === "BROWSER_ACTION_REF_EXPIRED"
  );
});

test("prepared Node REPL programs retain exact fixture bytes", async () => {
  const { browser, workbench } = makeBrowser();
  const listed = await browser.listTabs({ cwd });
  await browser.prepareClick({ tabRef: listed.tabs[0].tabRef, role: "button", name: "Send", cwd });
  const fixture = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures", "browser-node-repl-programs-v1.json"), "utf8"));
  for (const [title, expected] of Object.entries(fixture)) {
    const call = workbench.calls.find((entry) => entry.arguments?.title === title);
    assert.ok(call, `fixture call ${title} must be captured`);
    const actual = createHash("sha256").update(call.arguments.code).digest("hex");
    assert.equal(actual, expected.sha256, `${title} generated program bytes drifted`);
  }
});

