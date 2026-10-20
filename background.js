// Background service worker for settings storage and GitHub solution uploads.

const LANGUAGE_EXTENSIONS = {
  c: "c",
  "c++": "cpp",
  csharp: "cs",
  go: "go",
  java: "java",
  javascript: "js",
  kotlin: "kt",
  mysql: "sql",
  php: "php",
  python: "py",
  python3: "py",
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

// Confirms a solution message came from a LeetCode page.
function isLeetCodePage(sender) {
  if (!sender.url) {
    return false;
  }

  try {
    return new URL(sender.url).origin === "https://leetcode.com";
  } catch {
    return false;
  }
}

// Checks the required fields and slug format before building a repository path.
function isValidSolution(message) {
  return (
    message &&
    message.site === "leetcode" &&
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

  if (
    !settings ||
    (!token && !savedSettings.githubToken) ||
    typeof settings.username !== "string" ||
    !settings.username.trim() ||
    typeof settings.repo !== "string" ||
    !settings.repo.trim()
  ) {
    throw new Error("Enter a GitHub token, username, and repository name.");
  }

  await chrome.storage.local.set({
    githubToken: token || savedSettings.githubToken,
    githubUsername: settings.username.trim(),
    githubRepo: settings.repo.trim()
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

// Calls GitHub's Contents API and reports HTTP failures without exposing secrets.
async function githubRequest(url, token, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed with status ${response.status}.`);
  }

  return response.json();
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
  let sha;

  const existingResponse = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${settings.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  if (existingResponse.ok) {
    const existingFile = await existingResponse.json();
    sha = existingFile.sha;
  } else if (existingResponse.status !== 404) {
    throw new Error(`GitHub lookup failed with status ${existingResponse.status}.`);
  }

  const payload = {
    message: `Add ${solution.site} solution: ${solution.problem}`,
    content: encodeBase64(solution.code)
  };

  if (sha) {
    payload.sha = sha;
  }

  const result = await githubRequest(apiUrl, settings.githubToken, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  return { path, url: result.content.html_url };
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

  if (!isLeetCodePage(sender)) {
    sendResponse({ ok: false, error: "Solutions can only be submitted from LeetCode." });
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
