# CodePusher

CodePusher is a Chrome extension that saves accepted LeetCode and Codeforces solutions to a GitHub repository.

## Why I built it

I do not trust third-party code pushers with a GitHub token, so I built one I can audit.

## Features

- Pushes a solution when an accepted LeetCode or Codeforces submission is detected.
- Saves each problem in its own platform folder with a language-named solution file and a `README.md` containing the problem statement, difficulty or rating, and problem link.
- Maintains a generated index in the solutions repository's root `README.md`, while preserving content outside the generated section.
- Provides one-click sync of accepted solutions already in your account history. Sync asks for confirmation before it starts and can skip existing problem folders or re-push them.
- Provides **Rebuild index only** for Codeforces. It rebuilds index entries from accepted submission metadata and existing solution folders without fetching or pushing solution files.
- Compares existing file contents and skips writes when a solution, problem README, or index file is unchanged.
- Shows status and error notices in the popup and on the coding-site page.

## How it works

The LeetCode and Codeforces content scripts detect accepted submissions and collect their code and problem metadata. Both use the shared sync runner for historical syncs. The background service worker validates incoming messages, keeps the GitHub token, and reads or writes files through GitHub's Contents API. The options page saves the GitHub destination and token; the popup starts a sync for the active supported site.

Coding-site requests use your already logged-in browser session through same-origin requests from the page. CodePusher does not read or store your LeetCode or Codeforces login credentials, or send them anywhere outside those platforms. The browser handles the session for same-origin requests; the extension reads LeetCode's CSRF cookie only to make those requests.

```text
Options page --settings--> Background service worker
                                  |
Popup --sync request--> Site content script
                            |     |
                            |     +--progress/status--> Page
                            +--solution/index message--> Background worker
                                                         |
                                                         +--> GitHub APIs
```

## Security design

| Threat | Mitigation |
| --- | --- |
| A token with broad repository access could expose more than this extension needs. | Create a fine-grained personal access token for only the solutions repository, with **Contents: Read and write** and no other repository permissions. The extension uses GitHub's Contents API to read and write files and the Git Trees API to list existing solution folders. The token's actual scope is set on GitHub, not enforced by the extension. |
| Coding-site scripts or pages could receive the GitHub token. | The options page accepts the token and sends it directly to the extension worker to save. Storage access is restricted to trusted contexts (extension pages and the service worker), excluding content scripts. The background service worker reads the stored token and adds it to GitHub API requests. It does not return the token to the options page after saving or send it to coding-site content scripts or page code. |
| A page or forged message could ask the worker to write arbitrary content. | The worker checks sender origins and extension identity, restricts settings messages to the options page, and validates solution and index message fields, formats, sizes, and platform. |
| Untrusted problem metadata could create unexpected repository paths. | The worker builds paths from allowlisted platform names, validated numeric problem identifiers, lowercase slugs, and a language-to-extension map. Index entries are separately checked for valid folder formats and platform-number prefixes. |
| Excessive browser privileges or access to unrelated sites. | `manifest.json` declares only the `storage` permission. Its exact `host_permissions` are `https://leetcode.com/*`, `https://codeforces.com/*`, and `https://api.github.com/*`. |
| Remote code execution, unrelated data collection, or transmission through another service. | The extension uses plain JavaScript and makes requests to the supported coding sites and GitHub API. It loads no remote executable code, uses no `eval`, and has no separate third-party backend or analytics. |
| Scraped page content could be interpreted as injected HTML. | Notices use `textContent`. Problem HTML is parsed and converted to a restricted Markdown subset; raw HTML is not passed through to the generated Markdown. |
| A problem link could use a dangerous URL scheme. | The HTML-to-Markdown converter emits links and images only when their resolved URL uses HTTPS. Other links are rendered as text, and raw HTML is not emitted. |
| Bulk sync could overload a site or continue through a challenge page or repeated failures. | Codeforces requests are serialized with a delay between request starts. Bulk sync requires confirmation, runs sequentially with a provider-specific delay, and stops on rate limits or detected challenges and after three consecutive errors. |

## Limitations and threat model

- The token is stored in `chrome.storage.local`. It is not encrypted by this extension and may be readable by someone with access to the local browser profile.
- The extension depends on LeetCode's GraphQL and submissions endpoints and on Codeforces' public API and page structure. These can change. LeetCode's endpoints are not a stable public integration contract.
- Codeforces may rate-limit requests or return a challenge page. The extension stops when it detects those responses; it cannot bypass them.
- Bulk Codeforces history sync filters out Gym contests, and group-contest workflows are not supported. The live submission code recognizes a Gym submission route, but that does not make Gym bulk sync supported.
- Fine-grained GitHub tokens expire. When yours expires, create a replacement and save it in Options.
- Data read from LeetCode and Codeforces pages is untrusted. The worker validates its format, size, and destination path but cannot verify that it is genuine. A compromised page could therefore make the extension write bad content into the solutions repository, but only inside validated paths.

This project does not protect a compromised browser profile or device, validate the correctness or safety of submitted solutions, or control the availability and behavior of GitHub, LeetCode, or Codeforces.

## Note on content

Generated problem `README.md` files include statements copied from the platforms. Keep the solutions repository private or check the platforms' terms before publishing it.

## Setup

1. Create a GitHub repository for your solutions. It can be empty; CodePusher creates the solution folders, index file, and root index section as needed.
2. Create a fine-grained personal access token on GitHub:
   1. Open **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**, then choose **Generate new token**.
   2. Select the account that owns the solutions repository as the resource owner.
   3. Set **Repository access** to **Only select repositories** and select the solutions repository.
   4. Under **Repository permissions**, set **Contents** to **Read and write**. Leave other repository permissions at **No access**.
   5. Choose an expiration, generate the token, and copy it. GitHub shows the token only when it is created.
3. Clone this repository:

   ```sh
   git clone https://github.com/manav15dhupar-ux/code-pusher.git
   ```

4. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the cloned project folder.
5. Open the extension's **Options** page. Enter the GitHub token, your GitHub username, and the solutions repository name, then save. The repository field is only the repo name, not a URL or `username/repo`; leave the token blank on later saves to keep the saved token.
6. Sign in to LeetCode or Codeforces. When an accepted submission is detected, CodePusher pushes its solution and problem README.
7. To sync older accepted submissions, open the extension popup while on the relevant coding site, optionally set a maximum number, choose whether to re-push existing solutions, and select **Sync all solutions for this site**. Confirm the sync in the page dialog.
8. On Codeforces, choose **Rebuild index only** in the popup to rebuild the index from accepted history and folders already in the repository.

### Troubleshooting

- **No sync button available:** Open a LeetCode or Codeforces tab and reload the page after installing or reloading the extension.
- **GitHub rejects the request:** Check the username and repo name. A 401 usually means the token is incorrect or expired; a 403 indicates missing Contents write access; a 404 can mean the repository details are wrong or the token is not scoped to that repository.
- **Nothing is pushed:** Check that the submission is accepted and that you are signed in to the coding site. Unsupported languages and incomplete site metadata are reported as errors.
- **Codeforces sync stops:** Wait before trying again if Codeforces returned a rate limit or challenge. The extension deliberately stops rather than retrying through a challenge.
- **Extension was reloaded:** Refresh the coding-site tab so its content script reconnects.

## Project structure

```text
.
|-- .github/copilot-instructions.md  Project-specific development instructions
|-- background.js                    Settings, validation, and GitHub API operations
|-- content-codeforces.js            Codeforces submission detection and sync provider
|-- content-leetcode.js              LeetCode submission detection and sync provider
|-- content-markdown.js              Restricted HTML-to-Markdown converter
|-- LICENSE                          MIT license
|-- manifest.json                    Manifest V3 permissions and extension entry points
|-- options.html                     GitHub settings page
|-- options.js                       Options-page settings logic
|-- popup.html                       Sync controls
|-- popup.js                         Active-site popup actions
|-- README.md                        Project documentation
|-- SECURITY.md                      Vulnerability reporting and scope
`-- sync-runner.js                   Shared sequential historical sync runner
```

## Roadmap

- GeeksforGeeks
- CodeChef
- HackerRank

## Author

Manav — [github.com/manav15dhupar-ux](https://github.com/manav15dhupar-ux)

## License

MIT. See [LICENSE](./LICENSE).
