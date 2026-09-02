#!/usr/bin/env node
/** Run the focused upstream session importer without exposing Doctor's raw report. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDoctorIssue(value) {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string"
  );
}

function parseTarget(value) {
  if (
    !isRecord(value) ||
    typeof value.agentId !== "string" ||
    value.agentId.length === 0 ||
    !Array.isArray(value.issues) ||
    !value.issues.every(isDoctorIssue) ||
    !isNonnegativeSafeInteger(value.legacyEntries) ||
    !isNonnegativeSafeInteger(value.importedEntries) ||
    !isNonnegativeSafeInteger(value.importedTranscriptEvents)
  ) {
    return undefined;
  }

  return {
    importedEntries: value.importedEntries,
    importedTranscriptEvents: value.importedTranscriptEvents,
    issueCount: value.issues.length,
    legacyEntries: value.legacyEntries,
  };
}

function parseDoctorReport(stdout, expectedMode) {
  let report;
  try {
    report = JSON.parse(utf8Decoder.decode(stdout));
  } catch {
    return { kind: "malformed" };
  }

  if (
    !isRecord(report) ||
    report.mode !== expectedMode ||
    !Array.isArray(report.targets) ||
    !isRecord(report.totals)
  ) {
    return { kind: "malformed" };
  }

  const targets = [];
  for (const target of report.targets) {
    const parsedTarget = parseTarget(target);
    if (!parsedTarget) {
      return { kind: "malformed" };
    }
    targets.push(parsedTarget);
  }

  const totals = report.totals;
  if (
    !isNonnegativeSafeInteger(totals.targets) ||
    !isNonnegativeSafeInteger(totals.issues) ||
    !isNonnegativeSafeInteger(totals.legacyEntries) ||
    !isNonnegativeSafeInteger(totals.importedEntries) ||
    !isNonnegativeSafeInteger(totals.importedTranscriptEvents)
  ) {
    return { kind: "malformed" };
  }

  const summed = targets.reduce(
    (result, target) => ({
      importedEntries: result.importedEntries + target.importedEntries,
      importedTranscriptEvents: result.importedTranscriptEvents + target.importedTranscriptEvents,
      issues: result.issues + target.issueCount,
      legacyEntries: result.legacyEntries + target.legacyEntries,
    }),
    { importedEntries: 0, importedTranscriptEvents: 0, issues: 0, legacyEntries: 0 },
  );

  if (
    totals.targets !== targets.length ||
    totals.issues !== summed.issues ||
    totals.legacyEntries !== summed.legacyEntries ||
    totals.importedEntries !== summed.importedEntries ||
    totals.importedTranscriptEvents !== summed.importedTranscriptEvents
  ) {
    return { kind: "counts" };
  }

  return {
    kind: "ok",
    totals: {
      importedEntries: totals.importedEntries,
      importedTranscriptEvents: totals.importedTranscriptEvents,
      issues: totals.issues,
      legacyEntries: totals.legacyEntries,
      targets: totals.targets,
    },
  };
}

function childStatus(exitCode, signal) {
  if (Number.isSafeInteger(exitCode) && exitCode >= 0) {
    return String(exitCode);
  }
  if (typeof signal === "string" && signal.length > 0) {
    return `signal-${signal}`;
  }
  return "unknown";
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    child.once("error", () => {
      finish({ kind: "spawn", status: "spawn" });
    });
    child.once("close", (exitCode, signal) => {
      finish({ kind: "closed", status: childStatus(exitCode, signal) });
    });
  });
}

async function runDoctor(mode) {
  let reportDirectory;
  let reportFileDescriptor;
  let reportFilePath;
  try {
    reportDirectory = fs.mkdtempSync("/tmp/openclaw-session-migration-");
    fs.chmodSync(reportDirectory, 0o700);
    reportFilePath = path.join(reportDirectory, "doctor-report.json");
    reportFileDescriptor = fs.openSync(reportFilePath, "wx", 0o600);
    fs.chmodSync(reportFilePath, 0o600);

    let child;
    try {
      child = spawn(
        "node",
        [
          "/app/dist/index.js",
          "doctor",
          "--session-sqlite",
          mode,
          "--session-sqlite-all-agents",
          "--json",
        ],
        { shell: false, stdio: ["ignore", reportFileDescriptor, "ignore"] },
      );
    } catch {
      return { kind: "spawn", status: "spawn" };
    }

    const execution = await waitForChild(child);
    fs.closeSync(reportFileDescriptor);
    reportFileDescriptor = undefined;
    if (execution.kind === "spawn") {
      return execution;
    }
    if (execution.status !== "0") {
      return { kind: "complete", status: execution.status };
    }

    const reportStats = fs.statSync(reportFilePath);
    if (!reportStats.isFile() || reportStats.size > MAX_REPORT_BYTES) {
      return { kind: "report-limit", status: execution.status };
    }
    return {
      kind: "complete",
      status: execution.status,
      stdout: fs.readFileSync(reportFilePath),
    };
  } catch {
    return { kind: "report-file", status: "helper" };
  } finally {
    if (typeof reportFileDescriptor === "number") {
      try {
        fs.closeSync(reportFileDescriptor);
      } catch {
        // Nothing safe to report here; the status remains bounded.
      }
    }
    if (reportFilePath) {
      try {
        fs.unlinkSync(reportFilePath);
      } catch {
        // The private directory remains inaccessible to other users.
      }
    }
    if (reportDirectory) {
      try {
        fs.rmdirSync(reportDirectory);
      } catch {
        // Never widen cleanup beyond this helper-owned directory.
      }
    }
  }
}

function emitFailure(code, status) {
  process.stdout.write(`session-migration: failed code=${code} status=${status}\n`);
  process.exitCode = 1;
}

function requireReport(execution, phase) {
  if (execution.kind === "spawn") {
    emitFailure(`${phase}-spawn`, execution.status);
    return undefined;
  }
  if (execution.kind === "report-file") {
    emitFailure(`${phase}-report-file`, execution.status);
    return undefined;
  }
  if (execution.kind === "report-limit") {
    emitFailure(`${phase}-output-limit`, execution.status);
    return undefined;
  }
  if (execution.status !== "0") {
    emitFailure(`${phase}-child`, execution.status);
    return undefined;
  }

  const report = parseDoctorReport(execution.stdout, phase === "import" ? "import" : "dry-run");
  if (report.kind === "malformed") {
    emitFailure(`${phase}-report`, execution.status);
    return undefined;
  }
  if (report.kind === "counts") {
    emitFailure(`${phase}-counts`, execution.status);
    return undefined;
  }
  return report;
}

async function main() {
  const preflightReport = requireReport(await runDoctor("dry-run"), "preflight");
  if (!preflightReport) {
    return;
  }
  if (preflightReport.totals.issues !== 0) {
    emitFailure("preflight-issues", "0");
    return;
  }

  if (preflightReport.totals.targets === 0 && preflightReport.totals.legacyEntries === 0) {
    process.stdout.write("session-migration: no-op\n");
    return;
  }
  if (preflightReport.totals.targets === 0 || preflightReport.totals.legacyEntries === 0) {
    emitFailure("preflight-zero-denominator", "0");
    return;
  }

  const importReport = requireReport(await runDoctor("import"), "import");
  if (!importReport) {
    return;
  }
  if (importReport.totals.issues !== 0) {
    emitFailure("import-issues", "0");
    return;
  }
  if (
    importReport.totals.targets !== preflightReport.totals.targets ||
    importReport.totals.legacyEntries !== preflightReport.totals.legacyEntries ||
    importReport.totals.importedEntries !== preflightReport.totals.legacyEntries
  ) {
    emitFailure("import-counts", "0");
    return;
  }

  const postflightReport = requireReport(await runDoctor("dry-run"), "postflight");
  if (!postflightReport) {
    return;
  }
  if (
    postflightReport.totals.targets !== 0 ||
    postflightReport.totals.legacyEntries !== 0 ||
    postflightReport.totals.issues !== 0 ||
    postflightReport.totals.importedEntries !== 0 ||
    postflightReport.totals.importedTranscriptEvents !== 0
  ) {
    emitFailure("postflight-remaining", "0");
    return;
  }

  process.stdout.write(
    `session-migration: applied targets=${importReport.totals.targets} entries=${importReport.totals.importedEntries} events=${importReport.totals.importedTranscriptEvents}\n`,
  );
}

main().catch(() => {
  emitFailure("internal", "helper");
});
