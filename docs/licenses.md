# Dependency license inventory

Generated from `npm ls --all --json` and each package's `package.json` after `npm install` (lockfile: `package-lock.json`). Owner: Platform & DevOps (S1-PLT-02).

## Policy

- The core runtime has **zero runtime dependencies** (`dependencies` is empty).
- AI provider SDKs are `optionalDependencies`, pinned to exact versions published on or before 2026-10-04, and loaded only when credentials are configured; the deterministic `local` provider needs none of them.
- Permissive = MIT, Apache-2.0, BSD-2/3-Clause, ISC. Anything else is flagged below. No copyleft (GPL/LGPL/AGPL/MPL/SSPL) packages are present.

## Direct optional dependencies

| Package | Pinned version | License | Use |
|---|---|---|---|
| @anthropic-ai/vertex-sdk | 0.20.2 | MIT | Claude on Vertex AI |
| @google/genai | 2.27.0 | Apache-2.0 | Gemini on Vertex AI |

Both import successfully under Node 22 (verified: `AnthropicVertex` and `GoogleGenAI` are exported).

## Flagged (non-permissive or unusual)

- **fast-sha256@1.3.0** (Unlicense): public-domain dedication, not a standard OSS license. Transitive via standardwebhooks > fast-sha256. Acceptable for a PoC; legal review required before commercial licensing, or drop by omitting the vertex-sdk.

BSD-3-Clause packages (protobufjs family, buffer-equal-constant-time) are permissive but carry a non-endorsement clause and attribution requirements; keep their notices when redistributing.

## All installed packages (50)

| Package | Version | License | Permissive |
|---|---|---|---|
| @anthropic-ai/sdk | 0.135.0 | MIT | yes |
| @anthropic-ai/vertex-sdk | 0.20.2 | MIT | yes |
| @babel/runtime | 7.29.10 | MIT | yes |
| @google/genai | 2.27.0 | Apache-2.0 | yes |
| @opentelemetry/api | 1.9.1 | Apache-2.0 | yes |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause | yes |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause | yes |
| @protobufjs/codegen | 2.0.5 | BSD-3-Clause | yes |
| @protobufjs/eventemitter | 1.1.1 | BSD-3-Clause | yes |
| @protobufjs/fetch | 1.1.1 | BSD-3-Clause | yes |
| @protobufjs/float | 1.0.2 | BSD-3-Clause | yes |
| @protobufjs/path | 1.1.2 | BSD-3-Clause | yes |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause | yes |
| @protobufjs/utf8 | 1.1.2 | BSD-3-Clause | yes |
| @stablelib/base64 | 1.0.1 | MIT | yes |
| @types/node | 26.6.5 | MIT | yes |
| @types/retry | 0.12.0 | MIT | yes |
| agent-base | 7.1.4 | MIT | yes |
| base64-js | 1.5.1 | MIT | yes |
| bignumber.js | 9.3.1 | MIT | yes |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause | yes |
| data-uri-to-buffer | 4.0.1 | MIT | yes |
| debug | 4.4.3 | MIT | yes |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 | yes |
| extend | 3.0.2 | MIT | yes |
| fast-sha256 | 1.3.0 | Unlicense | FLAG |
| fetch-blob | 3.2.0 | MIT | yes |
| formdata-polyfill | 4.0.10 | MIT | yes |
| gaxios | 7.3.1 | Apache-2.0 | yes |
| gcp-metadata | 8.1.2 | Apache-2.0 | yes |
| google-auth-library | 10.9.1 | Apache-2.0 | yes |
| google-logging-utils | 1.1.3 | Apache-2.0 | yes |
| https-proxy-agent | 7.0.6 | MIT | yes |
| json-bigint | 1.0.0 | MIT | yes |
| json-schema-to-ts | 3.1.1 | MIT | yes |
| jwa | 2.0.1 | MIT | yes |
| jws | 4.0.1 | MIT | yes |
| long | 5.3.2 | Apache-2.0 | yes |
| ms | 2.1.3 | MIT | yes |
| node-domexception | 1.0.0 | MIT | yes |
| node-fetch | 3.3.2 | MIT | yes |
| p-retry | 4.6.2 | MIT | yes |
| protobufjs | 7.6.6 | BSD-3-Clause | yes |
| retry | 0.13.1 | MIT | yes |
| safe-buffer | 5.2.1 | MIT | yes |
| standardwebhooks | 1.1.1 | MIT | yes |
| ts-algebra | 2.0.0 | MIT | yes |
| undici-types | 8.9.0 | MIT | yes |
| web-streams-polyfill | 3.3.3 | MIT | yes |
| ws | 8.22.0 | MIT | yes |

## Optional peers not installed

npm reports these as unmet optional dependencies; they are not in the lockfile install tree and not shipped. Licenses per the registry.

| Package | Wanted by | License |
|---|---|---|
| zod | @anthropic-ai/sdk (peer, optional) | MIT |
| @modelcontextprotocol/sdk | @google/genai (peer, optional) | MIT |
| bufferutil | ws (optional) | MIT |
| utf-8-validate | ws (optional) | MIT |
