# Retrieval Evaluation Harness

The `DECISIONS.md` file references a fixture-based evaluation harness used to tune chunk sizing, retrieval modes, and freshness decay (measuring metrics like recall@5).

Because this harness requires a substantial fixture corpus of indexed documents and a running Qdrant instance to execute meaningfully, it is not currently bundled in the `tests/` directory of the published v1.0.0 release.

## Recreating the Harness

If you are modifying the retrieval pipeline (e.g. changing the chunking strategy, swapping the embedding model, or altering the RRF fusion weights), you should recreate a local harness:

1. Create an isolated Qdrant collection (e.g. `ask_my_tabs_eval`).
2. Scrape and index a known corpus (e.g. 10-20 long-form articles).
3. Write a set of 50+ query fixtures in the format:
   ```json
   {
     "query": "What is the memory footprint of WebLLM?",
     "expected_source_url": "https://example.com/webllm-docs",
     "expected_chunk_substring": "requires approximately 1.5GB of VRAM"
   }
   ```
4. Run your queries against `src/lib/agent.js`'s `retrieve()` function and assert that the `expected_chunk_substring` is present in the top-K results.

A formalized, runnable version of this harness is planned for a future release.
