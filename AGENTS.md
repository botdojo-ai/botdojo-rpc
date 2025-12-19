## packages/botdojo-rpc — Agents Guide

### Purpose
RPC and event streaming primitives used across connectors and the server (e.g., ChannelBroadcaster, socket utilities, PostMessage bridge).

### Key entry points
- Source root: `packages/botdojo-rpc/src/`
- Library entry: `packages/botdojo-rpc/src/index.ts`
- PostMessageBridge: `packages/botdojo-rpc/src/PostMessageBridge.ts`

### Where to edit what
- Add/update RPC abstractions, channel helpers, or client utilities under `src/`.
- Modify PostMessage bridge behavior: `src/PostMessageBridge.ts`
- Consumers: server (`dojo-server`) and canvas/client packages rely on these for streaming.

### PostMessage Bridge
For detailed documentation on the PostMessage bridge system (iframe communication, canvas integration, message routing), see:
- **[POSTMESSAGE_BRIDGE.md](./POSTMESSAGE_BRIDGE.md)** - Architecture, message flows, debugging, and best practices

### Build & dev
- Build: `pnpm --filter botdojo-rpc build`
- Dev (watch): `pnpm --filter botdojo-rpc dev`

### Improving this document
Found gaps or mistakes? Open a PR with concrete edits (specific lines/sections) and links to code.