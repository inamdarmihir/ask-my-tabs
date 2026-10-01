# Ask My Tabs

Turn the tabs you're reading into a private, AI-powered knowledge base. 

Ask My Tabs is an open-source extension that lets you ask questions across multiple web pages at once, backed by a real vector database (Qdrant).

## How it works
1. **Read:** As you browse research papers, documentation, or articles, open the popup and add the current tab, or tick other open tabs to add.
2. **Index:** The extension extracts the text and embeds it directly in your browser. The embedded text is saved to your Qdrant vector database.
3. **Ask:** Ask a question. An AI agent plans a search, retrieves the most relevant snippets, and writes a synthesized answer with numbered citations pointing back to the exact tabs.

## Bring Your Own Backend (Private by Design)
This extension does not route your data through our servers. You configure it to talk directly to your own infrastructure:

- **Vector Storage:** Connect to a free Qdrant Cloud cluster, or run Qdrant locally via Docker (`http://127.0.0.1:6333`).
- **Language Model:** Bring your own API key (OpenAI, Groq, Google Gemini) for fast answers, or use the "Local WebLLM" option to run a 1.5B parameter instruction model entirely on your device's GPU for ultimate privacy.

## Features
- **Multi-hop reasoning:** The agent doesn't just do one search. It evaluates the first batch of results and can issue a refined follow-up search before answering.
- **Hybrid Retrieval:** Combines dense semantic search (bge-small-en-v1.5) with a custom sparse lexical scorer, merged via Reciprocal Rank Fusion.
- **Working Set vs. Library:** Ask questions against just your open tabs, or against everything you've ever saved to your library.
- **Source filtering:** Filter your library search by domain or date indexed.

Open source on GitHub: https://github.com/inamdarmihir/ask-my-tabs
