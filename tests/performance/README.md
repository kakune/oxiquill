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

## Output contract migration

The outputs-only result migration was measured on 2026-10-10 with Node v24.21.0, 12th Gen Intel(R) Core(TM) i7-12700F, linux x64. The baseline runtime modules were compiled from commit 19d1f2d before changes; the second run uses the outputs-only implementation. Both runs use the same deterministic inputs, five warmups, and 25 normalization samples per case. Raw reports are in [output-contract-before.json](output-contract-before.json) and [output-contract-after.json](output-contract-after.json). The after report identifies the parent commit and labels the modified working tree explicitly.

Bytes are UTF-8 serialized worker result sizes after worker bounding. Timings measure main-thread normalization of those same bounded results, without Wasm/Pyodide startup, browser transport, or rendering. Text contains 256 KiB, JSON contains 5,000 records, line contains 100,000 points, and mixed contains text, stderr, JSON, and a two-point line.

| Case  | Before bytes | After bytes | Before median | After median |
| ----- | -----------: | ----------: | ------------: | -----------: |
| text  |      524,371 |     262,204 |      0.160 ms |     0.162 ms |
| json  |      283,652 |     141,829 |     20.111 ms |    22.473 ms |
| line  |    5,505,134 |   2,752,568 |     46.376 ms |    39.478 ms |
| mixed |          400 |         250 |      0.016 ms |     0.012 ms |

All cases retain the same output count and have zero artifact errors. Removing duplicate fields approximately halves the larger responses. Timing differences include normal measurement noise and are not a cross-device performance guarantee.

After building the package, reproduce a measurement with:

```sh
pnpm exec node tests/performance/output-contract.mjs --output test-results/output-contract.json
```

Use `--runtime` to select a separately compiled baseline module directory and `--revision` to identify its source commit. The benchmark reports measurements without a timing-based CI threshold.

## Large chart rendering

P43 was measured on 2026-10-13 with 153.0.8010.12 headless Chromium, Node v24.21.0, ECharts 6.1.0, and 12th Gen Intel(R) Core(TM) i7-12700F (20 available CPUs, 25197961216 bytes RAM), linux x64. The viewport was 900 × 700, the chart 720 × 360, and device pixel ratio 1, without CPU/network throttling. The Vite-compiled harness mounts the actual ChartOutput with animations disabled and preloaded ECharts. Each condition has one discarded warmup and five fresh-page samples; no builds or test suites ran during measurement.

The [before report](chart-rendering-before.json) uses source commit 3970e62f7c1d441536150c0ca0d6c3a88b64c355. The [after report](chart-rendering-after.json) identifies that same parent and explicitly labels the modified working tree; it measures the implementation included in this change. Both builds use the same installed dependencies. The source-selectable harness and raw samples remain reproducible. The threshold constants were chosen after preliminary comparisons: LTTB at 10,000 points did not give a repeatable component-level improvement, so it starts at 100,000 points. Scatter large rendering starts at 10,000 original points and stays in that mode while zooming to avoid renderer-switch overhead. Tiny (under 4px), empty, and hidden scatter symbols are excluded because ECharts' large path changes their appearance.

| Chart   |  Points | Initial before / after | Update before / after | Zoom before / after | Main-thread before / after |
| ------- | ------: | ---------------------: | --------------------: | ------------------: | -------------------------: |
| line    |   1,000 |         40.9 / 39.8 ms |        16.1 / 16.6 ms |      11.3 / 11.6 ms |             68.7 / 66.6 ms |
| line    |  10,000 |         62.9 / 65.0 ms |        23.0 / 20.4 ms |      14.4 / 14.8 ms |           108.8 / 111.4 ms |
| line    | 100,000 |       157.6 / 114.1 ms |        96.0 / 70.4 ms |      69.7 / 33.5 ms |           455.0 / 397.0 ms |
| scatter |   1,000 |         61.5 / 60.7 ms |        25.1 / 25.6 ms |      10.9 / 10.8 ms |           104.0 / 101.1 ms |
| scatter |  10,000 |       466.2 / 100.2 ms |       421.0 / 48.9 ms |      17.4 / 15.6 ms |           525.2 / 149.1 ms |
| scatter | 100,000 |      8779.5 / 368.9 ms |     8753.2 / 317.2 ms |     387.2 / 12.2 ms |         17267.1 / 835.4 ms |

Initial and update durations start at Preact rendering and include waiting for ECharts finished events and two settled animation frames. Main-thread TaskDuration is measured by Chromium over initial output, update, zoom, and cleanup together; it is not the sum of those elapsed times. The raw reports separately record worker preparation/bounding, postMessage transfer (aligned time origins), worker round trip, normalization, option conversion, and synchronous setOption time. Worker startup and ECharts loading are excluded. Request payloads contain only kind/count/revision; point data is generated and bounded in the worker. Byte counts are UTF-8 JSON worker-result sizes, not network traffic or an estimate of browser structured-clone storage.

At 100,000 scatter points, disabling progressive alone in the baseline reduced initial/update time to 911.9/803.7 ms but increased zoom to 3003.8 ms. The optimized progressive-disabled control is also recorded. Production keeps ECharts' progressive defaults: large mode improves all three operations without a blanket progressive override. Small-data paths are unchanged; sub-frame timing differences in the table are measurement noise, not a portable speed guarantee.

Transfer size is unchanged by rendering optimization. The 100,000-point line is 2,752,497 bytes and its main-thread normalization remains approximately 41.9 ms. Validation is preserved on both sides of the worker boundary. Reports also include a clearly synthetic legacy duplicate (outputs plus plots) and isolated structuredClone durations. These controls measure duplication cost, not a revived legacy runtime. The actual P21 before/after migration remains recorded separately in [Output contract migration](#output-contract-migration); these chart comparisons are both post-P21.

The P08 bar control converts 100,000 values without rendering. Positive-only values allocate no point wrappers; alternating signs wrap 50,000 negative points. Median option conversion before/after was 5.6/5.1 ms for positive bars and 7.5/7.7 ms for mixed bars. The existing selective wrapping remains unchanged.

Correctness is checked independently of timing: real ECharts tests cover spikes, monotonicity, missing-coordinate rejection, raw-data identity, zoom detail, and compatible updates; browser tests cover pointer tooltips, theme/update state, tables, and PNG/SVG exports. Sampling never feeds summaries or statistics. Tables/CSV keep original values within the existing 10,000-row limit. No new public chart option or telemetry is introduced, and CI has no wall-clock performance threshold.

Reproduce without other builds or tests running:

```sh
pnpm exec node tests/performance/chart-rendering.mjs --source /path/to/source --label before --output test-results/chart-before.json
pnpm exec node tests/performance/chart-rendering.mjs --label after --output test-results/chart-after.json
```

The selected source tree must resolve the same installed dependencies (as the existing chart gallery baseline does). Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH for a system/Nix Chromium. The benchmark requires at least five measured runs and rejects browser errors; raw rendering artifacts go under test-results.
