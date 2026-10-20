// Options-page logic; the background worker alone stores and reads the token.

const settingsForm = document.querySelector("#settings-form");
const statusMessage = document.querySelector("#status");
const usernameInput = document.querySelector("#username");
const repoInput = document.querySelector("#repo");

// Loads the non-secret repository settings from the background worker.
async function loadSettings() {
  statusMessage.textContent = "Loading saved settings...";

  try {
    const response = await chrome.runtime.sendMessage({ type: "getSettings" });
    if (!response.ok) {
      throw new Error(response.error);
    }

    usernameInput.value = response.settings.username;
    repoInput.value = response.settings.repo;
    statusMessage.textContent = response.settings.username
      ? "Leave the token blank to keep the saved token."
      : "Enter your GitHub details to get started.";
  } catch (error) {
    statusMessage.textContent = `Could not load settings: ${error.message}`;
  }
}

// Sends credentials to the worker for storage without exposing them to content scripts.
async function saveSettings(event) {
  event.preventDefault();
  statusMessage.textContent = "Saving settings...";

  const settings = {
    token: document.querySelector("#token").value,
    username: usernameInput.value,
    repo: repoInput.value
  };

  try {
    const response = await chrome.runtime.sendMessage({
      type: "saveSettings",
      settings
    });
    if (!response.ok) {
      throw new Error(response.error);
    }

    document.querySelector("#token").value = "";
    statusMessage.textContent = "Settings saved.";
  } catch (error) {
    statusMessage.textContent = `Could not save settings: ${error.message}`;
  }
}

settingsForm.addEventListener("submit", saveSettings);
loadSettings();
