import { IRPC_Client, RPCMessage, RegisterRPCClient, RPCConnection, ConectionOptions } from "./index";
import { PostMessageBridge } from "./PostMessageBridge";

/**
 * IRPC_Client implementation using window.postMessage for iframe communication.
 * This allows RPCConnection to work with postMessage transport just like Socket.IO.
 * 
 * Usage:
 *   const client = new PostMessageRPCClient(
 *     window.parent,
 *     { clientId: 'my-client', defaultDestinationId: 'server', ... }
 *   );
 *   const connection = new RPCConnection(client, options, onMessage);
 *   await connection.init();
 */
export class PostMessageRPCClient implements IRPC_Client {
    bridge: PostMessageBridge;
    
    public clientId: string;
    public defaultDestinationId: string;
    public onMessage: (message: RPCMessage) => Promise<void>;
    
    /**
     * @param targetWindow - Window to communicate with (e.g., window.parent for iframe)
     * @param funcInfo - Registration info (clientId, destinationId, etc.)
     * @param targetOrigin - Origin restriction for security (default: '*')
     * @param debug - Enable debug logging
     * @param role - Role of THIS bridge instance (not target window's role):
     *               - 'parent': I am the parent page → validate chat iframe PostMessages
     *               - 'canvas': I am a canvas iframe → validate chat iframe PostMessages
     *               - 'chat': I am the chat iframe → don't validate my own PostMessages
     *               Used to determine which CORS validation rules apply.
     * @param cors - CORS configuration for validating PostMessage origins
     */
    constructor(
        targetWindow: Window,
        funcInfo: RegisterRPCClient,
        targetOrigin: string = '*',
        debug: boolean = false,
        role?: 'parent' | 'canvas' | 'chat',
        cors?: {
            botdojoChatDomain?: string[];
            allowedToolCallOrigins?: string[];
        }
    ) {
        this.clientId = funcInfo.clientId;
        this.defaultDestinationId = funcInfo.defaultDestinationId;
        
        // Create PostMessageBridge with message forwarding to RPCConnection
        this.bridge = new PostMessageBridge({
            targetWindow,
            targetOrigin,
            clientId: this.clientId,
            debug,
            role,
            cors,
            onMessage: async (msg: RPCMessage) => {
                // Forward incoming RPC messages to RPCConnection's handler
                if (this.onMessage) {
                    await this.onMessage(msg);
                }
            },
            onReady: (readyMsg) => {
                if (debug) {
                    console.log(`[PostMessageRPCClient:${this.clientId}] Remote ready:`, readyMsg);
                }
            },
            onError: (error) => {
                console.error(`[PostMessageRPCClient:${this.clientId}] Error:`, error);
            }
        });
    }
    
    /**
     * Update the target window (useful when iframe loads after client creation)
     */
    updateTargetWindow(targetWindow: Window): void {
        this.bridge.updateTargetWindow(targetWindow);
    }
    
    /**
     * Initialize the client (start listening for postMessage events)
     */
    async init(): Promise<void> {
        this.bridge.start();
        // Send ready message to establish connection
        this.bridge.sendReady(undefined, ['rpc-client']);
        
        // Wait a bit for handshake (optional, but helps with reliability)
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    /**
     * Close the client (stop listening for postMessage events)
     */
    async close(): Promise<void> {
        this.bridge.stop();
    }
    
    /**
     * Send an RPC message via postMessage
     */
    async sendMessage(message: RPCMessage): Promise<any> {
        this.bridge.sendMessage(message);
    }
}

/**
 * Helper function to create an RPC connection using postMessage transport.
 * Parallel to getConnectionToFunctionCall() for Socket.IO.
 * 
 * @param targetWindow - Window to communicate with (e.g., window.parent)
 * @param channel - Channel identifier (not used for postMessage, but kept for API compatibility)
 * @param senderId - Client ID for this side
 * @param receiverId - Client ID for the other side
 * @param onMessage - Message handler for incoming requests
 * @param options - Connection options (timeout, etc.)
 * 
 * @example
 * const connection = await getPostMessageConnection(
 *   window.parent,
 *   'my-channel',
 *   'client-id',
 *   'server-id',
 *   async (msg) => { console.log('Received:', msg); }
 * );
 * 
 * // Use just like Socket.IO connection
 * connection.callbacks.set('myFunction', {
 *   source: connection.sender,
 *   func: async (data) => { return 'response'; }
 * });
 */
export async function getPostMessageConnection(
    targetWindow: Window,
    channel: string,
    senderId: string,
    receiverId: string,
    onMessage: (msg: RPCMessage) => Promise<any>,
    options?: ConectionOptions
): Promise<RPCConnection> {
    const client = new PostMessageRPCClient(
        targetWindow,
        {
            getToken: async () => senderId, // No real auth for postMessage
            clientId: senderId,
            defaultDestinationId: receiverId,
            baseChannel: channel
        },
        '*',
        true // Enable debug for now
    );
    
    const connection = new RPCConnection(client, options || new ConectionOptions(), onMessage);
    await connection.init();
    return connection;
}


