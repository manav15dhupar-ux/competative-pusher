// Runs provider-based historical solution syncs sequentially with visible progress.

let syncInProgress = false;
let syncNotice;

// Shows persistent sync progress without automatically dismissing it.
function showSyncNotice(message, isError = false) {
  if (!syncNotice) {
    syncNotice = document.createElement("div");
    syncNotice.setAttribute("role", "status");
    syncNotice.setAttribute("aria-live", "polite");
    Object.assign(syncNotice.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "2147483647",
      maxWidth: "min(420px, calc(100vw - 32px))",
      padding: "9px 13px",
      borderRadius: "6px",
      color: "#ffffff",
      backgroundColor: "#262626",
      boxShadow: "0 2px 10px rgba(0, 0, 0, 0.2)",
      font: "14px/1.4 sans-serif",
      pointerEvents: "none"
    });
    document.documentElement.appendChild(syncNotice);
  }
  syncNotice.textContent = message;
  syncNotice.style.borderLeft = isError
    ? "4px solid #ef4444"
    : "4px solid #22c55e";
}

// Waits between individual provider pushes so commits never overlap.
function waitForSyncDelay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

// Sends a batch of problem metadata to the background index updater and returns any error.
async function updateSolutionsIndex(entries) {
  console.log(`CodePusher: sending ${entries.length} index entries.`);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "updateIndex",
      entries
    });
    return response?.ok ? "" : response?.error || "Index update failed without an error message.";
  } catch (error) {
    return error?.message || "Index update failed without an error message.";
  }
}

// Retrieves known solution folders from the background worker for sync deduplication.
async function listExistingFolders() {
  const response = await chrome.runtime.sendMessage({ type: "listExistingFolders" });
  if (!response?.ok || !response.folders) {
    throw new Error(response?.error || "Could not list existing solution folders.");
  }
  return response.folders;
}

// Builds a stable key so repeated problem metadata is included only once per index batch.
function getIndexEntryKey(entry) {
  return `${entry.platform}:${entry.number}`;
}

// Deduplicates accepted submissions by problem and selects the newest submission.
function getNewestSubmissions(items) {
  const newestBySlug = new Map();
  for (const item of items) {
    if (!item || typeof item.slug !== "string" || !item.slug) {
      continue;
    }
    const previous = newestBySlug.get(item.slug);
    if (!previous || Number(item.timestamp) > Number(previous.timestamp)) {
      newestBySlug.set(item.slug, item);
    }
  }
  return [...newestBySlug.values()].sort(
    (first, second) => Number(first.timestamp) - Number(second.timestamp)
  );
}

// Runs one provider sync, keeping requests serial and stopping on repeated errors or rate limiting.
async function runSync(provider, limit, options = {}) {
  if (syncInProgress) {
    showSyncNotice("A solution sync is already running.", true);
    return { ok: false, error: "A solution sync is already running." };
  }
  if (
    !provider ||
    typeof provider.name !== "string" ||
    typeof provider.listAcceptedSubmissions !== "function" ||
    typeof provider.pushOne !== "function" ||
    !Number.isFinite(provider.delayMs) ||
    provider.delayMs < 0
  ) {
    showSyncNotice("This site does not have a valid sync provider.", true);
    return { ok: false, error: "Invalid sync provider." };
  }

  syncInProgress = true;
  const counts = { pushed: 0, unchanged: 0, alreadyThere: 0, failed: 0 };
  const entriesByProblem = new Map();
  let stopMessage = "";
  let finalNotice = "";
  let finalNoticeIsError = false;
  try {
    const listedItems = await provider.listAcceptedSubmissions();
    const items = getNewestSubmissions(listedItems);
    const boundedLimit = Number.isInteger(limit) && limit > 0
      ? Math.min(limit, items.length)
      : items.length;
    const selected = items.slice(0, boundedLimit);

    if (!window.confirm(`Push ${selected.length} solutions to GitHub?`)) {
      finalNotice = "Sync cancelled.";
      return { ok: true, cancelled: true };
    }

    const existingFolders = provider.getExistingFolder
      ? await listExistingFolders()
      : null;
    const preparedItems = selected.map((item) => ({
      item,
      folder: provider.getExistingFolder
        ? provider.getExistingFolder(item, existingFolders) || ""
        : ""
    }));
    for (const { item, folder } of preparedItems) {
      if (folder && provider.getIndexEntry) {
        const entry = provider.getIndexEntry(item, folder);
        if (entry) {
          entriesByProblem.set(getIndexEntryKey(entry), entry);
        }
      }
    }
    const workItems = preparedItems.filter(({ folder }) =>
      options.repushExisting === true || !folder
    );
    counts.alreadyThere = preparedItems.length - workItems.length;

    let consecutiveErrors = 0;
    let leftUnprocessed = 0;
    for (let index = 0; index < workItems.length; index += 1) {
      const item = workItems[index].item;
      showSyncNotice(`Syncing ${index + 1}/${workItems.length}: ${item.slug}`);
      try {
        const result = await provider.pushOne(item);
        if (result?.entry) {
          const key = getIndexEntryKey(result.entry);
          if (!entriesByProblem.has(key)) {
            entriesByProblem.set(key, result.entry);
          }
        }
        if (result?.status === "unchanged" || result?.alreadyUpToDate) {
          counts.unchanged += 1;
        } else {
          counts.pushed += 1;
        }
        consecutiveErrors = 0;
      } catch (error) {
        counts.failed += 1;
        consecutiveErrors += 1;
        console.log("CodePusher: failed sync for slug", item.slug);
        if (
          error?.stopSync ||
          error?.status === 429 ||
          /\b429\b|too many requests|captcha|challenge page/i.test(error?.message || "")
        ) {
          stopMessage = error?.status === 429
            ? "Stopped: HTTP 429 received."
            : `Stopped: ${error?.message || "The site returned a non-OK response or challenge page."}`;
          leftUnprocessed = workItems.length - index - 1;
          break;
        }
        if (consecutiveErrors >= 3) {
          stopMessage = "Stopped: 3 errors in a row.";
          leftUnprocessed = workItems.length - index - 1;
          break;
        }
      }

      if (index < workItems.length - 1) {
        await waitForSyncDelay(provider.delayMs);
      }
    }

    const summary = `Done: ${counts.pushed} pushed, ${counts.unchanged} already up to date, ${counts.alreadyThere} already there, ${counts.failed} failed`;
    finalNotice = `${stopMessage ? `${stopMessage} ` : ""}${summary}${stopMessage ? `; ${leftUnprocessed} items left unprocessed` : ""}`;
    finalNoticeIsError = Boolean(stopMessage);
    return { ok: true, ...counts, stopped: stopMessage || "", leftUnprocessed };
  } catch (error) {
    const message = error?.message || "Could not list accepted submissions.";
    const stopped = error?.stopSync || error?.status === 429 ||
      /\b429\b|captcha|challenge page/i.test(message);
    const notice = error?.status === 429
      ? `Stopped: HTTP 429 received. ${message}`
      : `${stopped ? "Stopped" : "Sync failed"}: ${message}`;
    finalNotice = notice;
    finalNoticeIsError = true;
    return { ok: false, error: message };
  } finally {
    const indexError = await updateSolutionsIndex([...entriesByProblem.values()]);
    if (indexError) {
      finalNotice = [finalNotice, `Solutions index update failed: ${indexError}`]
        .filter(Boolean)
        .join(" ");
      finalNoticeIsError = true;
    }
    if (finalNotice) {
      showSyncNotice(finalNotice, finalNoticeIsError);
    }
    syncInProgress = false;
  }
}

// Exposes the shared sync runner to site-specific content-script providers.
window.CodePusherSync = Object.freeze({
  run: runSync,
  updateIndex: updateSolutionsIndex,
  listExistingFolders
});
