import { spawnSync } from "node:child_process";

const advisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const expiresAt = "2026-12-18T00:00:00Z";

const audit = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"], { encoding: "utf8" });
if (audit.stderr) process.stderr.write(audit.stderr);
if (audit.status === 0) {
  console.log("npm audit passed at the high severity threshold.");
  process.exit(0);
}

function onlyExceptedAdvisory(report) {
  if (report.auditReportVersion !== 2 || report.error || !report.vulnerabilities) return false;

  const findings = Object.values(report.vulnerabilities);
  const high = findings.filter((finding) => finding.severity === "high");
  const totals = report.metadata?.vulnerabilities;
  if (!high.length || totals?.high !== high.length || totals?.critical !== 0
      || findings.some((finding) => finding.severity === "critical")) return false;

  const knownAdvisory = (cause) => cause?.name === "picomatch" && cause.url === advisory && cause.severity === "high";
  const belowThreshold = (severity) => ["info", "low", "moderate"].includes(severity);
  const excepted = new Set();
  const isExcepted = (cause) => knownAdvisory(cause) || excepted.has(cause);
  const isBelowThreshold = (cause) =>
    belowThreshold(typeof cause === "string" ? report.vulnerabilities[cause]?.severity : cause?.severity);

  // npm represents transitive findings as package-name references in `via`.
  // Admit a dependent only once every high-severity cause is accounted for.
  for (let pass = 0; pass < high.length; pass++) {
    for (const finding of high) {
      if (Array.isArray(finding.via) && finding.via.some(isExcepted)
          && finding.via.every((cause) => isExcepted(cause) || isBelowThreshold(cause))) {
        excepted.add(finding.name);
      }
    }
  }

  return high.every((finding) => excepted.has(finding.name))
    && excepted.has("picomatch") && report.vulnerabilities.picomatch.via.some(knownAdvisory);
}

// Keep the audit output visible even when CI accepts this advisory.
if (audit.stdout) process.stdout.write(audit.stdout);
if (audit.error) console.error(audit.error.message);

if (audit.status === 1 && Date.now() < Date.parse(expiresAt)) {
  try {
    if (onlyExceptedAdvisory(JSON.parse(audit.stdout))) {
      console.warn(`Temporary npm audit exception for ${advisory} expires ${expiresAt}.`);
      process.exit(0);
    }
  } catch (error) {
    console.error("Could not read npm audit output:", error.message);
  }
}
process.exitCode = 1;
