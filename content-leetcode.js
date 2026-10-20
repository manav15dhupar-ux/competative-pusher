// Detects newly accepted LeetCode submissions and sends their code to the worker.

const SUBMISSION_ID_PATTERN = /\/submissions\/detail\/(\d+)/;
const processedSubmissionIds = new Set();
let noticeElement;
let mutationTimer;
let pendingMutationRecords = [];
let routeObserver;

const LANGUAGE_INFO = {
  c: { language: "c", extension: "c" },
  "c++": { language: "c++", extension: "cpp" },
  "c#": { language: "csharp", extension: "cs" },
  csharp: { language: "csharp", extension: "cs" },
  go: { language: "go", extension: "go" },
  java: { language: "java", extension: "java" },
  javascript: { language: "javascript", extension: "js" },
  kotlin: { language: "kotlin", extension: "kt" },
  mysql: { language: "mysql", extension: "sql" },
  php: { language: "php", extension: "php" },
  python: { language: "python3", extension: "py" },
  python3: { language: "python3", extension: "py" },
  ruby: { language: "ruby", extension: "rb" },
  rust: { language: "rust", extension: "rs" },
  scala: { language: "scala", extension: "scala" },
  swift: { language: "swift", extension: "swift" },
  typescript: { language: "typescript", extension: "ts" }
};

// Gets the problem slug only when the current SPA route is a problem page.
function getProblemSlug() {
  const match = window.location.pathname.match(/^\/problems\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Finds a submission-detail link inside a small accepted-result region.
function findSubmissionId(container) {
  const links = [];
  if (container.matches?.("a[href]")) {
    links.push(container);
  }
  links.push(...container.querySelectorAll("a[href]"));

  for (const link of links) {
    const match = link.href.match(SUBMISSION_ID_PATTERN);
    if (match) {
      return match[1];
    }
  }

  return null;
}

// Finds a newly changed accepted-result region and extracts its submission ID.
function findAcceptedSubmissionId(changedNode) {
  let element =
    changedNode.nodeType === Node.ELEMENT_NODE
      ? changedNode
      : changedNode.parentElement;

  for (let level = 0; element && level < 8; level += 1) {
    const resultText = element.textContent || "";
    const submissionId =
      resultText.length <= 2000 && /\bAccepted\b/.test(resultText)
        ? findSubmissionId(element)
        : null;
    if (submissionId) {
      return submissionId;
    }
    element = element.parentElement;
  }

  return null;
}

// Checks whether a changed node came from the current LeetCode problem page.
function isProblemPage() {
  return window.location.hostname === "leetcode.com" && Boolean(getProblemSlug());
}

// Shows a small status message as plain text so page content cannot become markup.
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
      padding: "10px 14px",
      borderRadius: "6px",
      color: "#ffffff",
      backgroundColor: "#262626",
      boxShadow: "0 2px 10px rgba(0, 0, 0, 0.25)",
      font: "14px/1.4 sans-serif"
    });
    document.documentElement.appendChild(noticeElement);
  }

  noticeElement.textContent = message;
  noticeElement.style.borderLeft = isError ? "4px solid #ef4444" : "4px solid #22c55e";
}

// Maps LeetCode's language labels to the background worker's supported language.
function getLanguageInfo(languageName) {
  const normalizedName = languageName.trim().toLowerCase();
  return LANGUAGE_INFO[normalizedName] || null;
}

// Fetches a submission's source and language from LeetCode's authenticated GraphQL API.
async function fetchSubmission(submissionId) {
  const query = `
    query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        code
        lang {
          name
          verboseName
        }
      }
    }
  `;
  const response = await fetch("/graphql/", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { submissionId: Number(submissionId) }
    })
  });

  if (!response.ok) {
    throw new Error(`LeetCode submission lookup failed (${response.status}).`);
  }

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(result.errors[0].message || "LeetCode could not return the submission.");
  }

  const submission = result.data?.submissionDetails;
  if (
    !submission ||
    typeof submission.code !== "string" ||
    !submission.lang
  ) {
    throw new Error("LeetCode did not return the submission code and language.");
  }

  return submission;
}

// Sends one accepted submission to the background worker and reports its result.
async function pushAcceptedSubmission(submissionId) {
  if (processedSubmissionIds.has(submissionId)) {
    return;
  }
  processedSubmissionIds.add(submissionId);

  const problem = getProblemSlug();
  if (!problem) {
    return;
  }

  try {
    const submission = await fetchSubmission(submissionId);
    const languageName =
      submission.lang.name || submission.lang.verboseName || "";
    if (typeof languageName !== "string") {
      throw new Error("LeetCode returned an invalid programming language.");
    }
    const languageInfo = getLanguageInfo(languageName);
    if (!languageInfo || !languageInfo.extension) {
      throw new Error(`Unsupported LeetCode language: ${languageName || "unknown"}.`);
    }

    const result = await chrome.runtime.sendMessage({
      site: "leetcode",
      problem,
      language: languageInfo.language,
      code: submission.code
    });
    if (!result?.ok) {
      throw new Error(result?.error || "The background worker could not push the solution.");
    }

    showNotice("Pushed to GitHub");
  } catch (error) {
    showNotice(error.message || "Could not push the solution to GitHub.", true);
  }
}

// Checks changed DOM nodes for an accepted result without scanning the editor.
function handleMutations(records) {
  if (!isProblemPage()) {
    return;
  }

  for (const record of records) {
    const changedNodes =
      record.type === "characterData"
        ? [record.target]
        : Array.from(record.addedNodes);

    for (const node of changedNodes) {
      const submissionId = findAcceptedSubmissionId(node);
      if (submissionId) {
        void pushAcceptedSubmission(submissionId);
        return;
      }
    }
  }
}

// Debounces React's DOM changes before checking the new result area.
function scheduleMutationCheck(records) {
  pendingMutationRecords.push(...records);
  clearTimeout(mutationTimer);
  mutationTimer = window.setTimeout(checkPendingMutations, 150);
}

// Processes all queued changes so a later React update cannot hide an accepted result.
function checkPendingMutations() {
  const records = pendingMutationRecords;
  pendingMutationRecords = [];
  handleMutations(records);
}

// Starts watching for the SPA route to enter a LeetCode problem page.
function handleRouteMutations() {
  if (isProblemPage()) {
    routeObserver.disconnect();
    startAcceptedResultObserver();
  }
}

// Watches LeetCode's SPA result updates for accepted submission changes.
function startAcceptedResultObserver() {
  const observer = new MutationObserver(scheduleMutationCheck);
  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

if (isProblemPage()) {
  startAcceptedResultObserver();
} else {
  routeObserver = new MutationObserver(handleRouteMutations);
  routeObserver.observe(document.documentElement, { childList: true, subtree: true });
}
