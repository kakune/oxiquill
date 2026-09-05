# Python startup measurements

Issue #133 was measured on 2026-09-05 against production output served locally with gzip, at the same-origin `/oxiquill/` base path. The browser was headless Chromium 149.0.7827.55 from the development environment's Nix Playwright package. Hardware: Intel Core i7-12700F, 16 available CPUs, 25,199,001,600 bytes of RAM; Linux, Node 24.19.0, pnpm 11.2.2. Neither network nor CPU throttling was enabled. HTTP responses used `Cache-Control: public, max-age=600`.

Each example has five fresh browser contexts, five reloads of the same context, and five repeated executions on the same page. Fresh and reload latency runs from navigation start to Preact's committed output; repeat latency runs from the input/button trigger to output. The viewport was 1280 × 900 with full motion. Reactive repeats include the existing 150 ms debounce. The gzip server remains running throughout each measurement set, but browser contexts do not share an HTTP cache.

The baseline production build is commit `4047eb4` (timing instrumentation plus the preceding fixes, before Python optimization). The optimized build is `21839af` (shared preparation, overlapped package loading, lazy optional display imports, and `python.preload: true` in the dogfood site). Both used the same Pyodide assets and browser. The raw reports record `dirty: true` because source work or untracked reports existed when metadata was captured; the served build revisions above identify the measured runtime. No development server or working-tree source was served.

| Example           | Condition | Before median | After median | Change |
| ----------------- | --------- | ------------: | -----------: | -----: |
| Interactive cells | Fresh     |     1526.6 ms |    1538.7 ms |  +0.8% |
| Interactive cells | Reload    |     1386.4 ms |    1429.3 ms |  +3.1% |
| Interactive cells | Repeat    |      162.9 ms |     161.4 ms |  −0.9% |
| Rich output       | Fresh     |     8998.4 ms |    5779.3 ms | −35.8% |
| Rich output       | Reload    |     6444.1 ms |    5675.6 ms | −11.9% |
| Rich output       | Repeat    |      117.9 ms |     119.9 ms |  +1.7% |

The rich-output cold median meets the under-10-second target under these conditions. Its five optimized cold samples range from 5643.7 to 5801.7 ms; baseline samples varied more widely, so the median improvement is not a guarantee for other hardware or network conditions. The lightweight example is effectively unchanged, with a 42.9 ms reload increase. No claim is made about GitHub Pages transfer performance.

The cold-run browser boundaries were also recorded independently:

| Example and boundary                                   | Before median | After median |
| ------------------------------------------------------ | ------------: | -----------: |
| Interactive cells: hydration, since navigation         |      152.8 ms |     170.7 ms |
| Interactive cells: worker construction to module ready |        6.0 ms |      18.1 ms |
| Interactive cells: output committed, since navigation  |     1526.6 ms |    1538.7 ms |
| Rich output: hydration, since navigation               |      161.9 ms |     168.6 ms |
| Rich output: worker construction to module ready       |        5.9 ms |      16.2 ms |
| Rich output: output committed, since navigation        |     8998.4 ms |    5779.3 ms |

The worker's median cold phases explain the remaining rich-output cost:

| Phase                                        |    Before |                                  After |
| -------------------------------------------- | --------: | -------------------------------------: |
| Pyodide initialization                       | 1345.5 ms | 2271.0 ms, including declared packages |
| Additional declared package loading          | 1615.5 ms |              No separate load required |
| Display support installation                 |   34.0 ms |                                21.4 ms |
| Import discovery                             |    1.0 ms |                                 1.6 ms |
| Display preparation                          | 1143.4 ms |                                 0.5 ms |
| Authored execution, including Python imports | 2349.1 ms |                              3260.0 ms |
| Figure collection                            |  124.0 ms |                               111.6 ms |

These are per-phase medians and should not be added to reconstruct a navigation median. Package transfer now overlaps initialization. Removing unconditional optional imports moves Matplotlib's necessary import into authored execution; it does not eliminate that cost for a page that uses Matplotlib. Roughly 3.3 seconds of rich-output execution and 2.3 seconds of initialization/packages remain. A service worker, persistent browser cache, CDN, and custom Pyodide distribution were not needed to meet the local target and were not introduced.

The raw [before](./python-startup-before.json) and [after](./python-startup-after.json) reports include all samples, navigation and worker time origins, hydration/startup/output marks, phase durations, request/response timestamps, and resource transfer sizes. Resource entries retain relevant timing/size fields; unused browser-specific fields are omitted. `renderObserverDeltaMs` can be negative because the benchmark's response observer runs after the runtime's listener, which may already have committed output. This diagnostic is not a rendering duration; output completion is measured by the layout-effect mark instead. The boundary marks do not isolate rendering CPU time from result normalization. No telemetry or authored source is collected.

To reproduce, first build the desired revision, then run the benchmark without other builds or tests running:

```sh
BASE_PATH=/oxiquill/ env -u NODE_ENV pnpm build
pnpm exec node tests/performance/python-startup.mjs --runs 5 --label local --output test-results/python-startup.json
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when using a system/Nix Chromium. The script defaults to `examples/docs-site/dist`, `/oxiquill/`, and localhost gzip. Override `--site` or `--base` only if the build uses matching paths. User Timing entries are bounded to the latest phase per cell and stay local to the browser.
