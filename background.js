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
const MAX_INDEX_ENTRIES = 5000;
const MAX_INDEX_BYTES = 1024 * 1024;
const INDEX_START_MARKER = "<!-- codepusher:start -->";
const INDEX_END_MARKER = "<!-- codepusher:end -->";

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

// Returns the supported platform only when the message came from its content script.
function getSupportedContentScriptPlatform(sender) {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)) {
    return "";
  }
  try {
    const origin = new URL(sender.url).origin;
    return {
      "https://leetcode.com": "leetcode",
      "https://codeforces.com": "codeforces"
    }[origin] || "";
  } catch {
    return "";
  }
}

// Validates one index entry against the sending platform and repository path rules.
function isValidIndexEntry(entry, senderPlatform) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const expectedKeys = [
    "platform",
    "number",
    "title",
    "difficulty",
    "rating",
    "folder",
    "url",
    "language"
  ];
  if (
    Object.keys(entry).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(entry, key))
  ) {
    return false;
  }
  const stringLimits = {
    platform: 16,
    number: 32,
    title: 300,
    difficulty: 16,
    folder: 256,
    url: 2048,
    language: 32
  };
  if (Object.entries(stringLimits).some(([key, maxLength]) =>
    typeof entry[key] !== "string" ||
    !entry[key] ||
    entry[key].length > maxLength
  )) {
    return false;
  }
  if (
    entry.platform !== senderPlatform ||
    !["leetcode", "codeforces"].includes(entry.platform) ||
    !entry.title.trim() ||
    /[\u0000-\u001f]/.test(entry.title) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.folder) ||
    !Object.hasOwn(LANGUAGE_EXTENSIONS, entry.language.toLowerCase())
  ) {
    return false;
  }

  const numberPattern = entry.platform === "leetcode"
    ? /^\d+$/
    : /^\d+[A-Za-z]$/;
  const folderPrefix = entry.platform === "leetcode"
    ? `${entry.number.padStart(4, "0")}-`
    : `${entry.number.toLowerCase()}-`;
  if (!numberPattern.test(entry.number) || !entry.folder.startsWith(folderPrefix)) {
    return false;
  }
  if (
    entry.platform === "leetcode"
      ? !["Easy", "Medium", "Hard"].includes(entry.difficulty) || entry.rating !== ""
      : entry.difficulty !== "" ||
        !(entry.rating === "Unrated" ||
          Number.isSafeInteger(entry.rating) && entry.rating >= 0)
  ) {
    return false;
  }

  let problemUrl;
  try {
    problemUrl = new URL(entry.url);
  } catch {
    return false;
  }
  const expectedOrigin = entry.platform === "leetcode"
    ? "https://leetcode.com"
    : "https://codeforces.com";
  return problemUrl.protocol === "https:" &&
    problemUrl.origin === expectedOrigin &&
    !problemUrl.username &&
    !problemUrl.password;
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
async function upsertContentFile(apiUrl, token, path, content, commitMessage, exactCommitMessage = false) {
  const existingFile = await githubRequest(apiUrl, token, { allowNotFound: true });
  if (
    existingFile?.encoding === "base64" &&
    typeof existingFile.content === "string" &&
    decodeGitHubContent(existingFile.content) === content
  ) {
    return { status: "unchanged", path, url: existingFile.html_url };
  }

  const payload = {
    message: exactCommitMessage
      ? commitMessage
      : `${existingFile ? "Update" : "Add"} ${commitMessage}`,
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

// Escapes untrusted problem titles for safe placement in Markdown tables and links.
function escapeMarkdownTitle(title) {
  return title
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/[|\[\]<>`]/g, "\\$&");
}

// Encodes parentheses so a validated problem URL cannot break its Markdown link.
function escapeMarkdownUrl(url) {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

// Builds the marker-delimited README section from the complete solutions index.
function generateIndexBlock(entries) {
  const leetcodeEntries = entries
    .filter((entry) => entry.platform === "leetcode")
    .sort((first, second) => BigInt(first.number) < BigInt(second.number) ? -1 :
      BigInt(first.number) > BigInt(second.number) ? 1 : 0);
  const codeforcesEntries = entries
    .filter((entry) => entry.platform === "codeforces")
    .sort((first, second) => {
      const firstNumber = first.number.match(/^(\d+)([A-Za-z]+)$/);
      const secondNumber = second.number.match(/^(\d+)([A-Za-z]+)$/);
      const firstContest = BigInt(firstNumber[1]);
      const secondContest = BigInt(secondNumber[1]);
      if (firstContest !== secondContest) {
        return firstContest < secondContest ? -1 : 1;
      }
      return firstNumber[2].localeCompare(secondNumber[2]);
    });
  const difficultyCounts = { Easy: 0, Medium: 0, Hard: 0 };
  const ratingCounts = { low: 0, middle: 0, high: 0, unrated: 0 };
  for (const entry of leetcodeEntries) {
    difficultyCounts[entry.difficulty] += 1;
  }
  for (const entry of codeforcesEntries) {
    if (entry.rating === "Unrated") {
      ratingCounts.unrated += 1;
    } else if (entry.rating >= 800 && entry.rating < 1200) {
      ratingCounts.low += 1;
    } else if (entry.rating >= 1200 && entry.rating < 1600) {
      ratingCounts.middle += 1;
    } else {
      ratingCounts.high += 1;
    }
  }

  const lines = [
    INDEX_START_MARKER,
    `Total solved: ${entries.length} | LeetCode: Easy ${difficultyCounts.Easy}, Medium ${difficultyCounts.Medium}, Hard ${difficultyCounts.Hard} | Codeforces: 800-1199 ${ratingCounts.low}, 1200-1599 ${ratingCounts.middle}, 1600+ ${ratingCounts.high}, Unrated ${ratingCounts.unrated}`
  ];
  if (leetcodeEntries.length) {
    lines.push(
      "",
      "## LeetCode",
      "",
      "| # | Title | Difficulty | Language | Solution |",
      "| --- | --- | --- | --- | --- |",
      ...leetcodeEntries.map((entry) =>
        `| ${entry.number} | [${escapeMarkdownTitle(entry.title)}](${escapeMarkdownUrl(entry.url)}) | ${entry.difficulty} | ${entry.language} | [Solution](./leetcode/${encodeURIComponent(entry.folder)}/) |`
      )
    );
  }
  if (codeforcesEntries.length) {
    lines.push(
      "",
      "## Codeforces",
      "",
      "| Problem | Title | Rating | Language | Solution |",
      "| --- | --- | --- | --- | --- |",
      ...codeforcesEntries.map((entry) =>
        `| ${entry.number} | [${escapeMarkdownTitle(entry.title)}](${escapeMarkdownUrl(entry.url)}) | ${entry.rating} | ${entry.language} | [Solution](./codeforces/${encodeURIComponent(entry.folder)}/) |`
      )
    );
  }
  lines.push(INDEX_END_MARKER);
  return lines.join("\n");
}

// Replaces only the generated region, preserving all README content outside its markers.
function updateReadmeContent(existingContent, indexBlock) {
  if (existingContent === null) {
    return `# DSA Solutions\n\n${indexBlock}\n`;
  }
  const start = existingContent.indexOf(INDEX_START_MARKER);
  const end = existingContent.indexOf(INDEX_END_MARKER);
  if (start >= 0 && end >= start) {
    return `${existingContent.slice(0, start)}${indexBlock}${existingContent.slice(end + INDEX_END_MARKER.length)}`;
  }
  const separator = !existingContent
    ? ""
    : existingContent.endsWith("\n\n")
      ? ""
      : existingContent.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${existingContent}${separator}${indexBlock}\n`;
}

// Loads and validates the repository's stored JSON index before merging updates.
function parseIndexContent(content) {
  if (content === null) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The repository solutions index is not valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_INDEX_ENTRIES ||
    parsed.some((entry) => !isValidIndexEntry(entry, entry?.platform))) {
    throw new Error("The repository solutions index contains invalid entries.");
  }
  return parsed;
}

// Merges incoming metadata by platform and problem number, with new metadata winning.
function mergeIndexEntries(existingEntries, incomingEntries) {
  const entriesByProblem = new Map();
  for (const entry of existingEntries) {
    entriesByProblem.set(`${entry.platform}:${entry.number}`, entry);
  }
  for (const entry of incomingEntries) {
    entriesByProblem.set(`${entry.platform}:${entry.number}`, entry);
  }
  const entries = [...entriesByProblem.values()];
  if (entries.length > MAX_INDEX_ENTRIES) {
    throw new Error(`The solutions index cannot exceed ${MAX_INDEX_ENTRIES} entries.`);
  }
  return entries;
}

// Updates the private index and generated README without writing unchanged files.
async function updateSolutionsIndex(incomingEntries) {
  const settings = await chrome.storage.local.get([
    "githubToken",
    "githubUsername",
    "githubRepo"
  ]);
  if (!settings.githubToken || !settings.githubUsername || !settings.githubRepo) {
    throw new Error("Save your GitHub token, username, and repository in Options first.");
  }

  const indexPath = ".codepusher/index.json";
  const indexUrl = buildContentsApiUrl(settings.githubUsername, settings.githubRepo, indexPath);
  const storedIndexFile = await githubRequest(indexUrl, settings.githubToken, {
    allowNotFound: true
  });
  const storedIndex = storedIndexFile
    ? decodeGitHubContent(storedIndexFile.content)
    : null;
  const existingEntries = parseIndexContent(storedIndex);
  const entries = mergeIndexEntries(existingEntries, incomingEntries);
  const indexContent = `${JSON.stringify(entries, null, 2)}\n`;
  if (new TextEncoder().encode(indexContent).length >= MAX_INDEX_BYTES) {
    throw new Error("The repository solutions index must be smaller than 1 MB.");
  }

  await upsertContentFile(
    indexUrl,
    settings.githubToken,
    indexPath,
    indexContent,
    "Update solutions index",
    true
  );

  const readmePath = "README.md";
  const readmeUrl = buildContentsApiUrl(settings.githubUsername, settings.githubRepo, readmePath);
  const readmeFile = await githubRequest(readmeUrl, settings.githubToken, {
    allowNotFound: true
  });
  const existingReadme = readmeFile
    ? decodeGitHubContent(readmeFile.content)
    : null;
  const readmeContent = updateReadmeContent(
    existingReadme,
    generateIndexBlock(entries)
  );
  if (readmeContent !== existingReadme) {
    await upsertContentFile(
      readmeUrl,
      settings.githubToken,
      readmePath,
      readmeContent,
      "Update solutions index",
      true
    );
  }
  return { entries };
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
  const entry = {
    platform: solution.site,
    number: solution.number,
    title: solution.title,
    difficulty: solution.difficulty,
    rating: solution.site === "codeforces" && /^\d+$/.test(solution.rating)
      ? Number(solution.rating)
      : solution.rating,
    folder,
    url: solution.url,
    language: solution.language
  };
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
    entry,
    message: summary.length ? `${summary.join("; ")} on GitHub` : "Already up to date"
  };
}

// Routes options and LeetCode messages while keeping token data in the worker.
function handleMessage(message, sender, sendResponse) {
  if (message?.type === "updateIndex") {
    const senderPlatform = getSupportedContentScriptPlatform(sender);
    if (
      !senderPlatform ||
      !Array.isArray(message.entries) ||
      message.entries.length > MAX_INDEX_ENTRIES ||
      message.entries.some((entry) => !isValidIndexEntry(entry, senderPlatform))
    ) {
      sendResponse({ ok: false, error: "Invalid or unsupported solutions index update." });
      return false;
    }

    updateSolutionsIndex(message.entries).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

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
