# botdojo-rpc

RPC and PostMessage communication primitives for BotDojo.

## Features

- 🔌 **PostMessage RPC** - Type-safe RPC over PostMessage for iframe communication
- 🔄 **Bidirectional** - Full duplex communication between host and iframe
- 🎯 **Channel-based** - Isolated communication channels for multiple contexts
- 🔐 **Type-safe** - Full TypeScript support
- 🌐 **Universal** - Works in browser and Node.js environments

## Installation

```bash
npm install botdojo-rpc
# or
pnpm add botdojo-rpc
# or
yarn add botdojo-rpc
```

## Usage

### PostMessage Bridge

Create a bridge for iframe communication:

```typescript
import { createIframeBridge, PostMessageRPCClient } from 'botdojo-rpc';

// In parent window
const bridge = createIframeBridge(iframeElement, {
  targetOrigin: 'https://app.example.com'
});

const client = new PostMessageRPCClient({
  bridge,
  senderId: 'parent',
  receiverId: 'iframe'
});

// Send messages
await client.send('method-name', { data: 'value' });

// Listen for messages
client.on('event-name', (data) => {
  console.log('Received:', data);
});
```

### RPC Provider

Create an RPC provider to handle method calls:

```typescript
import { RPCProvider } from 'botdojo-rpc';

const provider = new RPCProvider();

// Register methods
provider.registerMethod('getData', async (params) => {
  return { result: 'data' };
});

// Handle incoming messages
connection.on('message', (message) => {
  provider.handleMessage(message, connection);
});
```

## API Reference

### `createIframeBridge(iframe, options)`

Creates a PostMessage bridge for iframe communication.

**Parameters:**
- `iframe: HTMLIFrameElement` - The iframe element
- `options.targetOrigin?: string` - Target origin for postMessage (default: '*')

**Returns:** `PostMessageBridge`

### `PostMessageRPCClient`

RPC client for sending and receiving messages over PostMessage.

**Constructor:**
```typescript
new PostMessageRPCClient({
  bridge: PostMessageBridge,
  senderId: string,
  receiverId: string,
  channel?: string
})
```

**Methods:**
- `send(method: string, params: any): Promise<any>` - Send RPC call
- `notify(method: string, params: any): void` - Send notification (no response)
- `on(event: string, handler: Function): void` - Listen for events
- `off(event: string, handler: Function): void` - Remove event listener

### `RPCProvider`

Provider for handling RPC method calls.

**Methods:**
- `registerMethod(name: string, handler: Function): void` - Register method handler
- `handleMessage(message: RPCMessage, connection: RPCConnection): Promise<void>` - Handle incoming message

### `RPCConnection`

Low-level connection interface for RPC communication.

**Methods:**
- `send(message: RPCMessage): void` - Send message
- `on(event: string, handler: Function): void` - Listen for events
- `close(): void` - Close connection

## License

MIT

## Author

Built by [BotDojo](https://botdojo.com)
