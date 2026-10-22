// Selects a provider from the active site and sends its sync request.

const SYNC_SITES = Object.freeze({
  "leetcode.com": { name: "LeetCode" },
  "codeforces.com": { name: "Codeforces" }
});
const syncButton = document.querySelector("#sync");
const rebuildIndexButton = document.querySelector("#rebuild-index");
const limitInput = document.querySelector("#limit");
const repushExistingInput = document.querySelector("#repush-existing");
const statusMessage = document.querySelector("#status");
let activeTabId = null;
let activeSiteHostname = "";

// Enables sync only when the active tab belongs to a supported site.
async function initializePopup() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const hostname = tab?.url ? new URL(tab.url).hostname : "";
    const site = SYNC_SITES[hostname];
    activeTabId = site ? tab.id : null;
    activeSiteHostname = site ? hostname : "";
    syncButton.disabled = !site;
    rebuildIndexButton.disabled = hostname !== "codeforces.com";
    statusMessage.textContent = site
      ? `Ready to sync ${site.name} solutions.`
      : "Open leetcode.com or codeforces.com first";
  } catch (error) {
    activeTabId = null;
    activeSiteHostname = "";
    syncButton.disabled = true;
    rebuildIndexButton.disabled = true;
    statusMessage.textContent = `Could not check the active tab: ${error.message}`;
  }
}

// Sends a bounded or unlimited sync request to the active coding-site content script.
async function startSync() {
  if (activeTabId === null) {
    statusMessage.textContent = "Open leetcode.com or codeforces.com first";
    return;
  }

  const rawLimit = limitInput.value.trim();
  const limit = rawLimit ? Number(rawLimit) : null;
  if (rawLimit && (!Number.isSafeInteger(limit) || limit < 1)) {
    statusMessage.textContent = "Enter a positive whole number or leave the field blank.";
    return;
  }

  syncButton.disabled = true;
  statusMessage.textContent = "Starting sync...";
  try {
    const response = await chrome.tabs.sendMessage(activeTabId, {
      type: "syncAll",
      limit,
      repushExisting: repushExistingInput.checked
    });
    if (!response?.ok) {
      throw new Error(response?.error || "The site did not start the sync.");
    }
    statusMessage.textContent = "Sync started. Progress appears on the page.";
  } catch (error) {
    statusMessage.textContent = `Could not start sync: ${error.message}`;
  } finally {
    syncButton.disabled = false;
  }
}

// Starts the Codeforces metadata-only index rebuild from the active tab.
async function rebuildIndexOnly() {
  if (activeTabId === null || activeSiteHostname !== "codeforces.com") {
    statusMessage.textContent = "Open codeforces.com first";
    return;
  }

  rebuildIndexButton.disabled = true;
  statusMessage.textContent = "Starting Codeforces index rebuild...";
  try {
    const response = await chrome.tabs.sendMessage(activeTabId, {
      type: "rebuildIndexOnly"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Codeforces did not start the index rebuild.");
    }
    statusMessage.textContent = "Index rebuild started. Progress appears on the page.";
  } catch (error) {
    statusMessage.textContent = `Could not start index rebuild: ${error.message}`;
  } finally {
    rebuildIndexButton.disabled = activeSiteHostname !== "codeforces.com";
  }
}

syncButton.addEventListener("click", startSync);
rebuildIndexButton.addEventListener("click", rebuildIndexOnly);
initializePopup();
