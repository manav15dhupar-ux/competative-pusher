// Detects LeetCode submission routes and sends accepted code to the background worker.

const SUBMISSION_ROUTE_PATTERNS = [
  /^\/problems\/([^/]+)\/submissions\/(\d+)\/?$/,
  /^\/(?:problems\/([^/]+)\/)?submissions\/detail\/(\d+)\/?$/
];
const MAX_LOOKUP_ATTEMPTS = 10;
const LOOKUP_RETRY_DELAY_MS = 1500;
const processedSubmissionIds = new Set();
const inFlightSubmissionIds = new Set();
const submissionEntries = new Map();
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
  11, 12, 13, 14, 15, 20, 21, 22, 30
]);
const SUBMISSION_QUERY = `
  query submissionDetails($submissionId: Int!) {
    submissionDetails(submissionId: $submissionId) {
      statusCode
      statusDisplay
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
const QUESTION_QUERY = `
  query questionDetails($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionFrontendId
      title
      difficulty
      content
      topicTags {
        name
      }
    }
  }
`;
const SUBMISSION_LIST_QUERY = `
  query submissionList($offset: Int!, $limit: Int!, $lastKey: String) {
    submissionList(offset: $offset, limit: $limit, lastKey: $lastKey) {
      lastKey
      hasNext
      submissions {
        id
        statusDisplay
        titleSlug
        timestamp
        lang
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

// Loads LeetCode problem metadata using the active session's CSRF-protected GraphQL request.
async function fetchQuestionMetadata(titleSlug) {
  const response = await fetch("/graphql/", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "x-csrftoken": getCsrfToken()
    },
    body: JSON.stringify({
      query: QUESTION_QUERY,
      variables: { titleSlug }
    })
  });

  if (!response.ok) {
    throw new Error(`LeetCode problem lookup failed (${response.status}).`);
  }

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(
      result.errors[0].message || "LeetCode could not return the problem details."
    );
  }
  return result.data?.question || null;
}

// Requests one page of LeetCode's GraphQL submission history.
async function fetchSubmissionListGraphQL(offset, lastKey) {
  const response = await fetch("/graphql/", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "x-csrftoken": getCsrfToken()
    },
    body: JSON.stringify({
      query: SUBMISSION_LIST_QUERY,
      variables: { offset, limit: 20, lastKey }
    })
  });
  if (!response.ok) {
    const error = new Error(`LeetCode submission list failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(result.errors[0].message || "LeetCode could not list submissions.");
  }
  const page = result.data?.submissionList;
  if (!page || !Array.isArray(page.submissions)) {
    throw new Error("LeetCode returned an invalid submission list.");
  }
  return page;
}

// Lists accepted LeetCode submissions with GraphQL and falls back to the submissions API.
async function listLeetCodeSubmissions() {
  try {
    const submissions = [];
    let offset = 0;
    let lastKey = null;
    while (true) {
      const page = await fetchSubmissionListGraphQL(offset, lastKey);
      submissions.push(...page.submissions);
      if (!page.hasNext) {
        break;
      }
      const nextLastKey = page.lastKey || null;
      if (nextLastKey === lastKey && page.submissions.length === 0) {
        throw new Error("LeetCode submission pagination did not advance.");
      }
      lastKey = nextLastKey;
      offset += 20;
    }
    console.log("CodePusher: LeetCode sync listing used GraphQL.");
    return submissions
      .filter((submission) => submission.statusDisplay === "Accepted")
      .map((submission) => ({
        id: String(submission.id),
        slug: submission.titleSlug,
        timestamp: Number(submission.timestamp) || 0
      }))
      .filter((item) => item.id && item.slug);
  } catch (graphqlError) {
    try {
      const submissions = [];
      let offset = 0;
      let lastKey = "";
      while (true) {
        const url = `/api/submissions/?offset=${offset}&limit=20&lastkey=${encodeURIComponent(lastKey)}`;
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) {
          const error = new Error(`LeetCode submissions API failed (${response.status}).`);
          error.status = response.status;
          throw error;
        }
        const page = await response.json();
        if (!Array.isArray(page.submissions)) {
          throw new Error("LeetCode submissions API returned an invalid response.");
        }
        submissions.push(...page.submissions);
        if (!page.has_next) {
          break;
        }
        const nextLastKey = page.last_key || page.lastKey || "";
        if (nextLastKey === lastKey && page.submissions.length === 0) {
          throw new Error("LeetCode API pagination did not advance.");
        }
        lastKey = nextLastKey;
        offset += 20;
      }
      console.log("CodePusher: LeetCode sync listing used the submissions API.");
      return submissions
        .filter((submission) =>
          submission.status_display === "Accepted" ||
          submission.statusDisplay === "Accepted"
        )
        .map((submission) => ({
          id: String(submission.id),
          slug: submission.title_slug || submission.titleSlug,
          timestamp: Number(submission.timestamp) || 0
        }))
        .filter((item) => item.id && item.slug);
    } catch (apiError) {
      console.log(
        "CodePusher: LeetCode sync listing failed.",
        graphqlError?.message || graphqlError,
        apiError?.message || apiError
      );
      const error = new Error(
        `Could not list LeetCode submissions using GraphQL or the submissions API. GraphQL: ${graphqlError?.message || "failed"}; API: ${apiError?.message || "failed"}`
      );
      error.status = graphqlError?.status === 429 || apiError?.status === 429 ? 429 : undefined;
      throw error;
    }
  }
}

// Retries pending lookups and returns once the submission reaches a terminal status.
async function fetchCompletedSubmission(submissionId) {
  for (let attempt = 1; attempt <= MAX_LOOKUP_ATTEMPTS; attempt += 1) {
    const submission = await fetchSubmission(submissionId);
    console.log(
      "CodePusher: status",
      submission?.statusCode,
      submission?.statusDisplay,
      "id",
      submissionId
    );
    if (
      submission &&
      (
        submission.statusDisplay === "Accepted" ||
        submission.statusCode === 10 ||
        (
          typeof submission.statusCode === "number" &&
          TERMINAL_NON_ACCEPTED_STATUSES.has(submission.statusCode)
        )
      )
    ) {
      return submission;
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
async function pushAcceptedSubmission(
  submissionId,
  { throwErrors = false, updateIndex = !throwErrors } = {}
) {
  if (processedSubmissionIds.has(submissionId)) {
    return { status: "unchanged", entry: submissionEntries.get(submissionId) };
  }
  if (inFlightSubmissionIds.has(submissionId)) {
    if (!throwErrors) {
      return { status: "unchanged", entry: submissionEntries.get(submissionId) };
    }
    while (inFlightSubmissionIds.has(submissionId)) {
      await wait(100);
    }
    if (processedSubmissionIds.has(submissionId)) {
      return { status: "unchanged", entry: submissionEntries.get(submissionId) };
    }
  }

  inFlightSubmissionIds.add(submissionId);
  try {
    const submission = await fetchCompletedSubmission(submissionId);
    if (
      submission.statusDisplay !== "Accepted" &&
      submission.statusCode !== 10
    ) {
      if (!throwErrors) {
        showNotice(
          `Not accepted: ${submission.statusDisplay || "Unknown"} (code ${submission.statusCode}); nothing was pushed.`,
          true
        );
      }
      return { status: "failed" };
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

    const question = await fetchQuestionMetadata(problem);
    const number = question?.questionFrontendId;
    const title = question?.title;
    const difficulty = question?.difficulty;
    if (
      (typeof number !== "string" && typeof number !== "number") ||
      !/^\d+$/.test(String(number)) ||
      typeof title !== "string" ||
      !title.trim() ||
      !["Easy", "Medium", "Hard"].includes(difficulty)
    ) {
      throw new Error("LeetCode did not return complete problem metadata.");
    }

    const statement = question.content
      ? CodePusherMarkdown.convertHtmlToMarkdown(question.content, "https://leetcode.com")
      : "Problem statement not available.";
    const url = `https://leetcode.com/problems/${problem}/`;
    const readme = [
      `# ${number}. ${title.trim()}`,
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Platform | LeetCode |",
      `| Problem number | ${number} |`,
      `| Difficulty | ${difficulty} |`,
      `| Language | ${languageInfo.language} |`,
      `| Link | [${url}](${url}) |`,
      "",
      "## Problem",
      "",
      statement,
      ""
    ].join("\n");

    const response = await chrome.runtime.sendMessage({
      site: "leetcode",
      problem,
      number: String(number),
      title: title.trim(),
      difficulty,
      rating: "",
      url,
      readme,
      language: languageInfo.language,
      code: submission.code
    });
    if (!response?.ok) {
      throw new Error(response?.error || "The background worker could not push the solution.");
    }

    processedSubmissionIds.add(submissionId);
    const entry = response.entry;
    if (entry) {
      submissionEntries.set(submissionId, entry);
    }
    const indexError = updateIndex && entry
      ? await window.CodePusherSync.updateIndex([entry])
      : "";
    if (!throwErrors) {
      showNotice(indexError
        ? `Pushed to GitHub, but the solutions index failed: ${indexError}`
        : response.message || "Pushed to GitHub");
    }
    return {
      status: response.unchanged?.length === 2 ? "unchanged" : "pushed",
      entry
    };
  } catch (error) {
    if (throwErrors) {
      throw error;
    }
    if (isExtensionContextInvalidated(error)) {
      showNotice("Extension reloaded. Refresh this page.", true);
    } else {
      showNotice(error.message || "Could not push the solution to GitHub.", true);
    }
    return { status: "failed" };
  } finally {
    inFlightSubmissionIds.delete(submissionId);
  }
}

// Pushes one historical LeetCode submission through the live solution pipeline.
async function pushOneLeetCodeSubmission(item) {
  const result = await pushAcceptedSubmission(item.id, {
    throwErrors: true,
    updateIndex: false
  });
  if (result?.status === "failed") {
    throw new Error("LeetCode submission is no longer accepted.");
  }
  return result;
}

// Provides LeetCode history listing and delegates each item to the existing push pipeline.
const LEETCODE_SYNC_PROVIDER = {
  name: "LeetCode",
  listAcceptedSubmissions: listLeetCodeSubmissions,
  pushOne: pushOneLeetCodeSubmission,
  delayMs: 2000
};

// Accepts sync requests only from this extension's popup.
function handleLeetCodeSyncMessage(message, sender, sendResponse) {
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

  void window.CodePusherSync.run(LEETCODE_SYNC_PROVIDER, message.limit);
  sendResponse({ ok: true });
  return false;
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
  checkSubmissionRoute();
  if (getSubmissionRoute()) {
    window.setInterval(checkSubmissionRoute, 1000);
  }
}

startRouteDetection();
chrome.runtime.onMessage.addListener(handleLeetCodeSyncMessage);
