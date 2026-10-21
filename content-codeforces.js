// Reads Codeforces submission pages and sends accepted solutions to the background worker.

   console.log("CodePusher: codeforces script loaded", location.href);

const SUBMISSION_ROUTE_PATTERNS = [
  /^\/contest\/(\d+)\/submission\/(\d+)\/?$/,
  /^\/gym\/(\d+)\/submission\/(\d+)\/?$/,
  /^\/problemset\/submission\/(\d+)\/(\d+)\/?$/
];
const MAX_VERDICT_WAIT_MS = 60000;
const PENDING_VERDICT_PATTERN = /\b(?:queue|queued|running|waiting)\b/i;
const LANGUAGE_PREFIXES = [
  ["gnu c++", "cpp"],
  ["c++", "cpp"],
  ["gnu c", "c"],
  ["python", "python3"],
  ["pypy", "python3"],
  ["javascript", "javascript"],
  ["node", "javascript"],
  ["java", "java"],
  ["kotlin", "kotlin"],
  ["rust", "rust"],
  ["go", "go"],
  ["c#", "csharp"],
  ["ruby", "ruby"],
  ["php", "php"],
  ["scala", "scala"],
  ["haskell", "haskell"],
  ["d", "d"]
];
const processedSubmissionIds = new Set();
const inFlightSubmissionIds = new Set();

let noticeElement;
let noticeTimer;

// Extracts the contest and submission IDs from supported Codeforces submission routes.
function getSubmissionRoute() {
  for (const pattern of SUBMISSION_ROUTE_PATTERNS) {
    const match = window.location.pathname.match(pattern);
    if (match) {
      return { contestId: match[1], submissionId: match[2] };
    }
  }
  return null;
}

// Displays a temporary status notice without inserting page content as HTML.
function showNotice(message, isError = false) {
  if (!noticeElement) {
    noticeElement = document.createElement("div");
    noticeElement.setAttribute("role", "status");
    noticeElement.setAttribute("aria-live", "polite");
    Object.assign(noticeElement.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "min(360px, calc(100vw - 32px))",
      padding: "9px 13px",
      borderRadius: "6px",
      color: "#ffffff",
      backgroundColor: "#262626",
      boxShadow: "0 2px 10px rgba(0, 0, 0, 0.2)",
      font: "14px/1.4 sans-serif",
      pointerEvents: "none"
    });
    document.documentElement.appendChild(noticeElement);
  }

  clearTimeout(noticeTimer);
  noticeElement.textContent = message;
  noticeElement.style.borderLeft = isError
    ? "4px solid #ef4444"
    : "4px solid #22c55e";
  noticeElement.hidden = false;
  // Hides the notice after the same five-second interval used by LeetCode.
  noticeTimer = window.setTimeout(() => {
    noticeElement.hidden = true;
    noticeElement.textContent = "";
  }, 5000);
}

// Logs missing page data with the table headers that were actually found.
function reportMissingPart(part, headersFound = []) {
  const headers = headersFound.length ? headersFound.join(", ") : "(none)";
  const message = `CodePusher: ${part} was not found. Headers found: ${headers}.`;
  console.log(message);
  showNotice(message, true);
}

// Finds the first table whose header row identifies the problem, language, and verdict columns.
function findSubmissionTable() {
  const headersFound = [];

  for (const table of document.querySelectorAll("table")) {
    const rows = Array.from(table.querySelectorAll("tr"));
    const headerRow = rows.find((row) => row.querySelector("th")) || rows[0];
    if (!headerRow) {
      continue;
    }

    const headers = Array.from(headerRow.cells, (cell) => cell.textContent.trim());
    headersFound.push(...headers.filter(Boolean));
    const normalizedHeaders = headers.map((header) =>
      header.replace(/:$/, "").trim().toLowerCase()
    );
    const problemIndex = normalizedHeaders.indexOf("problem");
    const languageIndex = normalizedHeaders.findIndex(
      (header) => header === "lang" || header === "language"
    );
    const verdictIndex = normalizedHeaders.indexOf("verdict");

    if (problemIndex >= 0 && languageIndex >= 0 && verdictIndex >= 0) {
      return {
        table,
        rows,
        headerRow,
        problemIndex,
        languageIndex,
        verdictIndex,
        headersFound
      };
    }
  }

  return { table: null, headersFound };
}

// Maps a Codeforces language label prefix to the background worker's language key.
function getLanguage(languageText) {
  const normalized = languageText.trim().toLowerCase();
  const match = LANGUAGE_PREFIXES.find(([prefix]) =>
    normalized.startsWith(prefix)
  );
  return match?.[1] || null;
}

// Builds a slug from the URL contest ID, problem index, and any usable displayed name.
function buildProblemSlug(contestId, problemText, problemHref) {
  const linkIndex = problemHref
    ? new URL(problemHref, window.location.origin).pathname.match(/\/([A-Za-z0-9]+)\/?$/)?.[1]
    : null;
  const textIndex = problemText.trim().match(/^([A-Za-z0-9]+)/)?.[1];
  const problemIndex = (linkIndex || textIndex || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!problemIndex) {
    return null;
  }

  const problemName = problemText.match(/\s+-\s+(.+)$/)?.[1] || "";
  const safeName = problemName.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${contestId}${problemIndex}${safeName ? `-${safeName}` : ""}`;
}

// Finds the first source-code pre element inside the page section labeled Source.
function findSourceBoxPre() {
  const labels = Array.from(document.querySelectorAll("*")).filter(
    (element) => element.textContent.trim() === "Source"
  );

  for (const label of labels) {
    let container = label.parentElement;
    while (container && container !== document.body && container !== document.documentElement) {
      const source = container.querySelector("pre");
      if (source) {
        return source;
      }
      container = container.parentElement;
    }
  }
  return null;
}

// Reads source, problem, language, and verdict from the submission page using header indexes.
function readSubmissionDetails(contestId) {
  const source = document.querySelector("pre#program-source-text") || findSourceBoxPre();
  const submissionTable = findSubmissionTable();
  if (!submissionTable.table) {
    reportMissingPart(
      "A submission table with Problem, Lang, and Verdict headers",
      submissionTable.headersFound
    );
    return null;
  }

  const { rows, headerRow, problemIndex, languageIndex, verdictIndex, headersFound } =
    submissionTable;
  const dataRow = rows[rows.indexOf(headerRow) + 1];
  if (!dataRow) {
    reportMissingPart("The first submission data row", headersFound);
    return null;
  }

  const problemCell = dataRow.cells[problemIndex];
  if (!problemCell) {
    reportMissingPart("The Problem cell in the first submission data row", headersFound);
    return null;
  }
  const problemLink = problemCell.querySelector("a");
  const problemText = problemCell.textContent.trim();
  const problem = buildProblemSlug(
    contestId,
    problemText,
    problemLink?.getAttribute("href") || ""
  );
  if (!problem) {
    reportMissingPart("A problem index in the Problem cell", headersFound);
    return null;
  }

  const languageCell = dataRow.cells[languageIndex];
  if (!languageCell) {
    reportMissingPart("The Lang cell in the first submission data row", headersFound);
    return null;
  }
  const languageText = languageCell.textContent.trim();
  const language = getLanguage(languageText);
  if (!language) {
    reportMissingPart(`A supported language in the Lang cell (${languageText || "empty"})`, headersFound);
    return null;
  }

  const verdictCell = dataRow.cells[verdictIndex];
  if (!verdictCell) {
    reportMissingPart("The Verdict cell in the first submission data row", headersFound);
    return null;
  }

  if (!source) {
    reportMissingPart("The source code element", headersFound);
    return null;
  }
  if (!source.textContent.length) {
    reportMissingPart("Text in the source code element", headersFound);
    return null;
  }

  return { code: source.textContent, language, problem, verdictCell };
}

// Waits for a queued or running submission verdict to become final, up to one minute.
function waitForFinalVerdict(verdictCell) {
  return new Promise((resolve) => {
    let settled = false;
    // Cleans up all watchers once the verdict is final or the timeout expires.
    const finish = (verdict) => {
      if (settled) {
        return;
      }
      settled = true;
      observer.disconnect();
      window.clearInterval(checkTimer);
      window.clearTimeout(timeoutTimer);
      resolve(verdict);
    };

    // Resolves immediately on a final verdict and runs again for observed mutations.
    const checkVerdict = () => {
      const verdict = verdictCell.textContent.trim();
      if (verdict && !PENDING_VERDICT_PATTERN.test(verdict)) {
        finish(verdict);
      }
    };
    const observer = new MutationObserver(checkVerdict);
    observer.observe(verdictCell, {
      childList: true,
      characterData: true,
      subtree: true
    });
    // Polls once per second in case the page updates without a detectable mutation.
    const checkTimer = window.setInterval(checkVerdict, 1000);
    // Bounds the verdict wait so a stuck judging page cannot block indefinitely.
    const timeoutTimer = window.setTimeout(
      () => finish(null),
      MAX_VERDICT_WAIT_MS
    );
    checkVerdict();
  });
}

// Detects an extension reload so the user can refresh the current page.
function isExtensionContextInvalidated(error) {
  return /extension context invalidated/i.test(error?.message || "");
}

// Sends one accepted solution and marks its ID only after the worker confirms success.
async function pushAcceptedSubmission(submissionId, contestId) {
  if (
    processedSubmissionIds.has(submissionId) ||
    inFlightSubmissionIds.has(submissionId)
  ) {
    return;
  }

  inFlightSubmissionIds.add(submissionId);
  try {
    const details = readSubmissionDetails(contestId);
    if (!details) {
      return;
    }

    let verdict = details.verdictCell.textContent.trim();
    if (PENDING_VERDICT_PATTERN.test(verdict)) {
      verdict = await waitForFinalVerdict(details.verdictCell);
    }
    if (!verdict) {
      showNotice("Codeforces is still processing this submission; nothing was pushed.", true);
      return;
    }
    if (!verdict.startsWith("Accepted")) {
      showNotice(`Not accepted (${verdict}); nothing was pushed.`, true);
      return;
    }

    const response = await chrome.runtime.sendMessage({
      site: "codeforces",
      problem: details.problem,
      language: details.language,
      code: details.code
    });
    if (!response?.ok) {
      throw new Error(response?.error || "The background worker could not push the solution.");
    }

    processedSubmissionIds.add(submissionId);
    showNotice(response.message || "Pushed to GitHub");
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      showNotice("Extension reloaded. Refresh this page.", true);
    } else {
      showNotice(error.message || "Could not push the solution to GitHub.", true);
    }
  } finally {
    inFlightSubmissionIds.delete(submissionId);
  }
}

// Starts processing once the current URL is a supported Codeforces submission.
function startSubmissionProcessing() {
  const route = getSubmissionRoute();
  if (route) {
    void pushAcceptedSubmission(route.submissionId, route.contestId);
  }
}

startSubmissionProcessing();
