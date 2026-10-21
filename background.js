// Background service worker for settings storage and GitHub solution uploads.

const LANGUAGE_EXTENSIONS = {
  c: "c",
  "c++": "cpp",
  bash: "sh",
  csharp: "cs",
  cpp: "cpp",
  dart: "dart",
  d: "d",
  elixir: "ex",
  erlang: "erl",
  go: "go",
  golang: "go",
  haskell: "hs",
  java: "java",
  javascript: "js",
  kotlin: "kt",
  mysql: "sql",
  php: "php",
  python: "py",
  python3: "py",
  racket: "rkt",
  ruby: "rb",
  rust: "rs",
  scala: "scala",
  swift: "swift",
  typescript: "ts"
};

// Confirms a message came from the extension's options page.
function isOptionsPage(sender) {
  return sender.url === chrome.runtime.getURL("options.html");
}

// Confirms a solution message came from the page for its declared site.
function isSupportedSitePage(sender, site) {
  if (!sender.url) {
    return false;
  }

  try {
    const expectedOrigin = {
      leetcode: "https://leetcode.com",
      codeforces: "https://codeforces.com"
    }[site];
    return Boolean(expectedOrigin) && new URL(sender.url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

// Checks the required fields and slug format before building a repository path.
function isValidSolution(message) {
  if (!message || typeof message !== "object") {
    return false;
  }
  const stringLimits = {
    site: 16,
    problem: 120,
    number: 32,
    title: 300,
    difficulty: 16,
    rating: 32,
    url: 2048,
    readme: 200 * 1024,
    language: 32,
    code: 1024 * 1024
  };
  if (Object.entries(stringLimits).some(([key, maxLength]) =>
    typeof message[key] !== "string" ||
    message[key].length === 0 && !["difficulty", "rating"].includes(key) ||
    message[key].length > maxLength
  )) {
    return false;
  }

  if (
    !["leetcode", "codeforces"].includes(message.site) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(message.problem) ||
    !message.title.trim() ||
    /[\u0000-\u001f]/.test(message.title) ||
    !message.readme.endsWith("\n") ||
    new TextEncoder().encode(message.readme).length >= 200 * 1024 ||
    new TextEncoder().encode(message.code).length > 1024 * 1024 ||
    !Object.hasOwn(LANGUAGE_EXTENSIONS, message.language.toLowerCase())
  ) {
    return false;
  }

  const numberPattern = message.site === "leetcode"
    ? /^\d+$/
    : /^\d+[A-Za-z]$/;
  if (!numberPattern.test(message.number)) {
    return false;
  }
  if (
    message.site === "leetcode"
      ? !["Easy", "Medium", "Hard"].includes(message.difficulty) || message.rating !== ""
      : message.difficulty !== "" ||
        !(message.rating === "Unrated" || /^\d+$/.test(message.rating))
  ) {
    return false;
  }

  let problemUrl;
  try {
    problemUrl = new URL(message.url);
  } catch {
    return false;
  }
  const expectedOrigin = message.site === "leetcode"
    ? "https://leetcode.com"
    : "https://codeforces.com";
  if (
    problemUrl.origin !== expectedOrigin ||
    problemUrl.protocol !== "https:" ||
    problemUrl.username ||
    problemUrl.password
  ) {
    return false;
  }

  const folder = message.site === "leetcode"
    ? `${message.number.padStart(4, "0")}-${message.problem}`
    : `${message.number.toLowerCase()}-${message.problem}`;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder);
}

// Stores settings sent by the options page without returning the token.
async function saveSettings(settings) {
  const savedSettings = await chrome.storage.local.get("githubToken");
  const token = typeof settings?.token === "string" ? settings.token.trim() : "";
  const username =
    typeof settings?.username === "string" ? settings.username.trim() : "";
  const repo = typeof settings?.repo === "string" ? settings.repo.trim() : "";

  if (
    !settings ||
    (!token && !savedSettings.githubToken) ||
    !username ||
    !repo
  ) {
    throw new Error("Enter a GitHub token, username, and repository name.");
  }

  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    throw new Error(
      "Enter a valid GitHub username using only letters, numbers, dots, dashes, and underscores."
    );
  }

  if (repo.includes("/") || repo.includes("://")) {
    throw new Error("Enter only the repo name, not the URL");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(
      "Enter a valid repo name using only letters, numbers, dots, dashes, and underscores."
    );
  }

  await chrome.storage.local.set({
    githubToken: token || savedSettings.githubToken,
    githubUsername: username,
    githubRepo: repo
  });
}

// Returns non-secret settings to the options page.
async function getSettings() {
  const settings = await chrome.storage.local.get([
    "githubUsername",
    "githubRepo"
  ]);

  return {
    username: settings.githubUsername || "",
    repo: settings.githubRepo || ""
  };
}

// Encodes UTF-8 solution text as base64 in chunks to avoid argument limits.
function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

// Maps common GitHub authorization, lookup, and conflict failures to actionable text.
function getGitHubError(status) {
  if (status === 401) {
    return new Error("GitHub rejected the token. It may be expired or incorrect.");
  }
  if (status === 403) {
    return new Error("The token lacks Contents write access to this repository.");
  }
  if (status === 404) {
    return new Error(
      "Repository or username not found, or the token is not scoped to this repository."
    );
  }
  if (status === 409 || status === 422) {
    return new Error("GitHub reported a conflict. Please try again.");
  }
  return new Error(`GitHub request failed with status ${status}.`);
}

// Calls GitHub's Contents API and reports HTTP failures without exposing secrets.
async function githubRequest(url, token, options = {}) {
  const { allowNotFound = false, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });

  if (response.status === 404 && allowNotFound) {
    return null;
  }
  if (!response.ok) {
    const error = getGitHubError(response.status);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

// Decodes GitHub's base64 file content for exact comparison with the submitted code.
function decodeGitHubContent(content) {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Creates or updates a repository file while skipping identical content.
async function upsertContentFile(apiUrl, token, path, content, commitMessage) {
  const existingFile = await githubRequest(apiUrl, token, { allowNotFound: true });
  if (
    existingFile?.encoding === "base64" &&
    typeof existingFile.content === "string" &&
    decodeGitHubContent(existingFile.content) === content
  ) {
    return { status: "unchanged", path, url: existingFile.html_url };
  }

  const payload = {
    message: `${existingFile ? "Update" : "Add"} ${commitMessage}`,
    content: encodeBase64(content)
  };
  if (existingFile?.sha) {
    payload.sha = existingFile.sha;
  }

  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      result = await githubRequest(apiUrl, token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      break;
    } catch (error) {
      if (attempt > 0 || ![409, 422].includes(error.status)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return {
    status: existingFile ? "updated" : "added",
    path,
    url: result.content.html_url
  };
}

// Builds the required platform-specific commit subject for a problem file.
function getProblemCommitSubject(solution) {
  return solution.site === "leetcode"
    ? `leetcode ${solution.number}. ${solution.title} [${solution.difficulty}]`
    : `codeforces ${solution.number}. ${solution.title} [rating ${solution.rating}]`;
}

// Builds a safely encoded GitHub Contents API URL for a repository path.
function buildContentsApiUrl(username, repo, path) {
  const repositoryPath = [
    encodeURIComponent(username),
    encodeURIComponent(repo),
    "contents",
    path.split("/").map(encodeURIComponent).join("/")
  ].join("/");
  return `https://api.github.com/repos/${repositoryPath}`;
}

// Creates or updates the solution and README using the GitHub Contents API.
async function pushSolution(solution) {
  const settings = await chrome.storage.local.get([
    "githubToken",
    "githubUsername",
    "githubRepo"
  ]);

  if (!settings.githubToken || !settings.githubUsername || !settings.githubRepo) {
    throw new Error("Save your GitHub token, username, and repository in Options first.");
  }

  const extension = LANGUAGE_EXTENSIONS[solution.language.toLowerCase()];
  const folder = solution.site === "leetcode"
    ? `${solution.number.padStart(4, "0")}-${solution.problem}`
    : `${solution.number.toLowerCase()}-${solution.problem}`;
  const folderPath = `${solution.site}/${folder}`;
  const solutionPath = `${folderPath}/solution.${extension}`;
  const readmePath = `${folderPath}/README.md`;
  const subject = getProblemCommitSubject(solution);
  const solutionFile = await upsertContentFile(
    buildContentsApiUrl(settings.githubUsername, settings.githubRepo, solutionPath),
    settings.githubToken,
    solutionPath,
    solution.code,
    subject
  );
  const readmeFile = await upsertContentFile(
    buildContentsApiUrl(settings.githubUsername, settings.githubRepo, readmePath),
    settings.githubToken,
    readmePath,
    solution.readme,
    subject
  );
  const files = [solutionFile, readmeFile];
  const added = files.filter((file) => file.status === "added").map((file) => file.path);
  const updated = files.filter((file) => file.status === "updated").map((file) => file.path);
  const unchanged = files.filter((file) => file.status === "unchanged").map((file) => file.path);
  const summary = [];
  if (added.length) {
    summary.push(`Added ${added.map((path) => path.split("/").pop()).join(" and ")}`);
  }
  if (updated.length) {
    summary.push(`Updated ${updated.map((path) => path.split("/").pop()).join(" and ")}`);
  }
  return {
    added,
    updated,
    unchanged,
    files,
    message: summary.length ? `${summary.join("; ")} on GitHub` : "Already up to date"
  };
}

// Routes options and LeetCode messages while keeping token data in the worker.
function handleMessage(message, sender, sendResponse) {
  if (message?.type === "getSettings") {
    if (!isOptionsPage(sender)) {
      sendResponse({ ok: false, error: "Settings are available only in Options." });
      return false;
    }

    getSettings().then(
      // Sends only non-secret settings to the waiting options page.
      (settings) => sendResponse({ ok: true, settings }),
      // Reports storage errors without including sensitive settings.
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message?.type === "saveSettings") {
    if (!isOptionsPage(sender)) {
      sendResponse({ ok: false, error: "Only Options can save GitHub settings." });
      return false;
    }

    saveSettings(message.settings).then(
      // Confirms success without returning the stored token.
      () => sendResponse({ ok: true }),
      // Reports save errors without including sensitive settings.
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (!isValidSolution(message)) {
    sendResponse({ ok: false, error: "Invalid or unsupported solution message." });
    return false;
  }

  if (!isSupportedSitePage(sender, message.site)) {
    sendResponse({
      ok: false,
      error: "Solutions can only be submitted from their supported coding site."
    });
    return false;
  }

  pushSolution(message).then(
    // Returns only the committed file's path and URL.
    (result) => sendResponse({ ok: true, ...result }),
    // Reports upload errors without returning request headers or credentials.
    (error) => sendResponse({ ok: false, error: error.message })
  );
  return true;
}

chrome.runtime.onMessage.addListener(handleMessage);
