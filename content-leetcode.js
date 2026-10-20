// Detects LeetCode submission routes and sends accepted code to the background worker.

const SUBMISSION_ROUTE_PATTERNS = [
  /^\/problems\/([^/]+)\/submissions\/(\d+)\/?$/,
  /^\/(?:problems\/([^/]+)\/)?submissions\/detail\/(\d+)\/?$/
];
const MAX_LOOKUP_ATTEMPTS = 10;
const LOOKUP_RETRY_DELAY_MS = 1500;
const processedSubmissionIds = new Set();
const inFlightSubmissionIds = new Set();
const LANGUAGE_INFO = {
  bash: { language: "bash", extension: "sh" },
  c: { language: "c", extension: "c" },
  "c++": { language: "c++", extension: "cpp" },
  cpp: { language: "c++", extension: "cpp" },
  csharp: { language: "csharp", extension: "cs" },
  dart: { language: "dart", extension: "dart" },
  elixir: { language: "elixir", extension: "ex" },
  erlang: { language: "erlang", extension: "erl" },
  go: { language: "go", extension: "go" },
  golang: { language: "go", extension: "go" },
  java: { language: "java", extension: "java" },
  javascript: { language: "javascript", extension: "js" },
  kotlin: { language: "kotlin", extension: "kt" },
  mysql: { language: "mysql", extension: "sql" },
  php: { language: "php", extension: "php" },
  python: { language: "python", extension: "py" },
  python3: { language: "python3", extension: "py" },
  racket: { language: "racket", extension: "rkt" },
  ruby: { language: "ruby", extension: "rb" },
  rust: { language: "rust", extension: "rs" },
  scala: { language: "scala", extension: "scala" },
  swift: { language: "swift", extension: "swift" },
  typescript: { language: "typescript", extension: "ts" }
};
const TERMINAL_NON_ACCEPTED_STATUSES = new Set([
  11, 12, 13, 14, 15, 16, 20, 21, 22, 30
]);
const SUBMISSION_QUERY = `
  query submissionDetails($submissionId: Int!) {
    submissionDetails(submissionId: $submissionId) {
      statusCode
      code
      lang {
        name
        verboseName
      }
      question {
        titleSlug
      }
    }
  }
`;

let noticeElement;
let noticeTimer;
let lastCheckedUrl = "";
let routeCheckTimer;

// Extracts a LeetCode submission ID and optional slug from either supported route.
function getSubmissionRoute() {
  if (window.location.hostname !== "leetcode.com") {
    return null;
  }

  for (const pattern of SUBMISSION_ROUTE_PATTERNS) {
    const match = window.location.pathname.match(pattern);
    if (match) {
      return { problemFromUrl: match[1] || null, submissionId: match[2] };
    }
  }

  return null;
}

// Shows a brief, non-interactive status notice using text only.
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
  noticeTimer = window.setTimeout(() => {
    noticeElement.hidden = true;
    noticeElement.textContent = "";
  }, 5000);
}

// Reads LeetCode's CSRF cookie without accessing or exposing extension credentials.
function getCsrfToken() {
  const cookie = document.cookie
    .split("; ")
    .find((item) => item.startsWith("csrftoken="));

  if (!cookie) {
    throw new Error("LeetCode's CSRF cookie is unavailable. Sign in and try again.");
  }

  const value = cookie.slice("csrftoken=".length);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Waits between submission lookups while LeetCode is still judging.
function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

// Loads the requested submission through LeetCode GraphQL using the active session.
async function fetchSubmission(submissionId) {
  const response = await fetch("/graphql/", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "x-csrftoken": getCsrfToken()
    },
    body: JSON.stringify({
      query: SUBMISSION_QUERY,
      variables: { submissionId: Number(submissionId) }
    })
  });

  if (!response.ok) {
    throw new Error(`LeetCode submission lookup failed (${response.status}).`);
  }

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(
      result.errors[0].message || "LeetCode could not return the submission."
    );
  }

  return result.data?.submissionDetails || null;
}

// Retries pending lookups and returns once the submission reaches a terminal status.
async function fetchCompletedSubmission(submissionId) {
  for (let attempt = 1; attempt <= MAX_LOOKUP_ATTEMPTS; attempt += 1) {
        const submission = await fetchSubmission(submissionId);
    if (submission && typeof submission.statusCode === "number") {
      if (
        submission.statusCode === 10 ||
        TERMINAL_NON_ACCEPTED_STATUSES.has(submission.statusCode)
      ) {
        return submission;
      }
    }
    if (attempt < MAX_LOOKUP_ATTEMPTS) {
      await wait(LOOKUP_RETRY_DELAY_MS);
    }
  }

  throw new Error("LeetCode is still processing this submission. Try again shortly.");
}

// Resolves a LeetCode language name to the worker's accepted name and file extension.
function getLanguageInfo(languageName) {
  if (typeof languageName !== "string") {
    return null;
  }
  return LANGUAGE_INFO[languageName.trim().toLowerCase()] || null;
}

// Identifies extension reload errors so the page can instruct the user to refresh.
function isExtensionContextInvalidated(error) {
  return /extension context invalidated/i.test(error?.message || "");
}

// Fetches, validates, and pushes one submission without marking failures as processed.
async function pushAcceptedSubmission(submissionId) {
  if (
    processedSubmissionIds.has(submissionId) ||
    inFlightSubmissionIds.has(submissionId)
  ) {
    return;
  }

  inFlightSubmissionIds.add(submissionId);
  try {
    const submission = await fetchCompletedSubmission(submissionId);
    if (submission.statusCode !== 10) {
      console.log("CodePusher: statusCode =", submission.statusCode);
      showNotice(`Not accepted (statusCode ${submission.statusCode}); nothing was pushed.`, true);
      return;
    }

    const problem = submission.question?.titleSlug;
    if (typeof problem !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(problem)) {
      throw new Error("LeetCode did not return a valid problem slug.");
    }
    if (typeof submission.code !== "string" || !submission.code.length) {
      throw new Error("LeetCode did not return the submission code.");
    }

    const languageName =
      submission.lang?.name || submission.lang?.verboseName || "";
    const languageInfo = getLanguageInfo(languageName);
    if (!languageInfo) {
      throw new Error(`Unsupported LeetCode language: ${languageName || "unknown"}.`);
    }

    const response = await chrome.runtime.sendMessage({
      site: "leetcode",
      problem,
      language: languageInfo.language,
      code: submission.code
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

// Checks the current URL and starts a push only when it enters a new submission route.
function checkSubmissionRoute() {
  const currentUrl = window.location.href;
  if (currentUrl === lastCheckedUrl) {
    return;
  }
  lastCheckedUrl = currentUrl;

  const route = getSubmissionRoute();
  if (route) {
    void pushAcceptedSubmission(route.submissionId);
  }
}

// Schedules a URL check to coalesce history events with the periodic SPA check.
function scheduleRouteCheck() {
  clearTimeout(routeCheckTimer);
  routeCheckTimer = window.setTimeout(checkSubmissionRoute, 0);
}

// Wraps a History API method so SPA navigation triggers an immediate URL check.
function wrapHistoryMethod(methodName) {
  const originalMethod = window.history[methodName];
  if (typeof originalMethod !== "function") {
    return;
  }

  window.history[methodName] = function codePusherHistoryMethod(...args) {
    const result = originalMethod.apply(this, args);
    scheduleRouteCheck();
    return result;
  };
}

// Listens for history navigation and polls once per second as a reliable fallback.
function startRouteDetection() {
  window.addEventListener("popstate", scheduleRouteCheck);
  window.addEventListener("hashchange", scheduleRouteCheck);
  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");
  window.setInterval(checkSubmissionRoute, 1000);
  checkSubmissionRoute();
}

startRouteDetection();
