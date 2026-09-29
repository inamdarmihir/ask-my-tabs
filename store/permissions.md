# Permissions Justification

Chrome Web Store reviewers require explicit justification for every permission requested in `manifest.json`. Copy these into the developer console when submitting.

## `tabs` and `activeTab`
**Why it's needed:** The core user flow is clicking the "Add current tab" button in the extension popup. The extension needs to read the current tab's URL and title to save it to the user's vector database. It does not monitor tabs in the background.

## `scripting`
**Why it's needed:** When the user clicks "Add current tab", the extension injects a small content script (`src/background.js` -> `extractPageText()`) to read the `document.body.innerText` of that specific tab. This text is what gets embedded and saved to the user's vector database. We do not use this to modify the page or inject ads.

## `storage`
**Why it's needed:** Used to store the user's API keys (Qdrant Cloud, OpenAI/Gemini), their chosen LLM model, and the list of tabs they currently have in their "working set" (which resets when tabs are closed).

## `offscreen`
**Why it's needed:** The extension runs AI models (an embedding model, and optionally a 1.5B parameter language model via WebGPU) locally in the browser. These models take seconds to load and consume significant memory. The offscreen document allows these models to load once per browser session and stay resident in the background, rather than forcing the user to wait for a 1.5GB model to load every time they open the popup.

## Host Permissions: `<all_urls>`
**Why it's needed:** The user can add *any* tab they are reading to their personal knowledge base. The `scripting` permission requires host access to the URL it is injecting into.

## Host Permissions: `http://127.0.0.1:6333/*` and `https://*.qdrant.io/*`
**Why it's needed:** To communicate with the user's configured vector database (either a local Docker container or Qdrant Cloud).

## Host Permissions: `https://api.openai.com/*`, `https://api.groq.com/*`, `https://generativelanguage.googleapis.com/*`
**Why it's needed:** If the user chooses to use an API provider instead of the local WebGPU model, the extension sends the prompt directly to these provider endpoints.
