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
  return (
    message &&
    ["leetcode", "codeforces"].includes(message.site) &&
    typeof message.problem === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(message.problem) &&
    typeof message.language === "string" &&
    Object.hasOwn(LANGUAGE_EXTENSIONS, message.language.toLowerCase()) &&
    typeof message.code === "string" &&
    message.code.length > 0
  );
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
    throw getGitHubError(response.status);
  }

  return response.json();
}

// Decodes GitHub's base64 file content for exact comparison with the submitted code.
function decodeGitHubContent(content) {
  const binary = atob(content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Creates or updates the solution file using GitHub's Contents API.
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
  const path = `${solution.site}/${solution.problem}/solution.${extension}`;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const repositoryPath = [
    encodeURIComponent(settings.githubUsername),
    encodeURIComponent(settings.githubRepo),
    "contents",
    encodedPath
  ].join("/");
  const apiUrl = `https://api.github.com/repos/${repositoryPath}`;
  const existingFile = await githubRequest(apiUrl, settings.githubToken, {
    allowNotFound: true
  });

  if (
    existingFile?.encoding === "base64" &&
    typeof existingFile.content === "string" &&
    decodeGitHubContent(existingFile.content) === solution.code
  ) {
    return {
      path,
      url: existingFile.html_url,
      message: "Already up to date"
    };
  }

  const payload = {
    message: `${existingFile ? "Update" : "Add"} ${solution.site} solution: ${solution.problem}`,
    content: encodeBase64(solution.code)
  };

  if (existingFile?.sha) {
    payload.sha = existingFile.sha;
  }

  const result = await githubRequest(apiUrl, settings.githubToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  return {
    path,
    url: result.content.html_url,
    message: existingFile ? "Updated on GitHub" : "Pushed to GitHub"
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
