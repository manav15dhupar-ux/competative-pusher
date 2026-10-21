// Selects a provider from the active site and sends its sync request.

const SYNC_SITES = Object.freeze({
  "leetcode.com": { name: "LeetCode" },
  "codeforces.com": { name: "Codeforces" }
});
const syncButton = document.querySelector("#sync");
const limitInput = document.querySelector("#limit");
const statusMessage = document.querySelector("#status");
let activeTabId = null;

// Enables sync only when the active tab belongs to a supported site.
async function initializePopup() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const hostname = tab?.url ? new URL(tab.url).hostname : "";
    const site = SYNC_SITES[hostname];
    activeTabId = site ? tab.id : null;
    syncButton.disabled = !site;
    statusMessage.textContent = site
      ? `Ready to sync ${site.name} solutions.`
      : "Open leetcode.com or codeforces.com first";
  } catch (error) {
    activeTabId = null;
    syncButton.disabled = true;
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
      limit
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

syncButton.addEventListener("click", startSync);
initializePopup();
