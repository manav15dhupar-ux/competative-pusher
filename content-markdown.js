// Converts untrusted problem HTML into Markdown without passing through raw HTML.

// Resolves only HTTPS URLs, making relative links absolute against the supplied site origin.
function getSafeMarkdownUrl(value, origin) {
  try {
    const url = new URL(value, origin);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// Converts an HTML node and its descendants into a restricted Markdown subset.
function renderMarkdownNode(node, origin) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const tag = node.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript") {
    return "";
  }

  const children = Array.from(node.childNodes)
    .map((child) => renderMarkdownNode(child, origin))
    .join("");
  const trimmed = children.trim();

  switch (tag) {
    case "p":
      return trimmed ? `${trimmed}\n\n` : "";
    case "br":
      return "  \n";
    case "pre":
      return trimmed ? `\n\`\`\`\n${children.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n` : "";
    case "code":
      return node.parentElement?.tagName.toLowerCase() === "pre"
        ? children
        : `\`${trimmed}\``;
    case "ul":
    case "ol":
      return renderMarkdownList(node, origin, tag === "ol");
    case "li":
      return `${trimmed}\n`;
    case "strong":
    case "b":
      return trimmed ? `**${trimmed}**` : "";
    case "em":
    case "i":
      return trimmed ? `*${trimmed}*` : "";
    case "sup":
      return trimmed ? `^${trimmed}^` : "";
    case "sub":
      return trimmed ? `~${trimmed}~` : "";
    case "a": {
      const href = getSafeMarkdownUrl(node.getAttribute("href") || "", origin);
      const label = trimmed.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      return href ? `[${label}](${href})` : children;
    }
    case "img": {
      const source = getSafeMarkdownUrl(node.getAttribute("src") || "", origin);
      const alt = (node.getAttribute("alt") || "")
        .replace(/\\/g, "\\\\")
        .replace(/\]/g, "\\]");
      return source ? `![${alt}](${source})` : "";
    }
    case "table":
      return renderMarkdownTable(node, origin);
    default:
      return children;
  }
}

// Renders list items recursively while retaining nested list indentation.
function renderMarkdownList(list, origin, ordered) {
  let itemIndex = 0;
  const items = [];
  for (const child of list.childNodes) {
    if (child.nodeType !== Node.ELEMENT_NODE || child.tagName.toLowerCase() !== "li") {
      continue;
    }
    const marker = ordered ? `${++itemIndex}. ` : "- ";
    const item = Array.from(child.childNodes)
      .map((node) => renderMarkdownNode(node, origin).trim())
      .filter(Boolean)
      .join(" ");
    if (item) {
      items.push(`${marker}${item}`);
    }
  }
  return items.length ? `\n${items.join("\n")}\n\n` : "";
}

// Converts an HTML table into pipe-delimited Markdown rows.
function renderMarkdownTable(table, origin) {
  const rows = [];
  for (const row of table.childNodes) {
    if (row.nodeType === Node.ELEMENT_NODE && row.tagName.toLowerCase() === "tr") {
      rows.push(row);
    } else if (row.nodeType === Node.ELEMENT_NODE) {
      for (const nestedRow of row.childNodes) {
        if (nestedRow.nodeType === Node.ELEMENT_NODE && nestedRow.tagName.toLowerCase() === "tr") {
          rows.push(nestedRow);
        }
      }
    }
  }

  const markdownRows = rows.map((row) => {
    const cells = Array.from(row.childNodes)
      .filter((cell) =>
        cell.nodeType === Node.ELEMENT_NODE &&
        ["th", "td"].includes(cell.tagName.toLowerCase())
      )
      .map((cell) =>
        Array.from(cell.childNodes)
          .map((child) => renderMarkdownNode(child, origin).trim())
          .join(" ")
          .replace(/\|/g, "\\|")
      );
    return cells.length ? `| ${cells.join(" | ")} |` : "";
  }).filter(Boolean);

  if (!markdownRows.length) {
    return "";
  }
  const separator = `| ${markdownRows[0].split("|").slice(1, -1).map(() => "---").join(" | ")} |`;
  return `\n${[markdownRows[0], separator, ...markdownRows.slice(1)].join("\n")}\n\n`;
}

// Parses untrusted HTML and emits Markdown from supported nodes only.
function convertHtmlToMarkdown(html, origin) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return Array.from(parsed.body.childNodes)
    .map((node) => renderMarkdownNode(node, origin))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

globalThis.CodePusherMarkdown = Object.freeze({ convertHtmlToMarkdown });
