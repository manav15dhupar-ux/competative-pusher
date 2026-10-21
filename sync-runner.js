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
async function runSync(provider, limit) {
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
  const counts = { pushed: 0, unchanged: 0, failed: 0 };
  let stopMessage = "";
  try {
    const listedItems = await provider.listAcceptedSubmissions();
    const items = getNewestSubmissions(listedItems);
    const boundedLimit = Number.isInteger(limit) && limit > 0
      ? Math.min(limit, items.length)
      : items.length;
    const selected = items.slice(0, boundedLimit);

    if (!window.confirm(`Push ${selected.length} solutions to GitHub?`)) {
      showSyncNotice("Sync cancelled.");
      return { ok: true, cancelled: true };
    }

    let consecutiveErrors = 0;
    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index];
      showSyncNotice(`Syncing ${index + 1}/${selected.length}: ${item.slug}`);
      try {
        const result = await provider.pushOne(item);
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
          break;
        }
        if (consecutiveErrors >= 3) {
          stopMessage = "Stopped: 3 errors in a row.";
          break;
        }
      }

      if (index < selected.length - 1) {
        await waitForSyncDelay(provider.delayMs);
      }
    }

    const summary = `Done: ${counts.pushed} pushed, ${counts.unchanged} already up to date, ${counts.failed} failed`;
    showSyncNotice(stopMessage ? `${stopMessage} ${summary}` : summary, Boolean(stopMessage));
    return { ok: true, ...counts, stopped: stopMessage || "" };
  } catch (error) {
    const message = error?.message || "Could not list accepted submissions.";
    const stopped = error?.stopSync || error?.status === 429 ||
      /\b429\b|captcha|challenge page/i.test(message);
    const notice = error?.status === 429
      ? `Stopped: HTTP 429 received. ${message}`
      : `${stopped ? "Stopped" : "Sync failed"}: ${message}`;
    showSyncNotice(notice, true);
    return { ok: false, error: message };
  } finally {
    syncInProgress = false;
  }
}

// Exposes the shared sync runner to site-specific content-script providers.
window.CodePusherSync = Object.freeze({ run: runSync });
