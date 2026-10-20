# Project: code-pusher

CodePusher is a Chrome extension that pushes accepted solutions from coding platforms to the user's GitHub repository.

## Platform and implementation

- Use Manifest V3 only.
- Write plain JavaScript. Do not add frameworks or a build step.
- Do not use remote code, `eval`, third-party servers, or analytics.
- Implement one coding site at a time. Start with LeetCode; do not add support for other sites until requested.

## GitHub token security

- Only the background service worker may access the GitHub token.
- Store the token only in `chrome.storage.local`. Never hardcode or log it.
- Never pass or expose the token to content scripts, page scripts, the DOM, or messages accessible to content scripts.
- Restrict `host_permissions` to the five supported coding sites and `https://api.github.com/*`.

## Safe content handling

- Treat scraped page content as untrusted. Never insert it with `innerHTML`; use `textContent` for text.
- Keep permissions and data access limited to what the current platform integration needs.

## Learning-friendly code

- Add a short explanatory comment for every file and every function, including new or substantially changed code.
- Keep comments concise and explain the file's purpose or the function's role.
