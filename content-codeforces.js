// Reads Codeforces submission pages and sends accepted solutions to the background worker.

   console.log("CodePusher: codeforces script loaded", location.href);

const SUBMISSION_ROUTE_PATTERNS = [
  { pattern: /^\/contest\/(\d+)\/submission\/(\d+)\/?$/, kind: "contest" },
  { pattern: /^\/gym\/(\d+)\/submission\/(\d+)\/?$/, kind: "gym" },
  { pattern: /^\/problemset\/submission\/(\d+)\/(\d+)\/?$/, kind: "problemset" }
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
let problemsetProblemsPromise;
let lastCodeforcesRequestAt = 0;
let codeforcesRequestQueue = Promise.resolve();

let noticeElement;
let noticeTimer;

// Extracts the contest and submission IDs from supported Codeforces submission routes.
function getSubmissionRoute() {
  for (const routePattern of SUBMISSION_ROUTE_PATTERNS) {
    const match = window.location.pathname.match(routePattern.pattern);
    if (match) {
      return {
        contestId: match[1],
        submissionId: match[2],
        kind: routePattern.kind
      };
    }
  }
  return null;
}

// Serializes Codeforces requests and enforces a two-second gap between their starts.
function fetchCodeforces(url, options = {}) {
  const request = codeforcesRequestQueue.then(async () => {
    const elapsed = Date.now() - lastCodeforcesRequestAt;
    if (lastCodeforcesRequestAt && elapsed < 2000) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000 - elapsed));
    }
    const startedAt = Date.now();
    lastCodeforcesRequestAt = startedAt;
    const response = await fetch(url, options);
    if (!response.ok) {
      const error = new Error(`Codeforces request failed (${response.status}).`);
      error.status = response.status;
      error.stopSync = true;
      throw error;
    }
    if (response.headers?.get("content-type")?.includes("text/html")) {
      const pageText = await response.clone().text();
      if (/captcha|verify (?:that )?you are human|challenge-platform|cf-chl-/i.test(pageText)) {
        const error = new Error("Codeforces returned a captcha or challenge page.");
        error.status = 403;
        error.stopSync = true;
        throw error;
      }
    }
    return response;
  });
  codeforcesRequestQueue = request.then(() => undefined, () => undefined);
  return request;
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

// Creates a safe folder title slug from the Codeforces problem title.
function buildProblemSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Extracts a Codeforces problem index from its link or visible problem cell.
function getProblemIndex(problemText, problemHref) {
  let hrefPath = "";
  try {
    hrefPath = problemHref
      ? new URL(problemHref, window.location.origin).pathname
      : "";
  } catch {
    // Falls back to the visible problem text when the page link is malformed.
  }
  const linkIndex =
    hrefPath.match(/\/problem\/([A-Za-z0-9]+)\/?$/)?.[1] ||
    hrefPath.match(/\/problemset\/problem\/\d+\/([A-Za-z0-9]+)\/?$/)?.[1];
  const textIndex = problemText.trim().match(/^([A-Za-z0-9]+)(?:\s*[-.]\s*|$)/)?.[1];
  return (linkIndex || textIndex || "").toLowerCase();
}

// Reads source, problem, language, and verdict from the submission page using header indexes.
function readSubmissionDetails() {
  const submissionTable = findSubmissionTable();
  if (!submissionTable.table) {
    reportMissingPart(
      "A submission table with Problem, Lang, and Verdict headers",
      submissionTable.headersFound
    );
    return null;
  }

  const { rows, headerRow, problemIndex: problemColumnIndex, languageIndex, verdictIndex, headersFound } =
    submissionTable;
  const dataRow = rows[rows.indexOf(headerRow) + 1];
  if (!dataRow) {
    reportMissingPart("The first submission data row", headersFound);
    return null;
  }

  const problemCell = dataRow.cells[problemColumnIndex];
  if (!problemCell) {
    reportMissingPart("The Problem cell in the first submission data row", headersFound);
    return null;
  }
  const problemLink = problemCell.querySelector("a");
  const problemText = problemCell.textContent.trim();
  const problemIndex = getProblemIndex(
    problemText,
    problemLink?.getAttribute("href") || ""
  );
  if (!problemIndex) {
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

  return {
    language,
    problemIndex,
    verdictCell
  };
}

// Fetches the raw submission page and preserves source-code line boundaries.
async function fetchSubmissionCode(submissionUrl = window.location.href) {
  const response = await fetchCodeforces(submissionUrl, { credentials: "same-origin" });

  const rawHtml = await response.text();
  const parsed = new DOMParser().parseFromString(rawHtml, "text/html");
  let source = parsed.querySelector("pre#program-source-text");
  if (!source) {
    const labels = Array.from(parsed.querySelectorAll("*")).filter(
      (element) => element.textContent.trim() === "Source"
    );
    for (const label of labels) {
      let container = label.parentElement;
      while (container && container !== parsed.body && container !== parsed.documentElement) {
        source = container.querySelector("pre");
        if (source) {
          break;
        }
        container = container.parentElement;
      }
      if (source) {
        break;
      }
    }
  }
  if (!source) {
    throw new Error("Codeforces source code was not found in the raw submission page.");
  }

  const lines = Array.from(source.querySelectorAll("li"));
  let code = lines.length
    ? lines.map((line) => line.textContent).join("\n")
    : source.textContent;
  code = code.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").replace(/\n*$/, "\n");
  if (!code.trim()) {
    throw new Error("Codeforces returned empty submission source code.");
  }
  return code;
}

// Fetches Codeforces problem pages with same-origin credentials and parses their HTML.
async function fetchCodeforcesProblemPage(path) {
  const response = await fetchCodeforces(new URL(path, window.location.origin).href, {
    credentials: "same-origin"
  });
  if (!response.ok) {
    throw new Error(`Codeforces problem lookup failed (${response.status}).`);
  }
  return new DOMParser().parseFromString(await response.text(), "text/html");
}

// Loads the Codeforces problem ratings once per page for fallback lookups.
async function fetchProblemsetRatings() {
  if (!problemsetProblemsPromise) {
    problemsetProblemsPromise = fetchCodeforces("https://codeforces.com/api/problemset.problems")
      .then((response) => response.json())
      .then((result) => {
        if (result.status !== "OK" || !Array.isArray(result.result?.problems)) {
          throw new Error("Codeforces did not return problem ratings.");
        }
        return result.result.problems;
      });
  }
  return problemsetProblemsPromise;
}

// Reads the problem statement, limits, title, and rating from its Codeforces page.
async function fetchProblemMetadata(route, problemIndex, apiProblem = null) {
  const problemPath = route.kind === "problemset"
    ? `/problemset/problem/${route.contestId}/${problemIndex}`
    : `/${route.kind}/${route.contestId}/problem/${problemIndex}`;
  const parsed = await fetchCodeforcesProblemPage(problemPath);
  const statementElement = parsed.querySelector(".problem-statement");
  if (!statementElement) {
    throw new Error("Codeforces problem statement was not found.");
  }

  const titleElement = statementElement.querySelector(".header .title");
  const pageTitle = titleElement?.textContent.trim().replace(/^[A-Za-z0-9]+\.\s*/, "") || "";
  const rawTitle = apiProblem?.name
    ? apiProblem.name.trim().replace(/^[A-Za-z0-9]+\.\s*/, "")
    : pageTitle;
  if (!rawTitle) {
    throw new Error("Codeforces problem title was not found.");
  }
  const problemName = buildProblemSlug(rawTitle);
  if (!problemName) {
    throw new Error("Codeforces returned an invalid problem title.");
  }

  // Reads a displayed time or memory limit without carrying presentation markup into the README.
  const getLimit = (selector) => {
    const limit = statementElement.querySelector(`${selector} > div`) ||
      statementElement.querySelector(selector);
    return limit?.textContent.trim().replace(/\s+/g, " ") || "Not provided";
  };
  const statementCopy = statementElement.cloneNode(true);
  statementCopy.querySelector(".header")?.remove();
  let statement = CodePusherMarkdown.convertHtmlToMarkdown(
    statementCopy.outerHTML,
    "https://codeforces.com"
  );
  statement = statement.replace(/\$\$\$([\s\S]*?)\$\$\$/g, (_match, expression) => `$${expression}$`);

  let rating = Number.isFinite(apiProblem?.rating)
    ? String(apiProblem.rating)
    : statementElement.querySelector('span.tag-box[title="Difficulty"]')
      ?.textContent.trim().replace(/^\*/, "") || "";
  if (!rating) {
    const problems = await fetchProblemsetRatings();
    const match = problems.find((problem) =>
      problem.contestId === Number(route.contestId) &&
      problem.index.toLowerCase() === problemIndex.toLowerCase()
    );
    rating = match && Number.isFinite(match.rating) ? String(match.rating) : "Unrated";
  }

  return {
    title: rawTitle,
    problem: problemName,
    number: `${route.contestId}${problemIndex.toUpperCase()}`,
    rating,
    tags: Array.isArray(apiProblem?.tags)
      ? apiProblem.tags
      : Array.from(statementElement.querySelectorAll(".tag-box"))
        .map((tag) => tag.textContent.trim())
        .filter(Boolean),
    timeLimit: getLimit(".time-limit"),
    memoryLimit: getLimit(".memory-limit"),
    statement
  };
}

// Builds the canonical Codeforces problem URL for contest and problemset routes.
function getCodeforcesProblemUrl(route, problemIndex) {
  const path = route.kind === "problemset"
    ? `/problemset/problem/${route.contestId}/${problemIndex}`
    : `/${route.kind}/${route.contestId}/problem/${problemIndex}`;
  return new URL(path, "https://codeforces.com").href;
}

// Pushes one accepted Codeforces solution with its metadata and README.
async function pushCodeforcesSolution({
  id,
  route,
  problemIndex,
  language,
  apiProblem = null,
  submissionUrl = "",
  updateIndex = true
}) {
  const [code, metadata] = await Promise.all([
    fetchSubmissionCode(submissionUrl || window.location.href),
    fetchProblemMetadata(route, problemIndex, apiProblem)
  ]);
  const url = getCodeforcesProblemUrl(route, problemIndex);
  const safeTags = metadata.tags.map((tag) => String(tag).replace(/\|/g, "\\|"));
  const readme = [
    `# ${metadata.number}. ${metadata.title}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Platform | Codeforces |",
    `| Problem number | ${metadata.number} |`,
    `| Rating | ${metadata.rating === "Unrated" ? "Unrated" : `rating ${metadata.rating}`} |`,
    `| Time limit | ${metadata.timeLimit.replace(/\|/g, "\\|")} |`,
    `| Memory limit | ${metadata.memoryLimit.replace(/\|/g, "\\|")} |`,
    ...(safeTags.length ? [`| Tags | ${safeTags.join(", ")} |`] : []),
    `| Language | ${language} |`,
    `| Link | [${url}](${url}) |`,
    "",
    "## Problem",
    "",
    metadata.statement || "Problem statement not available.",
    ""
  ].join("\n");

  const response = await chrome.runtime.sendMessage({
    site: "codeforces",
    problem: metadata.problem,
    number: metadata.number,
    title: metadata.title,
    difficulty: "",
    rating: metadata.rating,
    url,
    readme,
    language,
    code
  });
  if (!response?.ok) {
    throw new Error(response?.error || "The background worker could not push the solution.");
  }
  const entry = response.entry;
  const indexError = updateIndex && entry
    ? await window.CodePusherSync.updateIndex([entry])
    : "";
  if (id) {
    processedSubmissionIds.add(String(id));
  }
  return {
    status: response.unchanged?.length === 2 ? "unchanged" : "pushed",
    entry,
    indexError
  };
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
    const route = getSubmissionRoute();
    const details = readSubmissionDetails();
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

    if (!route) {
      throw new Error("Could not identify the Codeforces problem route.");
    }
    const result = await pushCodeforcesSolution({
      id: submissionId,
      route,
      problemIndex: details.problemIndex,
      language: details.language,
      submissionUrl: window.location.href
    });

    processedSubmissionIds.add(submissionId);
    showNotice(result.indexError
      ? `Pushed to GitHub, but the solutions index failed: ${result.indexError}`
      : result.status === "unchanged" ? "Already up to date" : "Pushed to GitHub");
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

// Finds the signed-in Codeforces handle or asks the user to provide it.
function getCodeforcesHandle() {
  const profileLinks = document.querySelectorAll(
    "header a[href^='/profile/'], #header a[href^='/profile/'], .header a[href^='/profile/']"
  );
  const profileLink = Array.from(profileLinks).find((link) => {
    try {
      return new URL(link.getAttribute("href"), window.location.origin)
        .pathname.match(/^\/profile\/([^/]+)/);
    } catch {
      return false;
    }
  });
  if (profileLink) {
    return new URL(profileLink.getAttribute("href"), window.location.origin)
      .pathname.match(/^\/profile\/([^/]+)/)?.[1] || "";
  }

  return window.prompt("Codeforces handle:")?.trim() || "";
}

// Lists accepted non-gym Codeforces submissions with their API problem metadata.
async function listCodeforcesSubmissions() {
  const handle = getCodeforcesHandle();
  if (!handle) {
    throw new Error("A Codeforces handle is required to sync submissions.");
  }

  const endpoint = new URL("https://codeforces.com/api/user.status");
  endpoint.searchParams.set("handle", handle);
  const response = await fetchCodeforces(endpoint.href);
  const result = await response.json();
  if (result.status !== "OK" || !Array.isArray(result.result)) {
    const error = new Error(result.comment || "Codeforces could not list user submissions.");
    error.stopSync = true;
    throw error;
  }

  return result.result
    .filter((submission) =>
      submission.verdict === "OK" &&
      Number.isFinite(submission.contestId) &&
      submission.contestId < 100000 &&
      submission.problem?.index
    )
    .map((submission) => {
      const problemIndex = String(submission.problem.index);
      return {
        id: String(submission.id),
        slug: `${submission.contestId}${problemIndex.toLowerCase()}`,
        timestamp: Number(submission.creationTimeSeconds) || 0,
        contestId: String(submission.contestId),
        problemIndex,
        language: getLanguage(submission.programmingLanguage || ""),
        problem: {
          name: submission.problem.name,
          rating: submission.problem.rating,
          tags: submission.problem.tags
        }
      };
    });
}

// Pushes one API-listed Codeforces submission using provider metadata where available.
async function pushOneCodeforcesSubmission(item) {
  if (!item.language) {
    throw new Error("Unsupported Codeforces submission language.");
  }
  const route = {
    contestId: item.contestId,
    submissionId: item.id,
    kind: "contest"
  };
  const submissionUrl = new URL(
    `/contest/${item.contestId}/submission/${item.id}`,
    "https://codeforces.com"
  ).href;
  return pushCodeforcesSolution({
    id: item.id,
    route,
    problemIndex: item.problemIndex,
    language: item.language,
    apiProblem: item.problem,
    submissionUrl,
    updateIndex: false
  });
}

const CODEFORCES_SYNC_PROVIDER = {
  name: "Codeforces",
  listAcceptedSubmissions: listCodeforcesSubmissions,
  pushOne: pushOneCodeforcesSubmission,
  delayMs: 2500
};

// Accepts sync requests only from this extension's popup.
function handleCodeforcesSyncMessage(message, sender, sendResponse) {
  if (message?.type !== "syncAll") {
    return false;
  }
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Sync requests must come from CodePusher." });
    return false;
  }
  if (!window.CodePusherSync?.run) {
    sendResponse({ ok: false, error: "The sync runner is unavailable." });
    return false;
  }

  void window.CodePusherSync.run(CODEFORCES_SYNC_PROVIDER, message.limit);
  sendResponse({ ok: true });
  return false;
}

// Starts processing once the current URL is a supported Codeforces submission.
function startSubmissionProcessing() {
  const route = getSubmissionRoute();
  if (route) {
    void pushAcceptedSubmission(route.submissionId, route.contestId);
  }
}

startSubmissionProcessing();
chrome.runtime.onMessage.addListener(handleCodeforcesSyncMessage);
